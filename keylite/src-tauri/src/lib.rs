use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use enigo::{Direction, Enigo, Key, Keyboard, Settings as EnigoSettings};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

mod audit;
mod diagnostics;
mod secure_clipboard;
mod public_header;
mod shortcuts;
mod snapshots;
mod webdav;

#[cfg(windows)]
use windows_sys::Win32::Foundation::HWND;
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
};

/// 呼出面板前记住的前台窗口句柄，Auto-Type 时要把焦点还回去
static FOREGROUND: AtomicIsize = AtomicIsize::new(0);
static AUTO_TYPE_CANCEL: AtomicU64 = AtomicU64::new(0);
static AUTO_TYPE_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();

/// 当前前台窗口是不是我们自己的（主窗口/面板）。是的话不能记，否则 Auto-Type 会往自己身上打字。
fn foreground_is_ours() -> bool {
    #[cfg(windows)]
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() {
            return true;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        return pid == std::process::id();
    }
    #[cfg(not(windows))]
    true
}

fn capture_foreground() {
    #[cfg(windows)]
    unsafe {
        if foreground_is_ours() {
            return;
        }
        let hwnd = GetForegroundWindow();
        if !hwnd.is_null() {
            FOREGROUND.store(hwnd as isize, Ordering::SeqCst);
        }
    }
}

fn restore_foreground(expected: isize) {
    #[cfg(windows)]
    unsafe {
        let raw = expected;
        if raw != 0 {
            let _ = SetForegroundWindow(raw as HWND);
        }
    }
}

/// 发键前的最后一道保险：前台必须是「别人的、可见的、且就是呼出面板前那个」窗口。
/// 这一关挡的是自动输入最危险的翻车：密码被敲进 KeyTree 自己的输入框，
/// 或焦点在等待期间被别的程序抢走（通知弹窗、输入法候选、Alt+Tab 误触）。
fn cancel_auto_type_now() { AUTO_TYPE_CANCEL.fetch_add(1, Ordering::SeqCst); }
fn check_cancel_generation(generation: u64) -> Result<(), String> {
    if AUTO_TYPE_CANCEL.load(Ordering::SeqCst) == generation { Ok(()) } else { Err("AUTO_TYPE_CANCELLED".into()) }
}
fn hello_gated<T>(verified: impl FnOnce() -> bool, unprotect: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    if verified() { unprotect() } else { Err("HELLO_NOT_VERIFIED".into()) }
}
fn require_main_window(window: &tauri::WebviewWindow) -> Result<(), String> {
    if window.label() == "main" { Ok(()) } else { Err("MAIN_WINDOW_ONLY".into()) }
}
fn require_main_or_panel(window: &tauri::WebviewWindow) -> Result<(), String> {
    if matches!(window.label(), "main" | "panel") { Ok(()) } else { Err("WINDOW_NOT_ALLOWED".into()) }
}
#[cfg(windows)]
fn validate_expected_window(expected: isize) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindow, IsWindowVisible};
    if expected == 0 { return Err("AUTO_TYPE_TARGET_INVALID".into()); }
    let hwnd = expected as HWND;
    unsafe {
        if IsWindow(hwnd) == 0 || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 { return Err("AUTO_TYPE_TARGET_INVALID".into()); }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if pid == std::process::id() { return Err("AUTO_TYPE_TARGET_INVALID".into()); }
    }
    Ok(())
}
#[cfg(windows)]
fn ensure_typing_target(expected: isize) -> Result<(), String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, IsWindow, IsWindowVisible};
    validate_expected_window(expected)?;
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.is_null() || IsWindow(hwnd) == 0 || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 || hwnd as isize != expected {
            return Err("AUTO_TYPE_FOCUS_MISMATCH".into());
        }
    }
    Ok(())
}
#[cfg(windows)]
fn check_auto_type(expected: isize, generation: u64) -> Result<(), String> {
    check_cancel_generation(generation)?;
    ensure_typing_target(expected)
}
// ==================== Windows Hello（快速解锁的验证环节） ====================

/// Tauri 的命令跑在线程池线程上，调 WinRT 前要初始化一次 COM。
/// 该线程已按别的模式初始化（RPC_E_CHANGED_MODE）时保持原样。
#[cfg(windows)]
fn with_winrt<R>(f: impl FnOnce() -> R) -> R {
    use windows::Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED};
    unsafe {
        let hr = RoInitialize(RO_INIT_MULTITHREADED);
        let result = f();
        // S_OK / S_FALSE 都要求配对 Uninitialize；RPC_E_CHANGED_MODE 不要求
        if hr.is_ok() {
            let _ = RoUninitialize();
        }
        result
    }
}

#[cfg(windows)]
mod hello {
    use windows::core::HSTRING;
    use windows::Security::Credentials::UI::{
        UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
    };

    /// Hello 是否可用（Available / 设备未配置 / 出错）
    pub fn availability() -> &'static str {
        let Ok(op) = UserConsentVerifier::CheckAvailabilityAsync() else {
            return "error";
        };
        match op.get() {
            Ok(UserConsentVerifierAvailability::Available) => "available",
            Ok(_) => "unavailable",
            Err(_) => "error",
        }
    }

    /// 弹 Hello 验证（指纹 / 人脸 / PIN），返回是否通过
    pub fn verify(prompt: &str) -> bool {
        let Ok(op) = UserConsentVerifier::RequestVerificationAsync(&HSTRING::from(prompt)) else {
            return false;
        };
        matches!(op.get(), Ok(UserConsentVerificationResult::Verified))
    }
}

// ==================== DPAPI + 快速解锁密钥副本 ====================

#[cfg(windows)]
mod dpapi {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    /// 用当前 Windows 账户的密钥链加密：别的账户、别的机器、拷走文件都解不开
    pub fn protect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: data.len() as u32,
                pbData: data.as_ptr() as *mut u8,
            };
            let mut output = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            };
            if CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut output,
            ) == 0
            {
                return Err("DPAPI 加密失败".into());
            }
            let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            LocalFree(output.pbData as _);
            Ok(bytes)
        }
    }

    pub fn unprotect(data: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input = CRYPT_INTEGER_BLOB {
                cbData: data.len() as u32,
                pbData: data.as_ptr() as *mut u8,
            };
            let mut output = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            };
            if CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                &mut output,
            ) == 0
            {
                return Err("DPAPI 解密失败（可能换了 Windows 账户）".into());
            }
            let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
            LocalFree(output.pbData as _);
            Ok(bytes)
        }
    }
}

