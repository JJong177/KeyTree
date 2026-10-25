<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useDialogFocus } from "../composables/useDialogFocus";
import type { ClipboardRecognition } from "../lib/clipboard-capture";
const props = defineProps<{ recognition: ClipboardRecognition }>();
const emit = defineEmits<{ dismiss: []; accept: [index: number] }>();
const root = ref<HTMLElement | null>(null);
const selected = ref(0);
const revealed = ref(false);
const record = computed(() => props.recognition.records[selected.value]);
watch(selected, () => { revealed.value = false; });
useDialogFocus(root, () => emit("dismiss"));
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/25 p-4 backdrop-blur-sm">
    <section ref="root" role="dialog" aria-modal="true" aria-labelledby="clipboard-recognition-title" tabindex="-1" class="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-[2rem] border border-stone-200 bg-[#faf6f1] shadow-xl">
      <header class="border-b border-stone-200 px-6 py-5">
        <p class="mb-1 text-xs font-medium tracking-wider text-[#6d8064]">剪贴板 · 本机识别</p>
        <h2 id="clipboard-recognition-title" class="font-serif text-xl font-semibold text-stone-800">检测到账号信息，是否填入？</h2>
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
          <div><dt class="text-xs text-stone-400">标题</dt><dd class="mt-1 break-all whitespace-pre-wrap text-stone-800">{{ record.title || '未识别 · 请在新增页补充' }}</dd></div>
          <div><dt class="text-xs text-stone-400">账号</dt><dd class="mt-1 break-all whitespace-pre-wrap text-stone-800">{{ record.username || '未识别 · 请在新增页补充' }}</dd></div>
          <div>
            <dt class="flex items-center justify-between text-xs text-stone-400">密码 <button v-if="record.password" type="button" :aria-pressed="revealed" class="rounded-full border border-stone-200 px-3 py-1 text-stone-600" @click="revealed = !revealed">{{ revealed ? '隐藏密码' : '显示密码' }}</button></dt>
            <dd class="mt-1 break-all whitespace-pre-wrap font-mono text-stone-800">{{ !record.password ? '未识别 · 请在新增页补充' : revealed ? record.password : '••••••••••••' }}</dd>
          </div>
          <div><dt class="text-xs text-stone-400">账号登录网址</dt><dd class="mt-1 break-all text-stone-800">{{ record.url || '未识别 · 不使用复制来源代替' }}</dd></div>
          <div v-if="record.notes"><dt class="text-xs text-stone-400">备注</dt><dd class="mt-1 break-all whitespace-pre-wrap text-stone-800">{{ record.notes }}</dd></div>
        </dl>
        <div v-if="record" class="space-y-2 text-xs leading-5">
          <p class="text-stone-500">识别依据：{{ record.evidence.join('；') }}</p>
          <ul v-if="record.warnings.length" class="list-inside list-disc rounded-xl bg-amber-50 p-3 text-amber-900"><li v-for="warning in record.warnings" :key="warning">{{ warning }}</li></ul>
        </div>
      </div>
      <footer class="flex justify-end gap-3 border-t border-stone-200 px-6 py-4">
        <button type="button" class="rounded-full border border-stone-300 bg-white px-5 py-2 text-sm text-stone-600" @click="emit('dismiss')">忽略</button>
        <button type="button" class="rounded-full bg-[#5c4033] px-5 py-2 text-sm text-white disabled:opacity-50" :disabled="!record" @click="emit('accept', selected)">填入新增页</button>
      </footer>
    </section>
  </div>
</template>
