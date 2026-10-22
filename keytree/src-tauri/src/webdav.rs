use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use std::future::Future;
use std::pin::Pin;
use std::task::{Context, Poll};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_http::reqwest::header::HeaderMap;
use tauri_plugin_http::reqwest::{self, header, Client, StatusCode, Url};

const MAX_PROFILE_BYTES: u64 = 1024 * 1024;
const MAX_CONFIGS: usize = 256;
const MAX_REMOTE_BYTES: usize = 64 * 1024 * 1024;
const MAX_URL_BYTES: usize = 4096;
const MAX_USERNAME_BYTES: usize = 256;
const MAX_PASSWORD_BYTES: usize = 4096;
const MAX_ETAG_BYTES: usize = 1024;
const MAX_TICKETS: usize = 256;
const WD_INVALID_URL: &str = "WD_INVALID_URL";
const WD_CREDENTIALS_REQUIRED: &str = "WD_CREDENTIALS_REQUIRED";
const WD_NOT_CONFIGURED: &str = "WD_NOT_CONFIGURED";
const WD_CONFIG_IO: &str = "WD_CONFIG_IO";
const WD_AUTH: &str = "WD_AUTH";
const WD_NETWORK: &str = "WD_NETWORK";
const WD_REDIRECT: &str = "WD_REDIRECT";
const WD_REMOTE_MISSING: &str = "WD_REMOTE_MISSING";
const WD_REMOTE_CHANGED: &str = "WD_REMOTE_CHANGED";
const WD_REMOTE_INVALID: &str = "WD_REMOTE_INVALID";
const WD_TOO_LARGE: &str = "WD_TOO_LARGE";
const WD_ETAG_REQUIRED: &str = "WD_ETAG_REQUIRED";
const WD_CREATE_UNSUPPORTED: &str = "WD_CREATE_UNSUPPORTED";
const WD_LOCAL_CHANGED: &str = "WD_LOCAL_CHANGED";
const WD_LOCAL_IO: &str = "WD_LOCAL_IO";
const WD_TICKET_INVALID: &str = "WD_TICKET_INVALID";
const WD_CANCELLED: &str = "WD_CANCELLED";
const WD_BUSY: &str = "WD_BUSY";
const WD_SERVER: &str = "WD_SERVER";
const WD_UNSUPPORTED: &str = "WD_UNSUPPORTED";

#[derive(Clone, Serialize, Deserialize)]
struct ConfigEntry {
    vault_path: String,
    url: String,
    username: String,
    encrypted_password: Vec<u8>,
    #[serde(default)]
    revision: u64,
    #[serde(default)]
    last_synced_at: Option<u64>,
}

#[derive(Default, Serialize, Deserialize)]
struct Profile {
    entries: Vec<ConfigEntry>,
}

#[derive(Serialize, Deserialize)]
struct EncryptedProfile {
    version: u8,
    ciphertext: Vec<u8>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigView {
    configured: bool,
    url: String,
    username: String,
    has_password: bool,
    last_synced_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrepareResult {
    token: String,
    bytes: Option<Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
    uploaded_stat: crate::VaultStat,
    synced_at: u64,
    // False explicitly means the conditional PUT succeeded but metadata persistence did not.
    metadata_saved: bool,
}

#[derive(Clone, Debug)]
enum RemoteCondition {
    IfMatch(String),
    IfNoneMatch,
}

#[derive(Debug)]
struct Ticket {
    vault_path: String,
    revision: u64,
    epoch: u64,
    condition: RemoteCondition,
}

#[derive(Default)]
struct RuntimeState {
    epochs: HashMap<String, u64>,
    tickets: HashMap<String, Ticket>,
}

#[derive(Clone)]
struct NetworkConfig {
    url: String,
    username: String,
    password: String,
    revision: u64,
}

struct RemoteSnapshot {
    bytes: Vec<u8>,
    etag: String,
}

struct ReadableRemote {
    bytes: Vec<u8>,
    etag: Option<String>,
    etag_status: EtagStatus,
}

struct CheckedSend<F> {
    vault: String,
    epoch: u64,
    future: Pin<Box<F>>,
}

impl<F, T> Future for CheckedSend<F>
where
    F: Future<Output = Result<T, reqwest::Error>>,
{
    type Output = Result<T, String>;

    fn poll(self: Pin<&mut Self>, context: &mut Context<'_>) -> Poll<Self::Output> {
        let this = self.get_mut();
        let state = match runtime().lock() {
            Ok(state) => state,
            Err(_) => return Poll::Ready(Err(WD_BUSY.to_string())),
        };
        if state.epochs.get(&this.vault).copied().unwrap_or(0) != this.epoch {
            return Poll::Ready(Err(WD_CANCELLED.to_string()));
        }
        // Hold the same lock cancel/save uses through the first poll which starts IO.
        let result = this.future.as_mut().poll(context);
        drop(state);
        match result {
            Poll::Pending => Poll::Pending,
            Poll::Ready(Ok(value)) => Poll::Ready(Ok(value)),
            Poll::Ready(Err(error)) => Poll::Ready(Err(if error.is_redirect() {
                WD_REDIRECT.to_string()
            } else {
                WD_NETWORK.to_string()
            })),
        }
    }
}

async fn checked_send<F, T>(future: F, vault: &str, epoch: u64) -> Result<T, String>
where
    F: Future<Output = Result<T, reqwest::Error>>,
{
    CheckedSend {
        vault: vault.to_string(),
        epoch,
        future: Box::pin(future),
    }
    .await
}

static RUNTIME: OnceLock<Mutex<RuntimeState>> = OnceLock::new();
static PROFILE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
#[cfg(test)]
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);
static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);

fn runtime() -> &'static Mutex<RuntimeState> {
    RUNTIME.get_or_init(|| Mutex::new(RuntimeState::default()))
}

fn profile_lock() -> Result<MutexGuard<'static, ()>, String> {
    PROFILE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| WD_BUSY.to_string())
}

fn runtime_lock() -> Result<MutexGuard<'static, RuntimeState>, String> {
    runtime().lock().map_err(|_| WD_BUSY.to_string())
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    crate::require_main_window(window).map_err(|_| WD_UNSUPPORTED.to_string())
}

fn canonical_vault_path(raw: &str) -> Result<String, String> {
    if raw.is_empty() || raw.len() > 32768 || raw.chars().any(char::is_control) {
        return Err(WD_LOCAL_IO.to_string());
    }
    let path = Path::new(raw)
        .canonicalize()
        .map_err(|_| WD_LOCAL_IO.to_string())?;
    if !path.is_file() {
        return Err(WD_LOCAL_IO.to_string());
    }
    Ok(path.to_string_lossy().into_owned())
}

fn key_for_cancel(raw: &str) -> String {
    canonical_vault_path(raw).unwrap_or_else(|_| raw.to_string())
}

fn current_epoch(key: &str) -> Result<u64, String> {
    Ok(*runtime_lock()?.epochs.get(key).unwrap_or(&0))
}

fn check_epoch(key: &str, expected: u64) -> Result<(), String> {
    if current_epoch(key)? == expected {
        Ok(())
    } else {
        Err(WD_CANCELLED.to_string())
    }
}