/// 快速解锁密钥副本落盘：AppData/quick-unlock.key（DPAPI 密文 + 绑定库路径）。
/// 多库支持：文件里是记录数组，每库一条；旧版单条格式兼容读取。
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct QuickUnlockRecord {
    vault: String,
    data: Vec<u8>,
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
enum QuickUnlockFile {
    Multi { records: Vec<QuickUnlockRecord> },
    Legacy(QuickUnlockRecord),
}

fn read_quick_records(path: &std::path::Path) -> Vec<QuickUnlockRecord> {
    let Ok(raw) = std::fs::read(path) else {
        return Vec::new();
    };
    match serde_json::from_slice::<QuickUnlockFile>(&raw) {
        Ok(QuickUnlockFile::Multi { records }) => records,
        Ok(QuickUnlockFile::Legacy(r)) => vec![r],
        Err(_) => Vec::new(),
    }
}

fn write_quick_records(
    path: &std::path::Path,
    records: &[QuickUnlockRecord],
) -> Result<(), String> {
    if records.is_empty() {
        // 全空就没有文件存在的意义
        let _ = std::fs::remove_file(path);
        return Ok(());
    }
    let payload = serde_json::to_vec(&QuickUnlockFile::Multi {
        records: records.to_vec(),
    })
    .map_err(|e| e.to_string())?;
    let tmp = path.with_extension("key.tmp");
    std::fs::write(&tmp, payload).map_err(|e| format!("写快速解锁密钥失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("快速解锁密钥替换失败：{e}")
    })
}

fn quick_unlock_file(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("拿不到 AppData 目录：{e}"))?;
    Ok(dir.join("quick-unlock.key"))
}

// ==================== 防截屏 ====================

#[cfg(windows)]
mod capture {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Gdi::{InvalidateRect, UpdateWindow};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        IsWindowVisible, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    /// 从屏幕捕获中剔除窗口：截图/录屏里整块区域直接透出底下的内容（不是黑块）。
    /// 只对顶层窗口设置——DWM 剔除会覆盖整棵窗口树，WebView2 的子窗口无需单独处理；
    /// WDA_MONITOR 那种「截图黑块」太粗暴，不用；Win10 < 2004 不支持时静默放弃。
    ///
    /// 隐藏窗口直接跳过：对隐藏的透明窗口设 affinity 会让它下次 show 时合成出白屏，
    /// 所以由调用方在窗口真正显示后补设（见 apply_capture_protection）。
    pub fn apply(hwnd: HWND, enable: bool) {
        unsafe {
            if IsWindowVisible(hwnd) == 0 {
                return;
            }
            let ok = if enable {
                SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)
            } else {
                SetWindowDisplayAffinity(hwnd, WDA_NONE)
            };
            // 切换 affinity 会让 DWM 重建这个窗口的表面。不主动重绘的话，
            // 切换瞬间可能留下一块白/黑残影（Jong 实测：关掉开关后界面出现白块）。
            if ok != 0 {
                InvalidateRect(hwnd, std::ptr::null(), 1);
                UpdateWindow(hwnd);
            }
        }
    }
}

/// 防截屏开关的当前值。隐藏窗口不设 affinity，所以窗口 show 之后要靠它补一次。
static SCREENSHOT_PROTECT: AtomicBool = AtomicBool::new(true);

#[cfg(windows)]
fn apply_capture_protection(window: &tauri::WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        capture::apply(hwnd.0, SCREENSHOT_PROTECT.load(Ordering::SeqCst));
    }
}

// ==================== 锁屏 / 休眠监听（隐藏消息窗口） ====================

/// 起一个隐藏窗口收系统广播：锁屏（WTS）和休眠（电源事件）→ 通知前端立即锁定。
/// 锁屏通知需要显式注册到某个窗口，所以不能偷懒用轮询。
#[cfg(windows)]
mod syswatch {
    use crate::{cancel_auto_type_now, secure_clipboard};
    use std::sync::OnceLock;
    use tauri::Emitter;
    use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows_sys::Win32::System::RemoteDesktop::{
        NOTIFY_FOR_THIS_SESSION, WTSRegisterSessionNotification,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PBT_APMSUSPEND,
        RegisterClassW, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WNDCLASSW, WTS_SESSION_LOCK, MSG,
    };

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if let Some(app) = APP.get() {
            let reason = match (msg, wparam as u32) {
                (WM_WTSSESSION_CHANGE, w) if w == WTS_SESSION_LOCK => Some("lock"),
                (WM_POWERBROADCAST, w) if w == PBT_APMSUSPEND => Some("suspend"),
                _ => None,
            };
            if let Some(reason) = reason {
                cancel_auto_type_now();
                secure_clipboard::clear_owned_best_effort(app);
                let _ = app.emit("keytree:system-lock", reason);
            }
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }

    pub fn start(app: tauri::AppHandle) {
        let _ = APP.set(app);
        std::thread::spawn(|| unsafe {
            let mut class_name: Vec<u16> = "KeyTreeSysWatch".encode_utf16().collect();
            class_name.push(0);
            let hinstance = GetModuleHandleW(std::ptr::null());
            let wc = WNDCLASSW {
                style: 0,
                lpfnWndProc: Some(wndproc),
                cbClsExtra: 0,
                cbWndExtra: 0,
                hInstance: hinstance,
                hIcon: std::ptr::null_mut(),
                hCursor: std::ptr::null_mut(),
                hbrBackground: std::ptr::null_mut(),
                lpszMenuName: std::ptr::null(),
                lpszClassName: class_name.as_ptr(),
            };
            if RegisterClassW(&wc) == 0 {
                eprintln!("[keytree] 注册系统监听窗口类失败");
                return;
            }
            // style=0 且不 Show：不可见的顶层窗口，能收到广播消息
            let hwnd = CreateWindowExW(
                0,
                class_name.as_ptr(),
                class_name.as_ptr(),
                0,
                0,
                0,
                0,
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                hinstance,
                std::ptr::null(),
            );
            if hwnd.is_null() {
                eprintln!("[keytree] 创建系统监听窗口失败");
                return;
            }
            // 注册后系统把 WM_WTSSESSION_CHANGE 直接发给这个窗口
            WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                let _ = DispatchMessageW(&msg);
            }
        });
    }
}

