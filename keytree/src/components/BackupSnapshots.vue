<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { save } from "@tauri-apps/plugin-dialog";
import { useVault } from "../composables/useVault";
import type { SnapshotInfo } from "../lib/snapshots";
const emit = defineEmits<{ working: [value: boolean] }>();
const { unlocked, vaultPath, busy, drawer, listBackupSnapshots, createBackupSnapshot, previewBackupSnapshot, exportBackupSnapshot, snapshotPreview, snapshotError, clearSnapshotPreview, cancelBackupOperations } = useVault();
const items = ref<SnapshotInfo[]>([]), working = ref(false), message = ref(""), loaded = ref(false);
const maxCount = ref(30), maxTotalBytes = ref(256 * 1024 * 1024);
let generation = 0, disposed = false;
const disabled = computed(() => working.value || busy.value || drawer.value.open || !unlocked.value);
watch(working, value => emit("working", value), { immediate: true, flush: "sync" });
const timeOf = (at: number) => new Date(at).toLocaleString("zh-CN", { hour12: false });
async function load(ticket: number) {
  const result = await listBackupSnapshots();
  if (disposed || ticket !== generation) return;
  loaded.value = true;
  if (result) { items.value = result.items; maxCount.value = result.maxCount; maxTotalBytes.value = result.maxTotalBytes; }
}
async function run(task: (ticket: number) => Promise<void>) {
  if (disabled.value) return;
  const ticket = generation; working.value = true; message.value = "";
  try { await task(ticket); }
  catch { if (!disposed && ticket === generation) message.value = "操作未完成，请刷新后重试。"; }
  finally { if (!disposed && ticket === generation) working.value = false; }
}
function refresh() { return run(async ticket => { clearSnapshotPreview(); await load(ticket); }); }
function create() { return run(async ticket => {
  const ok = await createBackupSnapshot();
  if (disposed || ticket !== generation) return;
  if (ok) { message.value = "当前已保存版本已备份。"; await load(ticket); }
}); }
function preview(item: SnapshotInfo) { return run(async ticket => {
  await previewBackupSnapshot(item);
  if (disposed || ticket !== generation) return;
}); }
function recover() { return run(async ticket => {
  const selected = snapshotPreview.value;
  if (!selected) return;
  const filename = (vaultPath.value.split(/[\\/]/).pop() ?? "vault.kdbx").replace(/\.kdbx$/i, "");
  const target = await save({ defaultPath: `${filename}-restored-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}.kdbx`, filters: [{ name: "KeePass 加密库", extensions: ["kdbx"] }] });
  if (disposed || ticket !== generation || !unlocked.value || snapshotPreview.value !== selected || typeof target !== "string") return;
  const ok = await exportBackupSnapshot(target);
  if (disposed || ticket !== generation) return;
  if (ok) { message.value = "已导出恢复副本；当前库未被替换，也不会自动打开或上传。"; clearSnapshotPreview(); await load(ticket); }
}); }
watch([vaultPath, unlocked], () => {
  generation++; working.value = false; items.value = []; loaded.value = false; message.value = ""; clearSnapshotPreview();
  if (unlocked.value) void refresh();
}, { immediate: true, flush: "sync" });
onBeforeUnmount(() => { disposed = true; generation++; cancelBackupOperations(); emit("working", false); });
</script>
<template>
  <section data-backup-snapshots class="space-y-3 border-t border-stone-200 pt-5">
    <h4 class="font-serif text-sm font-semibold text-stone-800">备份版本</h4>
    <p class="text-xs text-stone-500">本地加密备份，最多 {{ maxCount }} 份；不自动上传。</p>
    <div class="flex flex-wrap gap-2">
      <button :disabled="disabled" class="rounded-full border border-stone-300 bg-white px-4 py-2 text-xs disabled:opacity-50" @click="refresh">刷新版本</button>
      <button :disabled="disabled" class="rounded-full border border-stone-300 bg-white px-4 py-2 text-xs disabled:opacity-50" @click="create">{{ working ? '处理中…' : '立即备份' }}</button>
    </div>
    <p v-if="loaded && !items.length" class="text-xs text-stone-400">暂无备份版本</p>
    <ul v-if="items.length" class="max-h-52 space-y-1 overflow-y-auto rounded-xl border border-stone-200 bg-white p-2">
      <li v-for="item in items" :key="item.id" class="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-2 text-xs">
        <span class="min-w-0 text-stone-600">{{ timeOf(item.createdAt) }} <span class="text-stone-400">· {{ Math.max(1, Math.round(item.size / 1024)) }} KB</span></span>
        <button :disabled="disabled" class="shrink-0 rounded-full border border-stone-200 px-3 py-1 text-[#5c4033] disabled:opacity-50" @click="preview(item)">验证预览</button>
      </li>
    </ul>
    <div v-if="snapshotPreview" data-snapshot-preview class="space-y-2 rounded-xl border border-[#8b9d77]/40 bg-[#8b9d77]/10 p-3 text-xs leading-relaxed text-stone-700">
      <p class="font-medium">已用当前凭据解密并验证同一库：{{ timeOf(snapshotPreview.item.createdAt) }}</p>
      <p>条目：当前 {{ snapshotPreview.summary.currentEntries }} → 副本 {{ snapshotPreview.summary.snapshotEntries }}；分组：{{ snapshotPreview.summary.currentGroups }} → {{ snapshotPreview.summary.snapshotGroups }}</p>
      <p>相对当前库：新增 {{ snapshotPreview.summary.added }}，移除 {{ snapshotPreview.summary.removed }}，内容或位置变化 {{ snapshotPreview.summary.changed }}。</p>
      <p class="text-[11px] text-stone-500">摘要含回收站，不含历史、附件和设置差异。</p>
      <button :disabled="disabled" class="rounded-full bg-stone-800 px-4 py-2 text-xs text-white disabled:opacity-50" @click="recover">另存恢复副本（不覆盖）</button>
    </div>
    <p v-if="snapshotError" role="status" class="break-words text-xs leading-relaxed text-[#8b2332]">{{ snapshotError }}</p>
    <p v-if="message" role="status" class="break-words text-xs leading-relaxed text-[#5c4033]">{{ message }}</p>
    <details class="text-xs text-stone-500">
      <summary class="cursor-pointer">备份与恢复说明</summary>
      <p class="mt-2 leading-relaxed">本地备份总计不超过 {{ Math.round(maxTotalBytes / 1024 / 1024) }} MiB。恢复前自动备份当前版本，并另存新文件，不覆盖原库。旧副本可能需要旧密码或密钥文件，改密不会更新旧副本；请另备异地副本。</p>
    </details>
  </section>
</template>