fn invalidate(key: &str) -> Result<u64, String> {
    let mut state = runtime_lock()?;
    let epoch = state.epochs.entry(key.to_string()).or_insert(0);
    *epoch = epoch.wrapping_add(1);
    let next = *epoch;
    state.tickets.retain(|_, ticket| ticket.vault_path != key);
    Ok(next)
}

fn make_token() -> Result<String, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::Security::Cryptography::{
            BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
        };
        let mut bytes = [0u8; 32];
        let result = unsafe {
            BCryptGenRandom(
                std::ptr::null_mut(),
                bytes.as_mut_ptr(),
                bytes.len() as u32,
                BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            )
        };
        if result < 0 {
            return Err(WD_BUSY.to_string());
        }
        Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
    }
    #[cfg(all(not(windows), test))]
    {
        Ok(format!(
            "synthetic-{}",
            NEXT_TOKEN.fetch_add(1, Ordering::Relaxed)
        ))
    }
    #[cfg(all(not(windows), not(test)))]
    {
        Err(WD_UNSUPPORTED.to_string())
    }
}

fn insert_ticket(
    key: &str,
    revision: u64,
    epoch: u64,
    condition: RemoteCondition,
) -> Result<String, String> {
    let mut state = runtime_lock()?;
    if state.epochs.get(key).copied().unwrap_or(0) != epoch {
        return Err(WD_CANCELLED.to_string());
    }
    if state.tickets.len() >= MAX_TICKETS {
        return Err(WD_BUSY.to_string());
    }
    let token = make_token()?;
    state.tickets.insert(
        token.clone(),
        Ticket {
            vault_path: key.to_string(),
            revision,
            epoch,
            condition,
        },
    );
    Ok(token)
}

fn consume_ticket(key: &str, token: &str) -> Result<Ticket, String> {
    let mut state = runtime_lock()?;
    let ticket = state
        .tickets
        .remove(token)
        .ok_or_else(|| WD_TICKET_INVALID.to_string())?;
    if ticket.vault_path != key || state.epochs.get(key).copied().unwrap_or(0) != ticket.epoch {
        return Err(WD_TICKET_INVALID.to_string());
    }
    Ok(ticket)
}

fn profile_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join("webdav-profile.json"))
        .map_err(|_| WD_CONFIG_IO.to_string())
}

fn protect_profile(bytes: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        crate::dpapi::protect(bytes).map_err(|_| WD_CONFIG_IO.to_string())
    }
    #[cfg(all(not(windows), test))]
    {
        Ok(bytes.iter().map(|b| b ^ 0xA7).collect())
    }
    #[cfg(all(not(windows), not(test)))]
    {
        let _ = bytes;
        Err(WD_UNSUPPORTED.to_string())
    }
}

fn unprotect_profile(bytes: &[u8]) -> Result<Vec<u8>, String> {
    #[cfg(windows)]
    {
        crate::dpapi::unprotect(bytes).map_err(|_| WD_CONFIG_IO.to_string())
    }
    #[cfg(all(not(windows), test))]
    {
        Ok(bytes.iter().map(|b| b ^ 0xA7).collect())
    }
    #[cfg(all(not(windows), not(test)))]
    {
        let _ = bytes;
        Err(WD_UNSUPPORTED.to_string())
    }
}

fn protect_password(password: &str) -> Result<Vec<u8>, String> {
    protect_profile(password.as_bytes())
}

fn validate_username(username: &str) -> Result<(), String> {
    if username.is_empty()
        || username.len() > MAX_USERNAME_BYTES
        || username.chars().any(char::is_control)
    {
        return Err(WD_CREDENTIALS_REQUIRED.to_string());
    }
    Ok(())
}

fn validate_password(password: &str) -> Result<(), String> {
    if password.is_empty() || password.len() > MAX_PASSWORD_BYTES {
        return Err(WD_CREDENTIALS_REQUIRED.to_string());
    }
    Ok(())
}

fn validate_url(raw: &str, allow_loopback_http: bool) -> Result<Url, String> {
    if raw.is_empty() || raw.len() > MAX_URL_BYTES || raw.chars().any(char::is_control) {
        return Err(WD_INVALID_URL.to_string());
    }
    let url = Url::parse(raw).map_err(|_| WD_INVALID_URL.to_string())?;
    let scheme_ok = url.scheme() == "https" || (allow_loopback_http && url.scheme() == "http");
    if !scheme_ok
        || url.host_str().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || !url.path().to_ascii_lowercase().ends_with(".kdbx")
    {
        return Err(WD_INVALID_URL.to_string());
    }
    let authority_start = raw.find("://").ok_or_else(|| WD_INVALID_URL.to_string())? + 3;
    let authority_end = raw[authority_start..]
        .find(&['/', '?', '#'][..])
        .map(|n| authority_start + n)
        .unwrap_or(raw.len());
    if raw[authority_start..authority_end].contains('@') {
        return Err(WD_INVALID_URL.to_string());
    }
    if url.scheme() == "http" {
        if !allow_loopback_http
            || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
        {
            return Err(WD_INVALID_URL.to_string());
        }
    }
    Ok(url)
}

fn origin(url: &Url) -> String {
    url.origin().ascii_serialization()
}

fn read_profile(path: &Path) -> Result<Profile, String> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Profile::default()),
        Err(_) => return Err(WD_CONFIG_IO.to_string()),
    };
    let mut raw = Vec::new();
    file.take(MAX_PROFILE_BYTES + 1)
        .read_to_end(&mut raw)
        .map_err(|_| WD_CONFIG_IO.to_string())?;
    if raw.len() as u64 > MAX_PROFILE_BYTES {
        return Err(WD_CONFIG_IO.to_string());
    }
    let envelope: EncryptedProfile =
        serde_json::from_slice(&raw).map_err(|_| WD_CONFIG_IO.to_string())?;
    if envelope.version != 1
        || envelope.ciphertext.is_empty()
        || envelope.ciphertext.len() as u64 > MAX_PROFILE_BYTES
    {
        return Err(WD_CONFIG_IO.to_string());
    }
    let plaintext = unprotect_profile(&envelope.ciphertext)?;
    if plaintext.len() as u64 > MAX_PROFILE_BYTES {
        return Err(WD_CONFIG_IO.to_string());
    }
    let profile: Profile =
        serde_json::from_slice(&plaintext).map_err(|_| WD_CONFIG_IO.to_string())?;
    if profile.entries.len() > MAX_CONFIGS {
        return Err(WD_CONFIG_IO.to_string());
    }
    for entry in &profile.entries {
        if entry.vault_path.is_empty()
            || entry.vault_path.len() > 32768
            || entry.revision == 0
            || entry.encrypted_password.is_empty()
            || entry.encrypted_password.len() > MAX_PASSWORD_BYTES * 4
            || validate_username(&entry.username).is_err()
            || validate_url(&entry.url, false).is_err()
        {
            return Err(WD_CONFIG_IO.to_string());
        }
    }
    Ok(profile)
}

