<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useUpdates } from "../lib/updates";

const updates = useUpdates();
const { state, hasUpdate } = updates;
const opening = ref(false);
const linkError = ref("");
const statusText = computed(() => {
  if (state.checking) return "正在检查更新…";
  if (state.status === "unavailable" || state.status === "failed") return state.error || "暂时无法检查更新，请稍后重试";
  if (hasUpdate.value && state.release) return `发现新版本 v${state.release.version}`;
  return state.status === "current" ? "已是最新版本" : "尚未检查更新";
});
const versionText = computed(() => state.currentVersion ? `v${state.currentVersion}`
  : state.status === "unavailable" ? "版本信息不可用" : "读取版本中…");
watch(() => state.release, () => { linkError.value = ""; });
onMounted(() => { void updates.initialize(); });

async function openLink(download: boolean): Promise<void> {
  if (opening.value) return;
  opening.value = true;
  linkError.value = "";
  try {
    const opened = download ? await updates.openDownload() : await updates.openRelease();
    if (!opened) linkError.value = "无法打开链接，请稍后重试";
  } catch {
    linkError.value = "无法打开链接，请稍后重试";
  } finally { opening.value = false; }
}
</script>

<template>
  <section data-about-updates class="space-y-3" aria-labelledby="about-update-title">
    <header class="flex flex-wrap items-center justify-between gap-3">
      <div class="flex min-w-0 items-center gap-2">
        <h4 id="about-update-title" data-update-product class="font-serif text-base font-semibold text-stone-800">KeyTree</h4>
        <span data-current-version class="text-xs text-stone-500">{{ versionText }}</span>
      </div>
      <button
        data-update-check
        type="button"
        :disabled="state.checking"
        class="shrink-0 rounded-full border border-stone-300 bg-white px-4 py-2 text-xs text-stone-700 transition-colors hover:bg-stone-100 disabled:cursor-not-allowed disabled:opacity-50"
        @click="updates.check({ force: true })"
      >{{ state.checking ? "检查中…" : "检查更新" }}</button>
    </header>
    <p
      data-update-state
      :data-status="state.status"
      role="status"
      aria-live="polite"
      class="text-xs leading-5"
      :class="state.status === 'failed' || state.status === 'unavailable' ? 'text-[#8b2332]' : hasUpdate ? 'text-[#6d8064]' : 'text-stone-500'"
    >{{ statusText }}</p>
    <div v-if="hasUpdate && state.release" class="space-y-3 rounded-2xl border border-[#8b9d77]/30 bg-[#8b9d77]/5 p-4">
      <p data-available-version class="text-sm font-medium text-[#526542]">可更新至 v{{ state.release.version }}</p>
      <details v-if="state.release.notes" class="rounded-xl border border-stone-200 bg-white/80 p-3">
        <summary class="cursor-pointer text-xs font-medium text-stone-600">更新说明</summary>
        <pre data-update-notes class="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap break-words font-sans text-xs leading-5 text-stone-600">{{ state.release.notes }}</pre>
      </details>
      <div class="flex flex-wrap gap-2">
        <button
          v-if="state.release.downloadUrl"
          data-update-download
          type="button"
          :disabled="opening"
          class="rounded-full bg-[#8b9d77] px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-[#788b65] disabled:opacity-50"
          @click="openLink(true)"
        >下载新版本</button>
        <button
          data-update-release
          type="button"
          :disabled="opening"
          class="rounded-full border border-stone-300 bg-white px-4 py-2 text-xs text-stone-600 transition-colors hover:bg-stone-100 disabled:opacity-50"
          @click="openLink(false)"
        >{{ state.release.downloadUrl ? "查看发布页" : "前往发布页" }}</button>
      </div>
      <p v-if="linkError" class="text-xs text-[#8b2332]" role="alert">{{ linkError }}</p>
    </div>
    <p v-if="state.checkedAt !== null" class="text-[11px] text-stone-400">上次检查：{{ new Date(state.checkedAt).toLocaleString('zh-CN', { hour12: false }) }}</p>
  </section>
</template>
