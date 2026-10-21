use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
static COPY_GENERATION: AtomicU64 = AtomicU64::new(0);
pub fn copy_generation() -> u64 { COPY_GENERATION.load(Ordering::SeqCst) }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyResult { pub privacy_protected: bool, pub clear_scheduled: bool }

#[cfg(any(windows, test))]
fn ownership_matches(current: (u32, u64, isize), expected: (u32, u64, isize)) -> bool {
    current.0 != 0 && current.2 != 0 && current == expected
}

#[cfg(test)]
mod tests {
    #[test]
    fn stale_timer_never_owns_new_clipboard_contents() {
        use super::ownership_matches;
        assert!(ownership_matches((7, 3, 10), (7, 3, 10)));
        assert!(!ownership_matches((8, 3, 10), (7, 3, 10)));
        assert!(!ownership_matches((7, 4, 10), (7, 3, 10)));
        assert!(!ownership_matches((7, 3, 11), (7, 3, 10)));
        assert!(!ownership_matches((0, 3, 0), (0, 3, 0)));
    }
}

#[cfg(windows)]
mod platform {
    use super::{CopyResult, ownership_matches};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;
    use tauri::{AppHandle, Emitter};
    use windows_sys::Win32::Foundation::{GlobalFree, HWND};
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardOwner, GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows_sys::Win32::UI::WindowsAndMessaging::IsWindow;
    const CF_UNICODETEXT: u32 = 13;
    const MAX_TEXT_BYTES: usize = 1024 * 1024;
    const MAX_CLEAR_MS: u64 = 300_000;
    // Only identity metadata is global; clipboard contents and secrets are never captured.
    #[derive(Default)]
    struct Ownership { sequence: u32, generation: u64, owner: isize }
    static OWNERSHIP: OnceLock<Mutex<Ownership>> = OnceLock::new();
    fn lock_state() -> std::sync::MutexGuard<'static, Ownership> {
        OWNERSHIP.get_or_init(|| Mutex::new(Ownership::default())).lock().unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    fn clear_failed(app: &AppHandle) { let _ = app.emit("keytree:clipboard-status", serde_json::json!({ "kind": "clear-failed" })); }
    fn wide(s: &str) -> Vec<u16> { s.encode_utf16().chain(std::iter::once(0)).collect() }
    fn open_retry(owner: HWND) -> bool {
        for n in 0..6 { if unsafe { OpenClipboard(owner) } != 0 { return true; } if n < 5 { std::thread::sleep(Duration::from_millis(15 * (n + 1))); } }
        false
    }
    struct ClipboardGuard;
    impl Drop for ClipboardGuard { fn drop(&mut self) { unsafe { CloseClipboard() }; } }
    unsafe fn put(format: u32, bytes: &[u8]) -> bool {
        let h = GlobalAlloc(GMEM_MOVEABLE, bytes.len());
        if h.is_null() { return false; }
        let p = GlobalLock(h) as *mut u8;
        if p.is_null() { let _ = GlobalFree(h); return false; }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
        let _ = GlobalUnlock(h);
        if SetClipboardData(format, h).is_null() { let _ = GlobalFree(h); return false; }
        true
    }
    unsafe fn put_flag(name: &str) -> bool {
        let format = RegisterClipboardFormatW(wide(name).as_ptr());
        format != 0 && put(format, &0u32.to_ne_bytes())
    }
    pub fn copy(app: &AppHandle, owner: HWND, text: &str, delay: Option<u64>, generation: u64) -> Result<CopyResult, String> {
        if owner.is_null() || unsafe { IsWindow(owner) } == 0 { return Err("CLIPBOARD_OWNER_INVALID".into()); }
        let bytes = text.encode_utf16().count().checked_add(1).and_then(|n| n.checked_mul(2)).ok_or("CLIPBOARD_TEXT_INVALID")?;
        if text.contains('\0') || bytes > MAX_TEXT_BYTES { return Err("CLIPBOARD_TEXT_INVALID".into()); }
        if delay.is_some_and(|ms| ms > MAX_CLEAR_MS) { return Err("CLIPBOARD_CLEAR_DELAY_INVALID".into()); }
        let (sequence, generation, privacy_protected) = {
            let mut state = lock_state();
            if super::copy_generation() != generation { return Err("CLIPBOARD_COPY_CANCELLED".into()); }
            if !open_retry(owner) { return Err("CLIPBOARD_BUSY".into()); }
            let _guard = ClipboardGuard;
            if unsafe { EmptyClipboard() } == 0 { return Err("CLIPBOARD_WRITE_FAILED".into()); }
            let history = unsafe { put_flag("CanIncludeInClipboardHistory") };
            let cloud = unsafe { put_flag("CanUploadToCloudClipboard") };
            let mut words: Vec<u16> = text.encode_utf16().collect(); words.push(0);
            let payload = unsafe { std::slice::from_raw_parts(words.as_ptr() as *const u8, words.len() * 2) };
            if !unsafe { put(CF_UNICODETEXT, payload) } { return Err("CLIPBOARD_WRITE_FAILED".into()); }
            let seq = unsafe { GetClipboardSequenceNumber() };
            state.generation = state.generation.wrapping_add(1);
            state.sequence = seq;
            state.owner = if seq == 0 { 0 } else { owner as isize };
            if seq == 0 { state.generation = state.generation.wrapping_add(1); }
            (seq, state.generation, history && cloud)
        };
        let mut clear_scheduled = sequence != 0 && delay.is_some_and(|ms| ms > 0);
        if clear_scheduled {
            let app = app.clone(); let owner = owner as isize; let ms = delay.unwrap_or(0);
            clear_scheduled = std::thread::Builder::new().name("keytree-clipboard-expiry".into()).spawn(move || {
                std::thread::sleep(Duration::from_millis(ms));
                let _ = clear_expected(&app, sequence, generation, owner);
            }).is_ok();
        }
        Ok(CopyResult { privacy_protected, clear_scheduled })
    }
    enum ClearResult { Cleared, Replaced }
    fn clear_expected(app: &AppHandle, sequence: u32, generation: u64, owner: isize) -> Result<ClearResult, String> {
        let hwnd = owner as HWND; let mut state = lock_state();
        if !ownership_matches((state.sequence, state.generation, state.owner), (sequence, generation, owner)) { return Ok(ClearResult::Replaced); }
        if unsafe { GetClipboardSequenceNumber() } != sequence {
            state.generation = state.generation.wrapping_add(1); state.sequence = unsafe { GetClipboardSequenceNumber() }; state.owner = 0;
            return Ok(ClearResult::Replaced);
        }
        if hwnd.is_null() || unsafe { IsWindow(hwnd) } == 0 || !open_retry(hwnd) {
            drop(state); clear_failed(app); return Err("CLIPBOARD_CLEAR_FAILED".into());
        }
        let _guard = ClipboardGuard;
        if unsafe { GetClipboardSequenceNumber() } != sequence || unsafe { GetClipboardOwner() } != hwnd {
            state.generation = state.generation.wrapping_add(1); state.sequence = unsafe { GetClipboardSequenceNumber() }; state.owner = 0;
            return Ok(ClearResult::Replaced);
        }
        if unsafe { EmptyClipboard() } == 0 {
            drop(_guard); drop(state); clear_failed(app); return Err("CLIPBOARD_CLEAR_FAILED".into());
        }
        state.generation = state.generation.wrapping_add(1); state.sequence = unsafe { GetClipboardSequenceNumber() }; state.owner = 0;
        Ok(ClearResult::Cleared)
    }
    pub fn clear_owned(app: &AppHandle) -> Result<bool, String> {
        super::COPY_GENERATION.fetch_add(1, super::Ordering::SeqCst);
        let (sequence, generation, owner) = { let state = lock_state(); (state.sequence, state.generation, state.owner) };
        if owner == 0 { return Ok(false); }
        match clear_expected(app, sequence, generation, owner)? {
            ClearResult::Cleared => Ok(true),
            ClearResult::Replaced => Ok(false),
        }
    }
}
#[cfg(not(windows))]
mod platform {
    use super::CopyResult; use tauri::AppHandle;
    pub fn copy(_app: &AppHandle, _text: &str, _delay: Option<u64>) -> Result<CopyResult, String> { Err("CLIPBOARD_UNAVAILABLE".into()) }
    pub fn clear_owned(_app: &AppHandle) -> Result<bool, String> { Ok(false) }
}
#[cfg(windows)]
pub fn copy(app: &tauri::AppHandle, owner: windows_sys::Win32::Foundation::HWND, text: &str, delay: Option<u64>, generation: u64) -> Result<CopyResult, String> { platform::copy(app, owner, text, delay, generation) }
#[cfg(not(windows))]
pub fn copy(app: &tauri::AppHandle, text: &str, delay: Option<u64>) -> Result<CopyResult, String> { platform::copy(app, text, delay) }
pub fn clear_owned(app: &tauri::AppHandle) -> Result<bool, String> { platform::clear_owned(app) }
pub fn clear_owned_best_effort(app: &tauri::AppHandle) { let _ = clear_owned(app); }