use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_COUNT: usize = 30;
const MAX_TOTAL_BYTES: u64 = 268_435_456;
pub(crate) const MAX_FILE_BYTES: u64 = 67_108_864;
const MAX_SCAN_ENTRIES: usize = 512;
const SNAP_IO: &str = "SNAP_IO";
const SNAP_TOO_LARGE: &str = "SNAP_TOO_LARGE";
const SNAP_CHANGED: &str = "SNAP_CHANGED";
const SNAP_INVALID_ID: &str = "SNAP_INVALID_ID";
const SNAP_INVALID_FILE: &str = "SNAP_INVALID_FILE";
const SNAP_TARGET_EXISTS: &str = "SNAP_TARGET_EXISTS";
const SNAP_UNSUPPORTED: &str = "SNAP_UNSUPPORTED";

static SNAPSHOT_MUTEX: OnceLock<Mutex<()>> = OnceLock::new();
static NEXT_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotStat {
    pub mtime_ms: u64,
    pub size: u64,
    pub mtime_ns: String,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    pub id: String,
    pub created_at: u64,
    pub size: u64,
    pub stat: SnapshotStat,
}

#[derive(serde::Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotListResponse {
    pub items: Vec<SnapshotInfo>,
    pub max_count: usize,
    pub max_total_bytes: u64,
}

struct DiskSnapshot {
    id: String,
    created_ns: u128,
    counter: u64,
    stat: SnapshotStat,
}

fn write_lock() -> Result<MutexGuard<'static, ()>, String> {
    SNAPSHOT_MUTEX
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| SNAP_IO.to_string())
}

fn reject_reparse_flags(is_symlink: bool, is_reparse: bool) -> Result<(), String> {
    if is_symlink || is_reparse {
        Err(SNAP_UNSUPPORTED.into())
    } else {
        Ok(())
    }
}

fn check_reparse(meta: &Metadata) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        reject_reparse_flags(
            meta.file_type().is_symlink(),
            meta.file_attributes() & 0x400 != 0,
        )
    }
    #[cfg(not(windows))]
    {
        reject_reparse_flags(meta.file_type().is_symlink(), false)
    }
}

fn canonical_vault(path: &Path) -> Result<PathBuf, String> {
    let canonical = fs::canonicalize(path).map_err(|_| SNAP_IO.to_string())?;
    let meta = fs::symlink_metadata(&canonical).map_err(|_| SNAP_IO.to_string())?;
    check_reparse(&meta)?;
    if !meta.is_file() {
        return Err(SNAP_INVALID_FILE.into());
    }
    Ok(canonical)
}

fn backup_root(vault: &Path) -> PathBuf {
    let mut name = vault.as_os_str().to_os_string();
    name.push(".keytree-backups");
    PathBuf::from(name)
}

fn root_for_vault(path: &Path) -> Result<PathBuf, String> {
    Ok(backup_root(&canonical_vault(path)?))
}

fn check_root(root: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(root).map_err(|_| SNAP_IO.to_string())?;
    check_reparse(&meta)?;
    if !meta.is_dir() {
        return Err(SNAP_INVALID_FILE.into());
    }
    Ok(())
}

fn ensure_root(root: &Path) -> Result<(), String> {
    match fs::create_dir(root) {
        Ok(()) => check_root(root),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => check_root(root),
        Err(_) => Err(SNAP_IO.into()),
    }
}

fn snapshot_stat(meta: &Metadata) -> Result<SnapshotStat, String> {
    let modified = meta.modified().map_err(|_| SNAP_IO.to_string())?;
    let elapsed = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SNAP_IO.to_string())?;
    Ok(SnapshotStat {
        mtime_ms: elapsed
            .as_millis()
            .try_into()
            .map_err(|_| SNAP_IO.to_string())?,
        size: meta.len(),
        mtime_ns: elapsed.as_nanos().to_string(),
    })
}

fn snapshot_file_stat(path: &Path) -> Result<SnapshotStat, String> {
    let meta = fs::symlink_metadata(path).map_err(|_| SNAP_IO.to_string())?;
    check_reparse(&meta)?;
    if !meta.is_file() {
        return Err(SNAP_INVALID_FILE.into());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(SNAP_TOO_LARGE.into());
    }
    snapshot_stat(&meta)
}

