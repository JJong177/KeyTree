<script setup lang="ts">
import { onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
interface ShortcutStatus { requested: string; active: string | null; error: string | null }
const state = ref<ShortcutStatus | null>(null), draft = ref(""), saving = ref(false), error = ref("");
onMounted(async () => { try { state.value = await invoke<ShortcutStatus>("shortcut_status"); draft.value = state.value.requested; } catch { error.value = "无法读取全局快捷键状态"; } });
async function save(defaults = false) {
  if (saving.value) return;
  saving.value = true; error.value = "";
  try { state.value = await invoke<ShortcutStatus>("shortcut_set", { shortcut: defaults ? "Alt+Space" : draft.value }); draft.value = state.value.requested; }
  catch (e) { error.value = typeof e === "string" ? e : "快捷键设置失败，原快捷键保持有效"; }
  finally { saving.value = false; }
}
</script>
<template><section class="space-y-2 border-b border-stone-200 pb-5"><h4 class="text-sm font-medium text-stone-700">全局快捷键</h4><p class="text-xs text-stone-500">当前生效：<strong>{{ state?.active || '未注册' }}</strong></p><div class="flex gap-2"><input v-model="draft" aria-label="全局快捷键" class="min-w-0 flex-1 rounded-full border border-stone-200 bg-white px-4 py-2 text-xs" placeholder="Ctrl+Alt+Space" /><button class="rounded-full border border-stone-300 px-3 text-xs disabled:opacity-50" :disabled="saving" @click="save(false)">应用</button><button class="rounded-full border border-stone-300 px-3 text-xs disabled:opacity-50" :disabled="saving" @click="save(true)">默认</button></div><p role="status" class="text-xs text-[#8b2332]">{{ error || state?.error }}</p><p class="text-[11px] leading-relaxed text-stone-400">例如 Ctrl+Alt+K；若冲突，原快捷键保持不变。</p></section></template>
