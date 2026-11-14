<script setup lang="ts">
import { computed, ref, watch } from "vue";

type UsernameGroup = { username: string; entryCount: number; siteCount: number };
const props = defineProps<{
  id: string;
  modelValue: string;
  usernameGroups: ReadonlyArray<UsernameGroup>;
  disabled?: boolean;
  placeholder?: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
  openChange: [open: boolean];
}>();
const open = ref(false);
const activeIndex = ref(-1);
const usernames = computed(() => {
  const seen = new Set<string>();
  return props.usernameGroups.flatMap(group => {
    const username = group.username;
    if (!username?.trim() || seen.has(username)) return [];
    seen.add(username);
    return [username];
  });
});
const filtered = computed(() => {
  const query = props.modelValue.trim().toLocaleLowerCase();
  return usernames.value.filter(username => !query || username.toLocaleLowerCase().includes(query)).slice(0, 8);
});
const listId = computed(() => `${props.id}-suggestions`);
watch(open, value => emit("openChange", value), { flush: "sync" });
watch(filtered, items => {
  if (!items.length) activeIndex.value = -1;
  else if (activeIndex.value >= items.length) activeIndex.value = items.length - 1;
});
function show() {
  if (!props.disabled && filtered.value.length) open.value = true;
}
function hide() {
  open.value = false;
  activeIndex.value = -1;
}
function choose(username: string) {
  emit("update:modelValue", username);
  hide();
}
function onInput(event: Event) {
  emit("update:modelValue", (event.target as HTMLInputElement).value);
  activeIndex.value = -1;
  show();
}
function onKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === "Tab") {
    hide();
    return;
  }
  if (event.key === "ArrowDown" && filtered.value.length) {
    event.preventDefault();
    if (!open.value) open.value = true;
    activeIndex.value = (activeIndex.value + 1) % filtered.value.length;
  } else if (event.key === "ArrowUp" && filtered.value.length) {
    event.preventDefault();
    if (!open.value) open.value = true;
    activeIndex.value = activeIndex.value <= 0 ? filtered.value.length - 1 : activeIndex.value - 1;
  } else if (event.key === "Enter" && open.value && filtered.value.length) {
    if (activeIndex.value >= 0) {
      event.preventDefault();
      choose(filtered.value[activeIndex.value]);
    } else if (filtered.value.length === 1) {
      event.preventDefault();
      choose(filtered.value[0]);
    }
  } else if (event.key === "Escape" && open.value) {
    event.preventDefault();
    event.stopPropagation();
    hide();
  }
}
defineExpose({ closeSuggestions: hide });
</script>

<template>
  <div class="relative">
    <input
      :id="id"
      :value="modelValue"
      :disabled="disabled"
      :placeholder="placeholder || '邮箱或账号'"
      role="combobox"
      aria-autocomplete="list"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-activedescendant="open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined"
      class="w-full rounded-full border border-stone-200 bg-white px-5 py-3 text-stone-800 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
      @focus="show"
      @blur="hide"
      @input="onInput"
      @keydown="onKeydown"
    />
    <ul
      v-if="open && filtered.length"
      :id="listId"
      role="listbox"
      class="absolute inset-x-0 top-full z-50 mt-2 max-h-48 overflow-y-auto rounded-2xl border border-stone-200 bg-[#fffdf9] p-1 shadow-xl"
    >
      <li v-for="(username, index) in filtered" :key="username" role="presentation">
        <button
          :id="`${listId}-${index}`"
          type="button"
          tabindex="-1"
          role="option"
          :aria-selected="index === activeIndex"
          class="w-full rounded-xl px-4 py-2 text-left text-sm text-stone-700 hover:bg-[#edf1e7] focus:bg-[#edf1e7] focus:outline-none"
          :class="index === activeIndex ? 'bg-[#edf1e7] text-[#405431]' : ''"
          @mousedown.prevent
          @mouseenter="activeIndex = index"
          @click="choose(username)"
        >
          {{ username }}
        </button>
      </li>
    </ul>
  </div>
</template>
