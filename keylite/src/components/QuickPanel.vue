<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useVault } from "../composables/useVault";
import { copyText } from "../lib/clipboard";
import { toast } from "../lib/toast";
import { formatCode, generateTotp } from "../lib/totp";
import { initialOf, relativeTime, toneOf } from "../lib/format";

const emit = defineEmits<{ close: []; edit: [uuid: string] }>();

const { entries, selectGroup, selectEntry, totpConfigOf, draftOf } = useVault();

const query = ref("");
const activeIndex = ref(0);
const showActions = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);

const results = computed(() => {
  const q = query.value.trim().toLowerCase();
  const list = entries.value.filter((e) => !e.inTrash);
  const matched = q
    ? list.filter((e) =>
        [e.title, e.username, e.url, ...e.tags]
          .join("\n")
          .toLowerCase()
          .includes(q)
      )
    : list;
  return [...matched].sort(
    // spec §6.2：最近使用 > 收藏 > 最近修改
    (a, b) =>
      (b.usageCount ?? 0) - (a.usageCount ?? 0) ||
      Number(b.favorite ?? false) - Number(a.favorite ?? false) ||
      (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)
  ).slice(0, 20);
});

const active = computed(() => results.value[activeIndex.value] ?? null);

function move(delta: number) {
  if (!results.value.length) return;
  activeIndex.value =
    (activeIndex.value + delta + results.value.length) % results.value.length;
}

function copyPassword() {
  const entry = active.value;
  if (!entry) return;
  const draft = draftOf(entry.uuid);
  if (!draft) return;
  copyText(draft.password);
}

function copyUsername() {
  const entry = active.value;
  if (!entry || !entry.username) return;
  copyText(entry.username, 0);
}

async function copyTotp() {
  const entry = active.value;
  if (!entry) return;
  const config = totpConfigOf(entry.uuid);
  if (!config) {
    toast("这条没有可解析的 TOTP 密钥");
    return;
  }
  const result = await generateTotp(config);
  copyText(result.code, Math.max(1, result.remaining) * 1000);
  toast(`动态码 ${formatCode(result.code)} · 剩 ${result.remaining} 秒`);
}

async function openUrl() {
  const entry = active.value;
  if (!entry?.url) return;
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry.url)
    ? entry.url
    : `https://${entry.url}`;
  try {
    await invoke("open_url", { url: raw });
    emit("close");
  } catch (e) {
    toast(typeof e === "string" ? e : "打开链接失败");
  }
}

function editInApp() {
  const entry = active.value;
  if (!entry) return;
  selectGroup("all");
  selectEntry(entry.uuid);
  emit("edit", entry.uuid);
  emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    emit("close");
    return;
  }
  if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    showActions.value = !showActions.value;
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (showActions.value) {
      copyUsername();
    } else {
      copyPassword();
    }
  }
}

onMounted(async () => {
  await nextTick();
  inputRef.value?.focus();
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div
    class="fixed inset-0 z-50 flex items-start justify-center bg-stone-800/20 px-4 pt-[12vh]"
    @click.self="emit('close')"
  >
    <div
      class="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-[2rem] border border-stone-300 bg-[#faf6f1]"
    >
      <!-- 搜索框 -->
      <div class="flex items-center gap-3 border-b border-stone-200 px-4 py-3">
        <svg width="18" height="18" viewBox="0 0 20 20" class="shrink-0">
          <circle cx="8" cy="8" r="6" fill="#8b9d77" opacity="0.3" stroke="#5c4033" stroke-width="1.5" />
          <path d="M13 13 L18 18" stroke="#5c4033" stroke-width="1.5" stroke-linecap="round" />
        </svg>
        <input
          ref="inputRef"
          v-model="query"
          class="flex-1 bg-transparent text-lg font-semibold text-stone-800 placeholder:font-normal placeholder:text-stone-400 focus:outline-none"
          placeholder="搜索标题、用户名、网址、标签…"
          @input="activeIndex = 0; showActions = false"
        />
        <span class="shrink-0 rounded-full border border-stone-200 bg-white px-2 py-1 text-xs text-stone-500">
          Esc
        </span>
      </div>

      <!-- 结果 -->
      <ul class="min-h-0 flex-1 overflow-y-auto p-2">
        <li v-for="(e, index) in results" :key="e.uuid">
          <button
            class="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2.5 text-left transition-colors duration-150"
            :class="
              index === activeIndex
                ? 'border-2 border-[#8b9d77] bg-[#8b9d77]/10'
                : 'border border-transparent hover:bg-stone-100'
            "
            @mouseenter="activeIndex = index"
            @click="activeIndex = index; copyPassword()"
          >
            <span
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-stone-300 text-sm font-semibold text-stone-800"
              :class="toneOf(e.title) === 'sage' ? 'bg-[#8b9d77]/30' : 'bg-[#d4a373]/30'"
            >
              {{ initialOf(e.title) }}
            </span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-stone-800">
                {{ e.title }}
                <span v-if="e.favorite" class="text-[#d4a373]">★</span>
                <span v-if="e.hasTotp" class="ml-1 text-xs text-[#8b9d77]">⏱</span>
              </span>
              <span class="block truncate text-xs text-stone-500">
                {{ e.username || e.url || "—" }}
              </span>
            </span>
            <span class="shrink-0 text-xs text-stone-400">{{ relativeTime(e.updatedAt) }}</span>
          </button>
        </li>

        <li v-if="!results.length" class="px-4 py-10 text-center text-sm text-stone-400">
          没有匹配的条目
        </li>
      </ul>

      <!-- 次级动作 -->
      <div v-if="showActions && active" class="border-t border-stone-200 px-3 py-2">
        <div class="flex flex-wrap gap-2">
          <button class="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-100" @click="copyUsername">
            复制用户名
          </button>
          <button class="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-100" @click="copyPassword">
            复制密码
          </button>
          <button v-if="active.hasTotp" class="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-100" @click="copyTotp">
            复制动态码
          </button>
          <button v-if="active.url" class="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-100" @click="openUrl">
            打开网址
          </button>
          <button class="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-100" @click="editInApp">
            在主界面定位
          </button>
        </div>
      </div>

      <!-- 快捷键提示 -->
      <div class="flex flex-wrap items-center gap-3 border-t border-stone-200 px-4 py-2 text-xs text-stone-500">
        <span><kbd class="rounded-full border border-stone-200 bg-white px-1.5 py-0.5">Enter</kbd> 复制密码</span>
        <span><kbd class="rounded-full border border-stone-200 bg-white px-1.5 py-0.5">Tab</kbd> 更多动作</span>
        <span><kbd class="rounded-full border border-stone-200 bg-white px-1.5 py-0.5">↑↓</kbd> 选择</span>
        <span class="ml-auto text-[#8b2332]">复制后自动清空剪贴板</span>
      </div>
    </div>
  </div>
</template>
