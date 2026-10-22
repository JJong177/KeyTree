import { onBeforeUnmount, onMounted, watch } from "vue";
import { useVault } from "./useVault";
import { settings } from "../lib/settings";
import { toast } from "../lib/toast";

const ACTIVITY_EVENTS = [
  "mousemove",
  "mousedown",
  "keydown",
  "wheel",
  "touchstart",
] as const;

/**
 * 空闲自动锁定：任何输入都重置计时器，超时后清空内存中的库并回到解锁页。
 * 只在前端做（窗口进程活着就有效）；「系统休眠/锁屏」需要 Rust 侧事件，留到后续补。
 */
export function useAutoLock(): void {
  const { unlocked, lock, error } = useVault();
  let timer: number | undefined;

  function clear(): void {
    if (timer) {
      window.clearTimeout(timer);
      timer = undefined;
    }
  }

  function arm(): void {
    clear();
    if (!unlocked.value) return;
    const minutes = settings.autoLockMinutes;
    if (!minutes || minutes <= 0) return;
    timer = window.setTimeout(() => {
      // 锁定会先把合并窗口里的改动落盘，完成后再提示
      void lock({ force: true }).then((locked) => {
        if (locked) toast(error.value || "长时间未操作，已自动锁定", error.value ? 6000 : 3000);
      });
    }, minutes * 60_000);
  }

  function onActivity(): void {
    if (unlocked.value) arm();
  }

  onMounted(() => {
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }
    arm();
  });

  onBeforeUnmount(() => {
    clear();
    for (const event of ACTIVITY_EVENTS) {
      window.removeEventListener(event, onActivity);
    }
  });

  watch(unlocked, arm);
  watch(() => settings.autoLockMinutes, arm);
}