/// Auto-Type 的一步：文本 / 制表符 / 回车 / 等待
#[derive(serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TypePart {
    Text { value: String },
    Tab,
    Enter,
    Delay { ms: u64 },
}

/// 读取 .kdbx 原始字节（前端负责解密，Rust 层不理解库内容）
#[tauri::command]
fn read_vault(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("读取失败：{e}"))
}

/// KDBX 2/3/4 的文件签名（Sig1 + Sig2，小端）。KeePass 1.x 的 .kdb 不算。
const KDBX_SIG1: &[u8; 4] = b"\x03\xd9\xa2\x9a"; // 0x9AA2D903
const KDBX_SIG2: &[u8; 4] = b"\x67\xfb\x4b\xb5"; // 0xB54BFB67

fn is_kdbx(bytes: &[u8]) -> bool {
    bytes.len() >= 12 && bytes.starts_with(KDBX_SIG1) && bytes[4..8] == *KDBX_SIG2
}

/// 落盘 + fsync：rename 之前数据必须真的到盘，否则断电后可能留下空文件。
fn write_file_synced(path: &std::path::Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut file =
        std::fs::File::create(path).map_err(|e| format!("创建临时文件失败：{e}"))?;
    file.write_all(bytes)
        .map_err(|e| format!("写临时文件失败：{e}"))?;
    file.sync_all().map_err(|e| format!("刷盘失败：{e}"))?;
    Ok(())
}

/// 把磁盘上的上一版滚到 `<path>.bak`（spec §7）。
///
/// 两个前提，缺一不备份：
/// 1. 磁盘上已有的文件是合法 KDBX —— 免得把已经损坏的文件覆盖到好备份上；
/// 2. 新内容也是合法 KDBX —— write_vault 还兼职写密钥文件/CSV 导出，
///    绝不能给明文 CSV 留 `.bak` 副本。
fn backup_vault(path: &std::path::Path, new_bytes: &[u8]) -> Result<bool, String> {
    if !is_kdbx(new_bytes) {
        return Ok(false);
    }
    use std::io::Read;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("SNAP_IO".into()),
    };
    if file.metadata().map_err(|_| "SNAP_IO".to_string())?.len() > snapshots::MAX_FILE_BYTES {
        return Err("SNAP_TOO_LARGE".into());
    }
    let mut existing = Vec::new();
    file.take(snapshots::MAX_FILE_BYTES + 1).read_to_end(&mut existing)
        .map_err(|_| "SNAP_IO".to_string())?;
    if existing.len() as u64 > snapshots::MAX_FILE_BYTES {
        return Err("SNAP_TOO_LARGE".into());
    }
    if !is_kdbx(&existing) {
        return Ok(false);
    }
    let bak = std::path::PathBuf::from(format!("{}.bak", path.display()));
    let tmp = std::path::PathBuf::from(format!("{}.tmp", bak.display()));
    write_file_synced(&tmp, &existing).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e
    })?;
    std::fs::rename(&tmp, &bak).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("滚动备份失败：{e}")
    })?;
    crate::snapshots::archive_previous(path, &existing)?;
    Ok(true)
}

/// 保存：滚动备份 → 临时文件 → fsync → rename 原子替换（spec §7 铁律）
#[tauri::command]
fn write_vault(path: String, bytes: Vec<u8>, expected_stat: Option<VaultStat>) -> Result<Option<VaultStat>, String> {
    let target = std::path::PathBuf::from(&path);
    ensure_expected_vault(&path, expected_stat.as_ref())?;
    backup_vault(&target, &bytes)?;
    let tmp = std::path::PathBuf::from(format!("{path}.tmp"));
    write_file_synced(&tmp, &bytes).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e
    })?;
    let prepared_stat = stat_vault(tmp.to_string_lossy().to_string())?;
    // 乐观版本检查，不声称能排除所有非协作客户端在最后瞬间的写入。
    ensure_expected_vault(&path, expected_stat.as_ref()).map_err(|error| {
        let _ = std::fs::remove_file(&tmp);
        error
    })?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("原子替换失败：{e}")
    })?;
    Ok(Some(prepared_stat))
}

fn ensure_expected_vault(path: &str, expected: Option<&VaultStat>) -> Result<(), String> {
    if let Some(expected) = expected {
        let actual = stat_vault(path.to_string()).map_err(|_| "文件版本已变化或不可读，保存已中止".to_string())?;
        if actual.mtime_ms != expected.mtime_ms || actual.size != expected.size || actual.mtime_ns != expected.mtime_ns {
            return Err("文件版本已发生外部修改，保存已中止，请重试合并或另存副本".to_string());
        }
    }
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
    exists: bool,
    mtime_ms: u64,
    size: u64,
}

/// 查同目录滚动备份是否存在（解锁失败时判断能不能给「从备份恢复」的入口）
#[tauri::command]
fn backup_info(path: String) -> Result<BackupInfo, String> {
    let bak = format!("{path}.bak");
    match std::fs::metadata(&bak) {
        Ok(meta) => {
            let modified = meta.modified().map_err(|_| "读取备份修改时间失败".to_string())?;
            Ok(BackupInfo { exists: true, mtime_ms: modified.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0), size: meta.len() })
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BackupInfo { exists: false, mtime_ms: 0, size: 0 }),
        Err(_) => Err("读取备份文件信息失败".to_string()),
    }
}

/// 用 `.bak` 覆盖当前库。损坏的旧文件不删除，改名成 `.corrupt-<时间戳>` 留证；
/// `.bak` 本身保留（再坏一次还有得救）。
#[tauri::command]
fn restore_backup(path: String) -> Result<(), String> {
    let target = std::path::PathBuf::from(&path);
    let bak = std::path::PathBuf::from(format!("{path}.bak"));
    let bytes = std::fs::read(&bak).map_err(|e| format!("读取备份失败：{e}"))?;
    if !is_kdbx(&bytes) {
        return Err("备份文件不是有效的 KDBX，已中止恢复".into());
    }
    if target.exists() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let corrupt = std::path::PathBuf::from(format!("{path}.corrupt-{stamp}"));
        std::fs::rename(&target, &corrupt)
            .map_err(|e| format!("保留当前文件失败（可能被占用）：{e}"))?;
    }
    let tmp = std::path::PathBuf::from(format!("{path}.tmp"));
    write_file_synced(&tmp, &bytes).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e
    })?;
    std::fs::rename(&tmp, &target).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("恢复替换失败：{e}")
    })?;
    Ok(())
}

