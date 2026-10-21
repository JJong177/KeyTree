<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { copyText, useClipboardStatus } from "../lib/clipboard";
import { toast } from "../lib/toast";
import { relativeTime } from "../lib/format";
import { searchEntries } from "../lib/search";
import EntryAvatar from "../components/EntryAvatar.vue";
import EmptyState from "../components/EmptyState.vue";
import MatchText from "../components/MatchText.vue";
import MatchContext from "../components/MatchContext.vue";
import TotpCountdown from "../components/TotpCountdown.vue";
import {
  PANEL_OPENED_EVENT,
  PANEL_REQUEST_EVENT,
  PANEL_RESPONSE_EVENT,
  type PanelEntry,
  type PanelResponse,
  type CopyAction,
} from "../lib/panel";

useClipboardStatus();

const query = ref("");
const entries = ref<PanelEntry[]>([]);
const unlocked = ref(false);
const activeIndex = ref(0);
const showActions = ref(false);
/** 动作条上被 ←/→/Tab 选中的下标；-1 = 未选 */
const actionIndex = ref(-1);
const inputRef = ref<HTMLInputElement | null>(null);
/** 发起复制后等主窗口回话时，记住要做的事 */
const pending = ref("");
const session = ref(0);
function resetPending() { pending.value = ""; }

const listeners: UnlistenFn[] = [];

/** 次级动作（键盘可达：←/→ 或 Tab 循环，Enter 执行） */
interface PanelAction {
  key: string;
  label: string;
  run: () => void;
}

const actions = computed<PanelAction[]>(() => {
  const entry = active.value;
  if (!entry) return [];
  const list: PanelAction[] = [
    { key: "copy-password", label: "复制密码", run: () => void copyPassword() },
  ];
  if (entry.username) {
    list.push({
      key: "copy-username",
      label: "复制用户名",
      run: () => { void requestCopy("username"); },
    });
  }
  if (entry.hasTotp) {
    list.push({ key: "copy-totp", label: "复制动态码", run: () => void copyTotp() });
  }
  list.push({ key: "auto-type", label: "自动输入", run: () => void autoTypeEntry() });
  if (entry.url) {
    list.push({ key: "open-url", label: "打开网址", run: openUrl });
  }
  list.push({ key: "focus", label: "在主界面定位", run: () => void focusInMain() });
  return list;
});

const results = computed(() => searchEntries(entries.value, query.value).slice(0, 20));

const active = computed(() => results.value[activeIndex.value] ?? null);

function hide() {
  resetPending();
  void invoke("hide_panel");
}

async function sync() {
  await emit(PANEL_REQUEST_EVENT, { kind: "sync" });
}

function move(delta: number) {
  if (!results.value.length) return;
  activeIndex.value =
    (activeIndex.value + delta + results.value.length) % results.value.length;
  // 换了条目，动作列表跟着变，把选中的动作夹回有效范围
  clampActionIndex();
}

function clampActionIndex() {
  if (!showActions.value) return;
  if (!actions.value.length) {
    showActions.value = false;
    actionIndex.value = -1;
    return;
  }
  if (actionIndex.value < 0 || actionIndex.value >= actions.value.length) {
    actionIndex.value = 0;
  }
}

/** Tab：收起→展开并选中第一个；展开中→循环切下一个 */
function toggleActions() {
  if (!active.value) return;
  if (!showActions.value || actionIndex.value < 0) {
    showActions.value = true;
    actionIndex.value = 0;
    return;
  }
  actionIndex.value = (actionIndex.value + 1) % actions.value.length;
}

function resetToSearch() {
  activeIndex.value = 0;
  showActions.value = false;
  actionIndex.value = -1;
}

async function requestCopy(action: CopyAction) {
  if (!active.value || !unlocked.value || pending.value) return;
  const requestId = crypto.randomUUID(); pending.value = requestId;
  try { await emit(PANEL_REQUEST_EVENT, { kind: "copy", action, id: active.value.id, requestId, session: session.value }); }
  catch { resetPending(); toast("复制请求失败"); }
  window.setTimeout(() => { if (pending.value === requestId) { resetPending(); toast("请求超时，请重试"); } }, 5000);
}
async function copyPassword() { await requestCopy("password"); }
async function copyTotp() { await requestCopy("totp"); }

