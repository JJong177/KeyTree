use std::sync::atomic::{AtomicIsize, Ordering};

use enigo::{Direction, Enigo, Key, Keyboard, Settings as EnigoSettings};
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

#[cfg(windows)]
use windows_sys::Win32::Foundation::HWND;
#[cfg(windows)]
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowThreadProcessId, SetForegroundWindow,
};

/// 呼出面板前记住的前台窗口句柄，Auto-Type 时要把焦点还回去
static FOREGROUND: AtomicIsize = AtomicIsize::new(0);

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

fn restore_foreground() {
    #[cfg(windows)]
    unsafe {
        let raw = FOREGROUND.load(Ordering::SeqCst);
        if raw != 0 {
            let _ = SetForegroundWindow(raw as HWND);
        }
    }
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
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE,
    };

    /// 从屏幕捕获中剔除窗口：截图/录屏里整块区域直接透出底下的内容（不是黑块）。
    /// 只对顶层窗口设置——DWM 剔除会覆盖整棵窗口树，WebView2 的子窗口无需单独处理；
    /// WDA_MONITOR 那种「截图黑块」太粗暴，不用；Win10 < 2004 不支持时静默放弃。
    pub fn apply(hwnd: HWND, enable: bool) {
        unsafe {
            if enable {
                SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);
            } else {
                SetWindowDisplayAffinity(hwnd, WDA_NONE);
            }
        }
    }
}

// ==================== 锁屏 / 休眠监听（隐藏消息窗口） ====================

/// 起一个隐藏窗口收系统广播：锁屏（WTS）和休眠（电源事件）→ 通知前端立即锁定。
/// 锁屏通知需要显式注册到某个窗口，所以不能偷懒用轮询。
#[cfg(windows)]
mod syswatch {
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

/// 保存：临时文件 + rename 原子替换（spec §7 铁律，任何中断不损坏原库）
#[tauri::command]
fn write_vault(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let tmp = format!("{path}.tmp");
    std::fs::write(&tmp, &bytes).map_err(|e| format!("写临时文件失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("原子替换失败：{e}")
    })
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

/// 弹出 Windows Hello 验证；true = 通过。验证通过才允许读快速解锁密钥。
#[tauri::command]
fn hello_verify(prompt: String) -> bool {
    #[cfg(windows)]
    return with_winrt(|| hello::verify(&prompt));
    #[cfg(not(windows))]
    {
        let _ = prompt;
        false
    }
}

/// 存快速解锁凭据：DPAPI 加密后写 AppData，绑定库路径（多库 = 每库一条记录）
#[tauri::command]
fn quick_unlock_save(
    app: tauri::AppHandle,
    vault_path: String,
    secret: Vec<u8>,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        let encrypted = dpapi::protect(&secret)?;
        let path = quick_unlock_file(&app)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建 AppData 目录失败：{e}"))?;
        }
        let mut records = read_quick_records(&path);
        if let Some(existing) = records.iter_mut().find(|r| r.vault == vault_path) {
            existing.data = encrypted;
        } else {
            records.push(QuickUnlockRecord {
                vault: vault_path,
                data: encrypted,
            });
        }
        write_quick_records(&path, &records)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, vault_path, secret);
        Err("快速解锁仅支持 Windows".into())
    }
}

/// 读回快速解锁凭据：要求库路径匹配 + DPAPI 能解开（换账户/换机器会失败）
#[tauri::command]
fn quick_unlock_load(app: tauri::AppHandle, vault_path: String) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        let path = quick_unlock_file(&app)?;
        let record = read_quick_records(&path)
            .into_iter()
            .find(|r| r.vault == vault_path)
            .ok_or_else(|| "没有快速解锁密钥".to_string())?;
        dpapi::unprotect(&record.data)
    }
    #[cfg(not(windows))]
    {
        let _ = (app, vault_path);
        Err("快速解锁仅支持 Windows".into())
    }
}

