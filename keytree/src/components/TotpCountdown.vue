<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { secondsRemaining } from "../lib/totp";
const props = defineProps<{ period: number }>();
const now = ref(Date.now());
let timer: number | undefined;
onMounted(() => { timer = window.setInterval(() => { now.value = Date.now(); }, 1000); });
onBeforeUnmount(() => { window.clearInterval(timer); });
const remaining = computed(() => secondsRemaining(props.period, now.value));
</script>
<template><span class="inline-flex shrink-0 items-center gap-1 text-[11px]" :class="remaining <= 5 ? 'text-[#8b2332]' : 'text-[#667953]'" :title="`动态码 ${remaining} 秒后刷新`"><svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" opacity=".2" stroke-width="2"/><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" :stroke-dasharray="`${56.55 * remaining / period} 56.55`" transform="rotate(-90 12 12)"/></svg>{{ remaining }}s</span></template>
