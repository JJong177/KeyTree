<script setup lang="ts">
import { ref, watch } from "vue";
import { initialOf } from "../lib/format";
const props = withDefaults(defineProps<{ title: string; icon?: string | null; size?: number }>(), { size: 36 });
const failed = ref(false);
watch(() => props.icon, () => { failed.value = false; });
</script>
<template>
  <span class="entry-avatar" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${size * .38}px` }" aria-hidden="true">
    <img v-if="icon && !failed" :src="icon" alt="" :style="{ width: `${size * .66}px`, height: `${size * .66}px` }" @error="failed = true" />
    <span v-else>{{ initialOf(title) }}</span>
  </span>
</template>
<style scoped>
.entry-avatar { display:inline-flex; flex-shrink:0; align-items:center; justify-content:center; overflow:hidden; border:1px solid #dfd4c6; border-radius:32%; background:#f5eee3; color:#5c4033; font-weight:600; }
img { object-fit:contain; filter:saturate(.6); border-radius:20%; }
</style>