fn write_profile(path: &Path, profile: &Profile) -> Result<(), String> {
    if profile.entries.len() > MAX_CONFIGS {
        return Err(WD_CONFIG_IO.to_string());
    }
    let plaintext = serde_json::to_vec(profile).map_err(|_| WD_CONFIG_IO.to_string())?;
    if plaintext.len() as u64 > MAX_PROFILE_BYTES {
        return Err(WD_CONFIG_IO.to_string());
    }
    let envelope = EncryptedProfile {
        version: 1,
        ciphertext: protect_profile(&plaintext)?,
    };
    let raw = serde_json::to_vec(&envelope).map_err(|_| WD_CONFIG_IO.to_string())?;
    if raw.len() as u64 > MAX_PROFILE_BYTES {
        return Err(WD_CONFIG_IO.to_string());
    }
    let parent = path.parent().ok_or_else(|| WD_CONFIG_IO.to_string())?;
    fs::create_dir_all(parent).map_err(|_| WD_CONFIG_IO.to_string())?;
    let temp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|_| WD_CONFIG_IO.to_string())?;
        file.write_all(&raw).map_err(|_| WD_CONFIG_IO.to_string())?;
        file.sync_all().map_err(|_| WD_CONFIG_IO.to_string())?;
        drop(file);
        fs::rename(&temp, path).map_err(|_| WD_CONFIG_IO.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

fn config_view(entry: Option<&ConfigEntry>) -> ConfigView {
    match entry {
        Some(entry) => ConfigView {
            configured: true,
            url: entry.url.clone(),
            username: entry.username.clone(),
            has_password: !entry.encrypted_password.is_empty(),
            last_synced_at: entry.last_synced_at,
        },
        None => ConfigView {
            configured: false,
            url: String::new(),
            username: String::new(),
            has_password: false,
            last_synced_at: None,
        },
    }
}

fn read_config_view(path: &Path, vault: &str) -> Result<ConfigView, String> {
    let _guard = profile_lock()?;
    let profile = read_profile(path)?;
    Ok(config_view(
        profile
            .entries
            .iter()
            .find(|entry| entry.vault_path == vault),
    ))
}

fn save_config(
    path: &Path,
    vault: &str,
    raw_url: &str,
    username: &str,
    password: Option<String>,
) -> Result<ConfigView, String> {
    let url = validate_url(raw_url, false)?;
    validate_username(username)?;
    if let Some(ref password) = password {
        validate_password(password)?;
    }
    let _guard = profile_lock()?;
    let mut profile = read_profile(path)?;
    let existing_index = profile
        .entries
        .iter()
        .position(|entry| entry.vault_path == vault);
    let encrypted_password = match password {
        Some(password) => protect_password(&password)?,
        None => {
            let index = existing_index.ok_or_else(|| WD_CREDENTIALS_REQUIRED.to_string())?;
            let previous = &profile.entries[index];
            let previous_url =
                validate_url(&previous.url, false).map_err(|_| WD_CONFIG_IO.to_string())?;
            if previous.username != username || origin(&previous_url) != origin(&url) {
                return Err(WD_CREDENTIALS_REQUIRED.to_string());
            }
            previous.encrypted_password.clone()
        }
    };
    let revision = match existing_index {
        Some(index) => profile.entries[index]
            .revision
            .checked_add(1)
            .ok_or_else(|| WD_CONFIG_IO.to_string())?,
        None => {
            if profile.entries.len() >= MAX_CONFIGS {
                return Err(WD_CONFIG_IO.to_string());
            }
            1
        }
    };
    let entry = ConfigEntry {
        vault_path: vault.to_string(),
        url: raw_url.to_string(),
        username: username.to_string(),
        encrypted_password,
        revision,
        last_synced_at: existing_index
            .filter(|&i| {
                profile.entries[i].url == raw_url && profile.entries[i].username == username
            })
            .and_then(|i| profile.entries[i].last_synced_at),
    };
    if let Some(index) = existing_index {
        profile.entries[index] = entry.clone();
    } else {
        profile.entries.push(entry.clone());
    }
    write_profile(path, &profile)?;
    Ok(config_view(Some(&entry)))
}

fn forget_config(path: &Path, vault: &str) -> Result<(), String> {
    let _guard = profile_lock()?;
    let mut profile = read_profile(path)?;
    let old_len = profile.entries.len();
    profile.entries.retain(|entry| entry.vault_path != vault);
    if profile.entries.len() != old_len {
        write_profile(path, &profile)?;
    }
    Ok(())
}

fn load_network_config(path: &Path, vault: &str) -> Result<NetworkConfig, String> {
    let _guard = profile_lock()?;
    let profile = read_profile(path)?;
    let entry = profile
        .entries
        .iter()
        .find(|entry| entry.vault_path == vault)
        .ok_or_else(|| WD_NOT_CONFIGURED.to_string())?;
    let plaintext = unprotect_profile(&entry.encrypted_password)?;
    if plaintext.is_empty() || plaintext.len() > MAX_PASSWORD_BYTES {
        return Err(WD_CONFIG_IO.to_string());
    }
    let password = String::from_utf8(plaintext).map_err(|_| WD_CONFIG_IO.to_string())?;
    Ok(NetworkConfig {
        url: entry.url.clone(),
        username: entry.username.clone(),
        password,
        revision: entry.revision,
    })
}

fn revision_is_current(path: &Path, vault: &str, expected: u64) -> Result<bool, String> {
    let _guard = profile_lock()?;
    let profile = read_profile(path)?;
    Ok(profile
        .entries
        .iter()
        .find(|entry| entry.vault_path == vault)
        .is_some_and(|entry| entry.revision == expected))
}

fn record_sync(path: &Path, vault: &str, revision: u64, synced_at: u64) -> bool {
    let Ok(_guard) = profile_lock() else {
        return false;
    };
    let Ok(mut profile) = read_profile(path) else {
        return false;
    };
    let Some(entry) = profile
        .entries
        .iter_mut()
        .find(|entry| entry.vault_path == vault && entry.revision == revision)
    else {
        return false;
    };
    entry.last_synced_at = Some(synced_at);
    write_profile(path, &profile).is_ok()
}

fn make_client(allow_loopback_http: bool) -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .https_only(!allow_loopback_http)
        .build()
        .map_err(|_| WD_NETWORK.to_string())
}

fn strong_etag(headers: &HeaderMap) -> Result<String, String> {
    let mut values = headers.get_all(header::ETAG).iter();
    let value = values.next().ok_or_else(|| WD_ETAG_REQUIRED.to_string())?;
    if values.next().is_some() {
        return Err(WD_ETAG_REQUIRED.to_string());
    }
    let bytes = value.as_bytes();
    if bytes.len() < 3
        || bytes.len() > MAX_ETAG_BYTES
        || bytes[0] != b'"'
        || *bytes.last().unwrap() != b'"'
        || bytes.starts_with(b"W/")
        || bytes[1..bytes.len() - 1]
            .iter()
            .any(|b| !(*b == 0x21 || (0x23..=0x7e).contains(b)))
    {
        return Err(WD_ETAG_REQUIRED.to_string());
    }
    value
        .to_str()
        .map(str::to_owned)
        .map_err(|_| WD_ETAG_REQUIRED.to_string())
}

