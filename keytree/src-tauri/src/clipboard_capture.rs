use serde::Serialize;
use tauri::WebviewWindow;

const MAX_TEXT_BYTES: usize = 1024 * 1024;
const MAX_HTML_BYTES: usize = 2 * 1024 * 1024;
const MAX_SOURCE_URL_BYTES: usize = 2048;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardSnapshot {
    pub sequence: u32,
    pub text: String,
    pub html: Option<String>,
    pub source_url: Option<String>,
    pub source_app: Option<String>,
}

/// Read only a bounded clipboard snapshot while the main window is truly foreground.
#[tauri::command]
pub fn read_clipboard_candidate(
    window: WebviewWindow,
    last_sequence: Option<u32>,
) -> Result<Option<ClipboardSnapshot>, String> {
    if window.label() != "main" {
        return Err("MAIN_WINDOW_ONLY".into());
    }
    #[cfg(windows)]
    {
        platform::read(&window, last_sequence)
    }
    #[cfg(not(windows))]
    {
        let _ = (window, last_sequence);
        Ok(None)
    }
}

/// Decode a bounded CF_UNICODETEXT allocation. The allocation must contain a NUL
/// terminator on a UTF-16 code-unit boundary and valid UTF-16 before it.
fn decode_bounded_utf16(bytes: &[u8]) -> Option<String> {
    if bytes.is_empty() || bytes.len() > MAX_TEXT_BYTES || bytes.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_ne_bytes([pair[0], pair[1]]))
        .collect();
    let end = units.iter().position(|unit| *unit == 0)?;
    String::from_utf16(&units[..end]).ok()
}

struct ParsedHtml {
    fragment: String,
    source_url: Option<String>,
}

/// Parse CF_HTML offsets as byte offsets into the complete UTF-8 payload.
/// Only the fragment is returned; surrounding page context is never exposed.
fn parse_cf_html(bytes: &[u8]) -> Option<ParsedHtml> {
    if bytes.is_empty() || bytes.len() > MAX_HTML_BYTES {
        return None;
    }
    let raw = std::str::from_utf8(bytes).ok()?;
    // CF_HTML metadata belongs in a small header, before StartHTML. Bound the
    // probe so page content cannot masquerade as an unbounded header.
    let mut probe_end = raw.len().min(4096);
    while !raw.is_char_boundary(probe_end) {
        probe_end -= 1;
    }
    let probe = raw.get(..probe_end)?;
    let start_html = probe.lines().find_map(|line| {
        let (key, value) = line.trim_end_matches('\r').split_once(':')?;
        (key == "StartHTML")
            .then(|| parse_offset(value.trim()))
            .flatten()
    })?;
    if start_html > probe.len() || !raw.is_char_boundary(start_html) {
        return None;
    }
    let header = raw.get(..start_html)?;
    let mut declared_start_html = None;
    let mut end_html = None;
    let mut start_fragment = None;
    let mut end_fragment = None;
    let mut source_url = None;
    for line in header.lines() {
        let Some((key, value)) = line.trim_end_matches('\r').split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key {
            "StartHTML" => declared_start_html = parse_offset(value),
            "EndHTML" => end_html = parse_offset(value),
            "StartFragment" => start_fragment = parse_offset(value),
            "EndFragment" => end_fragment = parse_offset(value),
            "SourceURL" => {
                source_url = Some(
                    if value.len() <= MAX_SOURCE_URL_BYTES && !value.is_empty() {
                        Some(value.to_owned())
                    } else {
                        None
                    },
                );
            }
            _ => {}
        }
    }
    let end_html = end_html?;
    let start_fragment = start_fragment?;
    let end_fragment = end_fragment?;
    if declared_start_html? != start_html
        || start_html > end_html
        || end_html > bytes.len()
        || start_fragment < start_html
        || end_fragment < start_fragment
        || end_fragment > end_html
    {
        return None;
    }
    let fragment = std::str::from_utf8(bytes.get(start_fragment..end_fragment)?).ok()?;
    Some(ParsedHtml {
        fragment: fragment.to_owned(),
        source_url: source_url.flatten(),
    })
}

fn parse_offset(value: &str) -> Option<usize> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

