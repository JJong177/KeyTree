<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useVault } from "../composables/useVault";
import type { BulkEntryAction, BulkEntryKind } from "../composables/useVault";
import { useDialogFocus } from "../composables/useDialogFocus";
import AppSelect from "./AppSelect.vue";

const {
  bulkDialog,
  bulkTargetGroups,
  bulkWorking,
  bulkPendingSave,
  bulkError,
  canBulkTrash,
  busy,
  applyBulkAction,
  retryBulkSave,
  closeBulkDialog,
} = useVault();

const dialogRoot = ref<HTMLElement | null>(null);
const moveGroupUuid = ref("");
const tagInput = ref("");
const kind = computed<BulkEntryKind | null>(() => bulkDialog.value?.kind ?? null);
const selectedCount = computed(() => bulkDialog.value?.uuids.length ?? 0);
const moveOptions = computed(() => bulkTargetGroups.value.map(group => ({
  value: group.uuid,
  label: group.name,
  depth: group.depth,
})));
const parsedTags = computed(() => tagInput.value.split(/[,，]/).map(tag => tag.trim()).filter(Boolean));
const submitDisabled = computed(() => {
  if (bulkWorking.value || bulkPendingSave.value || busy.value || !selectedCount.value) return true;
  if (kind.value === "move") return !moveOptions.value.some(option => option.value === moveGroupUuid.value);
  if (kind.value === "tags") return parsedTags.value.length === 0;
  return kind.value !== "trash" || !canBulkTrash.value;
});

watch(bulkDialog, () => {
  moveGroupUuid.value = "";
  tagInput.value = "";
});

useDialogFocus(dialogRoot, closeBulkDialog);

async function submit(): Promise<void> {
  if (submitDisabled.value || !kind.value) return;
  const action: BulkEntryAction = kind.value === "move"
    ? { kind: "move", groupUuid: moveGroupUuid.value }
    : kind.value === "tags"
      ? { kind: "tags", tags: tagInput.value }
      : { kind: "trash" };
  await applyBulkAction(action);
}

function titleFor(kind: BulkEntryKind | null): string {
  return kind === "move" ? "移动条目" : kind === "tags" ? "添加标签" : "移到回收站";
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/35 p-4" @click.self="closeBulkDialog">
    <section
      ref="dialogRoot"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bulk-entry-dialog-title"
      tabindex="-1"
      class="w-full max-w-md rounded-[1.5rem] border border-stone-200 bg-[#faf6f1] p-5 text-stone-800 shadow-xl"
    >
      <header class="mb-4">
        <h2 id="bulk-entry-dialog-title" class="font-serif text-lg font-semibold">{{ titleFor(kind) }}</h2>
        <p class="mt-1 text-sm text-stone-600">将整理 {{ selectedCount }} 条</p>
      </header>

      <div v-if="bulkPendingSave" class="mb-4 rounded-[1rem] border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900" role="status">
        <p>已应用到内存，尚未保存</p>
        <p v-if="bulkError" class="mt-1 text-xs">{{ bulkError }}</p>
        <button class="mt-3 rounded-full border border-amber-300 bg-white px-4 py-2 text-xs disabled:opacity-50" :disabled="bulkWorking || busy" @click="retryBulkSave">
          {{ bulkWorking ? "保存中…" : "重试保存" }}
        </button>
      </div>
      <p v-else-if="bulkError" class="mb-3 text-sm text-[#8b2332]" role="alert">{{ bulkError }}</p>

      <fieldset class="space-y-3" :disabled="bulkWorking || bulkPendingSave || busy">
        <template v-if="kind === 'move'">
          <label class="block text-xs text-stone-600" for="bulk-entry-target">目标分组</label>
          <AppSelect
            id="bulk-entry-target"
            v-model="moveGroupUuid"
            :options="moveOptions"
            aria-label="目标分组"
            :disabled="!moveOptions.length || bulkWorking || bulkPendingSave || busy"
            placeholder="选择目标分组"
            class="w-full"
          />
          <p v-if="!moveOptions.length" class="text-xs text-stone-500">没有可用的目标分组</p>
        </template>
        <template v-else-if="kind === 'tags'">
          <label class="block text-xs text-stone-600" for="bulk-entry-tags">标签（逗号分隔）</label>
          <input
            id="bulk-entry-tags"
            v-model="tagInput"
            type="text"
            autocomplete="off"
            class="w-full rounded-full border border-stone-200 bg-white px-4 py-2.5 text-sm outline-none focus:border-[#8b9d77] focus:ring-2 focus:ring-[#8b9d77]/20"
            placeholder="例如：工作, 常用"
          />
        </template>
        <div v-else-if="kind === 'trash'" class="rounded-[1rem] border border-[#8b2332]/20 bg-white p-3 text-sm">
          <p>确认将 {{ selectedCount }} 条移到回收站？</p>
          <p v-if="!canBulkTrash" class="mt-1 text-xs text-[#8b2332]">回收站已关闭，无法移入。</p>
        </div>
      </fieldset>

      <footer
        class="mt-5 flex flex-wrap justify-end gap-2"
        :data-dialog-confirmation="kind === 'trash' ? '' : undefined"
      >
        <button
          class="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm text-stone-600 disabled:opacity-50"
          :disabled="bulkWorking"
          @click="closeBulkDialog"
        >{{ bulkPendingSave ? "关闭" : "取消" }}</button>
        <button
          v-if="!bulkPendingSave"
          class="rounded-full bg-[#8b9d77] px-5 py-2 text-sm font-medium text-white hover:bg-[#788b65] disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="submitDisabled"
          @click="submit"
        >
          {{ bulkWorking ? "处理中…" : kind === 'trash' ? "确认移到回收站" : "确认" }}
        </button>
      </footer>
    </section>
  </div>
</template>
