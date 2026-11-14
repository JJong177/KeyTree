<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipPortal, TooltipContent } from "radix-vue";
import { useVault } from "../composables/useVault";
const props = defineProps<{ blocked?: boolean }>();
const emit = defineEmits<{ configure: [] }>();
const { vaultPath, unlocked, busy, drawer, hasUnsavedChanges, webdavState, webdavAvailability, refreshWebdavAvailability, syncWebdav } = useVault();
watch([vaultPath, unlocked], () => { if (unlocked.value) void refreshWebdavAvailability(); }, { immediate: true });
const statusOpen = ref(false);
watch([() => props.blocked, () => drawer.value.open], ([blocked, editing]) => {
  if (blocked || editing) statusOpen.value = false;
});
const disabled = computed(() => props.blocked || busy.value || drawer.value.open || webdavAvailability.value.loading);
const lastUpload = computed(() => webdavState.value.lastSyncedAt ?? webdavAvailability.value.lastSyncedAt);
const label = computed(() => {
  if (webdavAvailability.value.loading) return "读取同步配置…";
  if (webdavAvailability.value.error) return "重试检测";
  if (!webdavAvailability.value.configured) return "配置同步";
  if (["saving", "downloading", "merging", "uploading"].includes(webdavState.value.phase)) return "同步中…";
  return ["error", "conflict", "cancelled"].includes(webdavState.value.phase) ? "重试同步" : "立即同步";
});
const message = computed(() => {
  const config = webdavAvailability.value;
  if (config.loading) return "正在读取本机同步配置，不会连接网盘。";
  if (config.error) return config.error;
  if (!config.configured) return "未配置 WebDAV · 仅本地使用，不会自动上传。";
  if (webdavState.value.phase === "unchecked" && hasUnsavedChanges.value) return "有本地修改待保存、待同步；尚未检查远端。";
  return webdavState.value.message;
});
const issue = computed(() => !!webdavAvailability.value.error || ["error", "conflict"].includes(webdavState.value.phase));
const statusLabel = computed(() => {
  if (webdavAvailability.value.loading) return "读取配置…";
  if (webdavAvailability.value.error) return "配置读取失败";
  if (!webdavAvailability.value.configured) return "仅本地使用";
  const phase = webdavState.value.phase;
  if (hasUnsavedChanges.value && ["unchecked", "synced", "pending"].includes(phase)) return "待保存/同步";
  return {
    unchecked: "未检查远端", saving: "保存中…", downloading: "下载中…", merging: "合并中…", uploading: "上传中…",
    synced: "上传已确认", pending: "待同步", conflict: "同步冲突", error: "同步失败", cancelled: "同步已取消",
  }[phase];
});
const dotClass = computed(() => issue.value ? "bg-[#8b2332]"
  : !webdavAvailability.value.configured ? "bg-stone-300"
  : webdavState.value.phase === "synced" && !hasUnsavedChanges.value ? "bg-[#8b9d77]" : "bg-[#d4a373]");
async function run() {
  if (disabled.value) return;
  if (webdavAvailability.value.error || webdavAvailability.value.configured === null) { await refreshWebdavAvailability(); return; }
  if (!webdavAvailability.value.configured) { emit("configure"); return; }
  await syncWebdav(false);
}
</script>
<template>
  <div data-sync-quickbar :data-phase="webdavState.phase" class="ml-auto flex min-w-0 shrink-0 items-center gap-2 text-xs" aria-label="同步快捷操作">
    <TooltipProvider :delay-duration="350" :skip-delay-duration="0">
      <TooltipRoot v-model:open="statusOpen" :disabled="blocked || drawer.open">
        <TooltipTrigger as-child>
          <button
            data-sync-summary
            type="button"
            :aria-label="`同步状态：${message}`"
            class="flex min-w-0 max-w-36 items-center gap-1.5 rounded-full px-1 py-0.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-[#8b9d77]/30"
            :class="issue ? 'text-[#8b2332]' : 'text-stone-600'"
          >
            <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="dotClass" aria-hidden="true" />
            <span class="truncate" role="status" aria-live="polite">{{ statusLabel }}</span>
          </button>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            data-sync-status-detail
            side="top"
            align="end"
            :side-offset="8"
            :collision-padding="12"
            class="z-50 max-w-sm rounded-2xl border border-[#ded9d1] bg-[#fffdf9] px-3 py-2 text-xs leading-5 text-[color:var(--ink-soft)] shadow-[0_12px_32px_-8px_#5c403326,0_3px_8px_#5c40330a]"
          >
            <p class="break-words">{{ message }}</p>
            <p v-if="lastUpload" class="mt-1 text-[10px] text-stone-500">上次上传确认：{{ new Date(lastUpload).toLocaleString('zh-CN', { hour12: false }) }} · 不代表远端当前一致</p>
          </TooltipContent>
        </TooltipPortal>
      </TooltipRoot>
    </TooltipProvider>
    <button type="button" :disabled="disabled" class="shrink-0 rounded-full border border-stone-300 bg-white px-2 py-0.5 text-stone-700 transition-colors hover:bg-stone-100 disabled:opacity-50" @click="run">{{ label }}</button>
    <button v-if="webdavAvailability.configured" type="button" :disabled="blocked || busy || drawer.open" class="shrink-0 text-stone-500 underline decoration-stone-300 underline-offset-2 disabled:opacity-50" @click="emit('configure')">同步设置</button>
  </div>
</template>
