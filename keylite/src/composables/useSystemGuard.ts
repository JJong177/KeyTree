import { onBeforeUnmount, onMounted, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useVault } from "./useVault";
import { settings } from "../lib/settings";
import { toast } from "../lib/toast";

/**
 * 系统级守卫：
 * 1. Rust 侧隐藏窗口监听「锁屏 / 休眠」，事件一到立即锁定库（空闲计时之外的第二道防线）
 * 2. 窗口防截屏：主窗口 + 快速面板设 display affinity，截图/录屏里显示为黑块
 *    （WebView2 的子窗口可能晚于启动创建，所以延迟补一次）
 */
export function useSystemGuard(): void {
  const { unlocked, lock } = useVault();
  let unlisten: UnlistenFn | undefined;

  function applyProtection(): void {
    invoke("set_screenshot_protection", {
      enable: settings.screenshotProtection,
    }).catch(() => {
      // 设不上就算了（非 Windows / 权限异常），不阻塞启动
    });
  }

  onMounted(async () => {
    applyProtection();
    // WebView2 子窗口的创建时机不确定，稍后再补一次，尽量把内容窗口都罩住
    window.setTimeout(applyProtection, 2000);

    unlisten = await listen<string>("keytree:system-lock", (event) => {
      if (!unlocked.value) return;
      lock();
      const why = event.payload === "suspend" ? "系统休眠" : "屏幕锁定";
      toast(`${why}，密码库已锁定`, 3000);
    });
  });

  onBeforeUnmount(() => {
    unlisten?.();
  });

  // 设置里开关防截屏时立即生效
  watch(() => settings.screenshotProtection, applyProtection);
}
