<script setup lang="ts">
import { computed, ref } from "vue";
import { useVault } from "../composables/useVault";
import { toast } from "../lib/toast";
const { importPreview, importApplied, importCount, confirmImport, cancelImport, error } = useVault();
const saving = ref(false);
const counts = computed(() => ({ new: importPreview.value.filter(r => r.classification === "new").length, duplicate: importPreview.value.filter(r => r.classification === "duplicate").length, conflict: importPreview.value.filter(r => r.classification === "conflict").length, invalid: importPreview.value.filter(r => r.classification === "invalid").length }));
const labels = { new: "新增", duplicate: "相同内容", conflict: "账号冲突", invalid: "无效" };
const selected = computed(() => importPreview.value.filter(r => r.selected && r.classification !== "invalid").length);
async function submit() {
  if (saving.value) return;
  saving.value = true;
  try { const n = await confirmImport(); if (n) toast(`已导入并保存 ${n} 条`); }
  finally { saving.value = false; }
}
</script>
<template>
  <section class="mt-4 space-y-3 rounded-[1rem] border border-stone-200 bg-white p-4">
    <h4 class="font-serif text-base font-semibold text-[#5c4033]">导入前，先看看</h4>
    <p class="text-xs leading-relaxed text-stone-500">新增 {{ counts.new }} · 相同 {{ counts.duplicate }} · 冲突 {{ counts.conflict }} · 无效 {{ counts.invalid }}。相同默认跳过，冲突需手动选择；不覆盖已有条目。</p>
    <div v-if="!importApplied" class="max-h-60 overflow-auto rounded-xl border border-stone-200">
      <table class="w-full text-left text-xs"><thead class="sticky top-0 bg-[#faf6f1]"><tr><th class="p-2">选择</th><th>标题 / 用户名</th><th>密码</th><th class="p-2">判断</th></tr></thead><tbody><tr v-for="row in importPreview" :key="row.index" class="border-t border-stone-100"><td class="p-2"><input v-model="row.selected" type="checkbox" :disabled="row.classification === 'invalid' || saving" :aria-label="`导入第 ${row.index + 1} 行`" /></td><td class="max-w-44 truncate py-2">{{ row.record.title }}<span class="block text-stone-400">{{ row.record.username || row.record.url || '—' }}</span></td><td>{{ row.record.password ? '••••••' : '空' }}</td><td class="p-2" :class="row.classification === 'conflict' ? 'text-[#8b2332]' : 'text-stone-500'">{{ labels[row.classification] }}</td></tr></tbody></table>
    </div>
    <p v-else class="text-xs text-[#8b2332]">{{ importCount }} 条已加入内存，但尚未确认全部落盘。重试只保存，不重复插入；关闭预览不会回滚已加入的内容。</p>
    <p v-if="error" role="alert" class="text-xs text-[#8b2332]">{{ error }}</p>
    <div class="flex gap-2"><button class="rounded-full bg-stone-800 px-4 py-2 text-xs text-stone-50 disabled:opacity-50" :disabled="saving || (!selected && !importApplied)" @click="submit">{{ saving ? '保存中…' : importApplied ? '重试保存' : `确认导入 ${selected} 条` }}</button><button class="rounded-full border border-stone-300 px-4 py-2 text-xs" :disabled="saving" @click="cancelImport">{{ importApplied ? '关闭预览（保留内存修改）' : '取消，不导入' }}</button></div>
    <p class="text-[11px] text-stone-400">预览仅在本机，锁定后清空。</p>
  </section>
</template>
