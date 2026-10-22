use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::WebviewWindow;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileDiagnostic {
    pub exists: bool,
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConflictDiagnostic {
    pub name: String,
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct VaultDiagnostics {
    pub file: FileDiagnostic,
    pub backup: FileDiagnostic,
    pub conflicts: Vec<ConflictDiagnostic>,
    pub conflict_count: usize,
}

fn metadata(path: &Path) -> Result<FileDiagnostic, String> {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(FileDiagnostic {
                exists: false,
                mtime_ms: 0,
                size: 0,
            });
        }
        Err(_) => return Err("读取文件信息失败".to_string()),
    };
    let modified = metadata
        .modified()
        .map_err(|_| "读取文件修改时间失败".to_string())?;
    Ok(FileDiagnostic {
        exists: true,
        mtime_ms: modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .min(u64::MAX as u128) as u64,
        size: metadata.len(),
    })
}

fn collect(path: &str) -> Result<VaultDiagnostics, String> {
    let target = PathBuf::from(path);
    let file_name = target
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "库路径无效".to_string())?;
    let stem = target
        .file_stem()
        .filter(|stem| !stem.is_empty())
        .ok_or_else(|| "库路径无效".to_string())?;
    let file = metadata(&target)?;

    let mut backup_path = target.as_os_str().to_os_string();
    backup_path.push(".bak");
    let backup = metadata(Path::new(&backup_path))?;

    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    let stem = stem.to_string_lossy();
    let prefix = format!("{stem}.conflict-");
    let entries = std::fs::read_dir(parent).map_err(|_| "读取库目录失败".to_string())?;
    let mut conflicts = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|_| "读取库目录失败".to_string())?;
        let name = entry.file_name();
        let Some(name_text) = name.to_str() else {
            continue;
        };
        if !name_text.starts_with(&prefix)
            || !name_text.ends_with(".kdbx")
            || name_text.len() <= prefix.len() + ".kdbx".len()
        {
            continue;
        }
        let kind = entry
            .file_type()
            .map_err(|_| "读取库目录失败".to_string())?;
        if !kind.is_file() {
            continue;
        }
        let info = metadata(&entry.path())?;
        conflicts.push(ConflictDiagnostic {
            name: name_text.to_string(),
            mtime_ms: info.mtime_ms,
            size: info.size,
        });
    }

    conflicts.sort_by(|left, right| {
        right
            .mtime_ms
            .cmp(&left.mtime_ms)
            .then_with(|| left.name.cmp(&right.name))
    });
    let conflict_count = conflicts.len();
    conflicts.truncate(100);
    let _ = file_name;
    Ok(VaultDiagnostics {
        file,
        backup,
        conflicts,
        conflict_count,
    })
}

#[tauri::command]
pub fn vault_diagnostics(
    window: WebviewWindow,
    path: String,
) -> Result<VaultDiagnostics, String> {
    if window.label() != "main" {
        return Err("仅主窗口可调用".to_string());
    }
    if path.trim().is_empty() {
        return Err("库路径无效".to_string());
    }
    collect(&path)
}

#[cfg(test)]
mod tests {
    use super::collect;
    use std::fs;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn summaries_filter_sort_and_scan_conflicts_non_recursively() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault.kdbx");
        fs::write(&vault, b"test-only placeholder").unwrap();
        fs::write(format!("{}.bak", vault.display()), b"backup placeholder").unwrap();
        let old = dir.path().join("vault.conflict-old.kdbx");
        let new = dir.path().join("vault.conflict-new.kdbx");
        fs::write(&old, b"old").unwrap();
        thread::sleep(Duration::from_millis(5));
        fs::write(&new, b"newer").unwrap();
        fs::write(dir.path().join("other.conflict-x.kdbx"), b"unrelated").unwrap();
        fs::write(dir.path().join("vault.conflict-not-kdbx.txt"), b"ignored").unwrap();
        let nested = dir.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join("vault.conflict-nested.kdbx"), b"nested").unwrap();

        let result = collect(vault.to_str().unwrap()).unwrap();
        assert!(result.file.exists);
        assert_eq!(result.file.size, b"test-only placeholder".len() as u64);
        assert!(result.backup.exists);
        assert_eq!(result.conflict_count, 2);
        assert_eq!(result.conflicts[0].name, "vault.conflict-new.kdbx");
        assert_eq!(result.conflicts[1].name, "vault.conflict-old.kdbx");
    }

    #[test]
    fn missing_files_are_reported_but_invalid_or_unreadable_paths_are_errors() {
        let dir = tempfile::tempdir().unwrap();
        let result = collect(dir.path().join("missing.kdbx").to_str().unwrap()).unwrap();
        assert!(!result.file.exists);
        assert!(!result.backup.exists);
        assert!(result.conflicts.is_empty());
        assert!(collect("").is_err());
        assert!(collect(".").is_err());

    }

    #[test]
    fn output_is_bounded_to_one_hundred_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("v.kdbx");
        for index in 0..105 {
            fs::write(dir.path().join(format!("v.conflict-{index}.kdbx")), b"x").unwrap();
        }
        let result = collect(vault.to_str().unwrap()).unwrap();
        assert_eq!(result.conflicts.len(), 100);
        assert_eq!(result.conflict_count, 105);
    }
}