fn matches_expected(actual: &SnapshotStat, expected: &crate::VaultStat) -> bool {
    actual.mtime_ms == expected.mtime_ms
        && actual.size == expected.size
        && actual.mtime_ns == expected.mtime_ns
}

fn parse_snapshot_id(id: &str) -> Result<(u128, u64), String> {
    let body = id
        .strip_prefix("snapshot-")
        .and_then(|value| value.strip_suffix(".kdbx"))
        .ok_or_else(|| SNAP_INVALID_ID.to_string())?;
    let (created, counter) = body
        .split_once('-')
        .ok_or_else(|| SNAP_INVALID_ID.to_string())?;
    if created.is_empty()
        || counter.is_empty()
        || !created.bytes().all(|b| b.is_ascii_digit())
        || !counter.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(SNAP_INVALID_ID.into());
    }
    let ns = created
        .parse::<u128>()
        .map_err(|_| SNAP_INVALID_ID.to_string())?;
    let n = counter
        .parse::<u64>()
        .map_err(|_| SNAP_INVALID_ID.to_string())?;
    if ns == 0 || n == 0 || ns.to_string() != created || n.to_string() != counter {
        return Err(SNAP_INVALID_ID.into());
    }
    Ok((ns, n))
}

fn info_from_disk(snapshot: &DiskSnapshot) -> Result<SnapshotInfo, String> {
    Ok(SnapshotInfo {
        id: snapshot.id.clone(),
        created_at: (snapshot.created_ns / 1_000_000)
            .try_into()
            .map_err(|_| SNAP_IO.to_string())?,
        size: snapshot.stat.size,
        stat: snapshot.stat.clone(),
    })
}

fn scan_owned(root: &Path) -> Result<Vec<DiskSnapshot>, String> {
    check_root(root)?;
    let mut snapshots = Vec::new();
    let mut scanned = 0;
    for entry in fs::read_dir(root).map_err(|_| SNAP_IO.to_string())? {
        let entry = entry.map_err(|_| SNAP_IO.to_string())?;
        scanned += 1;
        if scanned > MAX_SCAN_ENTRIES {
            return Err(SNAP_IO.into());
        }
        let Some(id) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Ok((created_ns, counter)) = parse_snapshot_id(&id) else {
            continue;
        };
        let stat = snapshot_file_stat(&root.join(&id))?;
        snapshots.push(DiskSnapshot {
            id,
            created_ns,
            counter,
            stat,
        });
    }
    snapshots.sort_by(|a, b| {
        b.created_ns
            .cmp(&a.created_ns)
            .then_with(|| b.counter.cmp(&a.counter))
    });
    Ok(snapshots)
}

#[cfg(windows)]
fn open_read_no_follow(path: &Path) -> Result<File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(0x0020_0000) // FILE_FLAG_OPEN_REPARSE_POINT
        .open(path)
        .map_err(|_| open_error(path))
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn open_read_no_follow(path: &Path) -> Result<File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(0x0002_0000) // O_NOFOLLOW
        .open(path)
        .map_err(|_| open_error(path))
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "dragonfly",
    target_os = "netbsd"
))]
fn open_read_no_follow(path: &Path) -> Result<File, String> {
    use std::os::unix::fs::OpenOptionsExt;
    OpenOptions::new()
        .read(true)
        .custom_flags(0x0000_0100) // O_NOFOLLOW
        .open(path)
        .map_err(|_| open_error(path))
}

#[cfg(not(any(
    windows,
    target_os = "linux",
    target_os = "android",
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "openbsd",
    target_os = "dragonfly",
    target_os = "netbsd"
)))]
fn open_read_no_follow(_path: &Path) -> Result<File, String> {
    Err(SNAP_UNSUPPORTED.into())
}

