<script setup lang="ts">
import { onBeforeUnmount, onMounted, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useVault } from "./composables/useVault";
import { useClipboardStatus } from "./lib/clipboard";
import { useAutoLock } from "./composables/useAutoLock";
import { useSystemGuard } from "./composables/useSystemGuard";
import { useVaultSync } from "./composables/useVaultSync";
import { usePanelHost } from "./composables/usePanelHost";
import UnlockView from "./components/UnlockView.vue";
import MainView from "./components/MainView.vue";
import ToastHost from "./components/ToastHost.vue";

const { unlocked, flushSave, syncExternalChanges } = useVault();

useAutoLock();
useClipboardStatus();
useSystemGuard();
useVaultSync();
usePanelHost();

// 托盘图标如实反映库状态：锁定 / 已解锁两枚，形状和颜色都不同
watch(
  unlocked,
  (value) => {
    void invoke("set_tray_state", { unlocked: value }).catch(() => {
      // 非 Windows 或托盘不可用：不影响主流程
    });
  },
  { immediate: true }
);

// 窗口失焦 / 被隐藏（关闭到托盘）时，把 500ms 合并窗口里的改动立刻落盘
function flushPending(): void {
  void flushSave();
}
function onVisibilityChange(): void {
  if (document.hidden) flushPending();
}

/**
 * 回到窗口时补一次磁盘检查。
 * watcher 在休眠唤醒、网盘延迟落盘、UNC/网络路径这些场景可能漏事件；
 * 每次获得焦点对一次 stat 最省事——内部用 knownStat 认自写事件，不会误合并。
 */
function onFocus(): void {
  void syncExternalChanges();
}

onMounted(() => {
  window.addEventListener("blur", flushPending);
  window.addEventListener("focus", onFocus);
  document.addEventListener("visibilitychange", onVisibilityChange);
});
onBeforeUnmount(() => {
  window.removeEventListener("blur", flushPending);
  window.removeEventListener("focus", onFocus);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<template>
  <UnlockView v-if="!unlocked" class="lock-arrival" />
  <MainView v-else />
  <ToastHost />
</template>
