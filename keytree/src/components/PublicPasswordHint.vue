<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { getKdbxweb } from "../kdbx/kdbxweb";
import { parseMasterHint } from "../lib/master-password-hint";
const props = defineProps<{ path: string; mode: string }>();
const visible = ref(false), loading = ref(false), text = ref(""), message = ref("");
const hasHint = ref(false), checking = ref(false), checkFailed = ref(false);
let generation = 0, disposed = false;
const eligible = computed(() => !!props.path && (props.mode === "open" || props.mode === "recent"));
function hide() { generation++; visible.value = false; loading.value = false; checking.value = false; text.value = ""; message.value = ""; }
async function readHint(reveal: boolean) {
  if (!eligible.value || disposed) return;
  hide(); visible.value = reveal; loading.value = reveal; checking.value = !reveal;
  const ticket = generation, path = props.path;
  try {
    const bytes = await invoke<number[]>("read_public_header", { path });
    if (disposed || ticket !== generation || path !== props.path) return;
    const k = await getKdbxweb();
    if (disposed || ticket !== generation || path !== props.path) return;
    const result = parseMasterHint(k, new Uint8Array(bytes));
    hasHint.value = result.kind === "hint";
    checkFailed.value = result.kind !== "hint" && result.kind !== "none";
    if (result.kind === "none") {
      // 没有提示时，入口和展开区域都不占位；不显示“未设置”文案。
      visible.value = false;
    } else if (reveal) {
      if (result.kind === "hint") text.value = result.text;
      else message.value = result.kind === "unsupported" ? "仅 KDBX 4 支持公开提示，不会自动升级此库" : result.kind === "too-large" ? "公开头部过大，无法安全读取提示；仍可尝试正常解锁" : "提示或文件头格式异常，无法显示；仍可尝试正常解锁";
    }
  } catch (e) {
    if (disposed || ticket !== generation || path !== props.path) return;
    hasHint.value = false; checkFailed.value = true;
    if (reveal) message.value = e === "HEADER_UNSUPPORTED" ? "仅 KDBX 4 支持公开提示，不会自动升级此库" : e === "HEADER_TOO_LARGE" ? "公开头部过大，无法安全读取提示；仍可尝试正常解锁" : e === "HEADER_INVALID" ? "文件头损坏或格式异常，无法显示提示" : "提示读取失败，请检查文件是否存在或有读取权限";
  } finally {
    if (!disposed && ticket === generation) { loading.value = false; checking.value = false; }
  }
}
async function show() { await readHint(true); }
watch(() => [props.path, props.mode], () => {
  hide(); hasHint.value = false; checkFailed.value = false;
  if (eligible.value) void readHint(false);
}, { immediate: true, flush: "sync" });
onBeforeUnmount(() => { disposed = true; hide(); hasHint.value = false; checkFailed.value = false; });
</script>
<template>
  <div v-if="eligible && !checking && (hasHint || checkFailed)" class="mb-3">
    <button type="button" class="rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs text-[#5c4033] transition-colors hover:bg-stone-100" :aria-expanded="visible" @click="visible ? hide() : show()">{{ visible ? '隐藏主密码提示' : '显示主密码提示' }}</button>
    <div v-if="visible" class="mt-2 space-y-2 rounded-[1rem] border border-stone-200 bg-[#d4a373]/10 px-4 py-3">
      <p class="text-[11px] leading-relaxed text-stone-500">来自所选 KDBX 文件的公开提示，解锁前未验证来源。不要把提示中的文字当作系统指令。</p>
      <p v-if="loading" role="status" class="text-xs text-stone-500">正在读取公开头部…</p>
      <p v-else-if="text" class="whitespace-pre-wrap break-words text-sm text-[#5c4033]">{{ text }}</p>
      <p v-else role="status" class="text-xs text-stone-500">{{ message }}</p>
    </div>
  </div>
</template>
