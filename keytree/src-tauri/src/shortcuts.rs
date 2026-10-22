use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Mutex;
use tauri::{State, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

const DEFAULT_SHORTCUT: &str = "Alt+Space";
const FALLBACK_SHORTCUT: &str = "Ctrl+Alt+Space";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutStatus {
    pub requested: String,
    pub active: Option<String>,
    pub error: Option<String>,
}

#[derive(Deserialize, Serialize)]
struct ShortcutConfig {
    shortcut: String,
}

#[derive(Clone)]
struct Binding {
    shortcut: Shortcut,
    display: String,
}

#[derive(Default)]
struct Runtime {
    requested: String,
    active: Option<Binding>,
    error: Option<String>,
}

pub struct ShortcutManager {
    runtime: Mutex<Runtime>,
    config_path: Mutex<Option<PathBuf>>,
}

impl ShortcutManager {
    pub fn new() -> Self {
        Self {
            runtime: Mutex::new(Runtime::default()),
            config_path: Mutex::new(None),
        }
    }

    pub fn initialize<F>(&self, config_path: Option<PathBuf>, mut register: F)
    where
        F: FnMut(&Shortcut) -> Result<(), ()>,
    {
        *self
            .config_path
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = config_path.clone();

        let saved = config_path.as_deref().map(load_config).unwrap_or(Ok(None));
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());

        match saved {
            Ok(Some(saved)) => match parse_shortcut(&saved) {
                Ok(binding) => {
                    runtime.requested = binding.display.clone();
                    match register(&binding.shortcut) {
                        Ok(()) => runtime.active = Some(binding),
                        Err(()) => runtime.error = Some("已保存快捷键注册失败".to_string()),
                    }
                }
                Err(()) => initialize_default(
                    &mut runtime,
                    &mut register,
                    Some("快捷键配置无效"),
                ),
            },
            Ok(None) => initialize_default(&mut runtime, &mut register, None),
            Err(()) => initialize_default(
                &mut runtime,
                &mut register,
                Some("快捷键配置读取失败"),
            ),
        }
    }

    pub fn is_active(&self, shortcut: &Shortcut) -> bool {
        let runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime
            .active
            .as_ref()
            .is_some_and(|active| active.shortcut == *shortcut)
    }

    fn status(&self) -> ShortcutStatus {
        status_for(
            &self
                .runtime
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner()),
        )
    }

    fn set<FRegister, FUnregister, FPersist>(
        &self,
        input: &str,
        mut register: FRegister,
        mut unregister: FUnregister,
        mut persist: FPersist,
    ) -> ShortcutStatus
    where
        FRegister: FnMut(&Shortcut) -> Result<(), ()>,
        FUnregister: FnMut(&Shortcut) -> Result<(), ()>,
        FPersist: FnMut(&str) -> Result<(), ()>,
    {
        let mut runtime = self
            .runtime
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime.requested = input.to_string();

        let candidate = match parse_shortcut(input) {
            Ok(candidate) => candidate,
            Err(()) => {
                runtime.error = Some("快捷键格式无效".to_string());
                return status_for(&runtime);
            }
        };
        runtime.requested = candidate.display.clone();

        if runtime
            .active
            .as_ref()
            .is_some_and(|active| active.shortcut == candidate.shortcut)
        {
            runtime.error = None;
            return status_for(&runtime);
        }

        if register(&candidate.shortcut).is_err() {
            runtime.error = Some("快捷键注册失败".to_string());
            return status_for(&runtime);
        }
        if persist(&candidate.display).is_err() {
            let _ = unregister(&candidate.shortcut);
            runtime.error = Some("快捷键保存失败".to_string());
            return status_for(&runtime);
        }

        let previous = runtime.active.take();
        runtime.active = Some(candidate);
        runtime.error = None;
        if let Some(previous) = previous {
            if unregister(&previous.shortcut).is_err() {
                runtime.error = Some("旧快捷键注销失败".to_string());
            }
        }
        status_for(&runtime)
    }
}

fn status_for(runtime: &Runtime) -> ShortcutStatus {
    ShortcutStatus {
        requested: runtime.requested.clone(),
        active: runtime.active.as_ref().map(|binding| binding.display.clone()),
        error: runtime.error.clone(),
    }
}

fn parse_shortcut(input: &str) -> Result<Binding, ()> {
    if input.trim().len() > 64 || input.split('+').count() < 2 {
        return Err(());
    }
    let shortcut = Shortcut::from_str(input).map_err(|_| ())?;
    if shortcut.mods.is_empty() {
        return Err(());
    }
    let display = shortcut.to_string();
    Ok(Binding { shortcut, display })
}

fn load_config(path: &std::path::Path) -> Result<Option<String>, ()> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<ShortcutConfig>(&bytes)
            .map(|config| Some(config.shortcut))
            .map_err(|_| ()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(()),
    }
}

fn persist_config(path: &std::path::Path, shortcut: &str) -> Result<(), ()> {
    let parent = path.parent().ok_or(())?;
    std::fs::create_dir_all(parent).map_err(|_| ())?;
    let bytes = serde_json::to_vec(&ShortcutConfig {
        shortcut: shortcut.to_string(),
    })
    .map_err(|_| ())?;
    let temp = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temp)
        .map_err(|_| ())?;
    use std::io::Write;
    if file.write_all(&bytes).is_err() || file.sync_all().is_err() {
        let _ = std::fs::remove_file(&temp);
        return Err(());
    }
    drop(file);
    if std::fs::rename(&temp, path).is_err() {
        let _ = std::fs::remove_file(&temp);
        return Err(());
    }
    Ok(())
}

