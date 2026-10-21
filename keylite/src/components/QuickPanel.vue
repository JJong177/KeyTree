<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useDialogFocus } from "../composables/useDialogFocus";
import { useVault } from "../composables/useVault";
import { copyText } from "../lib/clipboard";
import { toast } from "../lib/toast";
import { formatCode, generateTotp } from "../lib/totp";
import { relativeTime } from "../lib/format";
import { searchEntries } from "../lib/search";
import { recordAudit } from "../lib/audit";
import EntryAvatar from "./EntryAvatar.vue";
import EmptyState from "./EmptyState.vue";
import MatchText from "./MatchText.vue";
import MatchContext from "./MatchContext.vue";
import TotpCountdown from "./TotpCountdown.vue";

const emit = defineEmits<{ close: []; edit: [uuid: string] }>();

const { entries, selectGroup, selectEntry, totpConfigOf, draftOf, touchUsage, autoType, error } = useVault();

const dialogRoot = ref<HTMLElement | null>(null);
useDialogFocus(dialogRoot, () => emit("close"));

const query = ref("");
const activeIndex = ref(0);
const showActions = ref(false);
const inputRef = ref<HTMLInputElement | null>(null);

const results = computed(() => searchEntries(entries.value.filter(e => !e.inTrash), query.value).slice(0, 20));

const active = computed(() => results.value[activeIndex.value] ?? null);

function move(delta: number) {
  if (!results.value.length) return;
  activeIndex.value =
    (activeIndex.value + delta + results.value.length) % results.value.length;
}

async function copyPassword() {
  const entry = active.value;
  if (!entry) return;
  const draft = draftOf(entry.uuid);
  if (!draft) return;
  if (await copyText(draft.password)) { void touchUsage(entry.uuid); void recordAudit("copy-password", entry.uuid); emit("close"); }
}

async function copyUsername() {
  const entry = active.value;
  if (!entry || !entry.username) return;
  if (await copyText(entry.username, 0)) emit("close");
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
  if (await copyText(result.code, Math.max(1, result.remaining) * 1000)) {
    void touchUsage(entry.uuid);
    toast(`动态码 ${formatCode(result.code)} · 剩 ${result.remaining} 秒`);
    emit("close");
  }
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

async function autoTypeEntry() {
  if (!active.value) return;
  const ok = await autoType(active.value.uuid);
  if (ok) emit("close"); else toast(error.value || "自动输入失败");
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
      ref="dialogRoot" role="dialog" aria-modal="true" aria-label="快速搜索" tabindex="-1"
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
            <EntryAvatar :title="e.title" :icon="e.icon" :size="32" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-stone-800">
                <MatchText :text="e.title" :query="query" />
                <span v-if="e.favorite" class="text-[#d4a373]">★</span>
                <TotpCountdown v-if="e.totpPeriod" :period="e.totpPeriod" />
              </span>
              <span class="block truncate text-xs text-stone-500">
                <MatchText :text="e.username || e.url || '—'" :query="query" />
              <MatchContext :entry="e" :query="query" />
              </span>
            </span>
            <span class="shrink-0 text-xs text-stone-400">{{ relativeTime(e.updatedAt) }}</span>
          </button>
        </li>

        <li v-if="!results.length" class="px-4 py-10 text-center text-sm text-stone-400">
          <EmptyState kind="search" title="没有找到匹配条目" description="试试标题、用户名、网址或标签中的关键词。" />
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
          <button class="rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs text-stone-700" @click="autoTypeEntry">自动输入</button>
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