/// 把磁盘上的库另存为冲突副本（`<名字>.conflict-<时间戳>.kdbx`），返回新文件路径。
/// 用途：外部修改解不开/合不了时，先把磁盘那份原样留存下来，
/// 绝不让随后的一次落盘把「别人的版本」无声覆盖掉（spec §8.2 的兜底）。
#[tauri::command]
fn save_conflict_copy(path: String) -> Result<String, String> {
    let src = std::path::PathBuf::from(&path);
    let bytes = std::fs::read(&src).map_err(|e| format!("读取磁盘版本失败：{e}"))?;
    if bytes.is_empty() {
        return Err("磁盘版本是空文件，无需留存".into());
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("vault")
        .to_string();
    let dir = src.parent().map(|p| p.to_path_buf()).unwrap_or_default();

    // 同一秒内连续合并失败也别互相覆盖
    let mut target = dir.join(format!("{stem}.conflict-{stamp}.kdbx"));
    let mut n = 1;
    while target.exists() && n < 100 {
        target = dir.join(format!("{stem}.conflict-{stamp}-{n}.kdbx"));
        n += 1;
    }
    write_file_synced(&target, &bytes)?;
    Ok(target.display().to_string())
}

/// 用系统默认浏览器打开链接。
///
/// 只放行 http/https；因为最终经 `cmd /C start` 启动，参数会被 cmd 重新解析，
/// 所以把能起副作用的字符（引号、&、|、<、>、^、换行）和空格一律挡掉，
/// 避免用户库里的恶意 URL 变成命令执行。
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("只允许打开 http/https 链接".into());
    }
    if url.contains(' ')
        || url.chars().any(|c| {
            matches!(
                c,
                '"' | '\'' | '&' | '|' | '<' | '>' | '^' | '\r' | '\n' | '\0'
            )
        })
    {
        return Err("链接包含不支持的字符".into());
    }

    #[cfg(windows)]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("打开链接失败：{e}"))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开链接失败：{e}"))?;
    }

    Ok(())
}

/// Windows Hello 是否可用（指纹 / 人脸 / PIN 至少配了一种）
#[tauri::command]
fn hello_status() -> String {
    #[cfg(windows)]
    return with_winrt(hello::availability).to_string();
    #[cfg(not(windows))]
    "unavailable".to_string()
}

/// Store DPAPI-protected quick-unlock credentials, bound to the current vault.
#[tauri::command]
fn quick_unlock_save(window: tauri::WebviewWindow, app: tauri::AppHandle, vault_path: String, secret: Vec<u8>) -> Result<(), String> {
    require_main_window(&window)?;
    #[cfg(windows)]
    {
        let encrypted = dpapi::protect(&secret)?;
        let path = quick_unlock_file(&app)?;
        if let Some(parent) = path.parent() { std::fs::create_dir_all(parent).map_err(|e| format!("quick unlock directory: {e}"))?; }
        let mut records = read_quick_records(&path);
        if let Some(existing) = records.iter_mut().find(|r| r.vault == vault_path) { existing.data = encrypted; }
        else { records.push(QuickUnlockRecord { vault: vault_path, data: encrypted }); }
        write_quick_records(&path, &records)
    }
    #[cfg(not(windows))]
    { let _ = (app, vault_path, secret); Err("quick unlock is Windows-only".into()) }
}
#[tauri::command]
async fn quick_unlock_load(window: tauri::WebviewWindow, app: tauri::AppHandle, vault_path: String) -> Result<Vec<u8>, String> {
    require_main_window(&window)?;
    tauri::async_runtime::spawn_blocking(move || load_verified_credential(app, vault_path))
        .await.map_err(|_| "HELLO_UNAVAILABLE".to_string())?
}

fn load_verified_credential(app: tauri::AppHandle, vault_path: String) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        if with_winrt(hello::availability) != "available" { return Err("HELLO_UNAVAILABLE".into()); }
        hello_gated(
            || with_winrt(|| hello::verify("Verify quick unlock")),
            || {
                let path = quick_unlock_file(&app)?;
                let record = read_quick_records(&path).into_iter().find(|r| r.vault == vault_path)
                    .ok_or_else(|| "No quick unlock credential".to_string())?;
                dpapi::unprotect(&record.data)
            },
        )
    }
    #[cfg(not(windows))]
    { let _ = (app, vault_path); Err("HELLO_UNAVAILABLE".into()) }
}
#[tauri::command]
fn quick_unlock_exists(app: tauri::AppHandle, vault_path: String) -> bool {
    #[cfg(windows)]
    {
        let Ok(path) = quick_unlock_file(&app) else {
            return false;
        };
        read_quick_records(&path)
            .iter()
            .any(|r| r.vault == vault_path)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, vault_path);
        false
    }
}