#[cfg(windows)]
mod platform {
    use super::{
        decode_bounded_utf16, parse_cf_html, ClipboardSnapshot, MAX_HTML_BYTES, MAX_TEXT_BYTES,
    };
    use std::ffi::c_void;
    use tauri::WebviewWindow;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::DataExchange::{
        CloseClipboard, GetClipboardData, GetClipboardOwner, GetClipboardSequenceNumber,
        IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW,
    };
    use windows_sys::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, IsIconic, IsWindow, IsWindowVisible,
    };

    const CF_UNICODETEXT: u32 = 13;
    const CLIPBOARD_READ_FAILED: &str = "CLIPBOARD_READ_FAILED";
    const CLIPBOARD_TOO_LARGE: &str = "CLIPBOARD_TOO_LARGE";
    const CLIPBOARD_SEQUENCE_INVALID: &str = "CLIPBOARD_SEQUENCE_INVALID";
    const CLIPBOARD_CHANGED: &str = "CLIPBOARD_CHANGED";

    struct ClipboardGuard;
    impl Drop for ClipboardGuard {
        fn drop(&mut self) {
            unsafe { CloseClipboard() };
        }
    }

    struct GlobalLockGuard(*mut c_void);
    impl Drop for GlobalLockGuard {
        fn drop(&mut self) {
            unsafe { GlobalUnlock(self.0) };
        }
    }

    struct ProcessGuard(HANDLE);
    impl Drop for ProcessGuard {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }

    fn main_window_is_active(window: &WebviewWindow) -> bool {
        if window.label() != "main"
            || !window.is_visible().unwrap_or(false)
            || !window.is_focused().unwrap_or(false)
        {
            return false;
        }
        let Ok(hwnd) = window.hwnd() else {
            return false;
        };
        let hwnd = hwnd.0;
        if hwnd.is_null() {
            return false;
        }
        unsafe {
            IsWindow(hwnd) != 0
                && IsWindowVisible(hwnd) != 0
                && IsIconic(hwnd) == 0
                && GetForegroundWindow() == hwnd
        }
    }

    fn read_payload(format: u32, max_bytes: usize) -> Result<Option<Vec<u8>>, String> {
        if unsafe { IsClipboardFormatAvailable(format) } == 0 {
            return Ok(None);
        }
        let handle = unsafe { GetClipboardData(format) };
        if handle.is_null() {
            return Err(CLIPBOARD_READ_FAILED.into());
        }
        let size = unsafe { GlobalSize(handle) };
        if size > max_bytes {
            return Err(CLIPBOARD_TOO_LARGE.into());
        }
        if size == 0 {
            return Ok(Some(Vec::new()));
        }
        let ptr = unsafe { GlobalLock(handle) };
        if ptr.is_null() {
            return Err(CLIPBOARD_READ_FAILED.into());
        }
        let _lock = GlobalLockGuard(handle);
        let bytes = unsafe { std::slice::from_raw_parts(ptr.cast::<u8>(), size) }.to_vec();
        Ok(Some(bytes))
    }

    // Best-effort basename of the current clipboard-owner process, not a claim
    // about which application originally produced the copied data.
    fn source_app(owner: windows_sys::Win32::Foundation::HWND) -> Option<String> {
        if owner.is_null() {
            return None;
        }
        let mut pid = 0u32;
        unsafe { GetWindowThreadProcessId(owner, &mut pid) };
        if pid == 0 || pid == std::process::id() {
            return None;
        }
        let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
        if process.is_null() {
            return None;
        }
        let _process = ProcessGuard(process);
        let mut path = vec![0u16; 32768];
        let mut length = path.len() as u32;
        if unsafe { QueryFullProcessImageNameW(process, 0, path.as_mut_ptr(), &mut length) } == 0
            || length == 0
            || length as usize > path.len()
        {
            return None;
        }
        path.truncate(length as usize);
        let path = String::from_utf16(&path).ok()?;
        std::path::Path::new(&path)
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
    }

    fn html_format() -> u32 {
        let name: Vec<u16> = "HTML Format"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        unsafe { RegisterClipboardFormatW(name.as_ptr()) }
    }

    pub(super) fn read(
        window: &WebviewWindow,
        last_sequence: Option<u32>,
    ) -> Result<Option<ClipboardSnapshot>, String> {
        if !main_window_is_active(window) {
            return Ok(None);
        }
        let sequence = unsafe { GetClipboardSequenceNumber() };
        if sequence == 0 {
            return Err(CLIPBOARD_SEQUENCE_INVALID.into());
        }
        if last_sequence == Some(sequence) {
            return Ok(None);
        }
        if unsafe { OpenClipboard(std::ptr::null_mut()) } == 0 {
            return Err(CLIPBOARD_READ_FAILED.into());
        }
        let clipboard = ClipboardGuard;
        let owner = unsafe { GetClipboardOwner() };
        let mut candidate = None;

        let mut owner_pid = 0u32;
        if !owner.is_null() {
            unsafe { GetWindowThreadProcessId(owner, &mut owner_pid) };
        }
        if owner_pid != std::process::id() {
            let text = read_payload(CF_UNICODETEXT, MAX_TEXT_BYTES)?
                .and_then(|bytes| decode_bounded_utf16(&bytes));

            let html_id = html_format();
            let parsed_html = if html_id == 0 {
                None
            } else {
                read_payload(html_id, MAX_HTML_BYTES)?.and_then(|bytes| parse_cf_html(&bytes))
            };

            if text.is_some() || parsed_html.is_some() {
                candidate = Some(ClipboardSnapshot {
                    sequence,
                    text: text.unwrap_or_default(),
                    html: parsed_html.as_ref().map(|parsed| parsed.fragment.clone()),
                    source_url: parsed_html.and_then(|parsed| parsed.source_url),
                    source_app: source_app(owner),
                });
            }
        }

        drop(clipboard);
        if unsafe { GetClipboardSequenceNumber() } == 0 {
            return Err(CLIPBOARD_SEQUENCE_INVALID.into());
        }
        if unsafe { GetClipboardSequenceNumber() } != sequence {
            return Err(CLIPBOARD_CHANGED.into());
        }
        if !main_window_is_active(window) {
            return Ok(None);
        }
        Ok(candidate)
    }
}

