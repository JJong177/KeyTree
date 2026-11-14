<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { useVault } from "../composables/useVault";
import type { EntryVM } from "../composables/useVault";
import { daysUntil, relativeTime } from "../lib/format";

import EntryAvatar from "./EntryAvatar.vue";
import EmptyState from "./EmptyState.vue";
import MatchText from "./MatchText.vue";
import MatchContext from "./MatchContext.vue";
import AppSelect from "./AppSelect.vue";
const sortOptions = [
  { value: "recent", label: "最近修改" },
  { value: "used", label: "最近使用" },
  { value: "title", label: "按名称" },
] as const;
const {
  visibleEntries,
  selectedUuid,
  selectedGroup,
  sidebarView,
  selectedUsername,
  selectEntry,
  sortMode,
  favoritesOnly,
  openCreateDrawer,
  query,
  entries,
  selectedIsTrash,
  emptyTrash,
  selectionMode,
  bulkSelectedUuids,
  bulkWorking,
  bulkPendingSave,
  bulkError,
  canBulkTrash,
  busy,
  startBulkSelection,
  exitBulkSelection,
  toggleBulkSelection,
  selectAllBulkEntries,
  clearBulkSelection,
  openBulkDialog,
  retryBulkSave,
} = useVault();

const emptyConfirm = ref(false);
const listRef = ref<HTMLElement | null>(null);
const bulkActionDisabled = computed(() =>
  !bulkSelectedUuids.value.length || bulkWorking.value || bulkPendingSave.value || busy.value
);


// 键盘上下移动时把选中项滚进视野（鼠标点选时本来就在视野里，scrollIntoView 也不会动）
watch(selectedUuid, async (uuid) => {
  if (!uuid) return;
  await nextTick();
  const el = listRef.value?.querySelector<HTMLElement>(
    `[data-uuid="${CSS.escape(uuid)}"]`
  );
  el?.scrollIntoView({ block: "nearest" });
});

const heading = computed(() => {
  if (selectedIsTrash.value) return `回收站 · ${visibleEntries.value.length} 条`;
  if (sidebarView.value === "usernames") {
    const name = selectedUsername.value === null
      ? "全部账号"
      : `账号 · ${selectedUsername.value || "未填写账号"}`;
    return `${name} · ${visibleEntries.value.length} 条`;
  }
  return `${selectedGroup.value?.name ?? "全部条目"} · ${visibleEntries.value.length} 条`;
});

/** 只在「已过期」或「7 天内到期」时给徽章，避免列表噪音 */
function expiryBadge(entry: EntryVM): string {
  if (!entry.expires || !entry.expiryTime) return "";
  const days = daysUntil(entry.expiryTime);
  if (days === null) return "";
  if (days < 0) return "已过期";
  if (days === 0) return "今天到期";
  if (days <= 7) return `${days} 天后到期`;
  return "";
}

function isExpired(entry: EntryVM): boolean {
  const badge = expiryBadge(entry);
  return badge === "已过期" || badge === "今天到期";
}

function onEmptyTrash() {
  if (!emptyConfirm.value) {
    emptyConfirm.value = true;
    window.setTimeout(() => (emptyConfirm.value = false), 4000);
    return;
  }
  emptyConfirm.value = false;
  void emptyTrash();
}
</script>

