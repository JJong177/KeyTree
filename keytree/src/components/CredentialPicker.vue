<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { sortCredentialCandidates } from "../lib/entry-identity";
import type { CredentialCandidate } from "../lib/entry-identity";
import { useDialogFocus } from "../composables/useDialogFocus";

const props = defineProps<{ candidates: ReadonlyArray<CredentialCandidate>; preferredUsername?: string }>();
const emit = defineEmits<{ select: [uuid: string]; close: [] }>();
const root = ref<HTMLElement | null>(null);
const search = ref("");
const searchInput = ref<HTMLInputElement | null>(null);
useDialogFocus(root, () => emit("close"));
onMounted(async () => { await nextTick(); searchInput.value?.focus(); });
const sortedCandidates = computed(() => sortCredentialCandidates(props.candidates, props.preferredUsername ?? ""));
const filtered = computed(() => {
  const query = search.value.trim().toLocaleLowerCase();
  if (!query) return sortedCandidates.value;
  return sortedCandidates.value.filter(candidate => [candidate.title, candidate.username, candidate.site].some(value => (value ?? "").toLocaleLowerCase().includes(query)));
});
</script>

<template>
  <div class="fixed inset-0 z-[70] flex items-center justify-center bg-stone-900/40 p-4" @click.self="emit('close')">
    <section
      ref="root"
      data-testid="credential-picker"
      role="dialog"
      aria-modal="true"
      aria-labelledby="credential-picker-title"
      tabindex="-1"
      class="flex max-h-[min(80vh,44rem)] w-full max-w-xl flex-col overflow-hidden rounded-[1.75rem] border border-stone-200 bg-[#faf6f1] shadow-2xl"
    >
      <header class="flex items-center justify-between border-b border-stone-200 px-5 py-4">
        <h2 id="credential-picker-title" class="font-serif text-lg font-semibold text-stone-800">复用已有账号密码</h2>
        <button type="button" aria-label="关闭凭据选择" class="flex h-9 w-9 items-center justify-center rounded-full border border-stone-300 bg-white text-stone-700 hover:bg-stone-100" @click="emit('close')">✕</button>
      </header>
      <div class="p-4">
        <label for="credential-picker-search" class="sr-only">搜索条目名称、账号或站点</label>
        <input
          id="credential-picker-search"
          ref="searchInput"
          v-model="search"
          type="search"
          autocomplete="off"
          placeholder="搜索名称、账号或站点"
          class="w-full rounded-full border border-stone-200 bg-white px-5 py-3 text-sm text-stone-800 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
        />
      </div>
      <p class="px-5 pb-2 text-xs text-stone-500">选择一个来源；只读取并复制账号与密码，其他字段不会带入。</p>
      <ul class="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 pb-4" aria-label="可复用条目">
        <li v-for="candidate in filtered" :key="candidate.uuid">
          <button
            type="button"
            data-testid="credential-candidate"
            :data-source="candidate.uuid"
            class="w-full rounded-2xl border border-stone-200 bg-white px-4 py-3 text-left transition-colors hover:border-[#aab59a] hover:bg-[#f4f6f0] focus:outline-none focus:ring-2 focus:ring-[#8b9d77]"
            @click="emit('select', candidate.uuid)"
          >
            <span class="block break-words font-medium text-stone-800">{{ candidate.title || '未命名条目' }}</span>
            <span class="mt-1 block break-all text-sm text-stone-600">{{ candidate.username || '未填写账号' }}</span>
            <span v-if="candidate.site" class="mt-1 block break-all text-xs text-stone-500">{{ candidate.site }}</span>
          </button>
        </li>
        <li v-if="!filtered.length" class="rounded-2xl border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500">没有匹配的账号</li>
      </ul>
      <footer class="border-t border-stone-200 px-5 py-3 text-right">
        <button type="button" class="rounded-full border border-stone-300 px-5 py-2 text-sm text-stone-700 hover:bg-white" @click="emit('close')">取消</button>
      </footer>
    </section>
  </div>
</template>