fn open_error(path: &Path) -> String {
    if fs::symlink_metadata(path).is_ok_and(|meta| check_reparse(&meta).is_err()) {
        SNAP_UNSUPPORTED.into()
    } else {
        SNAP_IO.into()
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct FileIdentity(u64, u64);

#[cfg(windows)]
fn file_identity(file: &File) -> Result<FileIdentity, String> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct HandleInformation {
        attributes: u32,
        creation: [u32; 2],
        access: [u32; 2],
        write: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(
            handle: *mut std::ffi::c_void,
            info: *mut HandleInformation,
        ) -> i32;
    }
    let mut info = std::mem::MaybeUninit::<HandleInformation>::uninit();
    // The live File owns this handle; the API initializes the full structure on success.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err(SNAP_IO.into());
    }
    let info = unsafe { info.assume_init() };
    Ok(FileIdentity(
        info.volume as u64,
        ((info.index_high as u64) << 32) | info.index_low as u64,
    ))
}

#[cfg(unix)]
fn file_identity(file: &File) -> Result<FileIdentity, String> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata().map_err(|_| SNAP_IO.to_string())?;
    Ok(FileIdentity(meta.dev(), meta.ino()))
}

#[cfg(not(any(windows, unix)))]
fn file_identity(_file: &File) -> Result<FileIdentity, String> {
    Err(SNAP_UNSUPPORTED.into())
}

fn path_identity(path: &Path) -> Result<FileIdentity, String> {
    let file = open_read_no_follow(path)?;
    let meta = file.metadata().map_err(|_| SNAP_IO.to_string())?;
    check_reparse(&meta)?;
    if !meta.is_file() {
        return Err(SNAP_INVALID_FILE.into());
    }
    file_identity(&file)
}

fn remove_owned_file(path: &Path, identity: &FileIdentity) {
    if path_identity(path).is_ok_and(|current| current == *identity) {
        let _ = fs::remove_file(path);
    }
}

fn read_bounded(path: &Path) -> Result<(Vec<u8>, SnapshotStat, FileIdentity), String> {
    let mut file = open_read_no_follow(path)?;
    let before_meta = file.metadata().map_err(|_| SNAP_IO.to_string())?;
    check_reparse(&before_meta)?;
    if !before_meta.is_file() {
        return Err(SNAP_INVALID_FILE.into());
    }
    if before_meta.len() > MAX_FILE_BYTES {
        return Err(SNAP_TOO_LARGE.into());
    }
    let before = snapshot_stat(&before_meta)?;
    let identity = file_identity(&file)?;
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| SNAP_IO.to_string())?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(SNAP_TOO_LARGE.into());
    }
    if bytes.len() as u64 != before.size {
        return Err(SNAP_CHANGED.into());
    }
    let after_meta = file.metadata().map_err(|_| SNAP_IO.to_string())?;
    check_reparse(&after_meta)?;
    let after = snapshot_stat(&after_meta)?;
    if before != after || identity != file_identity(&file)? {
        return Err(SNAP_CHANGED.into());
    }
    Ok((bytes, after, identity))
}

fn read_snapshot(root: &Path, id: &str, expected: &crate::VaultStat) -> Result<Vec<u8>, String> {
    parse_snapshot_id(id)?;
    check_root(root)?;
    let path = root.join(id);
    let before_meta = fs::symlink_metadata(&path).map_err(|_| SNAP_IO.to_string())?;
    check_reparse(&before_meta)?;
    let before = snapshot_stat(&before_meta)?;
    if !matches_expected(&before, expected) {
        return Err(SNAP_CHANGED.into());
    }
    let before_identity = path_identity(&path)?;
    let (bytes, opened_stat, opened_identity) = read_bounded(&path)?;
    let after_meta = fs::symlink_metadata(&path).map_err(|_| SNAP_IO.to_string())?;
    check_reparse(&after_meta)?;
    let after = snapshot_stat(&after_meta)?;
    if !matches_expected(&after, expected)
        || before != after
        || before != opened_stat
        || before_identity != opened_identity
        || path_identity(&path)? != opened_identity
    {
        return Err(SNAP_CHANGED.into());
    }
    if !crate::is_kdbx(&bytes) {
        return Err(SNAP_INVALID_FILE.into());
    }
    Ok(bytes)
}

fn current_time_ns() -> Result<u128, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| SNAP_IO.to_string())?
        .as_nanos())
}