/// 清除快速解锁密钥：vault_path 传 Some 只清该库（改密/换密钥文件），None 清全部（关功能/退出）
#[tauri::command]
fn quick_unlock_clear(window: tauri::WebviewWindow, app: tauri::AppHandle, vault_path: Option<String>) -> Result<(), String> {
    require_main_window(&window)?;
    let Ok(path) = quick_unlock_file(&app) else { return Ok(()); };
    match vault_path {
        None => match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("clear quick unlock credential: {e}")),
        },
        Some(vp) => {
            let remaining: Vec<QuickUnlockRecord> = read_quick_records(&path).into_iter().filter(|r| r.vault != vp).collect();
            write_quick_records(&path, &remaining)
        }
    }
}
#[tauri::command]
fn set_screenshot_protection(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    SCREENSHOT_PROTECT.store(enable, Ordering::SeqCst);
    #[cfg(windows)]
    {
        for label in ["main", "panel"] {
            if let Some(window) = app.get_webview_window(label) {
                // 隐藏的窗口会在 apply 里被跳过：等它 show 的时候再补
                apply_capture_protection(&window);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
    }
    Ok(())
}

// ==================== 文件 watcher（网盘同步：外部修改自动合并，spec §8） ====================

#[cfg(windows)]
mod watcher {
    use notify_debouncer_full::{new_debouncer, DebouncedEvent};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc::RecvTimeoutError;
    use std::time::Duration;
    use tauri::Emitter;

    /// 监听代数：每次 start/stop +1，旧监听线程发现自己过时就退出
    static WATCH_GEN: AtomicU64 = AtomicU64::new(0);

    /// 开始监听库文件。写入走 tmp+rename，盯文件句柄会跟走，必须盯父目录；
    /// debouncer 线程持有它保证存活，stop 靠代数失效让线程自行退出并 drop。
    pub fn start(app: tauri::AppHandle, vault_path: String) -> Result<(), String> {
        let gen = WATCH_GEN.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = std::sync::mpsc::
            channel::<Result<Vec<DebouncedEvent>, Vec<notify::Error>>>();
        // 0.7 的 handler 是 FnMut，用闭包把事件转进 channel
        let mut debouncer = new_debouncer(Duration::from_millis(600), None, move |events| {
            let _ = tx.send(events);
        })
        .map_err(|e| format!("创建文件监听器失败：{e}"))?;
        let parent = std::path::Path::new(&vault_path)
            .parent()
            .map(|p| p.to_path_buf())
            .ok_or_else(|| "库文件没有父目录".to_string())?;
        debouncer
            .watch(&parent, notify::RecursiveMode::NonRecursive)
            .map_err(|e| format!("监听目录失败：{e}"))?;

        let watch_path = std::path::PathBuf::from(&vault_path);
        std::thread::spawn(move || {
            let _keep_alive = debouncer;
            loop {
                if WATCH_GEN.load(Ordering::SeqCst) != gen {
                    return; // 换库或已停止，退出并释放 watcher
                }
                match rx.recv_timeout(Duration::from_millis(300)) {
                    Ok(Ok(events)) => {
                        let hit = events.iter().any(|ev: &DebouncedEvent| {
                            ev.paths.iter().any(|p| p.ends_with(&watch_path))
                        });
                        if hit && WATCH_GEN.load(Ordering::SeqCst) == gen {
                            let _ = app.emit("keytree:vault-changed", &vault_path);
                        }
                    }
                    Ok(Err(_)) => continue, // notify 自身的错误（如目录暂时不可见）
                    Err(RecvTimeoutError::Timeout) => continue,
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
        });
        Ok(())
    }

    pub fn stop() {
        WATCH_GEN.fetch_add(1, Ordering::SeqCst);
    }
}

/// 开始/停止监听库文件（path 传 null 停止）；外部修改会发 keytree:vault-changed 事件
#[tauri::command]
fn watch_vault(app: tauri::AppHandle, path: Option<String>) -> Result<(), String> {
    #[cfg(windows)]
    match path {
        Some(p) => watcher::start(app, p),
        None => {
            watcher::stop();
            Ok(())
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, path);
        Ok(())
    }
}

/// 库文件当前 mtime(ms) 与大小：前端用来区分「自己刚写的」和「外部改的」
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultStat {
    mtime_ms: u64,
    size: u64,
    mtime_ns: String,
}

#[tauri::command]
fn stat_vault(path: String) -> Result<VaultStat, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("读文件信息失败：{e}"))?;
    let modified = meta.modified().map_err(|_| "读取文件版本失败".to_string())?
        .duration_since(std::time::UNIX_EPOCH).map_err(|_| "读取文件版本失败".to_string())?;
    let ms = modified.as_millis() as u64;
    Ok(VaultStat {
        mtime_ms: ms,
        size: meta.len(),
        mtime_ns: modified.as_nanos().to_string(),
    })
}

// ==================== 剪贴板（排除系统历史 / 云同步） ====================

/// 写入剪贴板的密码：同时告诉 Windows「这条别进剪贴板历史、别上云」。
/// 单纯用 navigator.clipboard 做不到这一点——Win+V 里会留下一串明文历史。
#[tauri::command]
async fn copy_secret(window: tauri::WebviewWindow, app: tauri::AppHandle, text: String, clear_after_ms: Option<u64>) -> Result<secure_clipboard::CopyResult, String> {
    require_main_or_panel(&window)?;
    #[cfg(windows)]
    {
        let owner = window.hwnd().map_err(|_| "CLIPBOARD_OWNER_INVALID")?.0 as isize;
        let generation = secure_clipboard::copy_generation();
        tauri::async_runtime::spawn_blocking(move || secure_clipboard::copy(&app, owner as HWND, &text, clear_after_ms, generation))
            .await.map_err(|_| "CLIPBOARD_WRITE_FAILED".to_string())?
    }
    #[cfg(not(windows))]
    { let _ = (app, text, clear_after_ms); Err("CLIPBOARD_UNAVAILABLE".into()) }
}

#[tauri::command]
fn clear_secret_clipboard(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Result<bool, String> {
    require_main_window(&window)?;
    secure_clipboard::clear_owned(&app)
}
fn validate_type_parts(parts: &[TypePart]) -> Result<(), String> {
    if parts.len() > 256 { return Err("AUTO_TYPE_LIMIT_EXCEEDED".into()); }
    let mut text_chars = 0usize;
    let mut total_delay = 0u64;
    for part in parts {
        match part {
            TypePart::Text { value } => text_chars = text_chars.checked_add(value.chars().count()).ok_or("AUTO_TYPE_LIMIT_EXCEEDED")?,
            TypePart::Delay { ms } => {
                if *ms > 5000 { return Err("AUTO_TYPE_LIMIT_EXCEEDED".into()); }
                total_delay = total_delay.checked_add(*ms).ok_or("AUTO_TYPE_LIMIT_EXCEEDED")?;
            }
            TypePart::Tab | TypePart::Enter => {}
        }
    }
    if text_chars > 8192 || total_delay > 30000 { return Err("AUTO_TYPE_LIMIT_EXCEEDED".into()); }
    Ok(())
}

#[tauri::command]
async fn auto_type(window: tauri::WebviewWindow, app: tauri::AppHandle, parts: Vec<TypePart>) -> Result<(), String> {
    require_main_window(&window)?;
    validate_type_parts(&parts)?;
    let expected = FOREGROUND.load(Ordering::SeqCst);
    let generation = AUTO_TYPE_CANCEL.load(Ordering::SeqCst);
    // Keep the IPC/event loop responsive so cancel/system-lock can invalidate an active run.
    tauri::async_runtime::spawn_blocking(move || run_auto_type(app, parts, expected, generation))
        .await.map_err(|_| "AUTO_TYPE_FAILED".to_string())?
}

fn run_auto_type(app: tauri::AppHandle, parts: Vec<TypePart>, expected: isize, generation: u64) -> Result<(), String> {
    check_cancel_generation(generation)?;
    let _exclusive = AUTO_TYPE_MUTEX.get_or_init(|| Mutex::new(())).try_lock().map_err(|_| "AUTO_TYPE_BUSY")?;
    #[cfg(windows)]
    {
        validate_expected_window(expected)?;
        // A third-party focus change before starting is not permission to steal focus back.
        let foreground = unsafe { GetForegroundWindow() };
        if foreground.is_null() || (foreground as isize != expected && !foreground_is_ours()) {
            return Err("AUTO_TYPE_FOCUS_MISMATCH".into());
        }
        check_cancel_generation(generation)?;
        if let Some(panel) = app.get_webview_window("panel") { let _ = panel.hide(); }
        restore_foreground(expected);
        let mut wait = 180u64;
        while wait > 0 {
            if AUTO_TYPE_CANCEL.load(Ordering::SeqCst) != generation { return Err("AUTO_TYPE_CANCELLED".into()); }
            let chunk = wait.min(50);
            std::thread::sleep(std::time::Duration::from_millis(chunk));
            wait -= chunk;
            if AUTO_TYPE_CANCEL.load(Ordering::SeqCst) != generation { return Err("AUTO_TYPE_CANCELLED".into()); }
        }
        check_auto_type(expected, generation)?;
        let mut enigo = Enigo::new(&EnigoSettings::default()).map_err(|_| "AUTO_TYPE_FAILED")?;
        for part in parts {
            match part {
                TypePart::Text { value } => {
                    for ch in value.chars() {
                        check_auto_type(expected, generation)?;
                        enigo.text(&ch.to_string()).map_err(|_| "AUTO_TYPE_FAILED")?;
                        check_auto_type(expected, generation)?;
                    }
                    check_auto_type(expected, generation)?;
                }
                TypePart::Tab => {
                    check_auto_type(expected, generation)?;
                    enigo.key(Key::Tab, Direction::Click).map_err(|_| "AUTO_TYPE_FAILED")?;
                    check_auto_type(expected, generation)?;
                }
                TypePart::Enter => {
                    check_auto_type(expected, generation)?;
                    enigo.key(Key::Return, Direction::Click).map_err(|_| "AUTO_TYPE_FAILED")?;
                    check_auto_type(expected, generation)?;
                }
                TypePart::Delay { ms } => {
                    let mut remaining = ms;
                    while remaining > 0 {
                        check_auto_type(expected, generation)?;
                        let chunk = remaining.min(50);
                        std::thread::sleep(std::time::Duration::from_millis(chunk));
                        remaining -= chunk;
                        check_auto_type(expected, generation)?;
                    }
                    check_auto_type(expected, generation)?;
                }
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    { let _ = (app, parts, expected, generation); Err("AUTO_TYPE_UNAVAILABLE".into()) }
}

#[tauri::command]
fn cancel_auto_type(window: tauri::WebviewWindow) -> Result<(), String> {
    require_main_window(&window)?;
    cancel_auto_type_now();
    Ok(())
}
#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        // 窗口从隐藏恢复后补一次防截屏（隐藏期间 apply 会跳过）
        #[cfg(windows)]
        apply_capture_protection(&window);
    }
}

/// 收起快速面板
#[tauri::command]
fn hide_panel(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("panel") {
        let _ = window.hide();
    }
}

/// 显示/隐藏快速面板（也供前端在测试或按钮里手动调用）
#[tauri::command]
fn toggle_panel(app: tauri::AppHandle) {
    toggle_panel_impl(&app);
}

fn toggle_panel_impl(app: &tauri::AppHandle) {
    let Some(panel) = app.get_webview_window("panel") else {
        return;
    };
    let visible = panel.is_visible().unwrap_or(false);
    if visible {
        let _ = panel.hide();
    } else {
        // 呼出前先记下当前前台窗口，Auto-Type 要还焦点给它
        capture_foreground();
        let _ = panel.show();
        let _ = panel.set_focus();
        // 隐藏期间不设 affinity（那会让透明窗口 show 出白屏），显示后立刻补上
        #[cfg(windows)]
        apply_capture_protection(&panel);
        // 面板每次被呼出都要重新同步一遍库状态（主窗口可能刚解锁/改过数据）
        let _ = panel.emit("panel:opened", ());
        // 兜底：万一 set_focus 被系统前台规则拒绝（面板可见但没有焦点），
        // 它收不到 Focused(false) 就永远不隐藏，会在屏幕上留一个点不掉的白块。
        // 1.5 秒后仍没焦点就自己收起来——没有焦点的面板本来也没法用键盘。
        let guard = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            if let Some(p) = guard.get_webview_window("panel") {
                if p.is_visible().unwrap_or(false) && !p.is_focused().unwrap_or(false) {
                    let _ = p.hide();
                }
            }
        });
    }
}

/// 托盘状态图标：锁定 / 已解锁两枚（形状 + 颜色都不同，扫一眼就能分辨）
fn tray_state_icon(unlocked: bool) -> tauri::image::Image<'static> {
    let bytes: &'static [u8] = if unlocked {
        include_bytes!("../icons/tray-unlocked.png")
    } else {
        include_bytes!("../icons/tray-locked.png")
    };
    tauri::image::Image::from_bytes(bytes).expect("内置托盘图标损坏")
}