/// 是否已有这个库的快速解锁密钥（只查存在性，不解密）
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
fn quick_unlock_clear(app: tauri::AppHandle, vault_path: Option<String>) -> Result<(), String> {
    let Ok(path) = quick_unlock_file(&app) else {
        return Ok(());
    };
    match vault_path {
        None => match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("清除快速解锁密钥失败：{e}")),
        },
        Some(vp) => {
            let records = read_quick_records(&path);
            let remaining: Vec<QuickUnlockRecord> = records
                .into_iter()
                .filter(|r| r.vault != vp)
                .collect();
            write_quick_records(&path, &remaining)
        }
    }
}

/// 窗口防截屏：主窗口 + 快速面板一起开/关；截图里整块区域透明（透出底下内容）
#[tauri::command]
fn set_screenshot_protection(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        for label in ["main", "panel"] {
            if let Some(window) = app.get_webview_window(label) {
                if let Ok(hwnd) = window.hwnd() {
                    capture::apply(hwnd.0, enable);
                }
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, enable);
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
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultStat {
    mtime_ms: u64,
    size: u64,
}

#[tauri::command]
fn stat_vault(path: String) -> Result<VaultStat, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("读文件信息失败：{e}"))?;
    let ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(VaultStat {
        mtime_ms: ms,
        size: meta.len(),
    })
}

/// 自动输入：先收起面板、把焦点还给上一个前台窗口，再按序列敲键。
#[tauri::command]
fn auto_type(app: tauri::AppHandle, parts: Vec<TypePart>) -> Result<(), String> {
    if let Some(panel) = app.get_webview_window("panel") {
        let _ = panel.hide();
    }
    restore_foreground();
    // 给系统一点时间完成焦点切换，否则最前面几个字符会丢
    std::thread::sleep(std::time::Duration::from_millis(180));

    let mut enigo =
        Enigo::new(&EnigoSettings::default()).map_err(|e| format!("初始化按键注入失败：{e}"))?;

    for part in parts {
        match part {
            TypePart::Text { value } => enigo
                .text(&value)
                .map_err(|e| format!("输入文本失败：{e}"))?,
            TypePart::Tab => enigo
                .key(Key::Tab, Direction::Click)
                .map_err(|e| format!("发送 Tab 失败：{e}"))?,
            TypePart::Enter => enigo
                .key(Key::Return, Direction::Click)
                .map_err(|e| format!("发送回车失败：{e}"))?,
            TypePart::Delay { ms } => {
                std::thread::sleep(std::time::Duration::from_millis(ms.min(5000)))
            }
        }
    }
    Ok(())
}

/// 显示并聚焦主窗口（快速面板里「在主界面定位」用）
#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
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
        // 面板每次被呼出都要重新同步一遍库状态（主窗口可能刚解锁/改过数据）
        let _ = panel.emit("panel:opened", ());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Alt+Space：失败时（被 PowerToys 之类占用）退到 Ctrl+Alt+Space
    let primary = Shortcut::new(Some(Modifiers::ALT), Code::Space);
    let fallback = Shortcut::new(
        Some(Modifiers::ALT | Modifiers::CONTROL),
        Code::Space,
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed
                        && (shortcut == &primary || shortcut == &fallback)
                    {
                        toggle_panel_impl(app);
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            read_vault,
            write_vault,
            open_url,
            auto_type,
            show_main_window,
            hide_panel,
            toggle_panel,
            hello_status,
            hello_verify,
            quick_unlock_save,
            quick_unlock_load,
            quick_unlock_exists,
            quick_unlock_clear,
            set_screenshot_protection,
            watch_vault,
            stat_vault
        ])
        .setup(move |app| {
            if app.global_shortcut().register(primary.clone()).is_err() {
                eprintln!("[keytree] Alt+Space 注册失败，改用 Ctrl+Alt+Space");
                if let Err(err) = app.global_shortcut().register(fallback.clone()) {
                    eprintln!("[keytree] 全局快捷键注册失败：{err}");
                }
            }

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
                    .icon(app.default_window_icon().expect("no tray icon").clone())
                    .tooltip("KeyTree")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.unminimize();
                                let _ = window.set_focus();
                            }
                        }
                        "lock" => {
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
                                    let _ = window.show();
                                    let _ = window.unminimize();
                                    let _ = window.set_focus();
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

#[cfg(all(test, windows))]
mod tests {
    use super::dpapi;

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
}
