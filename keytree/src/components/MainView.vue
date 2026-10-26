<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useVault } from "../composables/useVault";
import { settings, type VaultMeta } from "../lib/settings";
import { toast } from "../lib/toast";
import GroupTree from "./GroupTree.vue";
import EntryList from "./EntryList.vue";
import EntryDetail from "./EntryDetail.vue";
import EntryDrawer from "./EntryDrawer.vue";
import SettingsModal from "./SettingsModal.vue";
import QuickPanel from "./QuickPanel.vue";
import SyncQuickBar from "./SyncQuickBar.vue";
import ClipboardRecognition from "./ClipboardRecognition.vue";
import { createClipboardCapture, resolveClipboardRecord, type ClipboardChoices, type ClipboardRecognition as Recognition, type ClipboardRecord, type ClipboardSnapshot } from "../lib/clipboard-capture";

const settingsOpen = ref(false);
const settingsInitialTab = ref<"security" | "sync">("security");
function openSettings(tab: "security" | "sync" = "security") {
  if (busy.value || drawer.value.open) return;
  settingsInitialTab.value = tab; settingsOpen.value = true;
}
const panelOpen = ref(false);
const searchRef = ref<HTMLInputElement | null>(null);
/** Delete 两段式确认：第一下只提示，3 秒内再按才真删 */
const deleteArmed = ref("");
let deleteTimer: number | undefined;

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable
  );
}

/** 上下键在可见列表里移动选中项 */
function moveSelection(delta: number): void {
  const list = visibleEntries.value;
  if (!list.length) return;
  const index = list.findIndex((e) => e.uuid === selectedUuid.value);
  const next =
    index < 0
      ? delta > 0
        ? 0
        : list.length - 1
      : Math.min(list.length - 1, Math.max(0, index + delta));
  selectEntry(list[next].uuid);
}

function armDelete(): void {
  const entry = selectedEntry.value;
  if (!entry) return;
  if (deleteArmed.value === entry.uuid) {
    deleteArmed.value = "";
    if (deleteTimer) window.clearTimeout(deleteTimer);
    // 回收站开启时这一步只是移入回收站；关闭时才是永久删除（已由二次按键确认）
    void removeEntry(entry.uuid);
    return;
  }
  deleteArmed.value = entry.uuid;
  toast(`再按一次 Delete 删除「${entry.title}」`, 3000);
  if (deleteTimer) window.clearTimeout(deleteTimer);
  deleteTimer = window.setTimeout(() => (deleteArmed.value = ""), 3000);
}

function onGlobalKeydown(event: KeyboardEvent) {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  // Do not open a second overlay over an unsaved editor/settings form.
  if (drawer.value.open || settingsOpen.value) return;
  if (clipboardRecognition.value) return;

  // Ctrl+K 呼出快速面板（全局 Alt+Space 由 Rust 侧注册）
  if (mod && key === "k") {
    event.preventDefault();
    panelOpen.value = !panelOpen.value;
    return;
  }

  // 有弹层时，页面级快捷键让位（抽屉 / 设置 / 面板自己处理按键）
  if (drawer.value.open || settingsOpen.value || panelOpen.value) return;

  if (mod && key === "f") {
    event.preventDefault();
    searchRef.value?.focus();
    searchRef.value?.select();
    return;
  }
  if (mod && key === "n") {
    event.preventDefault();
    openCreateDrawer();
    return;
  }
  if (mod && key === "s") {
    event.preventDefault();
    void onSave();
    return;
  }
  if (mod && key === "e") {
    if (selectedEntry.value) {
      event.preventDefault();
      openEditDrawer(selectedEntry.value.uuid);
    }
    return;
  }

  // 搜索框里也允许上下键选条目（这是最顺的键盘流），其他输入框不抢键
  const inSearch = event.target === searchRef.value;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (isEditable(event.target) && !inSearch) return;
    event.preventDefault();
    moveSelection(event.key === "ArrowDown" ? 1 : -1);
    return;
  }

  if (isEditable(event.target)) return;

  if (event.key === "Delete") {
    event.preventDefault();
    armDelete();
    return;
  }
  if (event.key === "Escape") {
    if (query.value) {
      query.value = "";
    } else if (document.activeElement === searchRef.value) {
      searchRef.value?.blur();
    }
    return;
  }
  if (event.key === "/") {
    event.preventDefault();
    searchRef.value?.focus();
  }
}

