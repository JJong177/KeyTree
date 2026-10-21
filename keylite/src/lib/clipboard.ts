import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { onBeforeUnmount, onMounted } from "vue";
import { toast } from "./toast";
import { settings } from "./settings";

interface CopyResult { privacyProtected: boolean; clearScheduled: boolean }

/** Fail closed: only native clipboard ownership can safely schedule conditional clearing. */
export async function copyText(text: string, clearAfterMs?: number): Promise<boolean> {
  if (!text) return false;
  const configured = settings.clipboardSeconds * 1000;
  const requested = clearAfterMs === undefined ? configured : clearAfterMs;
  const delay = Number.isFinite(requested) ? Math.min(300000, Math.max(0, Math.round(requested))) : 30000;
  try {
    const result = await invoke<CopyResult>("copy_secret", { text, clearAfterMs: delay });
    const privacy = result.privacyProtected ? "" : "；系统隐私标记未全部生效，可能进入剪贴板历史";
    const clearing = delay > 0 && result.clearScheduled
      ? ` · ${Math.round(delay / 1000)} 秒后自动清空`
      : delay > 0 ? "；自动清空未启用，请手动清理" : " · 未设置定时清空";
    toast(`已复制${clearing}${privacy}`, privacy ? 6000 : 3000);
    return true;
  } catch {
    toast("安全复制失败，请重试（未使用浏览器剪贴板降级）");
    return false;
  }
}

/** Native notifications contain lifecycle metadata only, never copied content. */
export function useClipboardStatus(): void {
  let stop: (() => void) | undefined;
  let disposed = false;
  onMounted(async () => {
    try {
      const unlisten = await listen<{ kind: string }>("keytree:clipboard-status", event => {
        if (event.payload.kind === "clear-failed") toast("剪贴板自动清理失败，请手动清理", 6000);
        else if (event.payload.kind === "expiring") toast("剪贴板内容即将到期", 1500);
      });
      if (disposed) unlisten(); else stop = unlisten;
    } catch { /* Copy command still reports its own result. */ }
  });
  onBeforeUnmount(() => { disposed = true; stop?.(); });
}
