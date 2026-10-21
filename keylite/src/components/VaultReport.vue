<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useVault } from "../composables/useVault";
import EntryAvatar from "./EntryAvatar.vue";

interface FileInfo { exists: boolean; mtimeMs: number; size: number }
interface Diagnostics { file: FileInfo; backup: FileInfo; conflicts: Array<{ name: string; mtimeMs: number; size: number }>; conflictCount?: number }
type IssueKind = "weak" | "duplicate" | "expired";
const { vaultPath, unlocked, vaultInfo, entries, groups, drawer, busy, hasUnsavedChanges, vaultHealth, vaultKdfDetails, verifyCurrentBackup, selectEntry, selectGroup, openEditDrawer } = useVault();
const stats = ref<Diagnostics | null>(null);
const health = ref<ReturnType<typeof vaultHealth> | null>(null);
const params = ref<Array<{ label: string; value: string }>>([]);
const loading = ref(false), checking = ref(false), message = ref(""), error = ref("");
const filter = ref<"all" | IssueKind>("all"), search = ref("");
const editingId = ref(""), resultMessage = ref("");
const resultsHeading = ref<HTMLElement | null>(null);
let disposed = false, generation = 0;
const labels: Record<IssueKind, string> = { weak: "弱密码", duplicate: "重复密码", expired: "已过期" };

// Only public entry metadata reaches the list. Password comparison stays in vaultHealth().
const issueRows = computed(() => {
  const report = health.value;
  if (!report) return [];
  const kinds: IssueKind[] = ["weak", "duplicate", "expired"];
  const ids = new Map(kinds.map(kind => [kind, new Set(report[kind])]));
  const duplicates = new Map<string, { group: number; count: number }>();
  report.duplicateGroups.forEach((members, index) => {
    for (const id of members) duplicates.set(id, { group: index + 1, count: members.length });
  });
  const groupNames = new Map(groups.value.map(group => [group.uuid, group.name]));
  return entries.value.filter(entry => !entry.inTrash).flatMap(entry => {
    const reasons = kinds.filter(kind => ids.get(kind)!.has(entry.uuid));
    if (!reasons.length) return [];
    const duplicate = duplicates.get(entry.uuid);
    return [{
      id: entry.uuid, title: entry.title, username: entry.username, url: entry.url, icon: entry.icon,
      groupName: groupNames.get(entry.groupUuid) ?? "", reasons,
      duplicateGroup: duplicate?.group ?? null, duplicateCount: duplicate?.count ?? 0,
      expiryTime: entry.expiryTime,
    }];
  });
});
const filters = computed(() => [
  { key: "all" as const, label: "全部问题", count: issueRows.value.length },
  ...(["weak", "duplicate", "expired"] as const).map(key => ({ key, label: labels[key], count: health.value?.[key].length ?? 0 })),
]);
const visibleIssues = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  const rows = issueRows.value.filter(row =>
    (filter.value === "all" || row.reasons.includes(filter.value)) &&
    (!needle || [row.title, row.username, row.url, row.groupName].some(value => value.toLocaleLowerCase().includes(needle)))
  );
  if (filter.value === "duplicate") rows.sort((a, b) => (a.duplicateGroup ?? 0) - (b.duplicateGroup ?? 0));
  return rows;
});
const emptyText = computed(() => search.value.trim()
  ? "没有匹配的条目，试试其他关键词。"
  : issueRows.value.length ? "当前分类没有待处理条目。" : "未发现弱密码、重复密码或过期条目。");