// Nutstore returns a bare validator and expects exactly that spelling in If-Match.
// Provider reports and scope rationale are recorded in docs/webdav-sync.md.
fn is_nutstore_url(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("dav.jianguoyun.com")
        && url.port_or_known_default() == Some(443)
        && url.path().starts_with("/dav/")
}

fn upload_etag(headers: &HeaderMap, url: &Url) -> Result<String, String> {
    if let Ok(value) = strong_etag(headers) {
        return Ok(value);
    }
    if !is_nutstore_url(url) {
        return Err(WD_ETAG_REQUIRED.to_string());
    }
    let mut values = headers.get_all(header::ETAG).iter();
    let value = values.next().ok_or_else(|| WD_ETAG_REQUIRED.to_string())?;
    if values.next().is_some() {
        return Err(WD_ETAG_REQUIRED.to_string());
    }
    let raw = value.as_bytes();
    // A single opaque HTTP token, without wildcard/weak prefix/list/quotes/whitespace.
    // Never normalize, hash, quote or otherwise manufacture a server-side version.
    if raw.is_empty()
        || raw.len() > MAX_ETAG_BYTES
        || raw
            .iter()
            .any(|b| !(b.is_ascii_alphanumeric() || b"!#$%&'+-.^_`|~".contains(b)))
    {
        return Err(WD_ETAG_REQUIRED.to_string());
    }
    value
        .to_str()
        .map(str::to_owned)
        .map_err(|_| WD_ETAG_REQUIRED.to_string())
}

fn select_condition(
    remote: Option<&RemoteSnapshot>,
    allow_create: bool,
    url: &Url,
) -> Result<RemoteCondition, String> {
    match remote {
        Some(snapshot) => Ok(RemoteCondition::IfMatch(snapshot.etag.clone())),
        // Nutstore has been observed to ignore If-None-Match: *.
        // A user-chosen shared KDBX path is not an immutable unique-object key.
        None if is_nutstore_url(url) => Err(WD_CREATE_UNSUPPORTED.to_string()),
        None if allow_create => Ok(RemoteCondition::IfNoneMatch),
        None => Err(WD_REMOTE_MISSING.to_string()),
    }
}

fn validate_put_condition(condition: &RemoteCondition, url: &Url) -> Result<(), String> {
    match condition {
        RemoteCondition::IfNoneMatch if is_nutstore_url(url) => {
            Err(WD_CREATE_UNSUPPORTED.to_string())
        }
        RemoteCondition::IfNoneMatch => Ok(()),
        RemoteCondition::IfMatch(value) => {
            let mut headers = HeaderMap::new();
            let header =
                header::HeaderValue::from_str(value).map_err(|_| WD_ETAG_REQUIRED.to_string())?;
            headers.insert(header::ETAG, header);
            upload_etag(&headers, url).map(|_| ())
        }
    }
}

fn classify_etag(headers: &HeaderMap) -> EtagStatus {
    if strong_etag(headers).is_ok() {
        return EtagStatus::Strong;
    }
    let mut values = headers.get_all(header::ETAG).iter();
    let Some(value) = values.next() else {
        return EtagStatus::Missing;
    };
    if values.next().is_some() {
        return EtagStatus::Invalid;
    }
    if let Some(raw) = value.as_bytes().strip_prefix(b"W/") {
        if let Ok(value) = header::HeaderValue::from_bytes(raw) {
            let mut candidate = HeaderMap::new();
            candidate.insert(header::ETAG, value);
            if strong_etag(&candidate).is_ok() {
                return EtagStatus::Weak;
            }
        }
    }
    EtagStatus::Invalid
}

fn map_status(status: StatusCode) -> String {
    if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
        WD_AUTH.to_string()
    } else if status.is_redirection() {
        WD_REDIRECT.to_string()
    } else {
        WD_SERVER.to_string()
    }
}

