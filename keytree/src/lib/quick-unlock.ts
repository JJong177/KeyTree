import { watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { settings } from "./settings";
import { toast } from "./toast";

let queue: Promise<void> = Promise.resolve();
let generation = 0;
export function credentialCachingAllowed(): boolean {
  return settings.quickUnlock && !settings.highSecurityMode;
}
/** Serialize deletion after all in-flight writes; a late cache write cannot resurrect it. */
export function clearQuickUnlockCache(vaultPath?: string): Promise<void> {
  generation++;
  const job = queue.catch(() => {}).then(() => invoke<void>("quick_unlock_clear", vaultPath ? { vaultPath } : {}));
  queue = job;
  return job;
}
export function cacheQuickUnlock(path: string, password: string, keyFile: Uint8Array | null): Promise<void> {
  if (!credentialCachingAllowed()) return clearQuickUnlockCache();
  const ticket = generation;
  const job = queue.catch(() => {}).then(async () => {
    if (ticket !== generation || !credentialCachingAllowed()) return;
    const secret = new TextEncoder().encode(JSON.stringify({ p: password, k: keyFile ? Array.from(keyFile) : null }));
    try { await invoke("quick_unlock_save", { vaultPath: path, secret: Array.from(secret) }); }
    finally { secret.fill(0); }
  });
  queue = job;
  return job;
}
let installed = false;
/** Main application only: the quick panel cannot call credential commands. */
export function installQuickUnlockPolicy(): void {
  if (installed) return;
  installed = true;
  watch(() => [settings.quickUnlock, settings.highSecurityMode] as const, () => {
    if (settings.highSecurityMode) {
      settings.quickUnlock = false;
      settings.autoHelloUnlock = false;
    }
    if (!credentialCachingAllowed()) {
      void clearQuickUnlockCache().catch(() => toast("本机解锁缓存清理失败，请在安全设置中重试；不要假定缓存已删除", 8000));
    }
  }, { flush: "sync", immediate: true });
}