fn create_snapshot(root: &Path, bytes: &[u8]) -> Result<DiskSnapshot, String> {
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(SNAP_TOO_LARGE.into());
    }
    if !crate::is_kdbx(bytes) {
        return Err(SNAP_INVALID_FILE.into());
    }
    let created_ns = current_time_ns()?;
    for _ in 0..MAX_SCAN_ENTRIES {
        let counter = NEXT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let id = format!("snapshot-{created_ns}-{counter}.kdbx");
        let path = root.join(&id);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(SNAP_IO.into()),
        };
        if file.write_all(bytes).and_then(|_| file.sync_all()).is_err() {
            let identity = file_identity(&file).ok();
            drop(file);
            if let Some(identity) = identity.as_ref() {
                remove_owned_file(&path, identity);
            }
            return Err(SNAP_IO.into());
        }
        let identity = file_identity(&file)?;
        drop(file);
        let stat = match snapshot_file_stat(&path) {
            Ok(stat) => stat,
            Err(error) => {
                remove_owned_file(&path, &identity);
                return Err(error);
            }
        };
        if path_identity(&path)? != identity || stat.size != bytes.len() as u64 {
            remove_owned_file(&path, &identity);
            return Err(SNAP_CHANGED.into());
        }
        return Ok(DiskSnapshot {
            id,
            created_ns,
            counter,
            stat,
        });
    }
    Err(SNAP_IO.into())
}

fn retain_snapshots(
    root: &Path,
    max_count: usize,
    max_total: u64,
    protected: Option<&str>,
) -> Result<(), String> {
    let snapshots = scan_owned(root)?;
    let mut keep: Vec<&str> = Vec::new();
    let mut total = 0u64;
    if let Some(id) = protected {
        if let Some(snapshot) = snapshots.iter().find(|s| s.id == id) {
            keep.push(snapshot.id.as_str());
            total = snapshot.stat.size;
        }
    }
    for snapshot in &snapshots {
        if keep.len() >= max_count.max(1) {
            break;
        }
        if keep.contains(&snapshot.id.as_str()) {
            continue;
        }
        if total
            .checked_add(snapshot.stat.size)
            .is_some_and(|n| n <= max_total)
        {
            keep.push(snapshot.id.as_str());
            total += snapshot.stat.size;
        }
    }
    for snapshot in &snapshots {
        if keep.contains(&snapshot.id.as_str()) {
            continue;
        }
        let path = root.join(&snapshot.id);
        let meta = fs::symlink_metadata(&path).map_err(|_| SNAP_IO.to_string())?;
        check_reparse(&meta)?;
        if !meta.is_file() || snapshot_stat(&meta)? != snapshot.stat {
            return Err(SNAP_CHANGED.into());
        }
        fs::remove_file(path).map_err(|_| SNAP_IO.to_string())?;
    }
    Ok(())
}

fn archive_previous_locked(path: &Path, existing: &[u8]) -> Result<SnapshotInfo, String> {
    if existing.len() as u64 > MAX_FILE_BYTES {
        return Err(SNAP_TOO_LARGE.into());
    }
    if !crate::is_kdbx(existing) {
        return Err(SNAP_INVALID_FILE.into());
    }
    let root = backup_root(&canonical_vault(path)?);
    ensure_root(&root)?;
    scan_owned(&root)?;
    if fs::read_dir(&root)
        .map_err(|_| SNAP_IO.to_string())?
        .take(MAX_SCAN_ENTRIES)
        .count()
        >= MAX_SCAN_ENTRIES
    {
        return Err(SNAP_IO.into());
    }
    let new_snapshot = create_snapshot(&root, existing)?;
    retain_snapshots(&root, MAX_COUNT, MAX_TOTAL_BYTES, Some(&new_snapshot.id))?;
    info_from_disk(&new_snapshot)
}

pub(crate) fn archive_previous(path: &Path, existing: &[u8]) -> Result<(), String> {
    let _guard = write_lock()?;
    archive_previous_locked(path, existing).map(|_| ())
}

