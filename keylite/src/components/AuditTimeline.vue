<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { auditState, auditError, refreshAudit, setAuditEnabled, clearAudit, readAudit, type AuditEvent } from "../lib/audit";
const events = ref<AuditEvent[]>([]), busy = ref(false), message = ref("");
let disposed = false;
const names = { unlock: "成功解锁", "copy-password": "复制密码", "auto-type": "完成自动输入", merge: "合并外部修改" };
async function refresh() { try { const result = await readAudit(); if (!disposed) events.value = result; } catch { if (!disposed) message.value = "审计文件读取失败，未显示不完整记录"; } }
async function toggle(event: Event) {
  if (busy.value) return;
  const enabled = (event.target as HTMLInputElement).checked;
  busy.value = true; message.value = "";
  try { await setAuditEnabled(enabled); await refresh(); }
  catch { message.value = "设置失败，原审计状态保持不变"; }
  finally { busy.value = false; }
}
async function clear() { if (busy.value) return; busy.value = true; message.value = ""; try { await clearAudit(); events.value = []; message.value = "本机事件记录已清空"; } catch { message.value = "清空失败，请重试"; } finally { busy.value = false; } }
onMounted(async () => { await refreshAudit(); if (!disposed) await refresh(); });
onBeforeUnmount(() => { disposed = true; events.value = []; });
</script>
<template><section class="space-y-4"><h4 class="font-serif text-lg font-semibold text-[#5c4033]">本地时间线</h4><label class="flex items-center gap-2 text-sm text-stone-700"><input type="checkbox" :checked="auditState.enabled" :disabled="busy" @change="toggle" />启用本地审计时间线（默认关闭）</label><p class="text-xs leading-relaxed text-stone-500">仅在本机保留 7 天，记录操作、条目 ID 和时间，不含密码等内容。</p><div class="flex gap-2"><button class="rounded-full border border-stone-300 px-4 py-2 text-xs" :disabled="busy" @click="refresh">刷新</button><button class="rounded-full border border-[#8b2332]/40 px-4 py-2 text-xs text-[#8b2332]" :disabled="busy" @click="clear">清空本机记录</button></div><p v-if="message || auditError" role="status" class="text-xs text-[#8b2332]">{{ message || auditError }}</p><ol v-if="events.length" class="max-h-80 space-y-3 overflow-y-auto border-l border-stone-200 pl-4"><li v-for="(event, index) in [...events].reverse()" :key="index" class="relative text-xs"><span class="absolute -left-[21px] top-1 h-2 w-2 rounded-full bg-[#8b9d77]"/><time class="text-stone-400">{{ new Date(event.at).toLocaleString('zh-CN', { hour12: false }) }}</time><p class="mt-1 font-medium text-[#5c4033]">{{ names[event.kind] }}</p><p v-if="event.entryUuid" class="mt-1 break-all font-mono text-[10px] text-stone-400">条目 {{ event.entryUuid }}</p></li></ol><p v-else class="rounded-[1rem] bg-[#faf6f1] p-5 text-center text-xs text-stone-500">{{ auditState.enabled ? '暂无记录' : '未启用，不记录使用轨迹' }}</p></section></template>
