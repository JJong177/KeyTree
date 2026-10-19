#[tauri::command]
fn greet(name: &str) -> String {
    format!("你好，{}！Rust IPC 已通。", name)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![greet, read_vault, write_vault])
        .run(tauri::generate_context!())
        .expect("error while running keylite");
}