fn read_current_vault(
    path: &Path,
    expected: &crate::VaultStat,
) -> Result<(PathBuf, Vec<u8>), String> {
    let canonical = canonical_vault(path)?;
    let before_meta = fs::symlink_metadata(&canonical).map_err(|_| SNAP_IO.to_string())?;
    check_reparse(&before_meta)?;
    let before = snapshot_stat(&before_meta)?;
    if !matches_expected(&before, expected) {
        return Err(SNAP_CHANGED.into());
    }
    let before_identity = path_identity(&canonical)?;
    let (bytes, opened_stat, opened_identity) = read_bounded(&canonical)?;
    let after_meta = fs::symlink_metadata(&canonical).map_err(|_| SNAP_IO.to_string())?;
    check_reparse(&after_meta)?;
    let after = snapshot_stat(&after_meta)?;
    if !matches_expected(&after, expected)
        || before != after
        || before != opened_stat
        || before_identity != opened_identity
        || path_identity(&canonical)? != opened_identity
    {
        return Err(SNAP_CHANGED.into());
    }
    if !crate::is_kdbx(&bytes) {
        return Err(SNAP_INVALID_FILE.into());
    }
    Ok((canonical, bytes))
}

fn create_current_snapshot(
    path: &Path,
    expected: &crate::VaultStat,
) -> Result<SnapshotInfo, String> {
    let (canonical, bytes) = read_current_vault(path, expected)?;
    archive_previous_locked(&canonical, &bytes)
}

fn list_snapshots(path: &Path) -> Result<SnapshotListResponse, String> {
    let root = root_for_vault(path)?;
    let mut items = Vec::new();
    match fs::symlink_metadata(&root) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(SNAP_IO.into()),
        Ok(_) => {
            for snapshot in scan_owned(&root)? {
                if items.len() >= MAX_COUNT {
                    break;
                }
                let info = info_from_disk(&snapshot)?;
                let used: u64 = items.iter().map(|item: &SnapshotInfo| item.size).sum();
                if used
                    .checked_add(info.size)
                    .is_some_and(|n| n <= MAX_TOTAL_BYTES)
                {
                    items.push(info);
                } else {
                    break;
                }
            }
        }
    }
    Ok(SnapshotListResponse {
        items,
        max_count: MAX_COUNT,
        max_total_bytes: MAX_TOTAL_BYTES,
    })
}

