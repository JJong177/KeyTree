<script setup lang="ts">
import { computed, ref } from "vue";
import { useVault } from "../composables/useVault";
import type { EntryVM } from "../composables/useVault";
import { daysUntil, initialOf, relativeTime, toneOf } from "../lib/format";

const {
  visibleEntries,
  selectedUuid,
  selectedGroup,
  selectEntry,
  sortMode,
  query,
  entries,
  selectedIsTrash,
  emptyTrash,
} = useVault();

const emptyConfirm = ref(false);

const heading = computed(() => {
  const name = selectedIsTrash.value
    ? "回收站"
    : (selectedGroup.value?.name ?? "全部条目");
  return `${name} · ${visibleEntries.value.length} 条`;
});

function toggleSort() {
  sortMode.value = sortMode.value === "recent" ? "title" : "recent";
}

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
    <div class="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
      <span class="truncate font-serif text-sm font-semibold text-stone-800">
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
      <button
        v-else
        class="shrink-0 rounded-full border border-stone-200 bg-white px-3 py-1 text-xs text-stone-600 transition-colors duration-300 hover:bg-stone-100"
        @click="toggleSort"
      >
        {{ sortMode === "recent" ? "最近修改 ▾" : "按名称 ▾" }}
      </button>
    </div>

    <ul class="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 pb-4">
      <li v-for="e in visibleEntries" :key="e.uuid">
        <button
          class="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left transition-colors duration-300"
          :class="
            selectedUuid === e.uuid
              ? 'border-2 border-[#8b9d77] bg-[#faf6f1]'
              : 'border border-stone-200 bg-white hover:border-stone-300'
          "
          @click="selectEntry(e.uuid)"
        >
          <span
            class="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full border border-stone-300 font-semibold text-stone-800"
            :class="e.icon ? 'bg-white' : toneOf(e.title) === 'sage' ? 'bg-[#8b9d77]/30' : 'bg-[#d4a373]/30'"
          >
            <img v-if="e.icon" :src="e.icon" alt="" class="h-6 w-6 object-contain" />
            <template v-else>{{ initialOf(e.title) }}</template>
          </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-2">
                <span class="truncate font-medium text-stone-800">{{ e.title }}</span>
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
              {{ e.username || e.url || "—" }}
            </span>
          </span>
          <span class="shrink-0 text-xs text-stone-400">{{ relativeTime(e.updatedAt) }}</span>
        </button>
      </li>

      <li
        v-if="!visibleEntries.length"
        class="px-4 py-12 text-center text-sm text-stone-400"
      >
        <template v-if="query.trim()">
          没有匹配「{{ query.trim() }}」的条目
        </template>
        <template v-else-if="selectedIsTrash"> 回收站是空的 </template>
        <template v-else-if="entries.length"> 这个分组还是空的 </template>
        <template v-else> 库里还没有条目，点右上角「+ 新建」加一条 </template>
      </li>
    </ul>
  </section>
</template>
