<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
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
import logoUrl from "../../assets/logo-256.png";

const settingsOpen = ref(false);
const panelOpen = ref(false);

function onGlobalKeydown(event: KeyboardEvent) {
  // Ctrl+K 呼出快速面板（全局 Alt+Space 需要系统级热键，后续用 Tauri 全局快捷键做）
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    panelOpen.value = !panelOpen.value;
  }
}

function onPanelEdit(uuid: string) {
  openEditDrawer(uuid);
}

const {
  query,
  drawer,
  openCreateDrawer,
  openEditDrawer,
  saveVault,
  lock,
  error,
  status,
  busy,
  clearError,
  vaultInfo,
  vaultPath,
} = useVault();

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
function switchTo(vault: VaultMeta): void {
  vaultMenuOpen.value = false;
  if (vault.path === vaultPath.value) return;
  settings.lastVaultPath = vault.path;
  lock();
  toast(`已切换到「${vault.name}」，请解锁`);
}

function onDocPointerDown(event: MouseEvent): void {
  if (vaultMenuOpen.value && menuRef.value && !menuRef.value.contains(event.target as Node)) {
    vaultMenuOpen.value = false;
  }
}

onMounted(() => {
  window.addEventListener("keydown", onGlobalKeydown);
  document.addEventListener("pointerdown", onDocPointerDown);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onGlobalKeydown);
  document.removeEventListener("pointerdown", onDocPointerDown);
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
      <!-- 左上角：库切换器（logo + 当前库名，点击弹最近库列表） -->
      <div ref="menuRef" class="relative shrink-0">
        <button
          class="flex items-center gap-2 rounded-full px-2 py-1.5 -ml-2 transition-colors duration-300 hover:bg-stone-100"
          title="切换密码库"
          @click.stop="toggleVaultMenu"
        >
        <img :src="logoUrl" alt="KeyTree" class="h-7 w-7" />
        <span class="font-serif text-lg font-semibold">KeyTree</span>
          <span
            v-if="currentVaultName"
            class="max-w-[10rem] truncate rounded-full border border-stone-200 bg-[#faf6f1] px-2.5 py-0.5 text-xs text-stone-500"
            :title="vaultPath"
          >
            {{ currentVaultName }}
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 20 20"
            class="text-stone-400 transition-transform duration-300"
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
          v-model="query"
          class="w-full rounded-full border border-stone-200 bg-[#faf6f1] py-2 pl-10 pr-4 text-sm text-stone-800 placeholder:text-stone-400 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
          placeholder="搜索条目…"
        />
      </div>

      <div class="flex shrink-0 items-center gap-2">
        <button
          class="flex h-9 w-9 items-center justify-center rounded-full border border-stone-300 bg-white text-stone-600 transition-colors duration-300 hover:bg-stone-100"
          title="设置"
          @click="settingsOpen = true"
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
          @click="openCreateDrawer"
        >
          + 新建
        </button>
        <button
          class="rounded-full border border-stone-300 bg-white px-4 py-2 text-sm text-stone-700 transition-colors duration-300 hover:bg-stone-100"
          @click="lock"
        >
          锁定
        </button>
      </div>
    </header>

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
      <span class="truncate">{{ status || "本地文件模式 · 所有数据只存在这个 .kdbx 里" }}</span>
      <span class="hidden shrink-0 md:inline">
        <kbd class="rounded-full border border-stone-200 bg-[#faf6f1] px-1.5 py-0.5">Ctrl+K</kbd>
        快速搜索
      </span>
      <span class="shrink-0">{{ vaultInfo.kdf }} · {{ vaultInfo.version }}</span>
    </footer>

    <EntryDrawer v-if="drawer.open" />
    <SettingsModal v-if="settingsOpen" @close="settingsOpen = false" />
    <QuickPanel
      v-if="panelOpen"
      @close="panelOpen = false"
      @edit="onPanelEdit"
    />
  </div>
</template>