/// 前端报告库状态，切换托盘图标 + tooltip
#[tauri::command]
fn set_tray_state(app: tauri::AppHandle, unlocked: bool) -> Result<(), String> {
    let Some(tray) = app.tray_by_id("keytree-tray") else {
        return Ok(());
    };
    tray.set_icon(Some(tray_state_icon(unlocked)))
        .map_err(|e| format!("切换托盘图标失败：{e}"))?;
    let tip = if unlocked {
        "KeyTree · 已解锁"
    } else {
        "KeyTree · 已锁定"
    };
    tray.set_tooltip(Some(tip))
        .map_err(|e| format!("更新托盘提示失败：{e}"))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(shortcuts::ShortcutManager::new())
        .manage(audit::AuditStore::new())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed
                        && app
                            .try_state::<shortcuts::ShortcutManager>()
                            .is_some_and(|manager| manager.is_active(shortcut))
                    {
                        toggle_panel_impl(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            read_vault,
            webdav::webdav_get_config,
            webdav::webdav_save_config,
            webdav::webdav_forget_config,
            webdav::webdav_test_connection,
            webdav::webdav_prepare_sync,
            webdav::webdav_commit_sync,
            webdav::webdav_cancel_sync,
            public_header::read_public_header,
            write_vault,
            snapshots::snapshot_list,
            snapshots::snapshot_read,
            snapshots::snapshot_export,
            snapshots::snapshot_create,
            open_url,
            copy_secret,
            clear_secret_clipboard,
            auto_type,
            cancel_auto_type,
            show_main_window,
            hide_panel,
            toggle_panel,
            hello_status,
            quick_unlock_save,
            quick_unlock_load,
            quick_unlock_exists,
            quick_unlock_clear,
            set_screenshot_protection,
            watch_vault,
            stat_vault,
            backup_info,
            restore_backup,
            save_conflict_copy,
            set_tray_state,
            shortcuts::shortcut_status,
            shortcuts::shortcut_set,
            diagnostics::vault_diagnostics,
            audit::audit_status,
            audit::audit_set_enabled,
            audit::audit_clear,
            audit::audit_read,
            audit::audit_append
        ])
        .setup(move |app| {
            let app_data_dir = app.path().app_data_dir().ok();
            app.state::<shortcuts::ShortcutManager>().initialize(
                app_data_dir.as_ref().map(|dir| dir.join("shortcut-config.json")),
                |shortcut| app.global_shortcut().register(*shortcut).map_err(|_| ())
            );
            app.state::<audit::AuditStore>().initialize(app_data_dir);

            // 锁屏 / 休眠 → 事件发给前端，前端立即锁定
            #[cfg(windows)]
            syswatch::start(app.handle().clone());

            // 快速面板失焦自动收起
            if let Some(panel) = app.get_webview_window("panel") {
                let handle = panel.clone();
                panel.on_window_event(move |event| {
                    if let tauri::WindowEvent::Focused(false) = event {
                        let _ = handle.hide();
                    }
                });
            }

            // 系统托盘：显示主窗 / 锁定 / 退出（唯一正常退出入口）
            {
                use tauri::menu::{Menu, MenuItem};
                use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

                let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
                let lock = MenuItem::with_id(app, "lock", "锁定密码库", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "退出 KeyTree", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show, &lock, &quit])?;

                TrayIconBuilder::with_id("keytree-tray")
                    // 默认锁定态：启动时库是锁着的，图标如实反映
                    .icon(tray_state_icon(false))
                    .tooltip("KeyTree · 已锁定")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => show_main_window(app.clone()),
                        "lock" => {
                            cancel_auto_type_now();
                            secure_clipboard::clear_owned_best_effort(app);
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.emit("keytree:tray-lock", ());
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        // 左键单击托盘：切换主窗口显示/隐藏
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false)
                                    && window.is_focused().unwrap_or(false)
                                {
                                    let _ = window.hide();
                                } else {
                                    show_main_window(app.clone());
                                }
                            }
                        }
                    })
                    .build(app)?;
            }

            // 关闭主窗口 = 最小化到托盘（不退出）；真正退出只走托盘菜单
            if let Some(main) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                main.on_window_event(move |event| match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        let _ = handle.get_webview_window("main").map(|w| w.hide());
                    }
                    tauri::WindowEvent::Focused(false) => capture_foreground(),
                    _ => {}
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building keytree")
        .run(|app, event| {
            // 退出即弃：删掉快速解锁密钥副本（下次启动要重新输一次主密码，spec §7.1）
            if matches!(event, tauri::RunEvent::Exit) {
                cancel_auto_type_now();
                secure_clipboard::clear_owned_best_effort(app);
                #[cfg(windows)]
                if let Ok(dir) = app.path().app_data_dir() {
                    let _ = std::fs::remove_file(dir.join("quick-unlock.key"));
                }
                #[cfg(not(windows))]
                {
                    let _ = app;
                }
            }
        });
}

