<script setup lang="ts">
import { computed } from "vue";
import { highlightParts } from "../lib/search";
const props = defineProps<{ text: string; query: string }>();
const parts = computed(() => highlightParts(props.text, props.query));
</script>
<template><span><template v-for="(part, i) in parts" :key="i"><mark v-if="part.hit" class="rounded bg-[#d4a373]/30 px-0 text-inherit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></span></template>
