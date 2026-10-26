<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useVault } from "../composables/useVault";
import { webdavErrorMessage, webdavConnectionMessage, type WebdavConfig, type WebdavConnection, isNutstoreWebdavUrl } from "../lib/webdav";
import { getSyncOnLock, setSyncOnLock } from "../lib/settings";
const emit = defineEmits<{ dirty: [value: boolean]; working: [value: boolean] }>();
const { vaultPath, unlocked, busy, hasUnsavedChanges, webdavState, syncWebdav, resetWebdavSyncStatus, setWebdavConfigSummary } = useVault();
const empty = (): WebdavConfig => ({ configured: false, url: "", username: "", hasPassword: false, lastSyncedAt: null });
const config = ref<WebdavConfig>(empty());
const url = ref(""), username = ref(""), password = ref(""), message = ref("");
const working = ref(false), loaded = ref(false), allowCreate = ref(false), confirmForget = ref(false);
const testing = ref(false);
let generation = 0, disposed = false;
const dirty = computed(() => loaded.value && (url.value !== config.value.url || username.value !== config.value.username || password.value !== ""));
const isNutstore = computed(() => isNutstoreWebdavUrl(config.value.url));
const lastUpload = computed(() => webdavState.value.lastSyncedAt ?? config.value.lastSyncedAt);
const disabled = computed(() => !loaded.value || !unlocked.value || busy.value || working.value);
const syncOnLock = computed({
  get: () => getSyncOnLock(vaultPath.value),
  set: enabled => { setSyncOnLock(vaultPath.value, enabled); },
});
watch(dirty, value => { confirmForget.value = false; emit("dirty", value); }, { immediate: true, flush: "sync" });
watch(working, value => emit("working", value), { immediate: true, flush: "sync" });
function apply(view: WebdavConfig) {
  config.value = view; url.value = view.url; username.value = view.username; password.value = "";
}
watch([vaultPath, unlocked], async () => {
  const ticket = ++generation, path = vaultPath.value;
  password.value = ""; message.value = ""; allowCreate.value = false; confirmForget.value = false;
  loaded.value = false; working.value = false; testing.value = false; apply(empty());
  if (!unlocked.value || !path) return;
  working.value = true;
  try {
    const result = await invoke<WebdavConfig>("webdav_get_config", { vaultPath: path });
    if (disposed || ticket !== generation) return;
    apply(result); setWebdavConfigSummary(result); loaded.value = true;
  } catch (e) { if (!disposed && ticket === generation) message.value = webdavErrorMessage(e); }
  finally { if (!disposed && ticket === generation) working.value = false; }
}, { immediate: true, flush: "sync" });
async function action(kind: "save" | "test" | "sync" | "forget") {
  if (disabled.value) return;
  if ((kind === "test" || kind === "sync") && (!config.value.configured || dirty.value)) return;
  if (kind === "forget" && !confirmForget.value) { confirmForget.value = true; return; }
  const ticket = generation, path = vaultPath.value;
  working.value = true; testing.value = kind === "test";
  message.value = testing.value ? "正在只读检查远端文件和 ETag，不会上传…" : "";
  try {
    if (kind === "save") {
      const view = await invoke<WebdavConfig>("webdav_save_config", { vaultPath: path, url: url.value.trim(), username: username.value.trim(), password: password.value === "" ? null : password.value });
      if (disposed || ticket !== generation) return;
      apply(view); setWebdavConfigSummary(view); resetWebdavSyncStatus(); message.value = "配置已保存；尚未检查远端。";
    } else if (kind === "test") {
      const result = await invoke<WebdavConnection>("webdav_test_connection", { vaultPath: path });
      if (disposed || ticket !== generation) return;
      message.value = webdavConnectionMessage(result);
    } else if (kind === "sync") {
      await syncWebdav(allowCreate.value && !isNutstore.value);
      if (disposed || ticket !== generation) return;
      allowCreate.value = false;
    } else {
      await invoke("webdav_forget_config", { vaultPath: path });
      if (disposed || ticket !== generation) return;
      syncOnLock.value = false;
      apply(empty()); setWebdavConfigSummary(empty()); confirmForget.value = false; resetWebdavSyncStatus(); message.value = "本机配置已删除，本地和云端库文件均未删除。";
    }
  } catch (e) { if (!disposed && ticket === generation) message.value = webdavErrorMessage(e); }
  finally { if (!disposed && ticket === generation) { password.value = ""; working.value = false; testing.value = false; } }
}
onBeforeUnmount(() => { disposed = true; generation++; password.value = ""; emit("dirty", false); emit("working", false); });
</script>
<template>
  <section class="space-y-4" data-webdav-settings>
    <h4 class="font-serif text-sm font-semibold text-stone-800">WebDAV 同步</h4>
    <details class="rounded-xl border border-stone-200 bg-white p-3 text-xs leading-relaxed text-stone-600" data-jianguoyun-help>
      <summary class="cursor-pointer font-medium text-stone-700">坚果云配置帮助</summary>
      <div class="mt-3 space-y-2">
        <p>在坚果云安全设置的第三方应用管理中，为 KeyTree 生成应用密码；不要填写坚果云登录密码。</p>
        <p>用户名填坚果云账号（通常为邮箱）；地址填写 WebDAV 服务地址后加上实际目录和库文件名，例如：</p>
        <code class="block break-all rounded-lg bg-stone-100 p-2 text-[11px]">https://dav.jianguoyun.com/dav/KeyTree/vault.kdbx</code>
        <p>示例路径需换成你的实际路径，上级目录须先创建。网页分享链接（/c/sd/…）不能用于同步。</p>
        <p>先保存并测试连接；多端须使用同一份 KDBX。</p>
      </div>
    </details>
    <div class="space-y-3">
      <label class="block text-xs text-stone-600" for="webdav-url">远端 KDBX 完整地址</label>
      <input id="webdav-url" v-model="url" :disabled="disabled" type="url" autocomplete="off" spellcheck="false" placeholder="https://dav.jianguoyun.com/dav/目录/库名.kdbx" class="w-full rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm" />
      <label class="block text-xs text-stone-600" for="webdav-user">用户名</label>
      <input id="webdav-user" v-model="username" :disabled="disabled" autocomplete="off" spellcheck="false" class="w-full rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm" />
      <label class="block text-xs text-stone-600" for="webdav-password">应用专用密码</label>
      <input id="webdav-password" v-model="password" :disabled="disabled" type="password" autocomplete="new-password" :placeholder="config.hasPassword ? '已保存在本机；留空保留' : '填写服务提供的应用专用密码'" class="w-full rounded-xl border border-stone-200 bg-white px-4 py-2.5 text-sm" />
      <p class="text-[11px] text-stone-400">密码仅加密保存在本机。</p>
      <div class="flex flex-wrap gap-2">
        <button :disabled="disabled || !dirty" class="rounded-full border border-stone-300 bg-white px-4 py-2 text-xs disabled:opacity-50" @click="action('save')">保存配置</button>
        <button :disabled="disabled || dirty || !config.configured" class="rounded-full border border-stone-300 bg-white px-4 py-2 text-xs disabled:opacity-50" :aria-busy="testing" title="只读测试，不修改远端文件" @click="action('test')">{{ testing ? '测试中…' : '测试连接' }}</button>
      </div>
      <p v-if="message" data-webdav-connection-result role="status" aria-live="polite" class="break-words rounded-xl bg-stone-100 p-3 text-xs leading-relaxed text-[#5c4033]">{{ message }}</p>
    </div>
    <div class="space-y-2 border-t border-stone-200 pt-4" data-lock-sync-settings>
      <label class="flex items-center gap-2 text-sm text-stone-700">
        <input v-model="syncOnLock" type="checkbox" :disabled="disabled || dirty || !config.configured" />
        锁定时自动同步
      </label>
      <p v-if="syncOnLock" class="text-xs text-stone-500">锁定后上传已保存的加密文件；远端有变化时停止并提示。</p>
    </div>
    <div class="space-y-3 border-t border-stone-200 pt-4">
      <p role="status" aria-live="polite" class="rounded-xl bg-stone-100 p-3 text-xs leading-relaxed text-stone-700" :data-sync-phase="webdavState.phase">同步状态：{{ webdavState.message }}</p>
      <p class="text-xs text-stone-500">本地：{{ hasUnsavedChanges ? '有修改尚未保存' : '已保存' }}</p>
      <p v-if="lastUpload" class="text-[11px] text-stone-400">上次上传确认：{{ new Date(lastUpload).toLocaleString('zh-CN', { hour12: false }) }}（不代表当前远端一致）</p>
      <p v-if="isNutstore" class="text-xs text-stone-500">坚果云需先上传同一份 KDBX，再同步。</p>
      <label v-else class="flex items-start gap-2 text-xs text-stone-600"><input v-model="allowCreate" :disabled="disabled" type="checkbox" class="mt-0.5" />远端不存在时，允许首次创建（不创建目录）</label>
      <div class="flex flex-wrap gap-2">
        <button :disabled="disabled || dirty || !config.configured" class="rounded-full bg-stone-800 px-4 py-2 text-xs text-white disabled:opacity-50" @click="action('sync')">{{ working && !testing ? '处理中…' : '立即同步' }}</button>
        <button :disabled="disabled || !config.configured" class="rounded-full border border-[#8b2332]/30 px-4 py-2 text-xs text-[#8b2332] disabled:opacity-50" @click="action('forget')">{{ confirmForget ? '确认忘记本机配置' : '忘记本机配置' }}</button>
        <button v-if="confirmForget" class="text-xs text-stone-500" @click="confirmForget = false">取消</button>
      </div>
      <p v-if="dirty" class="text-xs text-stone-500">请先保存配置，再测试或同步。</p>
    </div>
    <p class="text-xs text-stone-500">多端使用同一份 KDBX；勿让云盘客户端同时同步本地文件。</p>
    <details class="text-xs text-stone-500">
      <summary class="cursor-pointer">同步须知</summary>
      <p class="mt-2 leading-relaxed">新设备先下载并打开密码库。密钥文件不自动同步，需另行保管；主密码提示为公开明文。服务条件请求及手机兼容性需实际验证。</p>
    </details>
  </section>
</template>