function onPanelEdit(uuid: string) {
  openEditDrawer(uuid);
}

const {
  query,
  drawer,
  visibleEntries,
  selectedUuid,
  selectedEntry,
  selectEntry,
  removeEntry,
  openCreateDrawer,
  openEditDrawer,
  saveVault,
  lock,
  error,
  status,
  busy,
  hasUnsavedChanges,
  clearError,
  vaultInfo,
  vaultPath,
} = useVault();

const { unlocked, clipboardCaptureEpoch, clipboardCaptureBlocked } = useVault();
const clipboardRecognition = ref<Recognition | null>(null);
const clipboardDraft = ref<Pick<ClipboardRecord, "title" | "username" | "password" | "url" | "notes"> | null>(null);
function canCaptureClipboard(): boolean {
  return settings.clipboardRecognition && unlocked.value && !clipboardCaptureBlocked.value && !busy.value && !drawer.value.open
    && !settingsOpen.value && !panelOpen.value && !clipboardRecognition.value
    && !document.hidden && document.hasFocus();
}
const clipboardCapture = createClipboardCapture({
  allowed: canCaptureClipboard,
  read: lastSequence => invoke<ClipboardSnapshot | null>("read_clipboard_candidate", { lastSequence }),
  result: value => { clipboardRecognition.value = value; },
});
function clearClipboardRecognition(): void {
  clipboardCapture.invalidate();
  clipboardRecognition.value = null;
}
function acceptClipboardRecord(index: number, choices: ClipboardChoices = {}): void {
  const record = clipboardRecognition.value?.records[index];
  if (!record || !settings.clipboardRecognition || !unlocked.value || clipboardCaptureBlocked.value || busy.value || drawer.value.open
    || settingsOpen.value || panelOpen.value || document.hidden || !document.hasFocus()) return;
  const resolved = resolveClipboardRecord(record, choices);
  if (!resolved) return;
  clearClipboardRecognition();
  openCreateDrawer();
  clipboardDraft.value = resolved;
}
function onClipboardFocus(): void { void clipboardCapture.focus(); }
function onClipboardVisibility(): void { if (document.hidden) clearClipboardRecognition(); }
watch([() => settings.clipboardRecognition, unlocked, clipboardCaptureEpoch, () => drawer.value.open, settingsOpen, panelOpen, busy], () => {
  clearClipboardRecognition();
  if (!drawer.value.open || !unlocked.value || !settings.clipboardRecognition) clipboardDraft.value = null;
}, { flush: "sync" });

const currentVaultName = computed(() => {
  const file = vaultPath.value.split(/[\\/]/).pop() ?? "";
  return file.replace(/\.kdbx$/i, "");
});

// ---- 左上角库切换器（多库支持：切库 = 锁定当前 → 解锁页预选目标） ----
const vaultMenuOpen = ref(false);
/** 每张卡片是否本机有 Hello 副本（打开下拉时探测） */
const menuHello = ref<Record<string, boolean>>({});
const menuRef = ref<HTMLElement | null>(null);

function toggleVaultMenu(): void {
  vaultMenuOpen.value = !vaultMenuOpen.value;
  if (vaultMenuOpen.value) void probeMenuHello();
}

async function probeMenuHello(): Promise<void> {
  const map: Record<string, boolean> = {};
  try {
    if ((await invoke<string>("hello_status")) !== "available") {
      menuHello.value = map;
      return;
    }
  } catch {
    menuHello.value = map;
    return;
  }
  await Promise.all(
    settings.vaults.map(async (v) => {
      try {
        map[v.path] = await invoke<boolean>("quick_unlock_exists", {
          vaultPath: v.path,
        });
      } catch {
        map[v.path] = false;
      }
    })
  );
  menuHello.value = map;
}

/** 点其他库：锁当前（自动保存已兜底），解锁页会预选目标库 */
let switchingVault = false;
async function switchTo(vault: VaultMeta): Promise<void> {
  vaultMenuOpen.value = false;
  if (switchingVault || vault.path === vaultPath.value) return;
  switchingVault = true;
  const previousPath = vaultPath.value;
  // 解锁页挂载时需要预选目标；锁定被取消时必须还原当前库。
  settings.lastVaultPath = vault.path;
  try {
    if (!(await lock())) {
      settings.lastVaultPath = previousPath;
      toast("切换已取消，请先保存当前密码库或另存副本", 4000);
      return;
    }
    toast(`已切换到「${vault.name}」，请解锁`);
  } finally {
    switchingVault = false;
  }
}

