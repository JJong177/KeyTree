<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { enable as autostartEnable, disable as autostartDisable, isEnabled as autostartEnabled } from "@tauri-apps/plugin-autostart";
import { useVault } from "../composables/useVault";
import { settings } from "../lib/settings";
import { toast } from "../lib/toast";

const emit = defineEmits<{ close: [] }>();

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") emit("close");
}
onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

const {
  vaultPath,
  vaultInfo,
  hasKeyFile,
  changeMasterPassword,
  applyKeyFile,
  createKeyFile,
  exportKdbx,
  exportCsv,
  importCsv,
  error,
  busy,
} = useVault();

const tab = ref<"security" | "convenience" | "data" | "about">("security");

const tabs = [
  { key: "security", label: "安全" },
  { key: "convenience", label: "便利" },
  { key: "data", label: "数据" },
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

watch(
  () => settings.quickUnlock,
  async (on) => {
    // 关掉开关时立刻删掉本机密钥副本；打开则等下次主密码解锁时自动重建
    if (!on) {
      try {
        await invoke("quick_unlock_clear");
        toast("已清除快速解锁密钥");
      } catch {
        /* 清不掉（文件本来就没有）也无妨 */
      }
    }
  }
);

async function clearQuickUnlock() {
  if (!confirmClearQuick.value) {
    confirmClearQuick.value = true;
    window.setTimeout(() => (confirmClearQuick.value = false), 4000);
    return;
  }
  confirmClearQuick.value = false;
  try {
    await invoke("quick_unlock_clear");
    say("已清除本机缓存的解锁密钥，下次需主密码", "ok");
  } catch (e) {
    say(`清除失败：${(e as Error).message}`, "err");
  }
}

// ---- 数据：导入 / 导出 ----
const confirmCsvExport = ref(false);
const importing = ref(false);

async function doExportKdbx() {
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

async function doExportCsv() {
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

async function doImportCsv() {
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
    const n = await importCsv(picked);
    if (n > 0) {
      say(`已从 CSV 导入 ${n} 条（Chrome/KeePassXC 格式自动识别）`, "ok");
      toast(`已导入 ${n} 条`);
    } else {
      say(error.value || "没有导入任何条目", "err");
    }
  } finally {
    importing.value = false;
  }
}

function say(text: string, kind: "ok" | "err" = "ok") {
  message.value = text;
  messageKind.value = kind;
}

async function submitPassword() {
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

async function pickKeyFile() {
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

async function generateKeyFile() {
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

async function removeKeyFile() {
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
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-stone-800/20 p-4">
    <div
      class="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-[2rem] border border-stone-200 bg-[#faf6f1]"
    >
      <div class="flex items-center justify-between border-b border-stone-200 px-6 py-4">
        <h3 class="font-serif text-xl font-semibold text-stone-800">设置</h3>
        <button
          class="flex h-9 w-9 items-center justify-center rounded-full border border-stone-300 bg-white text-stone-700 transition-colors duration-300 hover:bg-stone-100"
          @click="emit('close')"
        >
          ✕
        </button>
      </div>

      <!-- tab -->
      <div class="flex gap-1 border-b border-stone-200 px-6 py-3">
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

      <div class="flex-1 overflow-y-auto px-6 py-5">
        <!-- 安全 -->
        <div v-if="tab === 'security'" class="space-y-6">
          <section>
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
              改完会用新密码重新加密整个库文件；旧密码立即失效，且无法找回。
            </p>
            <button
              class="mt-3 rounded-full bg-stone-800 px-5 py-2 text-sm font-medium text-stone-50 transition-colors duration-300 hover:bg-stone-700 disabled:opacity-50"
              :disabled="busy"
              @click="submitPassword"
            >
              修改主密码
            </button>
          </section>

          <section class="border-t border-stone-200 pt-5">
            <h4 class="mb-2 font-serif text-sm font-semibold text-stone-800">密钥文件（第二因子）</h4>
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
                选择现有密钥文件
              </button>
              <button
                class="rounded-full border border-stone-300 bg-[#d4a373] px-4 py-2 text-xs font-medium text-stone-800 transition-colors duration-300 hover:bg-[#d4a373]/80"
                @click="generateKeyFile"
              >
                生成新的 .keyx
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
              丢失密钥文件 + 主密码 = 库永久打不开。启用后请立刻备份。
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
                class="mt-0.5 h-4 w-4"
              />
              <span>
                解锁成功后在本机缓存加密的凭据副本，之后可用指纹 / PIN 快速解锁
                <span class="block text-xs text-stone-400">
                  副本用 Windows DPAPI 绑定当前账户加密；改主密码自动更新，
                  换密钥文件 / 退出应用即清除
                </span>
              </span>
            </label>
            <button
              class="mt-3 rounded-full border px-4 py-2 text-xs transition-colors duration-300"
              :class="
                confirmClearQuick
                  ? 'border-[#8b2332] bg-[#8b2332] text-white'
                  : 'border-stone-300 bg-white text-[#8b2332] hover:bg-[#8b2332]/10'
              "
              @click="clearQuickUnlock"
            >
              {{ confirmClearQuick ? "再点一次确认清除" : "清除本机缓存的解锁密钥" }}
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
        <div v-else-if="tab === 'convenience'" class="space-y-5">
          <div class="border-b border-stone-200 pb-5">
            <label class="mb-1 flex items-center gap-2 text-sm font-medium text-stone-700">
              <input
                v-model="settings.launchAtLogin"
                type="checkbox"
                class="h-4 w-4"
              />
              开机自动启动 KeyTree
            </label>
            <p class="mt-1 text-xs text-stone-400">
              登录 Windows 后自动在后台运行；库仍处于锁定状态，解锁后才可见
            </p>
          </div>
          <div class="border-b border-stone-200 pb-5">
            <label class="mb-1 flex items-center gap-2 text-sm font-medium text-stone-700">
              <input
                v-model="settings.screenshotProtection"
                type="checkbox"
                class="h-4 w-4"
              />
              窗口防截屏
            </label>
            <p class="mt-1 text-xs text-stone-400">
              开启后截图 / 录屏里 KeyTree 窗口不会被捕获（远程桌面显示异常时可关闭）
            </p>
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-stone-700">空闲自动锁定</label>
            <select
              v-model.number="settings.autoLockMinutes"
              class="w-full rounded-full border border-stone-200 bg-white px-5 py-2.5 text-sm text-stone-800 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
            >
              <option v-for="o in autoLockOptions" :key="o.value" :value="o.value">
                {{ o.label }}
              </option>
            </select>
            <p class="mt-1 text-xs text-stone-400">
              有键鼠输入就重新计时；锁定后内存里的库会被清空
            </p>
          </div>

          <div>
            <label class="mb-1 block text-sm font-medium text-stone-700">
              复制后清空剪贴板
            </label>
            <select
              v-model.number="settings.clipboardSeconds"
              class="w-full rounded-full border border-stone-200 bg-white px-5 py-2.5 text-sm text-stone-800 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
            >
              <option v-for="o in clipboardOptions" :key="o.value" :value="o.value">
                {{ o.label }}
              </option>
            </select>
            <p class="mt-1 text-xs text-stone-400">
              只清空我们自己复制的内容，检测到剪贴板已被你换掉就不动它
            </p>
          </div>
        </div>

        <!-- 数据 -->
        <div v-else-if="tab === 'data'" class="space-y-6">
          <section>
            <h4 class="mb-2 font-serif text-sm font-semibold text-stone-800">导出</h4>
            <p class="mb-3 text-xs text-stone-500">
              KDBX 副本是完整加密备份（含分组、历史、回收站、站点图标）；
              CSV 里的密码是<span class="font-medium text-[#8b2332]">明文</span>，只用于迁移到浏览器或其他工具。
            </p>
            <div class="flex flex-wrap gap-2">
              <button
                class="rounded-full border border-stone-300 bg-white px-4 py-2 text-xs text-stone-700 transition-colors duration-300 hover:bg-stone-100"
                :disabled="busy"
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
                :disabled="busy"
                @click="doExportCsv"
              >
                {{ confirmCsvExport ? "明文警告：再点一次确认导出" : "导出 CSV（明文）" }}
              </button>
            </div>
            <p v-if="confirmCsvExport" class="mt-2 text-xs text-[#8b2332]">
              CSV 包含全部明文密码，迁移完成后请立即删除，不要上传网盘或发给别人。
            </p>
          </section>

          <section class="border-t border-stone-200 pt-5">
            <h4 class="mb-2 font-serif text-sm font-semibold text-stone-800">导入</h4>
            <p class="mb-3 text-xs text-stone-500">
              支持 Chrome / Edge 导出的密码 CSV，也支持 KeePassXC 格式（Group 列会自动按层级建组）。
              只新增条目，不动现有数据；表头自动识别。
            </p>
            <button
              class="rounded-full bg-stone-800 px-4 py-2 text-xs font-medium text-stone-50 transition-colors duration-300 hover:bg-stone-700 disabled:opacity-50"
              :disabled="importing"
              @click="doImportCsv"
            >
              {{ importing ? "导入中…" : "选择 CSV 文件导入" }}
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

        <!-- 关于 -->
        <div v-else class="space-y-3 text-sm text-stone-700">
          <div class="flex items-start justify-between gap-4">
            <span class="text-stone-500">库文件</span>
            <span class="max-w-[70%] break-all text-right text-xs">{{ vaultPath }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-stone-500">加密</span>
            <span>{{ vaultInfo.kdf }} · {{ vaultInfo.version }}</span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-stone-500">KeyTree</span>
            <span>0.1.0（M1/M2 开发中）</span>
          </div>
          <p class="border-t border-stone-200 pt-3 text-xs text-stone-400">
            密码数据只存在这个 .kdbx 文件里，KeyTree 没有任何云端服务。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