#[cfg(test)]
mod hello_gate_tests {
    use super::{hello_gated, validate_type_parts, TypePart, AUTO_TYPE_CANCEL, cancel_auto_type_now, check_cancel_generation};
    use std::sync::atomic::Ordering;
    use std::cell::Cell;
    #[test]
    fn auto_type_bounds_and_cancellation_are_enforced_without_os_input() {
        assert!(validate_type_parts(&[TypePart::Text { value: "x".repeat(8193) }]).is_err());
        assert!(validate_type_parts(&[TypePart::Delay { ms: 5001 }]).is_err());
        assert!(validate_type_parts(&(0..7).map(|_| TypePart::Delay { ms: 5000 }).collect::<Vec<_>>()).is_err());
        assert!(validate_type_parts(&(0..257).map(|_| TypePart::Tab).collect::<Vec<_>>()).is_err());
        assert!(validate_type_parts(&[TypePart::Text { value: "合成😀".into() }, TypePart::Delay { ms: 50 }]).is_ok());
        let generation = AUTO_TYPE_CANCEL.load(Ordering::SeqCst);
        assert!(check_cancel_generation(generation).is_ok());
        cancel_auto_type_now();
        assert!(check_cancel_generation(generation).is_err());
    }
    #[test]
    fn rejected_hello_never_calls_unprotect() {
        let called = Cell::new(false);
        let result = hello_gated(|| false, || { called.set(true); Ok(()) });
        assert_eq!(result.unwrap_err(), "HELLO_NOT_VERIFIED");
        assert!(!called.get());
    }
    #[test]
    fn verified_hello_calls_unprotect_once() {
        let calls = Cell::new(0);
        let result = hello_gated(|| true, || { calls.set(calls.get() + 1); Ok(7) });
        assert_eq!(result.unwrap(), 7);
        assert_eq!(calls.get(), 1);
    }
}
#[cfg(all(test, windows))]
mod tests {
    use super::{dpapi, is_kdbx, restore_backup, save_conflict_copy, write_vault};
    use std::path::PathBuf;