async fn fetch_remote(
    client: &Client,
    config: &NetworkConfig,
    allow_loopback_http: bool,
    guard: Option<(&str, u64)>,
) -> Result<Option<ReadableRemote>, String> {
    let url = validate_url(&config.url, allow_loopback_http)?;
    let request = async {
        client
            .get(url)
            .header(header::ACCEPT_ENCODING, "identity")
            .basic_auth(&config.username, Some(&config.password))
            .send()
            .await
    };
    let response = match guard {
        Some((vault, epoch)) => checked_send(request, vault, epoch).await?,
        None => request.await.map_err(|_| WD_NETWORK.to_string())?,
    };
    if let Some((vault, epoch)) = guard {
        check_epoch(vault, epoch)?;
    }
    let status = response.status();
    if status == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if status != StatusCode::OK {
        return Err(map_status(status));
    }
    if response.headers().contains_key(header::CONTENT_RANGE) {
        return Err(WD_REMOTE_INVALID.to_string());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_REMOTE_BYTES as u64)
    {
        return Err(WD_TOO_LARGE.to_string());
    }
    // Do not mistake an HTML/error body for a KDBX with a missing validator.
    let etag = upload_etag(
        response.headers(),
        &validate_url(&config.url, allow_loopback_http)?,
    )
    .ok();
    let etag_status = if etag.is_some() && strong_etag(response.headers()).is_err() {
        EtagStatus::NutstoreCompatible
    } else {
        classify_etag(response.headers())
    };
    let mut response = response;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| WD_NETWORK.to_string())? {
        if let Some((vault, epoch)) = guard {
            check_epoch(vault, epoch)?;
        }
        if bytes
            .len()
            .checked_add(chunk.len())
            .is_none_or(|length| length > MAX_REMOTE_BYTES)
        {
            return Err(WD_TOO_LARGE.to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    if let Some((vault, epoch)) = guard {
        check_epoch(vault, epoch)?;
    }
    if !crate::is_kdbx(&bytes) {
        return Err(WD_REMOTE_INVALID.to_string());
    }
    Ok(Some(ReadableRemote {
        bytes,
        etag,
        etag_status,
    }))
}

async fn get_remote(
    client: &Client,
    config: &NetworkConfig,
    allow_loopback_http: bool,
    guard: Option<(&str, u64)>,
) -> Result<Option<RemoteSnapshot>, String> {
    match fetch_remote(client, config, allow_loopback_http, guard).await? {
        None => Ok(None),
        Some(remote) => Ok(Some(RemoteSnapshot {
            bytes: remote.bytes,
            etag: remote.etag.ok_or_else(|| WD_ETAG_REQUIRED.to_string())?,
        })),
    }
}

fn build_put_request(
    client: &Client,
    config: &NetworkConfig,
    condition: &RemoteCondition,
    bytes: Vec<u8>,
    allow_loopback_http: bool,
) -> Result<reqwest::Request, String> {
    let url = validate_url(&config.url, allow_loopback_http)?;
    validate_put_condition(condition, &url)?;
    let mut request = client
        .put(url)
        .basic_auth(&config.username, Some(&config.password))
        .header(header::CONTENT_TYPE, "application/octet-stream");
    request = match condition {
        RemoteCondition::IfMatch(etag) => request.header(header::IF_MATCH, etag),
        RemoteCondition::IfNoneMatch => request.header(header::IF_NONE_MATCH, "*"),
    };
    request
        .body(bytes)
        .build()
        .map_err(|_| WD_SERVER.to_string())
}

async fn execute_put(
    client: &Client,
    request: reqwest::Request,
    guard: Option<(&str, u64)>,
) -> Result<(), String> {
    // Creating the request is inert; network IO starts only under the cancellation guard.
    let send = async { client.execute(request).await };
    let response = match guard {
        Some((vault, epoch)) => checked_send(send, vault, epoch).await?,
        None => send.await.map_err(|_| WD_NETWORK.to_string())?,
    };
    if response.status() == StatusCode::PRECONDITION_FAILED {
        return Err(WD_REMOTE_CHANGED.to_string());
    }
    if !matches!(
        response.status(),
        StatusCode::OK | StatusCode::CREATED | StatusCode::NO_CONTENT
    ) {
        return Err(map_status(response.status()));
    }
    Ok(())
}

async fn put_remote(
    client: &Client,
    config: &NetworkConfig,
    condition: &RemoteCondition,
    bytes: Vec<u8>,
    allow_loopback_http: bool,
    guard: Option<(&str, u64)>,
) -> Result<(), String> {
    let request = build_put_request(client, config, condition, bytes, allow_loopback_http)?;
    execute_put(client, request, guard).await
}

fn local_stat(path: &Path) -> Result<crate::VaultStat, String> {
    let metadata = fs::metadata(path).map_err(|_| WD_LOCAL_IO.to_string())?;
    if !metadata.is_file() {
        return Err(WD_LOCAL_IO.to_string());
    }
    let modified = metadata
        .modified()
        .map_err(|_| WD_LOCAL_IO.to_string())?
        .duration_since(UNIX_EPOCH)
        .map_err(|_| WD_LOCAL_IO.to_string())?;
    Ok(crate::VaultStat {
        mtime_ms: modified.as_millis() as u64,
        size: metadata.len(),
        mtime_ns: modified.as_nanos().to_string(),
    })
}

fn stats_match(left: &crate::VaultStat, right: &crate::VaultStat) -> bool {
    left.mtime_ms == right.mtime_ms && left.size == right.size && left.mtime_ns == right.mtime_ns
}

fn read_local_for_upload(
    path: &Path,
    expected: &crate::VaultStat,
) -> Result<(Vec<u8>, crate::VaultStat), String> {
    let before = local_stat(path)?;
    if !stats_match(&before, expected) {
        return Err(WD_LOCAL_CHANGED.to_string());
    }
    if before.size > MAX_REMOTE_BYTES as u64 {
        return Err(WD_TOO_LARGE.to_string());
    }
    let file = File::open(path).map_err(|_| WD_LOCAL_IO.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_REMOTE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| WD_LOCAL_IO.to_string())?;
    if bytes.len() > MAX_REMOTE_BYTES {
        return Err(WD_TOO_LARGE.to_string());
    }
    if !crate::is_kdbx(&bytes) {
        return Err(WD_REMOTE_INVALID.to_string());
    }
    let after = local_stat(path)?;
    if !stats_match(&after, expected) {
        return Err(WD_LOCAL_CHANGED.to_string());
    }
    Ok((bytes, after))
}

#[tauri::command]
pub async fn webdav_get_config(
    window: WebviewWindow,
    app: tauri::AppHandle,
    vault_path: String,
) -> Result<ConfigView, String> {
    require_main(&window)?;
    let vault = canonical_vault_path(&vault_path)?;
    let path = profile_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || read_config_view(&path, &vault))
        .await
        .map_err(|_| WD_CONFIG_IO.to_string())?
}

#[tauri::command]
pub async fn webdav_save_config(
    window: WebviewWindow,
    app: tauri::AppHandle,
    vault_path: String,
    url: String,
    username: String,
    password: Option<String>,
) -> Result<ConfigView, String> {
    require_main(&window)?;
    let vault = canonical_vault_path(&vault_path)?;
    validate_url(&url, false)?;
    validate_username(&username)?;
    if let Some(ref password) = password {
        validate_password(password)?;
    }
    invalidate(&vault)?;
    let path = profile_path(&app)?;
    let result = tauri::async_runtime::spawn_blocking(move || {
        save_config(&path, &vault, &url, &username, password)
    })
    .await
    .map_err(|_| WD_CONFIG_IO.to_string())?;
    let _ = invalidate(&canonical_vault_path(&vault_path).unwrap_or(vault_path));
    result
}

#[tauri::command]
pub async fn webdav_forget_config(
    window: WebviewWindow,
    app: tauri::AppHandle,
    vault_path: String,
) -> Result<(), String> {
    require_main(&window)?;
    let vault = canonical_vault_path(&vault_path)?;
    invalidate(&vault)?;
    let path = profile_path(&app)?;
    let result = tauri::async_runtime::spawn_blocking(move || forget_config(&path, &vault))
        .await
        .map_err(|_| WD_CONFIG_IO.to_string())?;
    let _ = invalidate(&canonical_vault_path(&vault_path).unwrap_or(vault_path));
    result
}

#[tauri::command]
pub async fn webdav_test_connection(
    window: WebviewWindow,
    app: tauri::AppHandle,
    vault_path: String,
) -> Result<ExistsView, String> {
    require_main(&window)?;
    let vault = canonical_vault_path(&vault_path)?;
    let epoch = current_epoch(&vault)?;
    let path = profile_path(&app)?;
    let blocking_path = path.clone();
    let blocking_vault = vault.clone();
    let config = tauri::async_runtime::spawn_blocking(move || {
        load_network_config(&blocking_path, &blocking_vault)
    })
    .await
    .map_err(|_| WD_CONFIG_IO.to_string())??;
    let client = make_client(false)?;
    check_epoch(&vault, epoch)?;
    probe_remote(&client, &config, false, Some((&vault, epoch))).await
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EtagStatus {
    Strong,
    NutstoreCompatible,
    Missing,
    Weak,
    Invalid,
    NotChecked,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistsView {
    exists: bool,
    etag_status: EtagStatus,
}

async fn probe_remote(
    client: &Client,
    config: &NetworkConfig,
    allow_loopback_http: bool,
    guard: Option<(&str, u64)>,
) -> Result<ExistsView, String> {
    let remote = fetch_remote(client, config, allow_loopback_http, guard).await?;
    Ok(ExistsView {
        exists: remote.is_some(),
        etag_status: remote
            .map(|value| value.etag_status)
            .unwrap_or(EtagStatus::NotChecked),
    })
}

#[tauri::command]
pub async fn webdav_prepare_sync(
    window: WebviewWindow,
    app: tauri::AppHandle,
    vault_path: String,
    allow_create: bool,
) -> Result<PrepareResult, String> {
    require_main(&window)?;
    let vault = canonical_vault_path(&vault_path)?;
    let epoch = current_epoch(&vault)?;
    let path = profile_path(&app)?;
    let load_path = path.clone();
    let load_vault = vault.clone();
    let config =
        tauri::async_runtime::spawn_blocking(move || load_network_config(&load_path, &load_vault))
            .await
            .map_err(|_| WD_CONFIG_IO.to_string())??;
    check_epoch(&vault, epoch)?;
    let client = make_client(false)?;
    let remote = get_remote(&client, &config, false, Some((&vault, epoch))).await?;
    let condition = select_condition(
        remote.as_ref(),
        allow_create,
        &validate_url(&config.url, false)?,
    )?;
    let check_path = path.clone();
    let check_vault = vault.clone();
    let revision = config.revision;
    let revision_current = tauri::async_runtime::spawn_blocking(move || {
        revision_is_current(&check_path, &check_vault, revision)
    })
    .await
    .map_err(|_| WD_CONFIG_IO.to_string())??;
    if !revision_current {
        return Err(WD_CANCELLED.to_string());
    }
    check_epoch(&vault, epoch)?;
    let token = insert_ticket(&vault, revision, epoch, condition)?;
    Ok(PrepareResult {
        token,
        bytes: remote.map(|snapshot| snapshot.bytes),
    })
}

#[tauri::command]
pub async fn webdav_commit_sync(
    window: WebviewWindow,
    app: tauri::AppHandle,
    vault_path: String,
    token: String,
    expected_stat: crate::VaultStat,
) -> Result<CommitResult, String> {
    require_main(&window)?;
    let vault = canonical_vault_path(&vault_path)?;
    let ticket = consume_ticket(&vault, &token)?;
    let epoch = ticket.epoch;
    let path = profile_path(&app)?;
    let load_path = path.clone();
    let load_vault = vault.clone();
    let config =
        tauri::async_runtime::spawn_blocking(move || load_network_config(&load_path, &load_vault))
            .await
            .map_err(|_| WD_CONFIG_IO.to_string())??;
    if config.revision != ticket.revision {
        return Err(WD_TICKET_INVALID.to_string());
    }
    check_epoch(&vault, epoch)?;
    let local_path = PathBuf::from(&vault);
    let (bytes, uploaded_stat) = tauri::async_runtime::spawn_blocking(move || {
        read_local_for_upload(&local_path, &expected_stat)
    })
    .await
    .map_err(|_| WD_LOCAL_IO.to_string())??;
    check_epoch(&vault, epoch)?;
    let check_path = path.clone();
    let check_vault = vault.clone();
    let revision = config.revision;
    let revision_current = tauri::async_runtime::spawn_blocking(move || {
        revision_is_current(&check_path, &check_vault, revision)
    })
    .await
    .map_err(|_| WD_CONFIG_IO.to_string())??;
    if !revision_current {
        return Err(WD_CANCELLED.to_string());
    }
    check_epoch(&vault, epoch)?;
    let client = make_client(false)?;
    put_remote(
        &client,
        &config,
        &ticket.condition,
        bytes,
        false,
        Some((&vault, epoch)),
    )
    .await?;
    let synced_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    let metadata_saved = if current_epoch(&vault).ok() == Some(epoch) {
        let persist_path = path.clone();
        let persist_vault = vault.clone();
        tauri::async_runtime::spawn_blocking(move || {
            record_sync(&persist_path, &persist_vault, revision, synced_at)
        })
        .await
        .unwrap_or(false)
    } else {
        false
    };
    Ok(CommitResult {
        uploaded_stat,
        synced_at,
        metadata_saved,
    })
}

#[tauri::command]
pub fn webdav_cancel_sync(window: WebviewWindow, vault_path: String) -> Result<(), String> {
    require_main(&window)?;
    let key = key_for_cancel(&vault_path);
    invalidate(&key).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{TcpListener, TcpStream};
    use std::thread;

    fn fake_kdbx() -> Vec<u8> {
        b"\x03\xd9\xa2\x9a\x67\xfb\x4b\xb5\x00\x00\x04\x00synthetic".to_vec()
    }
    fn serve_request(stream: &mut TcpStream, response: &[u8]) -> String {
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut data = Vec::new();
        let mut buf = [0u8; 4096];
        let end;
        loop {
            let count = stream.read(&mut buf).unwrap();
            assert!(count > 0);
            data.extend_from_slice(&buf[..count]);
            if let Some(index) = data.windows(4).position(|b| b == b"\r\n\r\n") {
                end = index + 4;
                break;
            }
        }
        let headers = String::from_utf8_lossy(&data[..end]).to_string();
        let length = headers
            .lines()
            .find_map(|line| {
                line.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .and_then(|n| n.trim().parse::<usize>().ok())
            })
            .unwrap_or(0);
        while data.len() < end + length {
            let count = stream.read(&mut buf).unwrap();
            assert!(count > 0);
            data.extend_from_slice(&buf[..count]);
        }
        stream.write_all(response).unwrap();
        stream.flush().unwrap();
        headers
    }
    fn loopback_config(address: std::net::SocketAddr) -> NetworkConfig {
        NetworkConfig {
            url: format!("http://{address}/vault.kdbx"),
            username: "synthetic-user".into(),
            password: "synthetic password".into(),
            revision: 1,
        }
    }

    #[test]
    fn production_url_and_etag_validation_is_strict() {
        assert!(validate_url("https://dav.jianguoyun.com/dav/KeyTree/vault.kdbx", false).is_ok());
        for invalid in [
            "http://cloud.example/vault.kdbx",
            "https://u:p@cloud.example/vault.kdbx",
            "https://cloud.example/vault.kdbx?q=1",
            "https://cloud.example/vault.kdbx#part",
            "https://cloud.example/folder/",
            "https://cloud.example/vault.kdbx\n",
            "https://www.jianguoyun.com/c/sd/synthetic",
        ] {
            assert_eq!(validate_url(invalid, false).unwrap_err(), WD_INVALID_URL);
        }
        let mut headers = HeaderMap::new();
        for invalid in ["W/\"weak\"", "no-quotes", "\"bad\nvalue\""] {
            headers.clear();
            if let Ok(value) = header::HeaderValue::from_bytes(invalid.as_bytes()) {
                headers.insert(header::ETAG, value);
            }
            assert_eq!(strong_etag(&headers).unwrap_err(), WD_ETAG_REQUIRED);
        }
        headers.clear();
        assert_eq!(strong_etag(&headers).unwrap_err(), WD_ETAG_REQUIRED);
        headers.insert(header::ETAG, header::HeaderValue::from_static("\"v1\""));
        assert_eq!(strong_etag(&headers).unwrap(), "\"v1\"");
        headers.append(header::ETAG, header::HeaderValue::from_static("\"v2\""));
        assert_eq!(strong_etag(&headers).unwrap_err(), WD_ETAG_REQUIRED);
    }

    #[test]
    fn loopback_binary_get_and_conditional_put_handle_412_and_create() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let config = loopback_config(listener.local_addr().unwrap());
        let body = fake_kdbx();
        let response_body = body.clone();
        let server = thread::spawn(move || {
            let mut observed = Vec::new();
            let mut response = format!("HTTP/1.1 200 OK\r\nETag: \"v1\"\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", response_body.len()).into_bytes();
            response.extend(response_body);
            observed.push(serve_request(&mut listener.accept().unwrap().0, &response));
            for response in [
                b"HTTP/1.1 412 Precondition Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".as_slice(),
                b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".as_slice(),
                b"HTTP/1.1 201 Created\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".as_slice(),
            ] { observed.push(serve_request(&mut listener.accept().unwrap().0, response)); }
            observed
        });
        tauri::async_runtime::block_on(async {
            let client = make_client(true).unwrap();
            let remote = get_remote(&client, &config, true, None)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(remote.bytes, body);
            assert_eq!(
                put_remote(
                    &client,
                    &config,
                    &RemoteCondition::IfMatch(remote.etag),
                    body.clone(),
                    true,
                    None
                )
                .await
                .unwrap_err(),
                WD_REMOTE_CHANGED
            );
            assert!(get_remote(&client, &config, true, None)
                .await
                .unwrap()
                .is_none());
            put_remote(
                &client,
                &config,
                &RemoteCondition::IfNoneMatch,
                body,
                true,
                None,
            )
            .await
            .unwrap();
        });
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET "));
        assert!(requests[1]
            .to_ascii_lowercase()
            .contains("if-match: \"v1\""));
        assert!(requests[3]
            .to_ascii_lowercase()
            .contains("if-none-match: *"));
    }

    #[test]
    fn network_rejects_redirect_unconfirmed_put_invalid_body_and_oversize() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let config = loopback_config(listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            for response in [
                "HTTP/1.1 302 Found\r\nLocation: https://example.invalid/secret.kdbx\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                "HTTP/1.1 200 OK\r\nETag: \"big\"\r\nContent-Length: 67108865\r\nConnection: close\r\n\r\n",
            ] { serve_request(&mut listener.accept().unwrap().0, response.as_bytes()); }
        });
        tauri::async_runtime::block_on(async {
            let client = make_client(true).unwrap();
            assert!(
                matches!(get_remote(&client, &config, true, None).await, Err(e) if e == WD_REDIRECT)
            );
            assert_eq!(
                put_remote(
                    &client,
                    &config,
                    &RemoteCondition::IfNoneMatch,
                    fake_kdbx(),
                    true,
                    None
                )
                .await
                .unwrap_err(),
                WD_SERVER
            );
            assert!(
                matches!(get_remote(&client, &config, true, None).await, Err(e) if e == WD_REMOTE_INVALID)
            );
            assert!(
                matches!(get_remote(&client, &config, true, None).await, Err(e) if e == WD_TOO_LARGE)
            );
        });
        server.join().unwrap();
    }

    #[test]
    fn read_only_probe_distinguishes_etag_without_relaxing_sync() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let config = loopback_config(listener.local_addr().unwrap());
        let variants = [
            ("", EtagStatus::Missing),
            ("ETag: W/\"v1\"\r\n", EtagStatus::Weak),
            ("ETag: unquoted-v1\r\n", EtagStatus::Invalid),
            ("ETag: \"v1\"\r\n", EtagStatus::Strong),
        ];
        let server = thread::spawn(move || {
            for (header, _) in variants {
                for _ in 0..2 {
                    let body = fake_kdbx();
                    let mut response = format!("HTTP/1.1 200 OK\r\n{header}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len()).into_bytes();
                    response.extend(body);
                    let request = serve_request(&mut listener.accept().unwrap().0, &response);
                    assert!(
                        request.starts_with("GET "),
                        "read-only inspection and prepare must not PUT"
                    );
                }
            }
        });
        tauri::async_runtime::block_on(async {
            let client = make_client(true).unwrap();
            for (_, expected) in variants {
                let result = probe_remote(&client, &config, true, None)
                    .await
                    .expect("readable KDBX must report a diagnostic, not a generic ETag error");
                assert!(result.exists);
                assert_eq!(result.etag_status, expected);
                let sync = get_remote(&client, &config, true, None).await;
                if expected == EtagStatus::Strong {
                    assert!(sync.unwrap().is_some());
                } else {
                    assert!(
                        matches!(sync, Err(e) if e == WD_ETAG_REQUIRED),
                        "sync must still refuse missing/weak/invalid validators"
                    );
                }
            }
        });
        server.join().unwrap();
    }

    #[test]
    fn read_only_probe_reports_html_before_etag_capability() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let config = loopback_config(listener.local_addr().unwrap());
        let server = thread::spawn(move || {
            let html = "<html>synthetic login page</html>";
            let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len());
            serve_request(&mut listener.accept().unwrap().0, response.as_bytes());
        });
        tauri::async_runtime::block_on(async {
            let result = probe_remote(&make_client(true).unwrap(), &config, true, None).await;
            assert!(
                matches!(result, Err(e) if e == WD_REMOTE_INVALID),
                "an HTML response must not be mistaken for a KDBX lacking an ETag"
            );
        });
        server.join().unwrap();
    }

    #[test]
    fn nutstore_bare_etag_is_preserved_but_not_enabled_for_other_origins() {
        let url = Url::parse("https://dav.jianguoyun.com/dav/KeyTree/synthetic.kdbx").unwrap();
        let mut headers = HeaderMap::new();
        let token = "8sKBsnMc5tH71U67xjQTCQ";
        headers.insert(
            header::ETAG,
            header::HeaderValue::from_static("8sKBsnMc5tH71U67xjQTCQ"),
        );
        assert_eq!(
            upload_etag(&headers, &url)
                .expect("Nutstore bare ETag must remain a usable exact-match validator"),
            token
        );
        assert!(
            strong_etag(&headers).is_err(),
            "bare values must not be mislabeled RFC strong ETags"
        );
        for raw_url in [
            "https://other.example/dav/synthetic.kdbx",
            "https://dav.jianguoyun.com.evil.example/dav/synthetic.kdbx",
            "https://dav.jianguoyun.com:8443/dav/synthetic.kdbx",
            "https://dav.jianguoyun.com/not-dav/synthetic.kdbx",
        ] {
            assert!(
                upload_etag(&headers, &Url::parse(raw_url).unwrap()).is_err(),
                "bare compatibility must not escape the exact service scope"
            );
        }
        for value in [
            "*",
            "W/\"weak\"",
            "W/weak",
            "two tags",
            "a,b",
            "\"broken",
            "[tag]",
            "sha256:synthetic",
            "a/b",
            "a=b",
            "",
        ] {
            headers.clear();
            headers.insert(header::ETAG, header::HeaderValue::from_str(value).unwrap());
            assert!(
                upload_etag(&headers, &url).is_err(),
                "unsafe value must not become an update condition"
            );
        }
        headers.clear();
        headers.insert(header::ETAG, header::HeaderValue::from_static("bare-v1"));
        headers.append(header::ETAG, header::HeaderValue::from_static("bare-v2"));
        assert!(upload_etag(&headers, &url).is_err());
    }

    #[test]
    fn nutstore_create_only_is_blocked_even_with_explicit_allow_create() {
        let nutstore = Url::parse("https://dav.jianguoyun.com/dav/KeyTree/synthetic.kdbx").unwrap();
        assert_eq!(
            select_condition(None, true, &nutstore).unwrap_err(),
            WD_CREATE_UNSUPPORTED,
            "Nutstore must not rely on an ignored If-None-Match header to protect a shared KDBX"
        );
        assert_eq!(
            validate_put_condition(&RemoteCondition::IfNoneMatch, &nutstore).unwrap_err(),
            WD_CREATE_UNSUPPORTED
        );
        assert!(validate_put_condition(&RemoteCondition::IfMatch("*".into()), &nutstore).is_err());
        let generic = Url::parse("https://other.example/synthetic.kdbx").unwrap();
        assert!(matches!(
            select_condition(None, true, &generic).unwrap(),
            RemoteCondition::IfNoneMatch
        ));
        assert_eq!(
            select_condition(None, false, &generic).unwrap_err(),
            WD_REMOTE_MISSING
        );
    }

    #[test]
    fn nutstore_exact_if_match_updates_and_stale_version_never_overwrites() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let config = loopback_config(listener.local_addr().unwrap());
        let old_body = fake_kdbx();
        let initial = old_body.clone();
        let server = thread::spawn(move || {
            let token = "Nutstore-bare-v1";
            let mut response = format!("HTTP/1.1 200 OK\r\nETag: {token}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", initial.len()).into_bytes();
            response.extend(initial);
            let get = serve_request(&mut listener.accept().unwrap().0, &response);
            assert!(get
                .to_ascii_lowercase()
                .contains("accept-encoding: identity"));
            let matching = serve_request(
                &mut listener.accept().unwrap().0,
                b"HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
            assert!(matching
                .to_ascii_lowercase()
                .contains("if-match: nutstore-bare-v1\r\n"));
            assert!(
                !matching.contains("\"Nutstore-bare-v1\""),
                "must not repair the ETag by adding quotes"
            );
            // The server has now advanced to v2; a repeated v1 must fail, not retry without a condition.
            let stale = serve_request(&mut listener.accept().unwrap().0, b"HTTP/1.1 412 Precondition Failed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            assert!(stale
                .to_ascii_lowercase()
                .contains("if-match: nutstore-bare-v1\r\n"));
        });
        tauri::async_runtime::block_on(async {
            let client = make_client(true).unwrap();
            let remote = fetch_remote(&client, &config, true, None)
                .await
                .unwrap()
                .unwrap();
            assert_eq!(remote.bytes, old_body);
            // Keep the wire test loopback-only; classify the captured ETag against the production origin policy.
            let mut headers = HeaderMap::new();
            headers.insert(
                header::ETAG,
                header::HeaderValue::from_static("Nutstore-bare-v1"),
            );
            let origin = Url::parse("https://dav.jianguoyun.com/dav/synthetic.kdbx").unwrap();
            let token = upload_etag(&headers, &origin).unwrap();
            let condition = RemoteCondition::IfMatch(token);
            let provider = NetworkConfig {
                url: origin.to_string(),
                ..config.clone()
            };
            let mut request =
                build_put_request(&client, &provider, &condition, fake_kdbx(), false).unwrap();
            // Only reroute transport after production policy and header construction succeeded.
            *request.url_mut() = Url::parse(&config.url).unwrap();
            execute_put(&client, request, None).await.unwrap();
            let mut stale =
                build_put_request(&client, &provider, &condition, fake_kdbx(), false).unwrap();
            *stale.url_mut() = Url::parse(&config.url).unwrap();
            assert_eq!(
                execute_put(&client, stale, None).await.unwrap_err(),
                WD_REMOTE_CHANGED
            );
        });
        server.join().unwrap();
    }

    #[test]
    fn encrypted_config_roundtrip_reuses_only_same_origin_and_user() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic-profile.json");
        let vault = "synthetic-vault.kdbx";
        let secret = "synthetic password only";
        let first = save_config(
            &path,
            vault,
            "https://cloud.example/vault.kdbx",
            "synthetic-user",
            Some(secret.into()),
        )
        .unwrap();
        assert!(first.configured && first.has_password);
        assert_eq!(load_network_config(&path, vault).unwrap().password, secret);
        let raw = fs::read(&path).unwrap();
        assert!(!raw.windows(secret.len()).any(|w| w == secret.as_bytes()));
        assert!(!serde_json::to_string(&first).unwrap().contains(secret));
        assert!(record_sync(&path, vault, 1, 1000));
        let second = save_config(
            &path,
            vault,
            "https://cloud.example/other.kdbx",
            "synthetic-user",
            None,
        )
        .unwrap();
        assert_eq!(second.last_synced_at, None);
        assert!(
            matches!(save_config(&path, vault, "https://other.example/vault.kdbx", "synthetic-user", None), Err(e) if e == WD_CREDENTIALS_REQUIRED)
        );
        assert!(
            matches!(save_config(&path, vault, "https://cloud.example/other.kdbx", "other-user", None), Err(e) if e == WD_CREDENTIALS_REQUIRED)
        );
        forget_config(&path, vault).unwrap();
        assert!(!read_config_view(&path, vault).unwrap().configured);
    }

    #[test]
    fn invalidation_revokes_one_time_tickets_and_late_prepare() {
        let key = format!(
            "synthetic-ticket-{}",
            NEXT_TOKEN.fetch_add(1, Ordering::Relaxed)
        );
        let epoch = current_epoch(&key).unwrap();
        let token = insert_ticket(&key, 1, epoch, RemoteCondition::IfNoneMatch).unwrap();
        invalidate(&key).unwrap();
        assert_eq!(consume_ticket(&key, &token).unwrap_err(), WD_TICKET_INVALID);
        assert_eq!(
            insert_ticket(&key, 1, epoch, RemoteCondition::IfNoneMatch).unwrap_err(),
            WD_CANCELLED
        );
        let epoch = current_epoch(&key).unwrap();
        let token = insert_ticket(&key, 2, epoch, RemoteCondition::IfNoneMatch).unwrap();
        assert_eq!(consume_ticket(&key, &token).unwrap().revision, 2);
        assert_eq!(consume_ticket(&key, &token).unwrap_err(), WD_TICKET_INVALID);
    }

    #[test]
    fn cancelled_request_is_not_polled_or_sent() {
        let key = format!(
            "synthetic-cancel-{}",
            NEXT_TOKEN.fetch_add(1, Ordering::Relaxed)
        );
        let epoch = current_epoch(&key).unwrap();
        invalidate(&key).unwrap();
        let polled = std::sync::atomic::AtomicBool::new(false);
        let result = tauri::async_runtime::block_on(checked_send(
            async {
                polled.store(true, Ordering::Relaxed);
                Ok::<_, reqwest::Error>(())
            },
            &key,
            epoch,
        ));
        assert_eq!(result.unwrap_err(), WD_CANCELLED);
        assert!(!polled.load(Ordering::Relaxed));
    }

    #[test]
    fn upload_reads_only_matching_bounded_local_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("synthetic.kdbx");
        fs::write(&path, fake_kdbx()).unwrap();
        let stat = local_stat(&path).unwrap();
        assert_eq!(read_local_for_upload(&path, &stat).unwrap().0, fake_kdbx());
        let mut wrong = local_stat(&path).unwrap();
        wrong.mtime_ns.push('0');
        assert!(matches!(read_local_for_upload(&path, &wrong), Err(e) if e == WD_LOCAL_CHANGED));
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_REMOTE_BYTES as u64 + 1)
            .unwrap();
        assert!(
            matches!(read_local_for_upload(&path, &local_stat(&path).unwrap()), Err(e) if e == WD_TOO_LARGE)
        );
    }
}
