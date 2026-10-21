import { onBeforeUnmount, onMounted, watch } from "vue";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useVault } from "./useVault";
import { settings } from "../lib/settings";
import { toast } from "../lib/toast";
import { generateTotp } from "../lib/totp";
import { recordAudit } from "../lib/audit";
import { PANEL_REQUEST_EVENT, PANEL_RESPONSE_EVENT, type PanelEntry, type PanelRequest, type PanelResponse, type CopyAction } from "../lib/panel";

export function usePanelHost(): void {
  const { unlocked, vaultPath, entries, draftOf, totpConfigOf, autoType, selectGroup, selectEntry, touchUsage, error } = useVault();
  let session = Date.now(), unlisten: UnlistenFn | undefined;
  let disposed = false;
  const grants = new Map<string, { id: string; action: CopyAction; at: number }>();
  const reply = (payload: PanelResponse) => emitTo("panel", PANEL_RESPONSE_EVENT, payload);
  function snapshot(): PanelEntry[] {
    return entries.value.filter(e => !e.inTrash).map(e => ({ id: e.uuid, title: e.title, username: e.username, url: e.url, hasTotp: e.hasTotp, totpPeriod: e.totpPeriod, icon: e.icon, tags: e.tags, updatedAt: e.updatedAt?.getTime() ?? null, lastUsedAt: e.lastUsedAt?.getTime() ?? null, usageCount: e.usageCount, favorite: e.favorite }));
  }
  function sync() { return reply({ kind: "state", unlocked: unlocked.value, session, entries: unlocked.value ? snapshot() : [] }); }
  const stopSession = watch([unlocked, vaultPath], () => { session++; grants.clear(); }, { flush: "sync" });
  const stopSnapshot = watch([unlocked, entries], () => { void sync().catch(() => {}); }, { flush: "post" });
  async function handle(request: PanelRequest) {
    if (request.kind === "sync") { await sync(); return; }
    if (!unlocked.value || request.session !== session) { await sync(); return; }
    if (!entries.value.some(e => e.uuid === request.id && !e.inTrash)) return;
    if (request.kind === "copied") {
      const grant = grants.get(request.requestId); grants.delete(request.requestId);
      if (!grant || grant.id !== request.id || Date.now() - grant.at > 30000) return;
      if (grant.action !== "username") void touchUsage(request.id);
      if (grant.action === "password") void recordAudit("copy-password", request.id);
      return;
    }
    if (request.kind === "copy") {
      if (typeof request.requestId !== "string" || request.requestId.length > 100) return;
      const currentSession = session;
      let value = "", ttl = settings.clipboardSeconds;
      if (request.action === "totp") {
        const cfg = totpConfigOf(request.id); if (!cfg) return;
        const result = await generateTotp(cfg); value = result.code; ttl = result.remaining;
      } else {
        const draft = draftOf(request.id); if (!draft) return;
        if (request.action === "password") value = draft.password;
        else if (request.action === "username") { value = draft.username; ttl = 0; }
        else return;
      }
      if (session !== currentSession || !unlocked.value) return;
      for (const [key, grant] of grants) if (Date.now() - grant.at > 30000) grants.delete(key);
      if (grants.size >= 100) grants.clear();
      grants.set(request.requestId, { id: request.id, action: request.action, at: Date.now() });
      await reply({ kind: "copy", action: request.action, id: request.id, value, ttl, requestId: request.requestId, session });
    } else if (request.kind === "auto-type") {
      const ok = await autoType(request.id);
      toast(ok ? "已发送自动输入" : error.value || "自动输入失败");
    } else if (request.kind === "focus") {
      await invoke("show_main_window"); selectGroup("all"); selectEntry(request.id);
    }
  }
  onMounted(async () => {
    const off = await listen<PanelRequest>(PANEL_REQUEST_EVENT, event => { void handle(event.payload).catch(() => toast("快速访问操作失败，请重试")); });
    if (disposed) off(); else unlisten = off;
  });
  onBeforeUnmount(() => { disposed = true; unlisten?.(); stopSession(); stopSnapshot(); grants.clear(); });
}
