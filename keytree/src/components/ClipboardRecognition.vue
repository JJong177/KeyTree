<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useDialogFocus } from "../composables/useDialogFocus";
import {
  CLIPBOARD_FIELD_LABELS,
  CLIPBOARD_FIELDS,
  type ClipboardChoices,
  type ClipboardField,
  type ClipboardRecognition,
} from "../lib/clipboard-capture";

const props = defineProps<{ recognition: ClipboardRecognition }>();
const emit = defineEmits<{ dismiss: []; accept: [index: number, choices: ClipboardChoices] }>();
const root = ref<HTMLElement | null>(null);
const selected = ref(0);
const choices = ref<ClipboardChoices>({});
const revealed = ref(false);
const record = computed(() => props.recognition.records[selected.value]);
const MASK = "••••••••••••";
const missingCredentials = computed(() => !!record.value && !record.value.username && !record.value.password);
const hasPassword = computed(() => !!record.value?.password || !!record.value?.candidates?.password?.length);

function candidateList(field: ClipboardField) {
  return record.value?.candidates?.[field] ?? [];
}
function isAmbiguous(field: ClipboardField): boolean {
  const candidates = candidateList(field);
  return candidates.length > 1 || candidates.some(candidate => candidate.requiresConfirmation);
}
const ambiguousFields = computed(() => CLIPBOARD_FIELDS.filter(isAmbiguous));
function hasValidChoice(field: ClipboardField): boolean {
  const choice = choices.value[field];
  return choice === -1 || (typeof choice === "number" && Number.isInteger(choice) && choice >= 0 && choice < candidateList(field).length);
}
const unresolvedCount = computed(() => ambiguousFields.value.filter(field => !hasValidChoice(field)).length);
function chooseCandidate(field: ClipboardField, index: number): void {
  choices.value = { ...choices.value, [field]: index };
  if (field === "password") revealed.value = false;
}
function chooseNone(field: ClipboardField): void {
  choices.value = { ...choices.value, [field]: -1 };
  if (field === "password") revealed.value = false;
}
function displayValue(field: ClipboardField): string {
  const value = record.value?.[field] ?? "";
  if (field === "password" && value) return revealed.value ? value : MASK;
  return value;
}
watch(selected, () => {
  choices.value = {};
  revealed.value = false;
});
useDialogFocus(root, () => emit("dismiss"));
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/25 p-4 backdrop-blur-sm">
    <section ref="root" role="dialog" aria-modal="true" aria-labelledby="clipboard-recognition-title" tabindex="-1" class="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-[2rem] border border-stone-200 bg-[#faf6f1] shadow-xl">
      <header class="border-b border-stone-200 px-6 py-5">
        <p class="mb-1 text-xs font-medium tracking-wider text-[#6d8064]">剪贴板 · 本机识别</p>
        <h2 id="clipboard-recognition-title" class="font-serif text-xl font-semibold text-stone-800">{{ missingCredentials ? '检测到字段线索，请确认或补充' : '检测到账号信息，是否填入？' }}</h2>
        <p class="mt-2 text-xs leading-5 text-stone-500">当前没有创建或保存任何条目。请先核对，再到新增页补充修改并手动保存。</p>
      </header>
      <div class="space-y-4 overflow-y-auto px-6 py-5">
        <div class="rounded-2xl border border-stone-200 bg-white/70 px-4 py-3 text-xs leading-5 text-stone-500">
          <p>复制来源站点：<span class="break-all text-stone-700">{{ recognition.source.url || '未知（剪贴板未提供）' }}</span></p>
          <p>剪贴板所属应用：<span class="text-stone-700">{{ recognition.source.app || '未知' }}</span></p>
          <p class="mt-1">仅供参考，可能经过中转；来源不会自动作为账号登录网址。</p>
        </div>
        <fieldset v-if="recognition.records.length > 1" class="space-y-2">
          <legend class="mb-2 text-xs font-medium text-stone-700">识别到 {{ recognition.records.length }} 条，请选择本次要填入的一条</legend>
          <div class="flex max-h-28 flex-wrap gap-2 overflow-y-auto">
            <label v-for="(item, index) in recognition.records" :key="index" class="inline-flex max-w-full items-center gap-2 rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs text-stone-700">
              <input v-model="selected" type="radio" name="clipboard-record" :value="index" />
              <span class="truncate">{{ index + 1 }} · {{ item.title || item.username || '待补充账号' }}</span>
            </label>
          </div>
          <p class="text-xs text-stone-500">本次只填入所选条目，不批量保存；其余记录不会保留在后台。</p>
        </fieldset>
        <p v-if="recognition.truncated" class="text-xs text-amber-800">内容较多，本次最多预览前 50 条。建议分批复制。</p>
        <dl v-if="record" class="space-y-3 rounded-2xl bg-white p-4 text-sm">
          <template v-for="field in CLIPBOARD_FIELDS" :key="field">
            <div v-if="isAmbiguous(field)" class="rounded-xl border border-stone-200 bg-[#faf6f1] p-3">
              <dt class="mb-2 flex items-center justify-between gap-3 text-xs font-medium text-stone-600">
                <span>{{ CLIPBOARD_FIELD_LABELS[field] }} · 请选择候选</span>
                <button v-if="field === 'password' && hasPassword" type="button" :aria-pressed="revealed" class="shrink-0 rounded-full border border-stone-200 bg-white px-3 py-1 text-stone-600" @click="revealed = !revealed">{{ revealed ? '隐藏密码' : '显示密码' }}</button>
              </dt>
              <dd>
                <fieldset class="space-y-2">
                  <legend class="sr-only">{{ CLIPBOARD_FIELD_LABELS[field] }}候选</legend>
                  <label v-for="(candidate, candidateIndex) in candidateList(field)" :key="candidateIndex" class="flex cursor-pointer items-start gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700">
                    <input type="radio" :name="`clipboard-choice-${field}`" :value="candidateIndex" :checked="choices[field] === candidateIndex" :aria-label="`${CLIPBOARD_FIELD_LABELS[field]}候选 ${candidateIndex + 1}`" class="mt-1 shrink-0" @change="chooseCandidate(field, candidateIndex)" />
                    <span class="min-w-0">
                      <span class="block break-all font-mono">{{ field === 'password' && !revealed ? MASK : candidate.value }}</span>
                      <span class="mt-1 block text-xs leading-5 text-stone-500">依据：{{ candidate.evidence.join('；') || '未提供' }}</span>
                    </span>
                  </label>
                  <label class="flex cursor-pointer items-start gap-2 rounded-lg border border-dashed border-stone-300 bg-white/70 px-3 py-2 text-xs text-stone-600">
                    <input type="radio" :name="`clipboard-choice-${field}`" :value="-1" :checked="choices[field] === -1" :aria-label="`${CLIPBOARD_FIELD_LABELS[field]}暂不填入，稍后补充`" class="mt-0.5 shrink-0" @change="chooseNone(field)" />
                    <span>暂不填入，稍后补充</span>
                  </label>
                </fieldset>
              </dd>
            </div>
            <div v-else-if="field !== 'notes' || record[field]" class="min-w-0">
              <dt v-if="field !== 'password'" class="text-xs text-stone-400">{{ CLIPBOARD_FIELD_LABELS[field] }}</dt>
              <dt v-else class="flex items-center justify-between text-xs text-stone-400">
                <span>{{ CLIPBOARD_FIELD_LABELS[field] }}</span>
                <button v-if="hasPassword" type="button" :aria-pressed="revealed" class="rounded-full border border-stone-200 px-3 py-1 text-stone-600" @click="revealed = !revealed">{{ revealed ? '隐藏密码' : '显示密码' }}</button>
              </dt>
              <dd v-if="field === 'password'" class="mt-1 break-all whitespace-pre-wrap font-mono text-stone-800">{{ displayValue(field) || '未识别 · 请在新增页补充' }}</dd>
              <dd v-else class="mt-1 break-all whitespace-pre-wrap text-stone-800">{{ displayValue(field) || (field === 'url' ? '未识别 · 不使用复制来源代替' : '未识别 · 请在新增页补充') }}</dd>
            </div>
          </template>
        </dl>
        <div v-if="record" class="space-y-2 text-xs leading-5">
          <p class="text-stone-500">识别依据：{{ record.evidence.join('；') || '未提供' }}</p>
          <p v-if="ambiguousFields.length" class="rounded-xl bg-amber-50 p-3 text-amber-900">多个账号的字段候选可能来自不同条目或不同行，系统不会自动配对。请核对字段之间是否属于同一账号。</p>
          <ul v-if="record.warnings.length" class="list-inside list-disc rounded-xl bg-amber-50 p-3 text-amber-900"><li v-for="warning in record.warnings" :key="warning">{{ warning }}</li></ul>
        </div>
      </div>
      <footer class="flex justify-end gap-3 border-t border-stone-200 px-6 py-4">
        <button type="button" class="rounded-full border border-stone-300 bg-white px-5 py-2 text-sm text-stone-600" @click="emit('dismiss')">忽略</button>
        <button type="button" class="rounded-full bg-[#5c4033] px-5 py-2 text-sm text-white disabled:opacity-50" :disabled="!record || unresolvedCount > 0" @click="emit('accept', selected, { ...choices })">{{ unresolvedCount ? `还需选择 ${unresolvedCount} 项` : missingCredentials ? '打开新增页补充' : '填入新增页' }}</button>
      </footer>
    </section>
  </div>
</template>
