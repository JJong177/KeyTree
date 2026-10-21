<script setup lang="ts">
import { computed, watch } from "vue";
import { useVault } from "../composables/useVault";
const props = defineProps<{ blocked?: boolean }>();
const emit = defineEmits<{ configure: [] }>();
const { vaultPath, unlocked, busy, drawer, hasUnsavedChanges, webdavState, webdavAvailability, refreshWebdavAvailability, syncWebdav } = useVault();
watch([vaultPath, unlocked], () => { if (unlocked.value) void refreshWebdavAvailability(); }, { immediate: true });
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
async function run() {
  if (disabled.value) return;
  if (webdavAvailability.value.error || webdavAvailability.value.configured === null) { await refreshWebdavAvailability(); return; }
  if (!webdavAvailability.value.configured) { emit("configure"); return; }
  await syncWebdav(false);
}
</script>
<template>
  <div data-sync-quickbar :data-phase="webdavState.phase" class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-stone-200 bg-[#faf6f1] px-4 py-2 text-xs">
    <div class="min-w-0 flex-1" role="status" aria-live="polite">
      <p class="break-words leading-relaxed" :class="webdavAvailability.error || ['error', 'conflict'].includes(webdavState.phase) ? 'text-[#8b2332]' : 'text-stone-600'">{{ message }}</p>
      <p v-if="lastUpload" class="mt-0.5 text-[10px] text-stone-400">上次上传确认：{{ new Date(lastUpload).toLocaleString('zh-CN', { hour12: false }) }} · 不代表远端当前一致</p>
    </div>
    <button :disabled="disabled" class="shrink-0 rounded-full border border-stone-300 bg-white px-3 py-1.5 text-stone-700 disabled:opacity-50" @click="run">{{ label }}</button>
    <button v-if="webdavAvailability.configured" :disabled="blocked || busy || drawer.open" class="shrink-0 text-stone-500 underline disabled:opacity-50" @click="emit('configure')">同步设置</button>
  </div>
</template>
