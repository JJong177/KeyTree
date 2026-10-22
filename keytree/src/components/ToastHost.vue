<script setup lang="ts">
import { toastText } from "../lib/toast";
</script>

<template>
  <div class="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2">
    <div
      class="rounded-full bg-stone-800 px-5 py-2 text-sm text-stone-50 transition-all duration-300"
      :class="toastText ? 'translate-y-0 opacity-100' : 'translate-y-2 opacity-0'"
    >
      {{ toastText || " " }}
    </div>
  </div>
</template>
