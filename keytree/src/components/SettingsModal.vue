<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useDialogFocus } from "../composables/useDialogFocus";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { enable as autostartEnable, disable as autostartDisable, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { useVault } from "../composables/useVault";
import { settings } from "../lib/settings";
import { toast } from "../lib/toast";
import ImportPreview from "./ImportPreview.vue";
import ShortcutSettings from "./ShortcutSettings.vue";
import VaultReport from "./VaultReport.vue";
import AuditTimeline from "./AuditTimeline.vue";
import MasterPasswordHintSettings from "./MasterPasswordHintSettings.vue";
import WebdavSettings from "./WebdavSettings.vue";
import BackupSnapshots from "./BackupSnapshots.vue";
import EncryptionSettings from "./EncryptionSettings.vue";
import { clearQuickUnlockCache } from "../lib/quick-unlock";
import AppSelect from "./AppSelect.vue";

const props = withDefaults(defineProps<{ initialTab?: "security" | "convenience" | "data" | "health" | "audit" | "sync" | "about" }>(), { initialTab: "security" });
const emit = defineEmits<{ close: [] }>();

const dialogRoot = ref<HTMLElement | null>(null);
const settingsScroll = ref<HTMLElement | null>(null);
const working = ref(false);
const confirmDiscard = ref(false);
const hintDirty = ref(false);
const webdavDirty = ref(false), webdavWorking = ref(false), backupWorking = ref(false);
useDialogFocus(dialogRoot, () => { if (confirmDiscard.value) confirmDiscard.value = false; else requestClose(); });
function requestClose() {
  if (busy.value || working.value || webdavWorking.value || backupWorking.value) return;
  if (currentPw.value || newPw.value || confirmPw.value || hintDirty.value || webdavDirty.value) {
    confirmDiscard.value = true;
    void nextTick(() => dialogRoot.value?.querySelector<HTMLElement>("[data-continue-editing]")?.focus());
    return;
  }
  emit("close");
}
async function runAction(action: () => Promise<void>) {
  if (working.value || busy.value || webdavWorking.value || backupWorking.value) return;
  working.value = true;
  try { await action(); } catch { say("操作未完成，请重试", "err"); }
  finally { working.value = false; }
}
onBeforeUnmount(() => { cancelImport(); });

const {
  vaultPath,
  vaultInfo,
  drawer,
  hasKeyFile,
  changeMasterPassword,
  applyKeyFile,
  createKeyFile,
  exportKdbx,
  exportCsv,
  previewCsv,
  importPreview,
  cancelImport,
  backupInfoOf,
  error,
  busy,
} = useVault();

/** 滚动备份信息（数据 tab 展示，让 .bak 不是隐形功能） */
const backupInfo = ref({ exists: false, mtimeMs: 0, size: 0 });
const backupName = computed(() => {
  const file = vaultPath.value.split(/[\\/]/).pop() ?? "vault.kdbx";
  return `${file}.bak`;
});
const backupText = computed(() => {
  const b = backupInfo.value;
  if (!b.exists) return "";
  return `${new Date(b.mtimeMs).toLocaleString("zh-CN", { hour12: false })} · ${Math.max(
    1,
    Math.round(b.size / 1024)
  )} KB`;
});

async function refreshBackupInfo(): Promise<void> {
  backupInfo.value = vaultPath.value
    ? await backupInfoOf(vaultPath.value)
    : { exists: false, mtimeMs: 0, size: 0 };
}

const tab = ref<"security" | "convenience" | "data" | "health" | "audit" | "sync" | "about">(props.initialTab);

watch(tab, () => { if (settingsScroll.value) settingsScroll.value.scrollTop = 0; }, { flush: "post" });

const tabs = [
  { key: "security", label: "安全" },
  { key: "convenience", label: "便利" },
  { key: "data", label: "数据" },
  { key: "sync", label: "同步" },
  { key: "health", label: "库体检" },
  { key: "audit", label: "时间线" },
  { key: "about", label: "关于" },
] as const;

const currentPw = ref("");
const newPw = ref("");
const confirmPw = ref("");
const message = ref("");
const messageKind = ref<"ok" | "err">("ok");
const keyFileName = ref("");
const confirmRemoveKey = ref(false);

// ---- Windows Hello 快速解锁 ----
const helloText = ref("检测中…");
const confirmClearQuick = ref(false);

onMounted(async () => {
  void refreshBackupInfo();
  try {
    const s = await invoke<string>("hello_status");
    helloText.value =
      s === "available" ? "已就绪（指纹 / 人脸 / PIN）" : "未配置（先在 Windows 设置 PIN 或指纹）";
  } catch {
    helloText.value = "不可用";
  }
  // 以系统实际注册状态为准（用户可能在系统设置里改过）
  try {
    settings.launchAtLogin = await autostartEnabled();
  } catch {
    /* 插件不可用时保持本地值 */
  }
});

// 开机自启：勾选变化即调系统注册/注销
watch(
  () => settings.launchAtLogin,
  async (on) => {
    try {
      if (on) await autostartEnable();
      else await autostartDisable();
    } catch {
      // 注册失败时回滚显示，避免 UI 谎报
      settings.launchAtLogin = !on;
      toast("开机自启设置失败");
    }
  }
);

function toggleHighSecurity() { return runAction(async () => {
  settings.highSecurityMode = !settings.highSecurityMode;
  if (settings.highSecurityMode) {
    try {
      await clearQuickUnlockCache();
      say("高安全模式已启用，本机解锁缓存已清除。之后需主密码及所需密钥文件解锁", "ok");
    } catch { say("已禁止快速解锁，但本机缓存删除失败，请点击清除缓存重试", "err"); }
  } else say("已退出高安全模式；快速解锁仍保持关闭，需要时可自行开启", "ok");
}); }

function clearQuickUnlock() { return runAction(clearQuickUnlockAction); }
async function clearQuickUnlockAction() {
  if (!confirmClearQuick.value) {
    confirmClearQuick.value = true;
    window.setTimeout(() => (confirmClearQuick.value = false), 4000);
    return;
  }
  confirmClearQuick.value = false;
  try {
    await clearQuickUnlockCache();
    say("已清除本机缓存的解锁密钥，下次需主密码", "ok");
  } catch (e) {
    say(`清除失败：${(e as Error).message}`, "err");
  }
}

// ---- 数据：导入 / 导出 ----
const confirmCsvExport = ref(false);
const importing = ref(false);

function doExportKdbx() { return runAction(doExportKdbxAction); }
async function doExportKdbxAction() {
  message.value = "";
  const target = await save({
    defaultPath: "vault-backup.kdbx",
    filters: [{ name: "KeePass 数据库", extensions: ["kdbx"] }],
  });
  if (typeof target !== "string") return;
  const ok = await exportKdbx(target);
  if (ok) {
    say(`已另存完整副本：${target}`, "ok");
    toast("KDBX 副本已保存");
  } else {
    say(error.value || "另存失败", "err");
  }
}

function doExportCsv() { return runAction(doExportCsvAction); }
async function doExportCsvAction() {
  message.value = "";
  // 双确认：CSV 是明文密码，spec §5 要求防止手滑导出
  if (!confirmCsvExport.value) {
    confirmCsvExport.value = true;
    window.setTimeout(() => (confirmCsvExport.value = false), 6000);
    return;
  }
  confirmCsvExport.value = false;
  const target = await save({
    defaultPath: "passwords.csv",
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (typeof target !== "string") return;
  const ok = await exportCsv(target);
  if (ok) {
    say(`已导出：${target}。文件是明文密码，迁移完成后请立即删除！`, "ok");
    toast("CSV 已导出");
  } else {
    say(error.value || "导出失败", "err");
  }
}

function doImportCsv() { return runAction(doImportCsvAction); }
async function doImportCsvAction() {
  message.value = "";
  if (importing.value) return;
  let picked: string | null = null;
  try {
    const result = await open({
      multiple: false,
      filters: [{ name: "CSV", extensions: ["csv", "txt"] }],
    });
    picked = typeof result === "string" ? result : null;
  } catch {
    return;
  }
  if (!picked) return;
  importing.value = true;
  try {
    if (!(await previewCsv(picked))) say(error.value || "预览失败", "err");
  } finally {
    importing.value = false;
  }
}

function say(text: string, kind: "ok" | "err" = "ok") {
  message.value = text;
  messageKind.value = kind;
}

function submitPassword() { return runAction(submitPasswordAction); }
async function submitPasswordAction() {
  message.value = "";
  if (!currentPw.value) return say("请输入当前主密码", "err");
  if (newPw.value.length < 8) return say("新主密码至少 8 位", "err");
  if (newPw.value !== confirmPw.value) return say("两次输入的新密码不一致", "err");

  const ok = await changeMasterPassword(currentPw.value, newPw.value);
  if (ok) {
    currentPw.value = "";
    newPw.value = "";
    confirmPw.value = "";
    say("主密码已更新，文件已用新密码重新加密", "ok");
    toast("主密码已更新");
  } else {
    say(error.value || "修改失败", "err");
  }
}

function pickKeyFile() { return runAction(pickKeyFileAction); }
async function pickKeyFileAction() {
  message.value = "";
  try {
    const picked = await open({ multiple: false });
    if (typeof picked !== "string") return;
    const bytes = await invoke<number[]>("read_vault", { path: picked });
    const ok = await applyKeyFile(new Uint8Array(bytes));
    if (ok) {
      keyFileName.value = picked.split(/[\\/]/).pop() ?? picked;
      say("已启用密钥文件，务必把它备份到安全的地方", "ok");
    } else {
      say(error.value || "启用失败", "err");
    }
  } catch (e) {
    say(`读取密钥文件失败：${(e as Error).message}`, "err");
  }
}

function generateKeyFile() { return runAction(generateKeyFileAction); }
async function generateKeyFileAction() {
  message.value = "";
  const target = await save({
    defaultPath: "keytree.keyx",
    filters: [{ name: "密钥文件", extensions: ["keyx", "key"] }],
  });
  if (typeof target !== "string") return;
  const ok = await createKeyFile(target);
  if (ok) {
    keyFileName.value = target.split(/[\\/]/).pop() ?? target;
    say(`已生成并启用：${target}`, "ok");
  } else {
    say(error.value || "生成失败", "err");
  }
}

function removeKeyFile() { return runAction(removeKeyFileAction); }
async function removeKeyFileAction() {
  if (!confirmRemoveKey.value) {
    confirmRemoveKey.value = true;
    window.setTimeout(() => (confirmRemoveKey.value = false), 4000);
    return;
  }
  confirmRemoveKey.value = false;
  const ok = await applyKeyFile(null);
  if (ok) {
    keyFileName.value = "";
    say("已移除密钥文件，以后只需主密码", "ok");
  } else {
    say(error.value || "移除失败", "err");
  }
}

const autoLockOptions = [
  { value: 0, label: "关闭" },
  { value: 1, label: "1 分钟" },
  { value: 5, label: "5 分钟" },
  { value: 10, label: "10 分钟" },
  { value: 30, label: "30 分钟" },
  { value: 60, label: "1 小时" },
];

const clipboardOptions = [
  { value: 0, label: "不清空" },
  { value: 15, label: "15 秒" },
  { value: 30, label: "30 秒" },
  { value: 60, label: "60 秒" },
  { value: 120, label: "2 分钟" },
];
</script>

<template>
  <div ref="dialogRoot" :inert="drawer.open" role="dialog" aria-modal="true" aria-label="设置" tabindex="-1" :aria-busy="working || busy || webdavWorking || backupWorking" class="fixed inset-0 z-40 flex items-center justify-center bg-stone-800/20 p-4">
    <div v-if="confirmDiscard" data-dialog-confirmation class="absolute inset-0 z-10 flex items-center justify-center bg-stone-800/30 p-6">
      <div class="rounded-2xl bg-[#faf6f1] p-6 text-sm" role="alert">
        <p>有尚未保存的修改，要放弃吗？</p>
        <div class="mt-4 flex flex-wrap gap-3">
          <button data-continue-editing class="rounded-full bg-stone-800 px-4 py-2 text-white" @click="confirmDiscard = false">继续编辑</button>
          <button class="rounded-full border px-4 py-2" :disabled="working || busy || webdavWorking || backupWorking" @click="emit('close')">放弃修改</button>
        </div>
      </div>
    </div>
    <div
      class="flex max-h-full min-h-0 w-full max-w-xl flex-col overflow-hidden rounded-[2rem] border border-stone-200 bg-[#faf6f1]"
    >
      <div class="flex shrink-0 items-center justify-between border-b border-stone-200 px-6 py-4">
        <h3 class="font-serif text-xl font-semibold text-stone-800">设置</h3>
        <button
          class="flex h-9 w-9 items-center justify-center rounded-full border border-stone-300 bg-white text-stone-700 transition-colors duration-300 hover:bg-stone-100"
          @click="requestClose" :disabled="busy || working || webdavWorking || backupWorking"
        >
          ✕
        </button>
      </div>

      <!-- tab -->
      <div :inert="confirmDiscard" class="flex shrink-0 flex-wrap gap-1 border-b border-stone-200 px-6 py-3">
        <button
          v-for="item in tabs"
          :key="item.key"
          class="rounded-full px-4 py-1.5 text-sm transition-colors duration-300"
          :class="
            tab === item.key
              ? 'bg-stone-800 text-stone-50'
              : 'text-stone-600 hover:bg-stone-100'
          "
          @click="tab = item.key"
        >
          {{ item.label }}
        </button>
      </div>

      <div ref="settingsScroll" data-settings-scroll class="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
        <fieldset :disabled="working || busy || webdavWorking || backupWorking" :inert="confirmDiscard" class="min-w-0">
        <div v-show="tab === 'sync'">
          <WebdavSettings @dirty="webdavDirty = $event" @working="webdavWorking = $event" />
        </div>
        <!-- 安全 -->
        <div v-show="tab === 'security'" class="space-y-6">
          <EncryptionSettings @working="working = $event" />
          <section>
            <label class="flex items-start gap-2 text-sm font-medium text-stone-700">
              <input type="checkbox" :checked="settings.highSecurityMode" class="mt-0.5 h-4 w-4" @change="toggleHighSecurity" />
              高安全模式
            </label>
            <p class="mt-2 text-xs text-stone-500">关闭快速解锁，并清除本机解锁缓存。</p>
          </section>
          <MasterPasswordHintSettings @dirty="hintDirty = $event" />
          <section>
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <h4 class="font-serif text-sm font-semibold text-stone-800" title="远程桌面显示异常时可关闭">截图时隐藏窗口</h4>
              </div>
              <button
                type="button"
                role="switch"
                :aria-checked="settings.screenshotProtection"
                class="relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition-colors duration-300"
                :class="
                  settings.screenshotProtection
                    ? 'border-[#8b9d77] bg-[#8b9d77]'
                    : 'border-stone-300 bg-stone-200'
                "
                @click="settings.screenshotProtection = !settings.screenshotProtection"
              >
                <span
                  class="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white shadow-sm transition-all duration-300"
                  :class="
                    settings.screenshotProtection ? 'left-[23px]' : 'left-[3px]'
                  "
                />
              </button>
            </div>
          </section>

          <section class="border-t border-stone-200 pt-5">
            <h4 class="mb-2 font-serif text-sm font-semibold text-stone-800">修改主密码</h4>
            <div class="space-y-2">
              <input
                v-model="currentPw"
                type="password"
                class="w-full rounded-full border border-stone-200 bg-white px-5 py-2.5 text-sm text-stone-800 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
                placeholder="当前主密码"
              />
              <input
                v-model="newPw"
                type="password"
                class="w-full rounded-full border border-stone-200 bg-white px-5 py-2.5 text-sm text-stone-800 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
                placeholder="新主密码（至少 8 位）"
              />
              <input
                v-model="confirmPw"
                type="password"
                class="w-full rounded-full border border-stone-200 bg-white px-5 py-2.5 text-sm text-stone-800 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
                placeholder="再输一次新密码"
                @keyup.enter="submitPassword"
              />
            </div>
            <p class="mt-2 text-xs text-stone-500">
              新密码无法找回，请妥善保管。
            </p>
            <button
              class="mt-3 rounded-full bg-stone-800 px-5 py-2 text-sm font-medium text-stone-50 transition-colors duration-300 hover:bg-stone-700 disabled:opacity-50"
              :disabled="busy || working || webdavWorking || backupWorking"
              @click="submitPassword"
            >
              修改主密码
            </button>
          </section>

          <section class="border-t border-stone-200 pt-5">
            <h4 class="mb-2 font-serif text-sm font-semibold text-stone-800">密钥文件</h4>
            <p class="mb-2 text-xs text-stone-500">
              当前状态：
              <span :class="hasKeyFile ? 'text-[#8b9d77]' : 'text-stone-500'">
                {{ hasKeyFile ? "已启用" : "未启用" }}
              </span>
              <span v-if="keyFileName" class="text-stone-400"> · {{ keyFileName }}</span>
            </p>
            <div class="flex flex-wrap gap-2">
              <button
                class="rounded-full border border-stone-300 bg-white px-4 py-2 text-xs text-stone-700 transition-colors duration-300 hover:bg-stone-100"
                @click="pickKeyFile"
              >
                选择密钥文件
              </button>
              <button
                class="rounded-full border border-stone-300 bg-[#d4a373] px-4 py-2 text-xs font-medium text-stone-800 transition-colors duration-300 hover:bg-[#d4a373]/80"
                @click="generateKeyFile"
              >
                生成密钥文件
              </button>
              <button
                v-if="hasKeyFile"
                class="rounded-full border px-4 py-2 text-xs transition-colors duration-300"
                :class="
                  confirmRemoveKey
                    ? 'border-[#8b2332] bg-[#8b2332] text-white'
                    : 'border-stone-300 bg-white text-[#8b2332] hover:bg-[#8b2332]/10'
                "
                @click="removeKeyFile"
              >
                {{ confirmRemoveKey ? "再点一次确认移除" : "移除密钥文件" }}
              </button>
            </div>
            <p class="mt-2 text-xs text-[#8b2332]">
              请与密码库分开备份；密钥文件丢失将无法解锁。
            </p>
          </section>

          <section class="border-t border-stone-200 pt-5">
            <h4 class="mb-2 font-serif text-sm font-semibold text-stone-800">
              Windows Hello 快速解锁
            </h4>
            <p class="mb-2 text-xs text-stone-500">
              设备状态：<span class="text-[#5c4033]">{{ helloText }}</span>
            </p>
            <label class="flex items-start gap-2 text-sm text-stone-700">
              <input
                v-model="settings.quickUnlock"
                type="checkbox"
                :disabled="settings.highSecurityMode"
                class="mt-0.5 h-4 w-4"
              />
              <span>
                启用指纹 / 人脸 / PIN 解锁
                <span class="block text-xs leading-5 text-stone-400">在本机加密缓存解锁凭据。</span>
              </span>
            </label>
            <details class="mt-2 text-xs text-stone-500">
              <summary class="cursor-pointer">安全说明</summary>
              <p class="mt-2 leading-5">凭据由当前 Windows 账户加密保存，经 Hello 验证后读取；不属于硬件密钥绑定，无法抵御同账户恶意程序。正常退出时清理缓存，异常退出不保证。</p>
            </details>
            <button
              class="mt-3 rounded-full border px-4 py-2 text-xs transition-colors duration-300"
              :class="
                confirmClearQuick
                  ? 'border-[#8b2332] bg-[#8b2332] text-white'
                  : 'border-stone-300 bg-white text-[#8b2332] hover:bg-[#8b2332]/10'
              "
              @click="clearQuickUnlock"
            >
              {{ confirmClearQuick ? "再点一次确认清除" : "清除本机解锁缓存" }}
            </button>
          </section>

          <p
            v-if="message"
            class="rounded-[1rem] px-4 py-2 text-xs"
            :class="
              messageKind === 'ok'
                ? 'bg-[#8b9d77]/15 text-[#5c4033]'
                : 'bg-[#8b2332]/10 text-[#8b2332]'
            "
          >
            {{ message }}
          </p>
        </div>

        <!-- 便利 -->
        <div v-if="tab === 'convenience'" class="space-y-5">
          <ShortcutSettings />
          <div class="border-b border-stone-200 pb-5">
            <label class="mb-1 flex items-center gap-2 text-sm font-medium text-stone-700" title="登录后后台运行，密码库保持锁定">
              <input
                v-model="settings.launchAtLogin"
                type="checkbox"
                class="h-4 w-4"
              />
              开机启动
            </label>
          </div>
          <div class="border-b border-stone-200 pb-5">
            <label class="mb-1 flex items-center gap-2 text-sm font-medium text-stone-700" title="需先启用快速解锁；手动锁定后不会自动弹出">
              <input
                v-model="settings.autoHelloUnlock"
                type="checkbox"
                :disabled="settings.highSecurityMode || !settings.quickUnlock"
                class="h-4 w-4"
              />
              启动时用 Windows Hello 解锁
            </label>
          </div>
          <div class="border-b border-stone-200 pb-5">
            <label class="mb-1 flex items-center gap-2 text-sm font-medium text-stone-700">
              <input v-model="settings.clipboardRecognition" type="checkbox" class="h-4 w-4" :disabled="working || busy || webdavWorking || backupWorking" />
              识别剪贴板账号
            </label>
            <p class="mt-1 text-xs leading-5 text-stone-500">
              回到软件时本机识别，确认后填入，不自动保存。
            </p>
            <details class="mt-2 text-xs text-stone-500">
              <summary class="cursor-pointer">隐私说明</summary>
              <p class="mt-2 leading-5">仅在主窗口已解锁且未编辑时读取；不后台监听、不上传、不记录原文。打开设置时不读取。</p>
            </details>
          </div>
          <div>
            <label for="auto-lock-minutes" class="mb-1 block text-sm font-medium text-stone-700">空闲自动锁定</label>
            <AppSelect id="auto-lock-minutes" v-model="settings.autoLockMinutes" :options="autoLockOptions" :disabled="working || busy || webdavWorking || backupWorking" class="w-full" />
          </div>

          <div>
            <label for="clipboard-seconds" class="mb-1 block text-sm font-medium text-stone-700" title="仅清理 KeyTree 复制的内容，不影响后来复制的内容">
              复制后清空剪贴板
            </label>
            <AppSelect id="clipboard-seconds" v-model="settings.clipboardSeconds" :options="clipboardOptions" :disabled="working || busy || webdavWorking || backupWorking" class="w-full" />
          </div>
        </div>

        <!-- 数据 -->
        <div v-else-if="tab === 'data'" class="space-y-6">
          <section>
            <h4 class="mb-2 font-serif text-sm font-semibold text-stone-800">自动备份</h4>
            <p class="mb-2 text-xs text-stone-500">
              上一版：<code class="rounded bg-white px-1 py-0.5 text-[11px]">{{ backupName }}</code>
            </p>
            <p v-if="backupInfo.exists" class="text-xs text-[#5c4033]">
              当前备份：{{ backupText }}
            </p>
            <p v-else class="text-xs text-stone-400">
              暂无备份
            </p>
          </section>

          <BackupSnapshots @working="backupWorking = $event" />

          <section class="border-t border-stone-200 pt-5">
            <h4 class="mb-2 font-serif text-sm font-semibold text-stone-800">导出</h4>
            <p class="mb-3 text-xs text-stone-500">
              KDBX 为完整加密副本；CSV 含<span class="font-medium text-[#8b2332]">明文密码</span>，仅用于迁移。
            </p>
            <div class="flex flex-wrap gap-2">
              <button
                class="rounded-full border border-stone-300 bg-white px-4 py-2 text-xs text-stone-700 transition-colors duration-300 hover:bg-stone-100"
                :disabled="busy || working || webdavWorking || backupWorking"
                @click="doExportKdbx"
              >
                另存 KDBX 副本
              </button>
              <button
                class="rounded-full border px-4 py-2 text-xs transition-colors duration-300"
                :class="
                  confirmCsvExport
                    ? 'border-[#8b2332] bg-[#8b2332] text-white'
                    : 'border-stone-300 bg-white text-[#8b2332] hover:bg-[#8b2332]/10'
                "
                :disabled="busy || working || webdavWorking || backupWorking"
                @click="doExportCsv"
              >
                {{ confirmCsvExport ? "明文警告：再点一次确认导出" : "导出 CSV（明文）" }}
              </button>
            </div>
            <p v-if="confirmCsvExport" class="mt-2 text-xs text-[#8b2332]">
              CSV 含明文密码，请勿分享或上传，迁移后及时删除。
            </p>
          </section>

          <section class="border-t border-stone-200 pt-5">
            <h4 class="mb-2 font-serif text-sm font-semibold text-stone-800">导入</h4>
            <p class="mb-3 text-xs text-stone-500">
              预览后导入，不覆盖已有条目。
            </p>
            <button
              class="rounded-full bg-stone-800 px-4 py-2 text-xs font-medium text-stone-50 transition-colors duration-300 hover:bg-stone-700 disabled:opacity-50"
              :disabled="importing"
              @click="doImportCsv"
            >
              {{ importing ? "分析中…" : "选择 CSV" }}
            </button>
          </section>
          <ImportPreview v-if="importPreview.length" />

          <p
            v-if="message"
            class="rounded-[1rem] px-4 py-2 text-xs"
            :class="
              messageKind === 'ok'
                ? 'bg-[#8b9d77]/15 text-[#5c4033]'
                : 'bg-[#8b2332]/10 text-[#8b2332]'
            "
          >
            {{ message }}
          </p>
        </div>

        <VaultReport v-else-if="tab === 'health'" />
        <AuditTimeline v-else-if="tab === 'audit'" />
        <!-- 关于 -->
        <div v-else-if="tab === 'about'" class="space-y-3 text-sm text-stone-700">
          <div class="flex items-start justify-between gap-4">
            <span class="text-stone-500">库文件</span>
            <span class="max-w-[70%] break-all text-right text-xs">{{ vaultPath }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-stone-500">加密</span>
            <span>{{ vaultInfo.kdf }} · {{ vaultInfo.version }}</span>
          </div>
          <div class="font-medium text-stone-800">KeyTree</div>
          <p class="border-t border-stone-200 pt-3 text-xs text-stone-400">
            本地优先，可手动同步或启用锁定时同步。
          </p>
        </div>
        </fieldset>
      </div>
    </div>
  </div>
</template>
