<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { TooltipProvider, TooltipRoot, TooltipTrigger, TooltipPortal, TooltipContent } from "radix-vue";
import { useVault } from "../composables/useVault";

const { usernameGroups, selectedUsername, selectUsername } = useVault();
const search = ref("");
const overflowedUsername = ref<string | null>(null);
const tooltipUsername = ref<string | null>(null);

const filteredGroups = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  if (!needle) return usernameGroups.value;
  return usernameGroups.value.filter((group) => {
    const label = group.username === "" ? "未填写账号" : group.username;
    return label.toLocaleLowerCase().includes(needle);
  });
});

watch(filteredGroups, () => {
  overflowedUsername.value = null;
  tooltipUsername.value = null;
});

function measureOverflow(event: Event, username: string) {
  const label = (event.currentTarget as HTMLElement).querySelector<HTMLElement>("[data-account-name]");
  const truncated = !!label && label.scrollWidth > label.clientWidth;
  overflowedUsername.value = truncated ? username : null;
  if (event.type === "focus") tooltipUsername.value = truncated ? username : null;
}

function setTooltipOpen(open: boolean, username: string) {
  if (open) {
    if (overflowedUsername.value === username) tooltipUsername.value = username;
  } else if (tooltipUsername.value === username) {
    tooltipUsername.value = null;
  }
}
</script>

<template>
  <section class="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="账号筛选">
    <label class="px-3 pb-2 pt-3">
      <span class="sr-only">搜索账号</span>
      <input
        v-model="search"
        type="search"
        class="w-full rounded-full border border-stone-200 bg-[#faf6f1] px-3 py-1.5 text-xs text-stone-800 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
        placeholder="搜索账号…"
        aria-label="搜索账号"
        @keydown.esc.stop="search = ''"
      />
    </label>

    <TooltipProvider :delay-duration="350" :skip-delay-duration="0">
      <ul class="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3 text-sm" aria-label="账号分类">
        <li v-for="group in filteredGroups" :key="group.username" :data-username="group.username">
          <TooltipRoot :open="tooltipUsername === group.username" @update:open="open => setTooltipOpen(open, group.username)">
            <TooltipTrigger as-child>
              <button
                type="button"
                class="flex w-full min-w-0 items-start justify-between gap-2 rounded-[1rem] border py-2 pl-3 pr-2 text-left transition-colors duration-300"
                :class="selectedUsername === group.username ? 'border-stone-300 bg-[#faf6f1] font-medium' : 'border-transparent hover:bg-stone-100'"
                :aria-pressed="selectedUsername === group.username"
                @pointerenter="measureOverflow($event, group.username)"
                @focus="measureOverflow($event, group.username)"
                @click="selectUsername(selectedUsername === group.username ? null : group.username)"
              >
                <span data-account-name class="min-w-0 flex-1 truncate leading-5 text-stone-800">
                  {{ group.username === "" ? "未填写账号" : group.username }}
                </span>
                <span
                  data-account-count
                  :aria-label="`${group.entryCount} 条记录`"
                  class="shrink-0 rounded-full px-2 py-0.5 text-xs"
                  :class="selectedUsername === group.username ? 'bg-stone-800 text-stone-50' : 'text-stone-400'"
                >
                  {{ group.entryCount }}
                </span>
              </button>
            </TooltipTrigger>
            <TooltipPortal>
              <TooltipContent
                data-account-tooltip
                side="right"
                align="start"
                :side-offset="8"
                :collision-padding="12"
                class="z-50 max-w-xs break-all rounded-2xl border border-[#ded9d1] bg-[#fffdf9] px-3 py-2 text-xs leading-5 text-[color:var(--ink-soft)] shadow-[0_12px_32px_-8px_#5c403326,0_3px_8px_#5c40330a]"
              >
                {{ group.username === "" ? "未填写账号" : group.username }}
              </TooltipContent>
            </TooltipPortal>
          </TooltipRoot>
        </li>
        <li v-if="!filteredGroups.length" class="px-3 py-3 text-center text-xs text-stone-400">
          {{ search.trim() ? "没有匹配的账号" : "还没有可显示的账号" }}
        </li>
      </ul>
    </TooltipProvider>
  </section>
</template>