function date(value: number) { return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未知"; }
function size(value: number) { return value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1024 / 1024).toFixed(2)} MiB`; }
function refreshIssues() {
  health.value = unlocked.value ? vaultHealth() : null;
  params.value = unlocked.value ? vaultKdfDetails() : [];
}
async function refresh() {
  if (disposed || !unlocked.value || busy.value || checking.value) return;
  const path = vaultPath.value, ticket = ++generation;
  loading.value = true; error.value = ""; message.value = ""; resultMessage.value = "";
  // File metadata failure must not hide actionable results from the unlocked vault.
  refreshIssues();
  try {
    const result = await invoke<Diagnostics>("vault_diagnostics", { path });
    if (disposed || ticket !== generation || vaultPath.value !== path || !unlocked.value) return;
    stats.value = result;
    resultMessage.value = "体检结果已刷新";
  } catch {
    if (!disposed && ticket === generation) { stats.value = null; error.value = "文件摘要读取失败，问题列表仍可处理。"; }
  } finally { if (!disposed && ticket === generation) loading.value = false; }
}
function processEntry(id: string) {
  if (disposed || !unlocked.value || busy.value || checking.value || drawer.value.open) return;
  refreshIssues();
  if (!issueRows.value.some(row => row.id === id)) { resultMessage.value = "该条目已无此问题或已移除，列表已更新。"; return; }
  editingId.value = id;
  selectGroup("all"); selectEntry(id); openEditDrawer(id);
}
watch(() => drawer.value.open, (open, wasOpen) => {
  if (open || !wasOpen || !editingId.value || disposed || !unlocked.value) return;
  editingId.value = "";
  refreshIssues();
  resultMessage.value = "已刷新，继续处理剩余条目。";
  void nextTick(() => { if (!disposed && !drawer.value.open) resultsHeading.value?.focus({ preventScroll: true }); });
});
async function verify() {
  if (checking.value || busy.value || !unlocked.value) return;
  checking.value = true; message.value = "";
  const path = vaultPath.value, ticket = generation;
  try {
    const result = await verifyCurrentBackup();
    if (!disposed && ticket === generation && vaultPath.value === path && unlocked.value) message.value = result.text;
  } catch {
    if (!disposed && ticket === generation) message.value = "备份验证失败，请重试。";
  } finally { if (!disposed && ticket === generation) checking.value = false; }
}
function reset() {
  generation++;
  stats.value = null; health.value = null; params.value = [];
  search.value = ""; filter.value = "all"; editingId.value = "";
  resultMessage.value = ""; message.value = ""; error.value = "";
  loading.value = false; checking.value = false;
}
watch([vaultPath, unlocked], () => { reset(); if (unlocked.value) void refresh(); });
onMounted(() => { void refresh(); });
onBeforeUnmount(() => { disposed = true; reset(); });
</script>

<template>
  <section class="space-y-4" aria-label="密码库体检">
    <div class="flex items-center justify-between gap-3">
      <h4 class="font-serif text-lg font-semibold text-[#5c4033]">密码库体检</h4>
      <button class="shrink-0 rounded-full border border-stone-300 px-3 py-1.5 text-xs disabled:opacity-50" :disabled="loading || checking || busy" @click="refresh">{{ loading ? '刷新中…' : '刷新结果' }}</button>
    </div>
    <p class="text-xs text-stone-500">先在对应网站修改密码，再更新这里；仅修改本地条目不会改变网站密码。</p>
    <p v-if="hasUnsavedChanges" role="alert" class="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">结果基于当前内存内容，仍有改动未保存，请先重试保存或另存副本。</p>
    <p v-if="error" role="alert" class="text-xs text-[#8b2332]">{{ error }}</p>
    <div v-if="health" class="space-y-3">
      <div class="flex flex-wrap gap-2" aria-label="筛选体检问题">
        <button v-for="option in filters" :key="option.key" class="rounded-full border px-3 py-2 text-xs transition-colors" :class="filter === option.key ? 'border-stone-800 bg-stone-800 text-white' : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-100'" :aria-pressed="filter === option.key" @click="filter = option.key">
          {{ option.label }} <span class="ml-1 tabular-nums">{{ option.count }}</span>
        </button>
      </div>
      <input v-model="search" aria-label="搜索问题条目" type="search" placeholder="搜索标题、账号、网址或分组" class="w-full rounded-full border border-stone-200 bg-white px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-stone-200" />
      <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-stone-500">
        <h5 ref="resultsHeading" tabindex="-1" class="rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-stone-300">待处理条目 · {{ visibleIssues.length }} / {{ issueRows.length }}</h5>
        <span v-if="resultMessage" role="status">{{ resultMessage }}</span>
      </div>
      <p class="text-[11px] text-stone-400">不含回收站；弱密码为本地估算，并非泄露检测。</p>
      <ul v-if="visibleIssues.length" class="divide-y divide-stone-100 rounded-2xl border border-stone-200 bg-white" aria-label="问题条目列表">
        <li v-for="(item, index) in visibleIssues" :key="item.id" :data-health-entry="item.id" class="p-3">
          <p v-if="filter === 'duplicate' && (index === 0 || visibleIssues[index - 1].duplicateGroup !== item.duplicateGroup)" class="mb-3 text-xs font-medium text-[#5c4033]">重复组 {{ item.duplicateGroup }} · {{ item.duplicateCount }} 个条目</p>
          <div class="flex items-start gap-3">
            <EntryAvatar :title="item.title" :icon="item.icon" :size="32" />
            <div class="min-w-0 flex-1">
              <p class="break-words text-sm font-medium text-stone-800">{{ item.title || '未命名条目' }}</p>
              <p class="mt-0.5 break-all text-xs text-stone-500">{{ item.username || '无账号' }}<span v-if="item.groupName"> · {{ item.groupName }}</span></p>
              <div class="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                <span v-for="kind in item.reasons" :key="kind" class="rounded-full bg-[#8b2332]/7 px-2 py-0.5 text-[#8b2332]">{{ labels[kind] }}<template v-if="kind === 'duplicate'"> · 组 {{ item.duplicateGroup }}（{{ item.duplicateCount }} 条）</template></span>
              </div>
              <p v-if="item.reasons.includes('expired') && item.expiryTime" class="mt-1.5 text-[11px] text-stone-400">到期：{{ item.expiryTime.toLocaleDateString('zh-CN') }}</p>
            </div>
            <button class="shrink-0 rounded-full border border-stone-300 px-3 py-1.5 text-xs text-[#5c4033] hover:bg-stone-50 disabled:opacity-50" :disabled="busy || checking" :aria-label="`处理 ${item.title || '未命名条目'}`" @click="processEntry(item.id)">处理</button>
          </div>
        </li>
      </ul>
      <p v-else role="status" class="rounded-2xl border border-dashed border-stone-200 px-4 py-8 text-center text-sm text-stone-500">{{ emptyText }}</p>
    </div>
    <details class="rounded-2xl border border-stone-200 bg-white p-4">
      <summary class="cursor-pointer text-sm text-stone-600">文件与加密信息</summary>
      <div class="mt-3 space-y-3">
        <p class="text-xs text-stone-500">{{ vaultInfo.kdf }} · {{ vaultInfo.version }}<template v-if="health"> · {{ health.total }} 条目 · TOTP {{ health.withTotp }}/{{ health.total }}</template></p>
        <dl class="grid grid-cols-2 gap-3 text-xs">
          <div v-for="param in params" :key="param.label"><dt class="text-stone-400">{{ param.label }}</dt><dd class="mt-1 text-[#5c4033]">{{ param.value }}</dd></div>
          <template v-if="stats">
            <div><dt class="text-stone-400">文件大小</dt><dd>{{ stats.file.exists ? size(stats.file.size) : '库文件不存在' }}</dd></div>
            <div><dt class="text-stone-400">磁盘最后写入</dt><dd>{{ date(stats.file.mtimeMs) }}</dd></div>
            <div class="col-span-2"><dt class="text-stone-400">上版备份</dt><dd>{{ stats.backup.exists ? `${size(stats.backup.size)} · ${date(stats.backup.mtimeMs)}` : '暂无备份' }}</dd></div>
          </template>
        </dl>
      </div>
    </details>
    <div class="rounded-2xl border border-stone-200 bg-white p-4">
      <h5 class="mb-2 text-sm font-medium">备份验证</h5>
      <p class="mb-3 text-xs text-stone-500">用当前凭据解密验证；改密前的备份可能需要旧密码。</p>
      <button class="rounded-full border border-stone-300 px-4 py-2 text-xs disabled:opacity-50" :disabled="checking || loading || busy || !stats?.backup.exists" @click="verify">{{ checking ? '正在解密验证…' : '验证这份备份' }}</button>
      <p v-if="message" role="status" class="mt-3 text-xs text-[#5c4033]">{{ message }}</p>
    </div>
    <div v-if="stats" class="rounded-2xl border border-stone-200 bg-white p-4">
      <h5 class="mb-2 text-sm">冲突副本 · {{ stats.conflictCount ?? stats.conflicts.length }}</h5>
      <p v-if="!stats.conflicts.length" class="text-xs text-stone-400">没有发现当前库的冲突副本。</p>
      <ul v-else class="max-h-32 space-y-2 overflow-auto text-xs text-stone-500"><li v-for="file in stats.conflicts" :key="file.name" class="break-all">{{ file.name }} · {{ size(file.size) }} · {{ date(file.mtimeMs) }}</li></ul>
    </div>
  </section>
</template>