fn ensure_new_target(target: &Path) -> Result<(), String> {
    match fs::symlink_metadata(target) {
        Ok(_) => Err(SNAP_TARGET_EXISTS.into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(SNAP_IO.into()),
    }
}

fn export_snapshot(
    vault: &Path,
    id: &str,
    expected: &crate::VaultStat,
    current_stat: &crate::VaultStat,
    target: &Path,
) -> Result<(), String> {
    let root = root_for_vault(vault)?;
    // Buffer the selected ciphertext before retention can remove its original file.
    let bytes = read_snapshot(&root, id, expected)?;
    ensure_new_target(target)?;
    create_current_snapshot(vault, current_stat)?;
    if !matches_expected(&snapshot_file_stat(vault)?, current_stat) {
        return Err(SNAP_CHANGED.into());
    }
    export_bytes(&bytes, target)
}

fn export_bytes(bytes: &[u8], target: &Path) -> Result<(), String> {
    ensure_new_target(target)?;
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = target.file_name().ok_or_else(|| SNAP_IO.to_string())?;
    let mut staged = None;
    for _ in 0..MAX_SCAN_ENTRIES {
        let counter = NEXT_COUNTER.fetch_add(1, Ordering::Relaxed);
        let mut temp_name = name.to_os_string();
        temp_name.push(format!(
            ".keytree-export-{}-{counter}.tmp",
            current_time_ns()?
        ));
        let temp = parent.join(temp_name);
        let mut file = match OpenOptions::new().write(true).create_new(true).open(&temp) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(SNAP_IO.into()),
        };
        if file
            .write_all(&bytes)
            .and_then(|_| file.sync_all())
            .is_err()
        {
            let identity = file_identity(&file).ok();
            drop(file);
            if let Some(identity) = identity.as_ref() {
                remove_owned_file(&temp, identity);
            }
            return Err(SNAP_IO.into());
        }
        let identity = file_identity(&file)?;
        drop(file);
        staged = Some((temp, identity));
        break;
    }
    let (temp, identity) = staged.ok_or_else(|| SNAP_IO.to_string())?;
    let link = fs::hard_link(&temp, target);
    remove_owned_file(&temp, &identity);
    match link {
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(SNAP_TARGET_EXISTS.into())
        }
        Err(e) if e.kind() == std::io::ErrorKind::Unsupported => {
            return Err(SNAP_UNSUPPORTED.into())
        }
        Err(_) => return Err(SNAP_IO.into()),
        Ok(()) => {}
    }
    let result = (|| -> Result<(), String> {
        let target_meta = fs::symlink_metadata(target).map_err(|_| SNAP_IO.to_string())?;
        check_reparse(&target_meta)?;
        if !target_meta.is_file() || path_identity(target)? != identity {
            return Err(SNAP_CHANGED.into());
        }
        Ok(())
    })();
    if let Err(error) = result {
        remove_owned_file(target, &identity);
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
pub fn snapshot_list(
    window: tauri::WebviewWindow,
    vault_path: String,
) -> Result<SnapshotListResponse, String> {
    crate::require_main_window(&window)?;
    list_snapshots(Path::new(&vault_path))
}

#[tauri::command]
pub fn snapshot_read(
    window: tauri::WebviewWindow,
    vault_path: String,
    id: String,
    expected_stat: crate::VaultStat,
) -> Result<Vec<u8>, String> {
    crate::require_main_window(&window)?;
    let root = root_for_vault(Path::new(&vault_path))?;
    read_snapshot(&root, &id, &expected_stat)
}

#[tauri::command]
pub fn snapshot_export(
    window: tauri::WebviewWindow,
    vault_path: String,
    id: String,
    expected_stat: crate::VaultStat,
    current_stat: crate::VaultStat,
    target_path: String,
) -> Result<(), String> {
    crate::require_main_window(&window)?;
    let _guard = write_lock()?;
    export_snapshot(
        Path::new(&vault_path),
        &id,
        &expected_stat,
        &current_stat,
        Path::new(&target_path),
    )
}

#[tauri::command]
pub fn snapshot_create(
    window: tauri::WebviewWindow,
    vault_path: String,
    expected_stat: crate::VaultStat,
) -> Result<SnapshotInfo, String> {
    crate::require_main_window(&window)?;
    let _guard = write_lock()?;
    create_current_snapshot(Path::new(&vault_path), &expected_stat)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_kdbx(tag: u8) -> Vec<u8> {
        let mut bytes = b"\x03\xd9\xa2\x9a\x67\xfb\x4b\xb5\x00\x00\x00\x01".to_vec();
        bytes.push(tag);
        bytes
    }
    fn test_root(dir: &tempfile::TempDir) -> PathBuf {
        let root = dir.path().join("vault.kdbx.keytree-backups");
        fs::create_dir(&root).unwrap();
        root
    }
    fn write_test_snapshot(root: &Path, ns: u128, counter: u64, bytes: &[u8]) -> String {
        let id = format!("snapshot-{ns}-{counter}.kdbx");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(root.join(&id))
            .unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
        id
    }
    fn vault_stat(stat: &SnapshotStat) -> crate::VaultStat {
        crate::VaultStat {
            mtime_ms: stat.mtime_ms,
            size: stat.size,
            mtime_ns: stat.mtime_ns.clone(),
        }
    }

    #[test]
    fn backup_hook_archives_valid_old_and_skips_non_kdbx() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault.kdbx");
        let old = fake_kdbx(1);
        fs::write(&vault, &old).unwrap();
        assert!(crate::backup_vault(&vault, &fake_kdbx(2)).unwrap());
        assert_eq!(fs::read(format!("{}.bak", vault.display())).unwrap(), old);
        let root = backup_root(&vault);
        let snapshots = scan_owned(&root).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(
            read_snapshot(&root, &snapshots[0].id, &vault_stat(&snapshots[0].stat)).unwrap(),
            old
        );
        let plain = dir.path().join("plain.txt");
        fs::write(&plain, b"text").unwrap();
        assert!(!crate::backup_vault(&plain, b"new text").unwrap());
        assert!(!backup_root(&plain).exists());
    }

    #[test]
    fn oversized_existing_vault_is_rejected_before_backup_or_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("oversized.kdbx");
        let file = File::create(&vault).unwrap();
        file.set_len(MAX_FILE_BYTES + 1).unwrap();
        drop(file);
        assert_eq!(
            crate::backup_vault(&vault, &fake_kdbx(2)).unwrap_err(),
            SNAP_TOO_LARGE
        );
        assert_eq!(fs::metadata(&vault).unwrap().len(), MAX_FILE_BYTES + 1);
        assert!(!backup_root(&vault).exists());
        assert!(!dir.path().join("oversized.kdbx.bak").exists());
    }

    #[test]
    fn archive_error_stops_vault_replacement() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault.kdbx");
        let old = fake_kdbx(1);
        fs::write(&vault, &old).unwrap();
        fs::write(backup_root(&vault), b"blocker").unwrap();
        let err = crate::backup_vault(&vault, &fake_kdbx(2)).unwrap_err();
        assert_eq!(err, SNAP_INVALID_FILE);
        assert_eq!(fs::read(vault).unwrap(), old);
    }

    #[test]
    fn retention_enforces_small_count_and_total_and_keeps_latest() {
        let dir = tempfile::tempdir().unwrap();
        let root = test_root(&dir);
        let bytes = fake_kdbx(1);
        let ids = [
            write_test_snapshot(&root, 100, 1, &bytes),
            write_test_snapshot(&root, 200, 2, &bytes),
            write_test_snapshot(&root, 300, 3, &bytes),
        ];
        let foreign = root.join("other.bin");
        fs::write(&foreign, b"foreign").unwrap();
        retain_snapshots(&root, 2, 1_000, None).unwrap();
        assert!(!root.join(&ids[0]).exists());
        assert!(root.join(&ids[1]).exists() && root.join(&ids[2]).exists());
        retain_snapshots(&root, 30, (bytes.len() * 2 - 1) as u64, None).unwrap();
        assert!(!root.join(&ids[1]).exists());
        assert!(root.join(&ids[2]).exists());
        assert_eq!(fs::read(foreign).unwrap(), b"foreign");
        let latest = create_snapshot(&root, &fake_kdbx(8)).unwrap();
        retain_snapshots(&root, 1, MAX_TOTAL_BYTES, Some(&latest.id)).unwrap();
        assert!(root.join(latest.id).exists());
    }

    #[test]
    fn export_refuses_existing_and_preserves_all_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let root = test_root(&dir);
        let bytes = fake_kdbx(7);
        let snapshot = create_snapshot(&root, &bytes).unwrap();
        let expected = vault_stat(&snapshot.stat);
        let existing = dir.path().join("existing.kdbx");
        fs::write(&existing, b"do not overwrite").unwrap();
        assert_eq!(
            export_bytes(
                &read_snapshot(&root, &snapshot.id, &expected).unwrap(),
                &existing
            )
            .unwrap_err(),
            SNAP_TARGET_EXISTS
        );
        assert_eq!(fs::read(&existing).unwrap(), b"do not overwrite");
        let target = dir.path().join("restored.kdbx");
        export_bytes(
            &read_snapshot(&root, &snapshot.id, &expected).unwrap(),
            &target,
        )
        .unwrap();
        assert_eq!(fs::read(target).unwrap(), bytes);
        assert_eq!(fs::read(root.join(snapshot.id)).unwrap(), bytes);
    }

    #[test]
    fn full_retention_can_export_oldest_while_preserving_current() {
        let _guard = write_lock().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault.kdbx");
        let current = fake_kdbx(99);
        fs::write(&vault, &current).unwrap();
        let root = backup_root(&canonical_vault(&vault).unwrap());
        ensure_root(&root).unwrap();
        let selected_bytes = fake_kdbx(1);
        let selected_id = write_test_snapshot(&root, 100, 1, &selected_bytes);
        for i in 2..=MAX_COUNT {
            write_test_snapshot(&root, 100 + i as u128, i as u64, &fake_kdbx(i as u8));
        }
        let expected = vault_stat(&snapshot_file_stat(&root.join(&selected_id)).unwrap());
        let current_stat = vault_stat(&snapshot_file_stat(&vault).unwrap());
        let target = dir.path().join("restored.kdbx");
        let mut stale = vault_stat(&snapshot_file_stat(&vault).unwrap());
        stale.size += 1;
        assert_eq!(
            export_snapshot(&vault, &selected_id, &expected, &stale, &target).unwrap_err(),
            SNAP_CHANGED
        );
        assert!(!target.exists());
        assert_eq!(scan_owned(&root).unwrap().len(), MAX_COUNT);
        export_snapshot(&vault, &selected_id, &expected, &current_stat, &target).unwrap();
        assert_eq!(fs::read(&target).unwrap(), selected_bytes);
        assert_eq!(fs::read(&vault).unwrap(), current);
        assert!(
            !root.join(&selected_id).exists(),
            "oldest source should have rotated out"
        );
        let items = scan_owned(&root).unwrap();
        assert_eq!(items.len(), MAX_COUNT);
        assert!(items.iter().map(|item| item.stat.size).sum::<u64>() <= MAX_TOTAL_BYTES);
        assert_eq!(fs::read(root.join(&items[0].id)).unwrap(), current);
        assert_eq!(
            export_bytes(&fake_kdbx(2), &target).unwrap_err(),
            SNAP_TARGET_EXISTS
        );
        assert_eq!(fs::read(target).unwrap(), selected_bytes);
    }

    #[test]
    fn changed_stat_and_invalid_id_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let root = test_root(&dir);
        let snapshot = create_snapshot(&root, &fake_kdbx(9)).unwrap();
        let mut stale = vault_stat(&snapshot.stat);
        stale.mtime_ns.push('0');
        assert_eq!(
            read_snapshot(&root, &snapshot.id, &stale).unwrap_err(),
            SNAP_CHANGED
        );
        assert_eq!(
            read_snapshot(&root, "../outside.kdbx", &stale).unwrap_err(),
            SNAP_INVALID_ID
        );
        assert_eq!(
            read_snapshot(&root, "snapshot-01-1.kdbx", &stale).unwrap_err(),
            SNAP_INVALID_ID
        );
    }

    #[test]
    fn manual_create_checks_current_stat_before_archiving() {
        let dir = tempfile::tempdir().unwrap();
        let vault = dir.path().join("vault.kdbx");
        fs::write(&vault, fake_kdbx(3)).unwrap();
        let mut stale = vault_stat(&snapshot_file_stat(&vault).unwrap());
        stale.size += 1;
        assert_eq!(
            create_current_snapshot(&vault, &stale).unwrap_err(),
            SNAP_CHANGED
        );
        assert!(!backup_root(&vault).exists());
    }

    #[test]
    fn foreign_directories_and_files_are_not_pruned() {
        let dir = tempfile::tempdir().unwrap();
        let root = test_root(&dir);
        let foreign = root.join("foreign.bin");
        let foreign_dir = root.join("foreign-dir");
        fs::write(&foreign, b"untouched").unwrap();
        fs::create_dir(&foreign_dir).unwrap();
        let id = write_test_snapshot(&root, 555, 1, &fake_kdbx(5));
        retain_snapshots(&root, 1, MAX_TOTAL_BYTES, None).unwrap();
        assert_eq!(fs::read(foreign).unwrap(), b"untouched");
        assert!(foreign_dir.is_dir() && root.join(id).exists());
    }

    #[test]
    fn reparse_flags_are_rejected() {
        assert_eq!(
            reject_reparse_flags(true, false).unwrap_err(),
            SNAP_UNSUPPORTED
        );
        assert_eq!(
            reject_reparse_flags(false, true).unwrap_err(),
            SNAP_UNSUPPORTED
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_root_and_snapshot_are_rejected() {
        use std::os::unix::fs::symlink;
        let dir = tempfile::tempdir().unwrap();
        let root = test_root(&dir);
        let target = dir.path().join("target");
        fs::write(&target, fake_kdbx(4)).unwrap();
        let id = "snapshot-444-1.kdbx";
        symlink(&target, root.join(id)).unwrap();
        let expected = crate::VaultStat {
            mtime_ms: 0,
            size: 0,
            mtime_ns: "0".into(),
        };
        assert_eq!(
            read_snapshot(&root, id, &expected).unwrap_err(),
            SNAP_UNSUPPORTED
        );
        let linked = dir.path().join("linked.keytree-backups");
        symlink(&root, &linked).unwrap();
        assert_eq!(check_root(&linked).unwrap_err(), SNAP_UNSUPPORTED);
    }
}