#[cfg(test)]
mod tests {
    use super::{decode_bounded_utf16, parse_cf_html, MAX_HTML_BYTES, MAX_TEXT_BYTES};

    fn cf_html(fragment: &str, source_url: &str) -> Vec<u8> {
        let before = "<html><body><!--StartFragment-->";
        let after = "<!--EndFragment--></body></html>";
        let html = format!("{before}{fragment}{after}");
        let header_template = format!(
            "Version:0.9\r\nStartHTML:{:010}\r\nEndHTML:{:010}\r\nStartFragment:{:010}\r\nEndFragment:{:010}\r\nSourceURL:{source_url}\r\n",
            0, 0, 0, 0
        );
        let start_html = header_template.len();
        let start_fragment = start_html + before.len();
        let end_fragment = start_fragment + fragment.len();
        let end_html = start_html + html.len();
        let header = format!(
            "Version:0.9\r\nStartHTML:{start_html:010}\r\nEndHTML:{end_html:010}\r\nStartFragment:{start_fragment:010}\r\nEndFragment:{end_fragment:010}\r\nSourceURL:{source_url}\r\n"
        );
        assert_eq!(header.len(), header_template.len());
        [header.as_bytes(), html.as_bytes()].concat()
    }

    #[test]
    fn clipboard_capture_cf_html_uses_utf8_byte_offsets_and_returns_fragment_only() {
        let bytes = cf_html("标题-é-😀", "https://example.test/page");
        let parsed = parse_cf_html(&bytes).expect("valid CF_HTML");
        assert_eq!(parsed.fragment, "标题-é-😀");
        assert_eq!(
            parsed.source_url.as_deref(),
            Some("https://example.test/page")
        );
    }

    #[test]
    fn clipboard_capture_cf_html_rejects_bad_offsets_and_bounds_source_url() {
        let mut bad_offsets = cf_html("fragment", "https://example.test/");
        let end_fragment = bad_offsets
            .windows(b"EndFragment:".len())
            .position(|window| window == b"EndFragment:")
            .unwrap()
            + b"EndFragment:".len();
        bad_offsets[end_fragment..end_fragment + 10].copy_from_slice(b"9999999999");
        assert!(parse_cf_html(&bad_offsets).is_none());

        let long_url = format!("https://example.test/{}", "x".repeat(2100));
        let parsed =
            parse_cf_html(&cf_html("safe fragment", &long_url)).expect("fragment stays valid");
        assert_eq!(parsed.fragment, "safe fragment");
        assert_eq!(parsed.source_url, None);

        let malformed_url = cf_html("still safe", "not a url with spaces");
        let parsed = parse_cf_html(&malformed_url).expect("URL metadata is optional");
        assert_eq!(parsed.source_url.as_deref(), Some("not a url with spaces"));
    }

    #[test]
    fn clipboard_capture_cf_html_rejects_oversized_payload() {
        assert!(parse_cf_html(&vec![b'a'; MAX_HTML_BYTES + 1]).is_none());
    }

    #[test]
    fn clipboard_capture_utf16_requires_bound_terminator_and_valid_encoding() {
        let valid: Vec<u8> = "Secret 😀"
            .encode_utf16()
            .chain(std::iter::once(0))
            .flat_map(u16::to_ne_bytes)
            .collect();
        assert_eq!(decode_bounded_utf16(&valid).as_deref(), Some("Secret 😀"));
        assert!(decode_bounded_utf16(&[b'A', 0]).is_none()); // no UTF-16 NUL terminator
        assert!(decode_bounded_utf16(&[0x00, 0xd8, 0x00, 0x00]).is_none()); // unpaired high surrogate
        assert!(decode_bounded_utf16(&[0x41]).is_none()); // partial code unit
        assert!(decode_bounded_utf16(&vec![0; MAX_TEXT_BYTES + 2]).is_none());
    }
}
