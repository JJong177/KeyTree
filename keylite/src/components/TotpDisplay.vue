<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { copyText } from "../lib/clipboard";
import { formatCode, generateTotp, type TotpConfig } from "../lib/totp";

const props = defineProps<{ config: TotpConfig }>();

const raw = ref("");
const code = ref("");
const remaining = ref(0);
const error = ref("");

let timer: number | undefined;

async function refresh() {
  try {
    const result = await generateTotp(props.config);
    raw.value = result.code;
    code.value = formatCode(result.code);
    remaining.value = result.remaining;
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(() => {
  void refresh();
  timer = window.setInterval(() => void refresh(), 500);
});

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer);
});

watch(
  () => props.config,
  () => void refresh()
);

// 圆环周长：2 * π * 16
const CIRCUMFERENCE = 100.53;

function copy() {
  if (!raw.value) return;
  // 动态码过期后自动清空剪贴板，避免复制到一半就失效的码留在外面
  copyText(raw.value, Math.max(1, remaining.value) * 1000);
}
</script>

<template>
  <div class="rounded-[1rem] border border-stone-200 bg-[#8b9d77]/10 p-3">
    <div class="mb-1 flex items-center justify-between text-xs text-stone-500">
      <span>两步验证 (TOTP)</span>
      <span v-if="props.config.issuer || props.config.account" class="truncate pl-2">
        {{ props.config.issuer || props.config.account }}
      </span>
    </div>

    <div v-if="!error" class="flex items-center gap-3">
      <svg width="40" height="40" viewBox="0 0 40 40" class="shrink-0">
        <circle cx="20" cy="20" r="16" fill="none" stroke="#8b9d77" stroke-width="1.5" />
        <circle
          cx="20"
          cy="20"
          r="16"
          fill="none"
          stroke="#8b2332"
          stroke-width="3"
          stroke-linecap="round"
          :stroke-dasharray="`${(CIRCUMFERENCE * remaining) / (props.config.period || 30)} 1000`"
          transform="rotate(-90 20 20)"
        />
        <text
          x="20"
          y="24"
          text-anchor="middle"
          font-size="11"
          font-weight="bold"
          fill="#5c4033"
        >
          {{ remaining }}
        </text>
      </svg>

      <div class="min-w-0 flex-1">
        <div class="font-bold text-2xl tracking-wider text-stone-800">
          {{ code || "------" }}
        </div>
        <div class="text-xs text-stone-500">
          {{ props.config.steam ? "Steam 令牌" : `${props.config.period} 秒刷新` }}
          <span v-if="props.config.steam"> · {{ props.config.period }} 秒</span>
        </div>
      </div>

      <button
        class="shrink-0 rounded-full border border-stone-300 bg-white px-3 py-2 text-xs text-stone-700 transition-colors duration-300 hover:bg-stone-100"
        @click="copy"
      >
        复制
      </button>
    </div>

    <p v-else class="text-xs text-[#8b2332]">动态码生成失败：{{ error }}</p>
  </div>
</template>
