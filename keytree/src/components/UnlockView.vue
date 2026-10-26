<script lang="ts">
/**
 * 自动 Hello 解锁每个进程只尝试一次。
 * 手动锁定后解锁页会重新挂载，这时候绝不能再弹验证框（用户刚主动锁的）。
 */
let autoHelloAttempted = false;
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useVault } from "../composables/useVault";
import { settings, removeRecentVault, type VaultMeta } from "../lib/settings";
import { credentialCachingAllowed } from "../lib/quick-unlock";
import logoUrl from "../../assets/logo-256.png";
import PublicPasswordHint from "./PublicPasswordHint.vue";

const {
  openVault,
  createVault,
  helloUnlock,
  backupInfoOf,
  restoreBackup,
  busy,
  error,
  errorKind,
  status,
  clearError,
} = useVault();

type Mode = "recent" | "open" | "create";
const mode = ref<Mode>(settings.vaults.length ? "recent" : "open");
const path = ref(settings.lastVaultPath);
const password = ref("");
const showPassword = ref(false);
const name = ref("我的密码库");
const confirm = ref("");
const localError = ref("");
const keyFilePath = ref("");
const keyFileBytes = ref<Uint8Array | null>(null);
/** Hello 可用 且 本机有这个库的 DPAPI 密钥副本时才亮 */
const helloReady = ref(false);
/** 每张最近库卡片是否支持 Hello（进页面时批量探测） */
const helloMap = ref<Record<string, boolean>>({});

const canSubmit = computed(() => {
  if (busy.value) return false;
  if (mode.value === "create") return !!password.value && password.value === confirm.value;
  return !!path.value && !!password.value;
});

const tabs = computed(() => {
  const list: Array<{ key: Mode; label: string }> = [];
  if (settings.vaults.length) list.push({ key: "recent", label: "最近" });
  list.push({ key: "open", label: "打开" });
  list.push({ key: "create", label: "新建" });
  return list;
});

/** 探测快速解锁是否可用（Hello 设备 + 本机密钥副本都在） */
async function refreshHello(): Promise<void> {
  helloReady.value = false;
  if (!credentialCachingAllowed() || (mode.value !== "open" && mode.value !== "recent") || !path.value) return;
  try {
    const hello = await invoke<string>("hello_status");
    if (hello !== "available") return;
    const ready = await invoke<boolean>("quick_unlock_exists", { vaultPath: path.value });
    helloReady.value = credentialCachingAllowed() && ready;
  } catch {
    // 非 Windows / 命令失败：保持灰按钮即可
  }
}