    #[test]
    fn dpapi_roundtrip() {
        let secret: Vec<u8> = "open-sesame-主密码副本".bytes().collect();
        let protected = dpapi::protect(&secret).expect("protect");
        assert_ne!(protected, secret, "DPAPI 输出必须是密文");
        let restored = dpapi::unprotect(&protected).expect("unprotect");
        assert_eq!(restored, secret, "往返必须无损");
    }

    #[test]
    fn dpapi_tamper_fails() {
        let secret: Vec<u8> = b"secret".to_vec();
        let mut protected = dpapi::protect(&secret).expect("protect");
        assert!(protected.len() > 4);
        let last = protected.len() - 1;
        protected[last] ^= 0xff;
        assert!(dpapi::unprotect(&protected).is_err(), "篡改后的密文必须解不开");
    }

    /// 带合法 KDBX 签名的假库：备份逻辑只认签名，不解析内容
    fn fake_kdbx(tag: u8) -> Vec<u8> {
        let mut v = b"\x03\xd9\xa2\x9a\x67\xfb\x4b\xb5".to_vec();
        v.extend_from_slice(&[0, 0, 0, 1]); // version
        v.push(tag);
        v
    }

    fn path(dir: &tempfile::TempDir) -> String {
        dir.path().join("vault.kdbx").to_string_lossy().to_string()
    }

    #[test]
    fn expected_version_prevents_overwriting_changed_same_size_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic-version.kdbx");
        let p = path.to_string_lossy().to_string();
        write_vault(p.clone(), fake_kdbx(1), None).unwrap();
        let mut expected = super::stat_vault(p.clone()).unwrap();
        // Simulate a version mismatch even on filesystems with coarser timestamp resolution.
        expected.mtime_ns = "stale-version".to_string();
        let before = std::fs::read(&path).unwrap();
        let error = write_vault(p.clone(), fake_kdbx(2), Some(expected)).err().unwrap();
        assert!(error.contains("保存已中止"));
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert!(!std::path::Path::new(&format!("{p}.tmp")).exists());
    }

    #[test]
    fn expected_version_accepts_current_and_rechecks_before_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic-current.kdbx");
        let p = path.to_string_lossy().to_string();
        write_vault(p.clone(), fake_kdbx(1), None).unwrap();
        let expected = super::stat_vault(p.clone()).unwrap();
        let written = write_vault(p.clone(), fake_kdbx(2), Some(expected)).unwrap().unwrap();
        let actual = super::stat_vault(p.clone()).unwrap();
        assert_eq!(written.mtime_ns, actual.mtime_ns);
        assert_eq!(written.size, actual.size);
        let expected = actual;
        std::fs::write(&path, b"changed external version").unwrap();
        assert!(super::ensure_expected_vault(&p, Some(&expected)).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"changed external version");
    }

    #[test]
    fn backup_rolls_previous_version() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);

        write_vault(p.clone(), fake_kdbx(1), None).unwrap();
        assert!(!PathBuf::from(format!("{p}.bak")).exists(), "首次写入没有上一版");

        write_vault(p.clone(), fake_kdbx(2), None).unwrap();
        let bak = std::fs::read(format!("{p}.bak")).unwrap();
        let cur = std::fs::read(&p).unwrap();
        assert_eq!(bak, fake_kdbx(1), "备份必须是上一版");
        assert_eq!(cur, fake_kdbx(2), "当前文件必须是最新版");
    }

    #[test]
    fn backup_skips_non_kdbx_writes() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        write_vault(p.clone(), fake_kdbx(1), None).unwrap();
        write_vault(p.clone(), fake_kdbx(2), None).unwrap();
        let bak_before = std::fs::read(format!("{p}.bak")).unwrap();

        // 同一个 write_vault 也用于 CSV / 密钥文件：明文绝不能留 .bak 副本
        let csv = b"name,url,username,password\nA,https://a,B,C\n".to_vec();
        write_vault(p.clone(), csv.clone(), None).unwrap();
        assert_eq!(
            std::fs::read(format!("{p}.bak")).unwrap(),
            bak_before,
            "非 KDBX 写入不得触碰备份"
        );
        assert_eq!(std::fs::read(&p).unwrap(), csv);
    }

    #[test]
    fn backup_does_not_overwrite_good_copy_with_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        write_vault(p.clone(), fake_kdbx(1), None).unwrap();
        write_vault(p.clone(), fake_kdbx(2), None).unwrap();
        let good = std::fs::read(format!("{p}.bak")).unwrap();

        // 磁盘上的文件被外部写坏：下一次保存不能拿它覆盖好备份
        std::fs::write(&p, b"garbage").unwrap();
        write_vault(p.clone(), fake_kdbx(3), None).unwrap();
        assert_eq!(std::fs::read(format!("{p}.bak")).unwrap(), good);
    }

    #[test]
    fn restore_backup_keeps_damaged_file_and_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        write_vault(p.clone(), fake_kdbx(1), None).unwrap();
        write_vault(p.clone(), fake_kdbx(2), None).unwrap();
        std::fs::write(&p, b"truncated").unwrap();

        restore_backup(p.clone()).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), fake_kdbx(1));
        assert!(is_kdbx(&std::fs::read(format!("{p}.bak")).unwrap()));

        let corrupt: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".corrupt-"))
            .collect();
        assert_eq!(corrupt.len(), 1, "损坏的文件要留证，不能直接删");
        assert_eq!(std::fs::read(corrupt[0].path()).unwrap(), b"truncated");
    }

    #[test]
    fn conflict_copy_keeps_disk_version_and_never_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        write_vault(p.clone(), fake_kdbx(1), None).unwrap();

        let first = save_conflict_copy(p.clone()).unwrap();
        assert!(first.contains(".conflict-"), "文件名要能一眼看出是冲突副本");
        assert_eq!(std::fs::read(&first).unwrap(), fake_kdbx(1));
        // 原文件必须原样留着，副本只是「另存一份」
        assert_eq!(std::fs::read(&p).unwrap(), fake_kdbx(1));

        // 同一秒内再存一次不能覆盖上一份
        let second = save_conflict_copy(p.clone()).unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(&second).unwrap(), fake_kdbx(1));
    }

    #[test]
    fn conflict_copy_refuses_empty_file() {
        let dir = tempfile::tempdir().unwrap();
        let p = path(&dir);
        std::fs::write(&p, b"").unwrap();
        assert!(save_conflict_copy(p).is_err(), "空文件没有留存价值");
    }
}