async function focusInMain() {
  if (!active.value) return;
  await emit(PANEL_REQUEST_EVENT, { kind: "focus", id: active.value.id, session: session.value });
  hide();
}

async function autoTypeEntry() {
  if (!active.value) return;
  // 面板由 Rust 侧收起并把焦点还给上一个前台窗口，这里不抢着 hide
  await emit(PANEL_REQUEST_EVENT, { kind: "auto-type", id: active.value.id, session: session.value });
}

function openUrl() {
  const entry = active.value;
  if (!entry?.url) return;
  const raw = /^[a-z][a-z0-9+.-]*:\/\//i.test(entry.url)
    ? entry.url
    : `https://${entry.url}`;
  void invoke("open_url", { url: raw })
    .then(hide)
    .catch((e) => toast(typeof e === "string" ? e : "打开链接失败"));
}

async function onResponse(payload: PanelResponse) {
  if (payload.kind === "state") {
    if (payload.session < session.value) return;
    if (session.value !== payload.session || !payload.unlocked) resetPending();
    session.value = payload.session; unlocked.value = payload.unlocked;
    entries.value = payload.unlocked ? payload.entries : [];
    if (!payload.unlocked) { query.value = ""; showActions.value = false; }
    if (activeIndex.value >= results.value.length) activeIndex.value = 0;
    return;
  }
  if (payload.kind === "notice") { toast(payload.message); return; }
  if (payload.kind !== "copy" || !unlocked.value || payload.session !== session.value || payload.requestId !== pending.value) return;
  resetPending();
  if (!payload.value) { toast("这条没有可复制的内容"); return; }
  const copied = await copyText(payload.value, payload.ttl * 1000);
  if (!copied || !unlocked.value || payload.session !== session.value) return;
  await emit(PANEL_REQUEST_EVENT, { kind: "copied", id: payload.id, requestId: payload.requestId, session: payload.session });
  hide();
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    // 动作条展开时第一下 Esc 先收动作条，再一下才关面板
    if (showActions.value) {
      showActions.value = false;
      actionIndex.value = -1;
      return;
    }
    hide();
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
    toggleActions();
    return;
  }
  if (event.key === "ArrowRight" && showActions.value && actions.value.length) {
    event.preventDefault();
    actionIndex.value = (actionIndex.value + 1) % actions.value.length;
    return;
  }
  if (event.key === "ArrowLeft" && showActions.value && actions.value.length) {
    event.preventDefault();
    actionIndex.value =
      (actionIndex.value - 1 + actions.value.length) % actions.value.length;
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (showActions.value && actionIndex.value >= 0) {
      actions.value[actionIndex.value]?.run();
      return;
    }
    void copyPassword();
  }
}

onMounted(async () => {
  listeners.push(
    await listen<PanelResponse>(PANEL_RESPONSE_EVENT, (event) =>
      void onResponse(event.payload).catch(() => toast("快速访问操作失败，请重试"))
    )
  );
  listeners.push(
    await listen(PANEL_OPENED_EVENT, async () => {
      pending.value = "";
      showActions.value = false;
      actionIndex.value = -1;
      query.value = "";
      activeIndex.value = 0;
      await sync();
      await nextTick();
      inputRef.value?.focus();
      inputRef.value?.select();
    })
  );
  window.addEventListener("keydown", onKeydown);
  await sync();
  await nextTick();
  inputRef.value?.focus();
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  for (const off of listeners) off();
});
</script>

