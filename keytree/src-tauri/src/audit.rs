use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{State, WebviewWindow};

const MAX_EVENTS: usize = 10_000;
const RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1_000;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuditStatus {
    pub enabled: bool,
    pub epoch: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuditEvent {
    pub kind: String,
    pub entry_uuid: Option<String>,
    pub at: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AuditRead {
    pub enabled: bool,
    pub epoch: u64,
    pub events: Vec<AuditEvent>,
}

#[derive(Deserialize, Serialize)]
struct AuditConfig {
    enabled: bool,
}

struct Runtime {
    root: Option<PathBuf>,
    enabled: bool,
    epoch: u64,
}

pub struct AuditStore {
    runtime: Mutex<Runtime>,
}

impl AuditStore {
    pub fn new() -> Self {
        Self::with_state(None, current_time_ms())
    }

    fn with_state(root: Option<PathBuf>, now: u64) -> Self {
        let enabled = root
            .as_deref()
            .and_then(load_config)
            .unwrap_or(false);
        Self {
            runtime: Mutex::new(Runtime {
                root,
                enabled,
                epoch: safe_time(now),
            }),
        }
    }

    pub fn initialize(&self, root: Option<PathBuf>) {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime.enabled = root
            .as_deref()
            .and_then(load_config)
            .unwrap_or(false);
        runtime.root = root;
    }

    fn status(&self) -> AuditStatus {
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        status_for(&runtime)
    }

    fn set_enabled(&self, enabled: bool) -> Result<AuditStatus, String> {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if runtime.enabled == enabled {
            return Ok(status_for(&runtime));
        }
        let path = config_path(&runtime)?;
        write_json_atomic(&path, &AuditConfig { enabled })?;
        runtime.enabled = enabled;
        runtime.epoch = next_epoch(runtime.epoch);
        Ok(status_for(&runtime))
    }

    fn clear(&self) -> Result<AuditStatus, String> {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let path = events_path(&runtime)?;
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("审计数据清理失败".to_string()),
        }
        runtime.epoch = next_epoch(runtime.epoch);
        Ok(status_for(&runtime))
    }

    fn read_at(&self, now: u64) -> Result<AuditRead, String> {
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (events, changed, existed) = read_events(&runtime, now)?;
        if changed && existed {
            let path = events_path(&runtime)?;
            write_json_atomic(&path, &events)?;
        }
        Ok(AuditRead {
            enabled: runtime.enabled,
            epoch: runtime.epoch,
            events,
        })
    }

    fn append_at(
        &self,
        kind: &str,
        entry_uuid: Option<&str>,
        epoch: u64,
        now: u64,
    ) -> Result<bool, String> {
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (mut events, changed, existed) = read_events(&runtime, now)?;
        if changed && existed {
            let path = events_path(&runtime)?;
            write_json_atomic(&path, &events)?;
        }
        if !runtime.enabled
            || runtime.epoch != epoch
            || !valid_event(kind, entry_uuid)
        {
            return Ok(false);
        }
        events.push(AuditEvent {
            kind: kind.to_string(),
            entry_uuid: entry_uuid.map(str::to_string),
            at: safe_time(now),
        });
        if events.len() > MAX_EVENTS {
            let excess = events.len() - MAX_EVENTS;
            events.drain(0..excess);
        }
        let path = events_path(&runtime)?;
        write_json_atomic(&path, &events)?;
        Ok(true)
    }
}

fn status_for(runtime: &Runtime) -> AuditStatus {
    AuditStatus {
        enabled: runtime.enabled,
        epoch: runtime.epoch,
    }
}

fn safe_time(now: u64) -> u64 {
    now.min(MAX_SAFE_INTEGER)
}

fn next_epoch(epoch: u64) -> u64 {
    epoch.saturating_add(1).min(MAX_SAFE_INTEGER)
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(MAX_SAFE_INTEGER as u128) as u64
}

fn load_config(root: &Path) -> Option<bool> {
    let bytes = std::fs::read(root.join("audit-config.json")).ok()?;
    serde_json::from_slice::<AuditConfig>(&bytes)
        .ok()
        .map(|config| config.enabled)
}

fn config_path(runtime: &Runtime) -> Result<PathBuf, String> {
    runtime
        .root
        .as_ref()
        .map(|root| root.join("audit-config.json"))
        .ok_or_else(|| "审计存储不可用".to_string())
}

fn events_path(runtime: &Runtime) -> Result<PathBuf, String> {
    runtime
        .root
        .as_ref()
        .map(|root| root.join("audit-events.json"))
        .ok_or_else(|| "审计存储不可用".to_string())
}

fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "审计存储写入失败".to_string())?;
    std::fs::create_dir_all(parent).map_err(|_| "审计存储写入失败".to_string())?;
    let bytes = serde_json::to_vec(value).map_err(|_| "审计存储写入失败".to_string())?;
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)
        .map_err(|_| "审计存储写入失败".to_string())?;
    use std::io::Write;
    if file.write_all(&bytes).is_err() || file.sync_all().is_err() {
        let _ = std::fs::remove_file(&temp);
        return Err("审计存储写入失败".to_string());
    }
    drop(file);
    if std::fs::rename(&temp, path).is_err() {
        let _ = std::fs::remove_file(&temp);
        return Err("审计存储写入失败".to_string());
    }
    Ok(())
}

