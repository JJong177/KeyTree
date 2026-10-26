<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useVault } from "../composables/useVault";
import { MAX_HINT_CHARS } from "../lib/master-password-hint";
const emit = defineEmits<{ dirty: [value: boolean] }>();
const { vaultPath, unlocked, getMasterHint, setMasterHint, busy, error } = useVault();
const draft = ref(""), message = ref(""), saving = ref(false), unsupported = ref(false);
let disposed = false, generation = 0;
function reset() {
  generation++;
  saving.value = false;
  const result = getMasterHint();
  draft.value = result.kind === "hint" ? result.text : "";
  unsupported.value = result.kind === "unsupported";
  message.value = result.kind === "invalid" ? "当前提示字段格式无效，可在这里重新设置或删除" : "";
}
watch([vaultPath, unlocked], reset, { immediate: true, flush: "sync" });
const savedDraft = ref(draft.value);
watch([draft, saving, busy], () => {
  const result = getMasterHint();
  savedDraft.value = result.kind === "hint" ? result.text : "";
  emit("dirty", draft.value !== savedDraft.value);
}, { immediate: true });
const count = computed(() => [...draft.value].length);
const canSave = computed(() => unlocked.value && !unsupported.value && !saving.value && !busy.value && count.value <= MAX_HINT_CHARS && !draft.value.includes("\0"));
async function submit(clear = false) {
  if (clear) {
    if (!unlocked.value || unsupported.value || saving.value || busy.value) return;
    draft.value = "";
  } else if (!canSave.value) return;
  const path = vaultPath.value, ticket = generation;
  message.value = ""; saving.value = true;
  try {
    const ok = await setMasterHint(draft.value);
    if (disposed || ticket !== generation || path !== vaultPath.value) return;
    message.value = ok ? (draft.value.trim() ? "提示已保存到当前 KDBX 文件" : "当前库提示已删除；旧备份或同步历史可能仍保留旧提示") : error.value || "提示未能保存，请重试或另存当前库";
  } finally { if (!disposed && ticket === generation) saving.value = false; }
}
onBeforeUnmount(() => { disposed = true; generation++; draft.value = ""; message.value = ""; });
</script>
<template>
  <section class="space-y-3 border-b border-stone-200 pb-5">
    <h4 class="font-serif text-sm font-semibold text-stone-800">主密码提示</h4>
    <p class="text-xs leading-relaxed text-[#805a33]">提示为公开明文，请勿填写密码；不能用于找回密码。</p>
    <p v-if="unsupported" class="text-xs text-[#8b2332]">当前 KDBX 版本不支持公开提示。</p>
    <template v-else>
      <label class="block text-xs text-stone-500" for="master-password-hint">记忆线索（可留空）</label>
      <textarea id="master-password-hint" v-model="draft" :disabled="saving || !unlocked" rows="3" class="w-full resize-none rounded-[1rem] border border-stone-200 bg-white px-4 py-3 text-sm text-stone-800 focus:outline-none focus:ring-2 focus:ring-stone-200" placeholder="写一句不含敏感信息的线索" />
      <p class="text-right text-[11px]" :class="count > MAX_HINT_CHARS ? 'text-[#8b2332]' : 'text-stone-400'">{{ count }} / {{ MAX_HINT_CHARS }} 字符</p>
      <div class="flex flex-wrap gap-2"><button class="rounded-full border border-stone-300 bg-white px-4 py-2 text-xs text-stone-700 disabled:opacity-50" :disabled="!canSave" @click="submit(false)">{{ saving ? '保存中…' : '保存提示' }}</button><button class="rounded-full border border-[#8b2332]/30 px-4 py-2 text-xs text-[#8b2332] disabled:opacity-50" :disabled="saving || busy || !unlocked" @click="submit(true)">删除提示</button></div>
    </template>
    <p v-if="message" role="status" class="text-xs leading-relaxed text-[#5c4033]">{{ message }}</p>
    <details class="text-xs text-stone-500">
      <summary class="cursor-pointer">提示须知</summary>
      <p class="mt-2 leading-relaxed">持有库文件的人均可查看。修改主密码后请检查提示，旧备份可能保留旧内容。</p>
    </details>
  </section>
</template>