<template>
  <!-- 窗口真透明：外圈留白给阴影呼吸，卡片自己画圆角/边框/投影 -->
  <div class="h-screen w-screen overflow-hidden bg-transparent p-6">
    <div
      class="panel-card flex h-full w-full flex-col overflow-hidden rounded-[1.5rem] border border-stone-300/60 bg-[#faf6f1]"
    >
      <!-- 搜索 -->
      <div
        class="flex shrink-0 items-center gap-3 border-b border-stone-200 px-4 py-3"
        data-tauri-drag-region
      >
        <svg width="18" height="18" viewBox="0 0 20 20" class="shrink-0">
          <circle cx="8" cy="8" r="6" fill="#8b9d77" opacity="0.3" stroke="#5c4033" stroke-width="1.5" />
          <path d="M13 13 L18 18" stroke="#5c4033" stroke-width="1.5" stroke-linecap="round" />
        </svg>
        <input
          ref="inputRef"
          v-model="query"
          class="min-w-0 flex-1 bg-transparent text-base font-semibold text-stone-800 placeholder:font-normal placeholder:text-stone-400 focus:outline-none"
          placeholder="搜索标题、用户名、网址、标签…"
          @input="resetToSearch"
        />
        <span class="shrink-0 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-[11px] text-stone-500">
          Esc
        </span>
      </div>

      <!-- 未解锁 -->
      <div
        v-if="!unlocked"
        class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
      >
        <p class="text-sm text-stone-500">密码库还没解锁</p>
        <button
          class="rounded-full bg-stone-800 px-4 py-2 text-sm text-stone-50 hover:bg-stone-700"
          @click="invoke('show_main_window'); hide()"
        >
          去主窗口解锁
        </button>
      </div>

      <!-- 结果 -->
      <ul v-else class="min-h-0 flex-1 overflow-y-auto p-2">
        <li v-for="(entry, index) in results" :key="entry.id">
          <button
            class="flex w-full items-center gap-3 rounded-[1rem] px-3 py-2 text-left transition-colors duration-150"
            :class="
              index === activeIndex
                ? 'border-2 border-[#8b9d77] bg-[#8b9d77]/10'
                : 'border border-transparent hover:bg-stone-100'
            "
            @mouseenter="activeIndex = index"
            @click="activeIndex = index; copyPassword()"
          >
            <EntryAvatar :title="entry.title" :icon="entry.icon" :size="32" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-stone-800">
                <MatchText :text="entry.title" :query="query" />
                <span v-if="entry.favorite" class="text-[#d4a373]">★</span>
                <TotpCountdown v-if="entry.totpPeriod" :period="entry.totpPeriod" />
              </span>
              <span class="block truncate text-xs text-stone-500">
                <MatchText :text="entry.username || entry.url || '—'" :query="query" />
              <MatchContext :entry="entry" :query="query" />
              </span>
            </span>
            <span class="shrink-0 text-[11px] text-stone-400">
              {{ relativeTime(entry.updatedAt ? new Date(entry.updatedAt) : null) }}
            </span>
          </button>
        </li>

        <li v-if="!results.length" class="px-4 py-10 text-center text-sm text-stone-400">
          <EmptyState kind="search" title="没有找到匹配条目" description="试试更短的关键词，或先在主窗口添加条目。" />
        </li>
      </ul>

      <!-- 次级动作：←/→ 或 Tab 循环选中，Enter 执行，鼠标也可点 -->
      <div v-if="showActions && actions.length" class="shrink-0 border-t border-stone-200 px-3 py-2">
        <div class="flex flex-wrap gap-2">
          <button
            v-for="(action, i) in actions"
            :key="action.key"
            class="rounded-full border px-3 py-1.5 text-xs transition-colors duration-150"
            :class="
              i === actionIndex
                ? 'border-[#8b9d77] bg-[#8b9d77]/15 font-medium text-[#5c4033]'
                : 'border-stone-300 bg-white text-stone-700 hover:bg-stone-100'
            "
            @mouseenter="actionIndex = i"
            @click="action.run()"
          >
            {{ action.label }}
          </button>
        </div>
        <p class="mt-1.5 text-[11px] text-stone-400">
          ←→ 切换动作 · Enter 执行 · Tab 循环 · Esc 收起
        </p>
      </div>

      <!-- 提示条 -->
      <div class="flex shrink-0 flex-wrap items-center gap-3 border-t border-stone-200 px-4 py-1.5 text-[11px] text-stone-500">
        <span><kbd class="rounded-full border border-stone-200 bg-white px-1.5 py-0.5">Enter</kbd> 复制密码</span>
        <span><kbd class="rounded-full border border-stone-200 bg-white px-1.5 py-0.5">Tab</kbd> 更多</span>
        <span><kbd class="rounded-full border border-stone-200 bg-white px-1.5 py-0.5">↑↓</kbd> 选择</span>
        <span class="ml-auto text-[#8b2332]">复制后自动清空</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 暖棕柔和投影：悬浮窗口需要空间感，自然有机风的「轻阴影」原则在悬浮层放宽到这一档 */
.panel-card {
  box-shadow:
    0 10px 30px -6px rgba(92, 64, 51, 0.32),
    0 2px 8px rgba(92, 64, 51, 0.1);
}
</style>