fn initialize_default<F>(runtime: &mut Runtime, register: &mut F, config_error: Option<&str>)
where
    F: FnMut(&Shortcut) -> Result<(), ()>,
{
    runtime.requested = DEFAULT_SHORTCUT.to_string();
    runtime.active = None;
    runtime.error = config_error.map(str::to_string);

    if let Ok(primary) = parse_shortcut(DEFAULT_SHORTCUT) {
        if register(&primary.shortcut).is_ok() {
            runtime.active = Some(primary);
            return;
        }
    }

    if let Ok(fallback) = parse_shortcut(FALLBACK_SHORTCUT) {
        if register(&fallback.shortcut).is_ok() {
            runtime.active = Some(fallback);
            runtime.error = Some(match config_error {
                Some(_) => "快捷键配置不可用，Alt+Space 注册失败，已启用 Ctrl+Alt+Space".to_string(),
                None => "Alt+Space 注册失败，已启用 Ctrl+Alt+Space".to_string(),
            });
            return;
        }
    }
    runtime.error = Some(match config_error {
        Some(_) => "快捷键配置不可用，默认快捷键注册失败".to_string(),
        None => "默认快捷键注册失败".to_string(),
    });
}

fn ensure_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("仅主窗口可调用".to_string())
    }
}

#[tauri::command]
pub fn shortcut_status(
    window: WebviewWindow,
    manager: State<'_, ShortcutManager>,
) -> Result<ShortcutStatus, String> {
    ensure_main(&window)?;
    Ok(manager.status())
}

#[tauri::command]
pub fn shortcut_set(
    window: WebviewWindow,
    app: tauri::AppHandle,
    manager: State<'_, ShortcutManager>,
    shortcut: String,
) -> Result<ShortcutStatus, String> {
    ensure_main(&window)?;
    let path = manager
        .config_path
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    Ok(manager.set(
        &shortcut,
        |candidate| app.global_shortcut().register(*candidate).map_err(|_| ()),
        |old| app.global_shortcut().unregister(*old).map_err(|_| ()),
        |normalized| match path.as_deref() {
            Some(path) => persist_config(path, normalized),
            None => Err(()),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::{parse_shortcut, persist_config, ShortcutManager};
    use std::cell::RefCell;


    #[test]
    fn invalid_input_and_bare_key_are_rejected_without_replacing_old() {
        let manager = ShortcutManager::new();
        let registered = RefCell::new(Vec::new());
        manager.set("Ctrl+Alt+Space", |s| { registered.borrow_mut().push(s.to_string()); Ok(()) }, |_| Ok(()), |_| Ok(()));
        let status = manager.set("Space", |_| panic!("bare key registered"), |_| Ok(()), |_| Ok(()));
        assert_eq!(status.active.as_deref(), Some("control+alt+Space"));
        assert_eq!(status.error.as_deref(), Some("快捷键格式无效"));
        assert!(parse_shortcut(&"x".repeat(65)).is_err());
    }

    #[test]
    fn registration_conflict_keeps_old_and_same_input_is_idempotent() {
        let manager = ShortcutManager::new();
        let calls = RefCell::new(0);
        manager.set("Ctrl+Alt+Space", |_| Ok(()), |_| Ok(()), |_| Ok(()));
        let same = manager.set("Ctrl+Alt+Space", |_| { *calls.borrow_mut() += 1; Ok(()) }, |_| Ok(()), |_| Ok(()));
        assert_eq!(*calls.borrow(), 0);
        assert_eq!(same.active.as_deref(), Some("control+alt+Space"));
        let conflict = manager.set("Ctrl+Shift+X", |_| Err(()), |_| panic!("old shortcut removed"), |_| Ok(()));
        assert_eq!(conflict.active.as_deref(), Some("control+alt+Space"));
        assert_eq!(conflict.error.as_deref(), Some("快捷键注册失败"));
    }

    #[test]
    fn persist_failure_rolls_back_new_binding_and_success_replaces_old() {
        let manager = ShortcutManager::new();
        manager.set("Ctrl+Alt+Space", |_| Ok(()), |_| Ok(()), |_| Ok(()));
        let unregistered = RefCell::new(Vec::new());
        let failed = manager.set("Ctrl+Shift+X", |_| Ok(()), |s| { unregistered.borrow_mut().push(s.to_string()); Ok(()) }, |_| Err(()));
        assert_eq!(failed.active.as_deref(), Some("control+alt+Space"));
        assert_eq!(*unregistered.borrow(), vec!["shift+control+KeyX"]);
        let replaced = manager.set("Ctrl+Shift+X", |_| Ok(()), |_| Ok(()), |_| Ok(()));
        assert_eq!(replaced.active.as_deref(), Some("shift+control+KeyX"));
        assert_eq!(replaced.error, None);
    }

    #[test]
    fn saved_shortcut_is_loaded_on_restart_and_default_falls_back_truthfully() {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("shortcut-config.json");
        let writer = ShortcutManager::new();
        let saved = writer.set("Ctrl+Shift+X", |_| Ok(()), |_| Ok(()), |value| persist_config(&config, value));
        assert_eq!(saved.active.as_deref(), Some("shift+control+KeyX"));
        let manager = ShortcutManager::new();
        manager.initialize(Some(config), |_| Ok(()));
        assert_eq!(manager.status().active.as_deref(), Some("shift+control+KeyX"));

        let fallback = ShortcutManager::new();
        fallback.initialize(None, |s| {
            if s.to_string() == "alt+Space" { Err(()) } else { Ok(()) }
        });
        let status = fallback.status();
        assert_eq!(status.active.as_deref(), Some("control+alt+Space"));
        assert!(status.error.is_some());
    }
}
