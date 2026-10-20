import { toast } from "./toast";
import { settings } from "./settings";

/**
 * 复制文本。
 * WebView2 里 navigator.clipboard 在 https/tauri 环境下通常可用，
 * 但窗口失焦或权限受限时会抛错，这里保留 execCommand 兜底。
 *
 * clearAfterMs 不传时按设置里的「剪贴板清空秒数」处理；传 0 表示不清空。
 */
export async function copyText(text: string, clearAfterMs?: number): Promise<void> {
  if (!text) return;

  const configured = settings.clipboardSeconds * 1000;
  const delay = clearAfterMs === undefined ? configured : clearAfterMs;

  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    ok = fallbackCopy(text);
  }

  if (!ok) {
    toast("复制失败");
    return;
  }
  toast(
    delay > 0
      ? `已复制 · ${Math.round(delay / 1000)} 秒后自动清空`
      : "已复制"
  );

  if (!delay) return;
  const snapshot = text;
  window.setTimeout(async () => {
    try {
      const current = await navigator.clipboard.readText();
      if (current === snapshot) await navigator.clipboard.writeText("");
    } catch {
      // 读不到剪贴板就放弃清空，不打扰用户
    }
  }, delay);
}

function fallbackCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