<template>
  <section class="flex min-h-0 flex-col">
    <div class="flex flex-wrap items-center justify-between gap-2 px-4 pb-2 pt-4">
      <span class="min-w-0 flex-1 truncate font-serif text-sm font-semibold text-stone-800">
        {{ heading }}
      </span>
      <button
        v-if="selectedIsTrash"
        class="shrink-0 rounded-full border px-3 py-1 text-xs transition-colors duration-300"
        :class="
          emptyConfirm
            ? 'border-[#8b2332] bg-[#8b2332] text-white'
            : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-100'
        "
        :disabled="!visibleEntries.length"
        @click="onEmptyTrash"
      >
        {{ emptyConfirm ? "确认清空？" : "清空回收站" }}
      </button>
      <div v-else class="ml-auto flex shrink-0 items-center gap-1">
        <button class="rounded-full border border-stone-200 px-2 py-1 text-xs" :class="favoritesOnly ? 'bg-[#d4a373]/25 text-[#5c4033]' : 'bg-white text-stone-500'" :aria-pressed="favoritesOnly" @click="favoritesOnly = !favoritesOnly">★ 收藏</button>
        <AppSelect v-model="sortMode" :options="sortOptions" aria-label="条目排序" size="compact" class="w-28 shrink-0" />
        <button
          v-if="!selectionMode && visibleEntries.length"
          class="rounded-full border border-stone-200 bg-white px-3 py-1 text-xs text-stone-600 hover:bg-stone-100"
          @click="startBulkSelection"
        >多选</button>
      </div>
    </div>

    <div v-if="selectionMode" class="flex flex-wrap items-center gap-2 px-4 pb-3 text-xs">
      <span class="mr-auto text-stone-600">已选 {{ bulkSelectedUuids.length }} 条</span>
      <button class="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-stone-600 disabled:opacity-50" :disabled="bulkWorking || bulkPendingSave || busy" title="全选当前结果" @click="selectAllBulkEntries">全选</button>
      <button class="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-stone-600 disabled:opacity-50" :disabled="bulkWorking || bulkPendingSave || busy" @click="clearBulkSelection">取消选择</button>
      <button class="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-stone-600 disabled:opacity-50" :disabled="bulkActionDisabled" @click="openBulkDialog('move')">移动</button>
      <button class="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-stone-600 disabled:opacity-50" :disabled="bulkActionDisabled" @click="openBulkDialog('tags')">添加标签</button>
      <span class="flex items-center gap-1">
        <button class="rounded-full border border-[#8b2332]/30 bg-white px-3 py-1.5 text-[#8b2332] disabled:opacity-50" :disabled="bulkActionDisabled || !canBulkTrash" :title="canBulkTrash ? undefined : '回收站已关闭'" @click="openBulkDialog('trash')">移到回收站</button>
        <span v-if="!canBulkTrash" class="text-[10px] text-stone-400">回收站已关闭</span>
      </span>
      <button class="rounded-full px-2 py-1.5 text-stone-500 hover:bg-stone-100 disabled:opacity-50" :disabled="bulkWorking || bulkPendingSave || busy" @click="exitBulkSelection">退出</button>
    </div>
    <div v-if="bulkPendingSave" class="mx-3 mb-3 rounded-[1rem] border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">
      <span>已应用到内存，尚未保存</span>
      <span v-if="bulkError" class="ml-2">{{ bulkError }}</span>
      <button class="ml-3 rounded-full border border-amber-300 px-3 py-1 disabled:opacity-50" :disabled="bulkWorking || busy" @click="retryBulkSave">{{ bulkWorking ? '保存中…' : '重试保存' }}</button>
    </div>

    <ul ref="listRef" class="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
      <li v-for="e in visibleEntries" :key="e.uuid" :data-uuid="e.uuid" class="flex items-center gap-2">
        <input
          v-if="selectionMode"
          type="checkbox"
          class="h-4 w-4 shrink-0 accent-[#8b9d77] disabled:opacity-50"
          :checked="bulkSelectedUuids.includes(e.uuid)"
          :disabled="bulkWorking || bulkPendingSave || busy"
          :aria-label="`选择 ${e.title}`"
          @change="toggleBulkSelection(e.uuid)"
        />
        <button
          class="flex w-full min-w-0 flex-1 items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left transition-colors duration-300"
          :class="
            selectedUuid === e.uuid
              ? 'border-2 border-[#8b9d77] bg-[#faf6f1]'
              : 'border border-stone-200 bg-white hover:border-stone-300'
          "
          @click="selectEntry(e.uuid)"
        >
          <EntryAvatar :title="e.title" :icon="e.icon" />
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-2">
                <span class="truncate font-medium text-stone-800"><MatchText :text="e.title" :query="query" /></span>
                <span v-if="e.favorite" class="shrink-0 text-xs text-[#d4a373]" title="已收藏">★</span>
                <span
                  v-if="e.tags.length"
                class="shrink-0 rounded-full border border-[#8b2332]/40 bg-[#8b2332]/10 px-2 py-0.5 text-xs text-[#8b2332]"
              >
                {{ e.tags[0] }}
              </span>
              <span v-if="e.hasTotp" class="shrink-0 text-xs text-[#8b9d77]">⏱ TOTP</span>
              <span
                v-if="expiryBadge(e)"
                class="shrink-0 rounded-full px-2 py-0.5 text-xs"
                :class="
                  isExpired(e)
                    ? 'bg-[#8b2332]/10 text-[#8b2332]'
                    : 'bg-[#d4a373]/20 text-[#5c4033]'
                "
              >
                {{ expiryBadge(e) }}
              </span>
              <span
                v-if="selectedIsTrash"
                class="shrink-0 rounded-full border border-stone-200 bg-stone-100 px-2 py-0.5 text-xs text-stone-500"
              >
                已删除
              </span>
            </span>
            <span class="block truncate text-xs text-stone-500">
              <MatchText :text="e.username || e.url || '—'" :query="query" />
              <MatchContext :entry="e" :query="query" />
            </span>
          </span>
          <span class="shrink-0 text-xs text-stone-400">{{ relativeTime(e.updatedAt) }}</span>
        </button>
      </li>

      <li v-if="!visibleEntries.length">
        <EmptyState
          v-if="query.trim()"
          kind="search"
          :title="sidebarView === 'usernames' && selectedUsername !== null ? '当前账号下暂无匹配条目' : '没有找到这片叶子'"
          :description="`没有匹配「${query.trim()}」的条目，试试更短的关键词。`"
        />
        <EmptyState v-else-if="selectedIsTrash" kind="box" title="回收站是空的" description="移除的条目会先停留在这里。" />
        <EmptyState v-else-if="favoritesOnly" kind="leaf" title="还没有收藏" description="在条目详情点击星标，把常用条目留在手边。" />
        <EmptyState
          v-else-if="sidebarView === 'usernames' && selectedUsername !== null"
          kind="leaf"
          title="当前账号下暂无匹配条目"
          description="这个账号分类下还没有有效条目。"
        />
        <EmptyState
          v-else
          :title="entries.some(e => !e.inTrash) ? (sidebarView === 'usernames' ? '没有账号条目' : '这个分组还在生长') : '种下第一把钥匙'"
          description="新增条目，或在设置的数据页导入已有密码。"
        ><button class="mt-4 rounded-full border border-stone-300 bg-white px-4 py-2 text-xs text-[#5c4033]" @click="openCreateDrawer">＋ 新建条目</button></EmptyState>
      </li>
    </ul>
  </section>
</template>
