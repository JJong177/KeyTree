import { invoke } from "@tauri-apps/api/core";
import type { WebdavConfig, WebdavPrepared, WebdavStat } from "./webdav";

/** Ciphertext fingerprint only; never accepts passwords or decrypted entries. */
export async function ciphertextFingerprint(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
const sameStat = (a: WebdavStat | null, b: WebdavStat) => !!a && !!a.mtimeNs
  && a.mtimeNs === b.mtimeNs && a.mtimeMs === b.mtimeMs && a.size === b.size;

/** Lock first. Only upload a saved ciphertext if the remote has not changed from a known baseline. */
export async function syncLockedVault(
  path: string,
  expectedStat: WebdavStat,
  savedFingerprint: string | null,
  baselineFingerprint: string | null,
  active: () => boolean
): Promise<"synced" | "unconfigured"> {
  const check = () => { if (!active()) throw "WD_CANCELLED"; };
  let prepared = false;
  let committed = false;
  try {
    check();
    const config = await invoke<WebdavConfig>("webdav_get_config", { vaultPath: path });
    check();
    if (!config.configured) return "unconfigured";
    if (!sameStat(await invoke<WebdavStat>("stat_vault", { path }), expectedStat)) throw "WD_LOCAL_CHANGED";
    check();
    const bytes = await invoke<number[]>("read_vault", { path });
    check();
    const fingerprint = await ciphertextFingerprint(Uint8Array.from(bytes).buffer);
    check();
    if ((savedFingerprint !== null && fingerprint !== savedFingerprint)
      || !sameStat(await invoke<WebdavStat>("stat_vault", { path }), expectedStat)) throw "WD_LOCAL_CHANGED";
    check();
    const remote = await invoke<WebdavPrepared>("webdav_prepare_sync", { vaultPath: path, allowCreate: false });
    prepared = true;
    check();
    if (!remote.bytes) throw "WD_REMOTE_MISSING";
    const remoteFingerprint = await ciphertextFingerprint(Uint8Array.from(remote.bytes).buffer);
    check();
    if (remoteFingerprint !== fingerprint && remoteFingerprint !== baselineFingerprint) throw "WD_REMOTE_CHANGED";
    if (remoteFingerprint !== fingerprint) {
      await invoke("webdav_commit_sync", { vaultPath: path, token: remote.token, expectedStat });
      committed = true;
      check();
    }
    return "synced";
  } finally {
    if (prepared && !committed && active()) await invoke("webdav_cancel_sync", { vaultPath: path }).catch(() => {});
  }
}
