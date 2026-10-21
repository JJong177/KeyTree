<script setup lang="ts">
import { computed } from "vue";
import { queryTokens, type SearchEntry } from "../lib/search";
import MatchText from "./MatchText.vue";
const props = defineProps<{ entry: SearchEntry; query: string }>();
const context = computed(() => {
  const tokens = queryTokens(props.query);
  const matches = (text: string) => tokens.some(t => text.toLocaleLowerCase().includes(t));
  const parts: string[] = [];
  if (props.entry.username && matches(props.entry.url)) parts.push(props.entry.url);
  const tags = props.entry.tags.filter(matches);
  if (tags.length) parts.push(`标签：${tags.join(" · ")}`);
  return parts.join(" · ");
});
</script>
<template><span v-if="context" class="block truncate text-[11px] text-[#6d785f]"><MatchText :text="context" :query="query" /></span></template>