fn read_events(runtime: &Runtime, now: u64) -> Result<(Vec<AuditEvent>, bool, bool), String> {
    let path = events_path(runtime)?;
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((Vec::new(), false, false));
        }
        Err(_) => return Err("审计数据读取失败".to_string()),
    };
    let original = serde_json::from_slice::<Vec<AuditEvent>>(&bytes)
        .map_err(|_| "审计数据读取失败".to_string())?;
    let original_len = original.len();
    let now = safe_time(now);
    let mut events = original
        .into_iter()
        .filter(|event| {
            event.at <= now
                && now.saturating_sub(event.at) <= RETENTION_MS
                && valid_event(&event.kind, event.entry_uuid.as_deref())
        })
        .collect::<Vec<_>>();
    if events.len() > MAX_EVENTS {
        let excess = events.len() - MAX_EVENTS;
        events.drain(0..excess);
    }
    let changed = events.len() != original_len;
    Ok((events, changed, true))
}

fn valid_event(kind: &str, entry_uuid: Option<&str>) -> bool {
    if !matches!(kind, "unlock" | "copy-password" | "auto-type" | "merge") {
        return false;
    }
    match entry_uuid {
        Some(uuid) => valid_uuid(uuid),
        None => matches!(kind, "unlock" | "merge"),
    }
}

fn valid_uuid(value: &str) -> bool {
    if value.len() == 36 {
        let bytes = value.as_bytes();
        return [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
            && bytes
                .iter()
                .enumerate()
                .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit());
    }

    let bytes = value.as_bytes();
    if bytes.len() != 24 || &bytes[22..] != b"==" {
        return false;
    }
    if !bytes[..22]
        .iter()
        .all(|byte| byte.is_ascii_alphanumeric() || *byte == b'+' || *byte == b'/')
    {
        return false;
    }
    base64_value(bytes[21]).is_some_and(|last| last & 0x0f == 0)
}