/** 批量探测每张卡片有没有 Hello 副本（只查文件，不解密，快） */
async function refreshCardBadges(): Promise<void> {
  const map: Record<string, boolean> = {};
  if (!credentialCachingAllowed()) { helloMap.value = map; return; }
  try {
    if ((await invoke<string>("hello_status")) !== "available") {
      helloMap.value = map;
      return;
    }
  } catch {
    helloMap.value = map;
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
  helloMap.value = credentialCachingAllowed() ? map : {};
}

/** 原生命令内部完成 Hello 门禁和凭据读取；取消后主密码入口始终可用。 */
async function helloSubmit(_silent = false): Promise<void> {
  if (!credentialCachingAllowed() || !helloReady.value || busy.value) return;
  localError.value = "";
  clearError();
  await helloUnlock(path.value);
  if (error.value) await refreshHello();
}

// ---- 从滚动备份恢复（.kdbx.bak） ----
const backup = ref({ exists: false, mtimeMs: 0, size: 0 });
const confirmRestore = ref(false);

async function refreshBackup(): Promise<void> {
  backup.value = path.value
    ? await backupInfoOf(path.value)
    : { exists: false, mtimeMs: 0, size: 0 };
}

/**
 * 只有「文件本身坏了 / 版本不支持」才给恢复入口。
 * 密码错时 .bak 一样解不开，摆个按钮只会让用户以为能绕过密码；
 * 选错文件、老 .kdb 格式、读不到文件同理——换文件或修权限才是正解。
 */
const showRestore = computed(
  () =>
    backup.value.exists &&
    !!path.value &&
    (errorKind.value === "corrupt" || errorKind.value === "unsupported")
);

const backupText = computed(() => {
  const b = backup.value;
  if (!b.exists) return "";
  const at = new Date(b.mtimeMs).toLocaleString("zh-CN", { hour12: false });
  return `${at} · ${Math.max(1, Math.round(b.size / 1024))} KB`;
});

async function doRestore(): Promise<void> {
  if (!confirmRestore.value) {
    confirmRestore.value = true;
    window.setTimeout(() => (confirmRestore.value = false), 5000);
    return;
  }
  confirmRestore.value = false;
  if (await restoreBackup(path.value)) {
    password.value = "";
    localError.value = "";
    await refreshBackup();
    await refreshHello();
  }
}

function switchMode(next: Mode) {
  mode.value = next;
  localError.value = "";
  clearError();
  password.value = "";
  confirm.value = "";
  keyFilePath.value = "";
  keyFileBytes.value = null;
  if (next === "recent") {
    // 回最近列表时默认选中最近用的那个
    path.value = settings.vaults[0]?.path ?? "";
  }
  if (next === "open") {
    path.value = "";
  }
}

/** 点最近库卡片：选中它，密码框聚焦 */
function pickRecent(vault: VaultMeta) {
  path.value = vault.path;
  localError.value = "";
  clearError();
  password.value = "";
}

function removeRecent(vault: VaultMeta) {
  if (busy.value) return;
  const selected = path.value.replace(/\//g, "\\") === vault.path.replace(/\//g, "\\");
  removeRecentVault(vault.path);
  delete helloMap.value[vault.path];
  if (!settings.vaults.length || selected) {
    helloReady.value = false;
    confirmRestore.value = false;
    backup.value = { exists: false, mtimeMs: 0, size: 0 };
    switchMode(settings.vaults.length ? "recent" : "open");
  }
}

async function pickKeyFile() {
  localError.value = "";
  try {
    const picked = await open({ multiple: false });
    if (typeof picked !== "string") return;
    const bytes = await invoke<number[]>("read_vault", { path: picked });
    keyFilePath.value = picked;
    keyFileBytes.value = new Uint8Array(bytes);
  } catch (e) {
    localError.value = `读取密钥文件失败：${(e as Error).message}`;
  }
}

async function pickFile() {
  localError.value = "";
  try {
    const picked = await open({
      multiple: false,
      filters: [{ name: "KeePass 数据库", extensions: ["kdbx"] }],
    });
    if (typeof picked === "string") {
      path.value = picked;
      // 从文件选择器回来后直接停在打开态，不用再点一遍
      mode.value = "open";
    }
  } catch (e) {
    localError.value = `选择文件失败：${(e as Error).message}`;
  }
}

async function submit() {
  if (!canSubmit.value) return;
  localError.value = "";
  clearError();
  if (mode.value !== "create") {
    const ok = await openVault(path.value, password.value, keyFileBytes.value);
    if (!ok) await refreshBackup();
    return;
  }
  if (password.value !== confirm.value) {
    localError.value = "两次输入的主密码不一致";
    return;
  }
  const target = await save({
    defaultPath: `${name.value.trim() || "我的密码库"}.kdbx`,
    filters: [{ name: "KeePass 数据库", extensions: ["kdbx"] }],
  });
  if (typeof target !== "string") return;
  const ok = await createVault(
    target,
    name.value.trim(),
    password.value,
    keyFileBytes.value
  );
  if (ok) {
    password.value = "";
    confirm.value = "";
  }
}

onMounted(async () => {
  void refreshHello();
  void refreshCardBadges();
  void refreshBackup();
  // spec §6.1：启动先试 Hello，失败再回落到主密码。只在本进程第一次挂载时做。
  if (autoHelloAttempted) return;
  autoHelloAttempted = true;
  if (!credentialCachingAllowed() || !settings.autoHelloUnlock) return;
  if (mode.value === "create" || !path.value) return;
  // 让窗口先画出来，系统验证框不会盖在空白窗口上
  await new Promise((resolve) => window.setTimeout(resolve, 600));
  // 用户已经在输密码了就别打断
  if (busy.value || password.value) return;
  await refreshHello();
  if (helloReady.value) await helloSubmit(true);
});
watch(path, () => {
  void refreshHello();
  void refreshBackup();
});
watch(mode, () => {
  void refreshHello();
  void refreshBackup();
  if (mode.value === "recent") void refreshCardBadges();
});

const shownError = computed(() => localError.value || error.value);
</script>

<template>
  <!-- 整页不留滚动：窗口再矮也只让卡片内部兜底 -->
  <div
    class="flex h-screen items-center justify-center overflow-hidden bg-[#faf6f1] px-4 py-3"
  >
    <div
      class="flex max-h-full w-full max-w-md flex-col overflow-y-auto rounded-[2rem] border border-stone-200 p-6"
    >
      <!-- 品牌区 -->
      <div class="mb-4 text-center">
        <img :src="logoUrl" alt="KeyTree" class="brand-logo mx-auto mb-2" />
        <h1 class="brand-title font-serif text-3xl font-semibold text-stone-800">KeyTree</h1>
        <p class="mt-1 text-sm text-stone-600">
          {{
            mode === "recent"
              ? "选择一个密码库解锁"
              : mode === "open"
                ? "打开你的密码库"
                : "创建一个新的密码库"
          }}
        </p>
      </div>

      <!-- 模式切换 -->
      <div class="mb-4 flex gap-1 rounded-full bg-white p-1">
        <button
          v-for="t in tabs"
          :key="t.key"
          class="flex-1 rounded-full px-4 py-2 text-sm transition-colors duration-300"
          :class="
            mode === t.key
              ? 'bg-stone-800 text-stone-50'
              : 'text-stone-600 hover:bg-stone-100'
          "
          @click="switchMode(t.key)"
        >
          {{ t.label }}
        </button>
      </div>

      <!-- 最近库：卡片列表（多库支持，一次解锁一个） -->
      <div v-if="mode === 'recent'" class="mb-3 space-y-2">
        <div
          v-for="v in settings.vaults"
          :key="v.path"
          class="flex w-full items-center gap-2 rounded-[1.25rem] border pr-3 transition-colors duration-300"
          :class="
            path === v.path
              ? 'border-[#8b9d77] bg-[#8b9d77]/10'
              : 'border-stone-200 bg-white hover:border-stone-300'
          "
        >
          <button
            class="flex min-w-0 flex-1 items-center gap-3 rounded-[1.25rem] px-4 py-3 text-left"
            :title="v.path"
            @click="pickRecent(v)"
          >
            <svg width="18" height="18" viewBox="0 0 20 20" class="shrink-0">
              <path
                d="M2 6 L6 6 L8 8 L18 8 L18 16 L2 16 Z"
                :fill="path === v.path ? '#8b9d77' : '#d4a373'"
                stroke="#5c4033"
                stroke-width="1.2"
              />
            </svg>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium text-stone-800">
                {{ v.name }}
              </span>
              <span class="block truncate text-[11px] text-stone-400">{{ v.path }}</span>
            </span>
            <span
              v-if="helloMap[v.path]"
              class="shrink-0 rounded-full border border-[#8b9d77] bg-[#8b9d77]/15 px-2 py-0.5 text-[10px] text-[#5c4033]"
              title="本机有此库的快速解锁密钥"
            >
              Hello
            </span>
          </button>
          <button
            class="shrink-0 rounded-full px-2 py-1 text-xs text-stone-400 hover:bg-stone-100 hover:text-[#8b2332] disabled:cursor-not-allowed disabled:opacity-50"
            title="仅移除访问记录，不删除密码库文件"
            :aria-label="`移除 ${v.name} 的访问记录`"
            :disabled="busy"
            @click.stop="removeRecent(v)"
          >
            移除
          </button>
        </div>
        <p v-if="!settings.vaults.length" class="px-2 py-4 text-center text-xs text-stone-400">
          还没有使用记录
        </p>
      </div>

      <!-- 打开：库路径 -->
      <button
        v-if="mode === 'open'"
        class="mb-3 flex w-full items-center gap-2 rounded-full border border-stone-200 bg-white px-5 py-2.5 text-left text-xs transition-colors duration-300 hover:border-stone-300"
        @click="pickFile"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" class="shrink-0">
          <path
            d="M1 3 L5 3 L7 5 L13 5 L13 12 L1 12 Z"
            fill="#d4a373"
            stroke="#5c4033"
            stroke-width="1"
          />
        </svg>
        <span class="truncate" :class="path ? 'text-stone-600' : 'text-stone-400'">
          {{ path || "点击选择 .kdbx 文件" }}
        </span>
      </button>

      <!-- 新建：库名称 -->
      <template v-if="mode === 'create'">
        <label class="mb-1 block text-sm font-medium text-stone-700">密码库名称</label>
        <input
          v-model="name"
          class="mb-3 w-full rounded-full border border-stone-200 bg-white px-5 py-2.5 text-stone-800 placeholder:text-stone-400 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
          placeholder="我的密码库"
        />
      </template>

      <!-- 主密码（最近/打开两个模式共用；新建的确认框在下面） -->
      <template v-if="mode !== 'create'">
        <label class="mb-1 block text-sm font-medium text-stone-700">
          {{ mode === "recent" ? "所选库的主密码" : "主密码" }}
        </label>
        <div class="relative mb-3">
          <input
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            class="w-full rounded-full border border-stone-200 bg-white px-5 py-2.5 pr-14 text-stone-800 placeholder:text-stone-400 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
            placeholder="••••••••••••"
            @keyup.enter="submit"
          />
          <button
            class="absolute right-2.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-stone-100 text-stone-700 transition-colors duration-300 hover:bg-stone-200"
            type="button"
            :title="showPassword ? '隐藏密码' : '显示密码'"
            @click="showPassword = !showPassword"
          >
            <svg v-if="showPassword" width="15" height="15" viewBox="0 0 16 16">
              <path
                d="M1 8 Q 4 3, 8 3 Q 12 3, 15 8 Q 12 13, 8 13 Q 4 13, 1 8 Z"
                fill="none"
                stroke="#5c4033"
                stroke-width="1.3"
              />
              <circle cx="8" cy="8" r="2.2" fill="#5c4033" />
            </svg>
            <svg v-else width="15" height="15" viewBox="0 0 16 16">
              <path
                d="M1 8 Q 4 3, 8 3 Q 12 3, 15 8 Q 12 13, 8 13 Q 4 13, 1 8 Z"
                fill="none"
                stroke="#5c4033"
                stroke-width="1.3"
              />
              <circle cx="8" cy="8" r="2.2" fill="none" stroke="#5c4033" stroke-width="1.3" />
              <path d="M3 13 L13 3" stroke="#5c4033" stroke-width="1.3" stroke-linecap="round" />
            </svg>
          </button>
        </div>

        <!-- 密钥文件（可选第二因子） -->
        <details class="mb-3">
          <summary
            class="cursor-pointer text-xs text-stone-500 transition-colors duration-300 hover:text-stone-700"
          >
            + 使用密钥文件（第二因子）
          </summary>
          <button
            class="mt-2 flex w-full items-center gap-2 rounded-full border border-stone-200 bg-white px-5 py-2 text-left text-xs transition-colors duration-300 hover:border-stone-300"
            @click="pickKeyFile"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" class="shrink-0">
              <circle cx="5" cy="8" r="3" fill="none" stroke="#d4a373" stroke-width="1.4" />
              <path d="M8 8 L14 8 M12 8 L12 10.5 M14 8 L14 10" stroke="#5c4033" stroke-width="1.4" stroke-linecap="round" />
            </svg>
            <span
              class="truncate"
              :class="keyFileBytes ? 'text-stone-600' : 'text-stone-400'"
            >
              {{ keyFilePath || "选择密钥文件…" }}
            </span>
            <span v-if="keyFileBytes" class="ml-auto shrink-0 text-[11px] text-[#8b9d77]">
              已加载
            </span>
          </button>
        </details>
      </template>

      <PublicPasswordHint :path="path" :mode="mode" />

      <!-- 新建：确认密码 -->
      <template v-if="mode === 'create'">
        <label class="mb-1 block text-sm font-medium text-stone-700">主密码</label>
        <div class="relative mb-2">
          <input
            v-model="password"
            :type="showPassword ? 'text' : 'password'"
            class="w-full rounded-full border border-stone-200 bg-white px-5 py-2.5 pr-14 text-stone-800 placeholder:text-stone-400 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
            placeholder="••••••••••••"
          />
          <button
            class="absolute right-2.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full bg-stone-100 text-stone-600 transition-colors duration-300 hover:bg-stone-200"
            type="button"
            :title="showPassword ? '隐藏密码' : '显示密码'"
            :aria-label="showPassword ? '隐藏密码' : '显示密码'"
            @click="showPassword = !showPassword"
          >
            <svg
              v-if="showPassword"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <line x1="1" y1="1" x2="23" y2="23" />
            </svg>
            <svg
              v-else
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.7"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
        </div>
        <div class="mb-2">
          <input
            v-model="confirm"
            :type="showPassword ? 'text' : 'password'"
            class="w-full rounded-full border border-stone-200 bg-white px-5 py-2.5 text-stone-800 placeholder:text-stone-400 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
            placeholder="再输入一次主密码"
            @keyup.enter="submit"
          />
        </div>
        <p
          v-if="confirm && password !== confirm"
          class="mb-2 px-2 text-xs text-[#8b2332]"
        >
          两次输入不一致
        </p>
      </template>

      <!-- 主按钮 -->
      <button
        class="mb-2 w-full rounded-full bg-stone-800 px-6 py-2.5 font-medium text-stone-50 transition-colors duration-300 hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="!canSubmit"
        @click="submit"
      >
        {{ busy ? "处理中…" : mode === "create" ? "创建密码库" : "解锁" }}
      </button>

      <!-- Windows Hello 快速解锁：本机存有 DPAPI 密钥副本时可用 -->
      <button
        v-if="mode !== 'create'"
        class="hello mb-3 flex w-full items-center justify-center gap-2 rounded-full px-6 py-2.5 text-sm font-medium transition-colors duration-300 disabled:cursor-not-allowed disabled:opacity-60"
        :class="
          helloReady
            ? 'border border-[#8b9d77] bg-[#8b9d77]/10 text-[#5c4033] hover:bg-[#8b9d77]/20'
            : 'border border-stone-300 bg-transparent text-stone-400'
        "
        type="button"
        :disabled="!helloReady || busy"
        :title="
          helloReady
            ? '用指纹 / 人脸 / PIN 快速解锁'
            : '需先在 Windows 设置指纹或 PIN，并用主密码成功解锁过一次'
        "
        @click="helloSubmit()"
      >
        <svg width="15" height="15" viewBox="0 0 16 16">
          <circle
            cx="8"
            cy="6"
            r="3"
            fill="none"
            :stroke="helloReady ? '#5c4033' : '#a8a29e'"
            stroke-width="1.5"
          />
          <path
            d="M2 14 Q 8 10, 14 14"
            fill="none"
            :stroke="helloReady ? '#5c4033' : '#a8a29e'"
            stroke-width="1.5"
          />
        </svg>
        用 Windows Hello 快速解锁
      </button>

      <p v-if="mode !== 'create'" class="text-center text-xs text-stone-500">
        忘记主密码？库里数据
        <span class="font-medium text-[#8b2332]">无法恢复</span>
      </p>

      <!-- 状态与错误（占用固定区域，避免出现提示时页面跳动） -->
      <div class="mt-2 min-h-[2.5rem] px-1">
        <p v-if="shownError" class="text-xs leading-relaxed text-[#8b2332]">
          {{ shownError }}
        </p>
        <p v-else-if="status" class="text-xs leading-relaxed text-stone-500">
          {{ status }}
        </p>

        <!-- 损坏兜底：同目录的滚动备份（spec §7） -->
        <div
          v-if="showRestore"
          class="mt-2 rounded-[1rem] border border-[#d4a373] bg-[#d4a373]/15 px-3 py-2 text-xs leading-relaxed text-[#5c4033]"
        >
          <p>
            同目录有上次保存前的备份（{{ backupText }}）。如果文件已损坏，可以用它覆盖恢复；
            当前的损坏文件会改名成 .corrupt-时间戳 留证。
          </p>
          <button
            class="mt-1.5 rounded-full border px-3 py-1 transition-colors duration-300"
            :class="
              confirmRestore
                ? 'border-[#8b2332] bg-[#8b2332] text-white'
                : 'border-[#d4a373] bg-white text-[#5c4033] hover:bg-[#d4a373]/20'
            "
            @click="doRestore"
          >
            {{ confirmRestore ? "再点一次确认恢复" : "从备份恢复" }}
          </button>
        </div>
      </div>

      <svg
        class="deco mx-auto opacity-30"
        width="100"
        height="18"
        viewBox="0 0 100 20"
      >
        <path
          d="M5 10 Q 15 2, 25 10 Q 35 18, 45 10 Q 55 2, 65 10 Q 75 18, 85 10 Q 95 2, 95 10"
          fill="none"
          stroke="#8b9d77"
          stroke-width="2"
          stroke-linecap="round"
        />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.brand-logo {
  width: 56px;
  height: 56px;
}

/* 窗口矮的时候整体收紧，保证 600px 高度也能一屏放下 */
@media (max-height: 700px) {
  .brand-logo {
    width: 40px;
    height: 40px;
    margin-bottom: 0.25rem;
  }
  .brand-title {
    font-size: 1.5rem;
    line-height: 2rem;
  }
  .deco {
    display: none;
  }
}

@media (max-height: 640px) {
  .hello {
    display: none;
  }
}
</style>
