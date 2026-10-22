<script setup lang="ts">
withDefaults(defineProps<{ title: string; description?: string; kind?: "leaf" | "box" | "search" }>(), { kind: "leaf", description: "" });
</script>
<template>
  <div class="empty-state px-5 py-10 text-center">
    <svg class="mx-auto mb-4 text-[#8b9d77]" width="68" height="68" viewBox="0 0 68 68" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <template v-if="kind === 'box'"><path d="M14 27 34 17 54 27 34 38Z M14 27v23l20 10 20-10V27 M34 38v22 M22 21l20 11" /><path d="m28 8 3 5m10-6-2 6" opacity=".5" /></template>
      <template v-else-if="kind === 'search'"><circle cx="29" cy="29" r="17"/><path d="m42 42 15 15 M24 29h10"/><path d="M10 55h13m-6-6v12" opacity=".45"/></template>
      <template v-else><path d="M18 49C8 24 33 12 53 12c0 21-4 43-29 42 M16 59l30-36 M25 47l-1-14m10 5 12-1"/><path d="M10 62h48" opacity=".4"/></template>
    </svg>
    <h4 class="font-serif text-base font-semibold text-[#5c4033]">{{ title }}</h4>
    <p v-if="description" class="mx-auto mt-2 max-w-xs text-xs leading-relaxed text-stone-500">{{ description }}</p>
    <slot />
  </div>
</template>