fn base64_value(byte: u8) -> Option<u8> {
    match byte {
        b'A'..=b'Z' => Some(byte - b'A'),
        b'a'..=b'z' => Some(byte - b'a' + 26),
        b'0'..=b'9' => Some(byte - b'0' + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

fn ensure_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("仅主窗口可调用".to_string())
    }
}

#[tauri::command]
pub fn audit_status(
    window: WebviewWindow,
    store: State<'_, AuditStore>,
) -> Result<AuditStatus, String> {
    ensure_main(&window)?;
    Ok(store.status())
}

#[tauri::command]
pub fn audit_set_enabled(
    window: WebviewWindow,
    store: State<'_, AuditStore>,
    enabled: bool,
) -> Result<AuditStatus, String> {
    ensure_main(&window)?;
    store.set_enabled(enabled)
}

#[tauri::command]
pub fn audit_clear(
    window: WebviewWindow,
    store: State<'_, AuditStore>,
) -> Result<AuditStatus, String> {
    ensure_main(&window)?;
    store.clear()
}

#[tauri::command]
pub fn audit_read(
    window: WebviewWindow,
    store: State<'_, AuditStore>,
) -> Result<AuditRead, String> {
    ensure_main(&window)?;
    store.read_at(current_time_ms())
}

#[tauri::command]
pub fn audit_append(
    window: WebviewWindow,
    store: State<'_, AuditStore>,
    kind: String,
    entry_uuid: Option<String>,
    epoch: u64,
) -> Result<bool, String> {
    ensure_main(&window)?;
    store.append_at(&kind, entry_uuid.as_deref(), epoch, current_time_ms())
}

#[cfg(test)]
mod tests {
    use super::{AuditEvent, AuditStore, MAX_SAFE_INTEGER, RETENTION_MS};
    use std::fs;

    const NOW: u64 = 1_700_000_000_000;
    const VALID_B64: &str = "AAAAAAAAAAAAAAAAAAAAAA==";
    const VALID_UUID: &str = "550e8400-e29b-41d4-a716-446655440000";

    fn store(root: &std::path::Path) -> AuditStore {
        AuditStore::with_state(Some(root.to_path_buf()), NOW)
    }

    #[test]
    fn default_status_and_read_do_not_create_event_file() {
        let dir = tempfile::tempdir().unwrap();
        let audit = store(dir.path());
        assert_eq!(audit.status().enabled, false);
        assert!(audit.status().epoch <= MAX_SAFE_INTEGER);
        assert!(audit.read_at(NOW).unwrap().events.is_empty());
        assert!(!dir.path().join("audit-events.json").exists());
    }

    #[test]
    fn preferences_persist_and_clear_invalidates_old_epoch() {
        let dir = tempfile::tempdir().unwrap();
        let audit = store(dir.path());
        let initial = audit.status();
        let enabled = audit.set_enabled(true).unwrap();
        assert!(enabled.enabled);
        assert!(enabled.epoch > initial.epoch);
        assert!(dir.path().join("audit-config.json").exists());
        assert!(audit.append_at("unlock", None, enabled.epoch, NOW).unwrap());
        assert!(dir.path().join("audit-events.json").exists());

        let restarted = store(dir.path());
        assert!(restarted.status().enabled);
        assert_ne!(restarted.status().epoch, enabled.epoch);
        let cleared = audit.clear().unwrap();
        assert!(cleared.enabled);
        assert!(cleared.epoch > enabled.epoch);
        assert!(!audit.append_at("unlock", None, enabled.epoch, NOW).unwrap());
        assert!(!dir.path().join("audit-events.json").exists());
        let disabled = audit.set_enabled(false).unwrap();
        assert!(!disabled.enabled);
        assert!(disabled.epoch > cleared.epoch);
        assert!(!store(dir.path()).status().enabled);
    }

    #[test]
    fn reads_prune_expired_and_future_events() {
        let dir = tempfile::tempdir().unwrap();
        let audit = store(dir.path());
        audit.set_enabled(true).unwrap();
        let path = dir.path().join("audit-events.json");
        let events = vec![
            AuditEvent { kind: "unlock".into(), entry_uuid: None, at: NOW - RETENTION_MS - 1 },
            AuditEvent { kind: "unlock".into(), entry_uuid: None, at: NOW + 10 },
            AuditEvent { kind: "unlock".into(), entry_uuid: None, at: NOW - 100 },
        ];
        fs::write(&path, serde_json::to_vec(&events).unwrap()).unwrap();
        let read = audit.read_at(NOW).unwrap();
        assert_eq!(read.events.len(), 1);
        assert_eq!(read.events[0].at, NOW - 100);
        let persisted: Vec<AuditEvent> = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(persisted.len(), 1);
    }

    #[test]
    fn kind_and_uuid_are_allowlisted_and_validated() {
        let dir = tempfile::tempdir().unwrap();
        let audit = store(dir.path());
        let epoch = audit.set_enabled(true).unwrap().epoch;
        assert!(!audit.append_at("password", None, epoch, NOW).unwrap());
        assert!(!audit.append_at("copy-password", Some("not an id"), epoch, NOW).unwrap());
        assert!(!audit.append_at("auto-type", None, epoch, NOW).unwrap());
        assert!(audit.append_at("copy-password", Some(VALID_B64), epoch, NOW).unwrap());
        assert!(audit.append_at("auto-type", Some(VALID_UUID), epoch, NOW).unwrap());
        assert!(audit.append_at("merge", None, epoch, NOW).unwrap());
        let events = audit.read_at(NOW).unwrap().events;
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn corrupt_events_return_generic_error_and_clear_recovers_other_operations() {
        let dir = tempfile::tempdir().unwrap();
        let audit = store(dir.path());
        fs::write(dir.path().join("audit-events.json"), b"secret-looking malformed contents").unwrap();
        assert_eq!(audit.read_at(NOW).unwrap_err(), "审计数据读取失败");
        assert_eq!(audit.status().enabled, false);
        let switched = audit.set_enabled(true).unwrap();
        assert!(switched.enabled);
        let cleared = audit.clear().unwrap();
        assert!(cleared.enabled);
        assert!(audit.read_at(NOW).unwrap().events.is_empty());
    }

    #[test]
    fn uuid_syntax_rejects_arbitrary_text_and_malformed_base64() {
        assert!(!super::valid_uuid("abcdefghijklmnop"));
        assert!(!super::valid_uuid("AAAAAAAAAAAAAAAAAAAAAB=="));
        assert!(super::valid_uuid(VALID_B64));
        assert!(super::valid_uuid(VALID_UUID));
    }
}