function onDocPointerDown(event: MouseEvent): void {
  if (vaultMenuOpen.value && menuRef.value && !menuRef.value.contains(event.target as Node)) {
    vaultMenuOpen.value = false;
  }
}

onMounted(() => {
  window.addEventListener("keydown", onGlobalKeydown);
  document.addEventListener("pointerdown", onDocPointerDown);
  window.addEventListener("focus", onClipboardFocus);
  window.addEventListener("blur", clearClipboardRecognition);
  document.addEventListener("visibilitychange", onClipboardVisibility);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
  clearClipboardRecognition();
  clipboardDraft.value = null;
  window.removeEventListener("focus", onClipboardFocus);
  window.removeEventListener("blur", clearClipboardRecognition);
  document.removeEventListener("visibilitychange", onClipboardVisibility);
  document.removeEventListener("pointerdown", onDocPointerDown);
  if (deleteTimer) window.clearTimeout(deleteTimer);
});

async function onSave() {
  if (await saveVault()) toast("已保存到磁盘");
}
</script>

<template>
  <div class="flex h-screen flex-col overflow-hidden bg-[#faf6f1] text-stone-800">
    <!-- 顶栏 -->
    <header
      class="flex shrink-0 flex-wrap items-center gap-3 border-b border-stone-200 bg-white px-4 py-3"
    >
      <!-- 左上角：当前密码库名（点击弹最近库列表切换） -->
      <div ref="menuRef" class="relative shrink-0">
        <button
          class="flex items-center gap-2 rounded-full px-2 py-1.5 -ml-2 transition-colors duration-300 hover:bg-stone-100"
          title="切换密码库"
          @click.stop="toggleVaultMenu"
        >
          <span
            class="max-w-[16rem] truncate font-serif text-lg font-semibold text-stone-800"
            :title="vaultPath"
          >
            {{ currentVaultName || "密码库" }}
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 20 20"
            class="shrink-0 self-center text-stone-400 transition-transform duration-300"
            :class="vaultMenuOpen ? 'rotate-180' : ''"
          >
            <path d="M5 8 L10 13 L15 8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>

        <!-- 下拉：最近库列表 -->
        <div
          v-if="vaultMenuOpen"
          class="absolute left-0 top-full z-30 mt-2 w-80 rounded-[1.25rem] border border-stone-200 bg-white p-2 shadow-sm"
        >
          <p class="px-3 pb-1 pt-1.5 text-[11px] text-stone-400">
            切换会先锁定当前库（改动都已自动保存）
          </p>
          <button
            v-for="v in settings.vaults"
            :key="v.path"
            class="flex w-full items-center gap-3 rounded-[1rem] border px-3 py-2 text-left transition-colors duration-150"
            :class="
              v.path === vaultPath
                ? 'border-[#8b9d77] bg-[#8b9d77]/10'
                : 'border-transparent hover:bg-stone-100'
            "
            @click="switchTo(v)"
          >
            <svg width="16" height="16" viewBox="0 0 20 20" class="shrink-0">
              <path
                d="M2 6 L6 6 L8 8 L18 8 L18 16 L2 16 Z"
                :fill="v.path === vaultPath ? '#8b9d77' : '#d4a373'"
                stroke="#5c4033"
                stroke-width="1.2"
              />
            </svg>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm text-stone-800">{{ v.name }}</span>
              <span class="block truncate text-[10px] text-stone-400">{{ v.path }}</span>
            </span>
            <span
              v-if="v.path === vaultPath"
              class="shrink-0 text-xs text-[#8b9d77]"
              title="当前库"
            >
              ✓
            </span>
            <span
              v-else-if="menuHello[v.path]"
              class="shrink-0 rounded-full border border-[#8b9d77] bg-[#8b9d77]/15 px-1.5 py-0.5 text-[10px] text-[#5c4033]"
              title="有快速解锁密钥"
            >
              Hello
            </span>
          </button>
          <p v-if="!settings.vaults.length" class="px-3 py-3 text-center text-xs text-stone-400">
            还没有库记录
          </p>
        </div>
      </div>

      <div class="relative mx-auto w-full max-w-md">
        <svg
          width="16"
          height="16"
          viewBox="0 0 20 20"
          class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2"
        >
          <circle cx="8" cy="8" r="6" fill="#8b9d77" opacity="0.3" stroke="#5c4033" stroke-width="1.5" />
          <path d="M13 13 L18 18" stroke="#5c4033" stroke-width="1.5" stroke-linecap="round" />
        </svg>
        <input
          ref="searchRef"
          v-model="query"
          class="w-full rounded-full border border-stone-200 bg-[#faf6f1] py-2 pl-10 pr-4 text-sm text-stone-800 placeholder:text-stone-400 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
          placeholder="搜索条目…（Ctrl+F）"
        />
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <button
          class="flex h-9 w-9 items-center justify-center rounded-full border border-stone-300 bg-white text-stone-600 transition-colors duration-300 hover:bg-stone-100"
          title="设置"
          @click="openSettings()" :disabled="busy || drawer.open"
        >
          <!-- lucide「settings」齿轮：圆孔 + 齿圈，跟日夜切换的太阳彻底区分 -->
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
            <path
              d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
            />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
        <button
          class="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm text-stone-700 transition-colors duration-300 hover:bg-stone-100 disabled:opacity-50"
          :disabled="busy"
          @click="onSave"
        >
          保存
        </button>
        <button
          class="rounded-full bg-stone-800 px-4 py-2 text-sm font-medium text-stone-50 transition-colors duration-300 hover:bg-stone-700"
          :disabled="busy" @click="openCreateDrawer"
        >
          + 新建
        </button>
        <button
          class="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm text-stone-700 transition-colors duration-300 hover:bg-stone-100"
          @click="lock()"
        >
          锁定
        </button>
      </div>
    </header>

    <SyncQuickBar :blocked="settingsOpen || panelOpen" @configure="openSettings('sync')" />

    <!-- 提示条 -->
    <div
      v-if="error"
      class="flex shrink-0 items-center justify-between gap-3 border-b border-[#8b2332]/20 bg-[#8b2332]/10 px-4 py-2 text-xs text-[#8b2332]"
    >
      <span class="truncate">{{ error }}</span>
      <button class="shrink-0 underline" @click="clearError">知道了</button>
    </div>

    <!-- 三栏 -->
    <div class="grid min-h-0 flex-1 grid-cols-[200px_1fr_340px]">
      <GroupTree class="min-h-0 overflow-hidden border-r border-stone-200 bg-white" />
      <EntryList class="min-h-0 overflow-hidden" />
      <EntryDetail class="min-h-0 overflow-hidden border-l border-stone-200 bg-white" />
    </div>

    <!-- 底部状态 -->
    <footer
      class="flex shrink-0 items-center justify-between gap-3 border-t border-stone-200 bg-white px-4 py-1.5 text-xs text-stone-400"
    >
      <span class="truncate">{{ hasUnsavedChanges ? "有未保存的修改 · 请保存或另存 KDBX 副本" : status || "本地优先 · 当前库修改已保存" }}</span>
      <span class="hidden shrink-0 items-center gap-3 md:flex">
        <span>
          <kbd class="rounded-full border border-stone-200 bg-[#faf6f1] px-1.5 py-0.5">Ctrl+F</kbd>
          搜索
        </span>
        <span>
          <kbd class="rounded-full border border-stone-200 bg-[#faf6f1] px-1.5 py-0.5">Ctrl+N</kbd>
          新建
        </span>
        <span>
          <kbd class="rounded-full border border-stone-200 bg-[#faf6f1] px-1.5 py-0.5">Del</kbd>
          删除
        </span>
        <span>
          <kbd class="rounded-full border border-stone-200 bg-[#faf6f1] px-1.5 py-0.5">Ctrl+K</kbd>
          快速面板
        </span>
      </span>
      <span class="shrink-0">{{ vaultInfo.kdf }} · {{ vaultInfo.version }}</span>
    </footer>

    <SettingsModal v-if="settingsOpen" :initial-tab="settingsInitialTab" @close="settingsOpen = false" />
    <EntryDrawer v-if="drawer.open" :clipboard-draft="clipboardDraft" />
    <ClipboardRecognition v-if="clipboardRecognition" :recognition="clipboardRecognition" @dismiss="clearClipboardRecognition" @accept="acceptClipboardRecord" />
    <QuickPanel
      v-if="panelOpen"
      @close="panelOpen = false"
      @edit="onPanelEdit"
    />
  </div>
</template>
