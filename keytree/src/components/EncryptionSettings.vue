<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useVault } from "../composables/useVault";
import { ENCRYPTION_PROFILES, type EncryptionProfile } from "../kdbx/security";
import AppSelect from "./AppSelect.vue";
type ProfileSelection = EncryptionProfile | "current";
const currentProfile = computed(() => {
  const info = vaultEncryption.value;
  if (!info || info.kdf !== "Argon2id" || !info.version.startsWith("KDBX 4.") || info.iterations !== 3 || info.parallelism !== 1) return null;
  return ENCRYPTION_PROFILES.find(item => item.memoryMiB === info.memoryMiB) ?? null;
});
const profileOptions = computed<Array<{ value: ProfileSelection; label: string; description?: string }>>(() => {
  const options: Array<{ value: ProfileSelection; label: string; description?: string }> = ENCRYPTION_PROFILES.map(item => ({
    value: item.id, label: `${item.label} · ${item.memoryMiB} MiB`,
    description: item.id === "recommended" ? "日常使用，兼顾安全与响应" : item.id === "strong" ? "增加内存成本，建议先测耗时" : "更高资源占用，适合性能充裕的设备",
  }));
  if (!currentProfile.value) options.unshift({ value: "current", label: "当前 · 自定义参数" });
  return options;
});

const emit = defineEmits<{ working: [value: boolean] }>();
const { vaultEncryption, vaultPath, busy, encryptionPreview, testEncryptionSpeed, upgradeEncryption, error } = useVault();
const profile = ref<ProfileSelection>("current");
const working = ref(false), confirmed = ref(false), message = ref(""), failed = ref(false);
const measuredMs = ref<number | null>(null);
const target = computed(() => {
  void vaultEncryption.value;
  if (profile.value === "current") return null;
  try { return encryptionPreview(profile.value); } catch { return null; }
});
function resetDraft() { confirmed.value = false; measuredMs.value = null; message.value = ""; }
watch(profile, resetDraft, { flush: "sync" });
watch([vaultPath, vaultEncryption], () => {
  profile.value = currentProfile.value?.id ?? "current";
  resetDraft();
}, { immediate: true, flush: "sync" });
async function run(action: () => Promise<void>) {
  if (working.value || busy.value) return;
  working.value = true; emit("working", true); message.value = ""; failed.value = false;
  try { await action(); }
  catch { message.value = "操作未完成，请重试"; failed.value = true; }
  finally { working.value = false; emit("working", false); }
}
function measure() { return run(async () => {
  if (profile.value === "current") return;
  measuredMs.value = await testEncryptionSpeed(profile.value);
  if (measuredMs.value === null) { failed.value = true; message.value = error.value || "测试已取消，密码库未修改"; }
}); }
function apply() { return run(async () => {
  if (!confirmed.value || profile.value === "current") return;
  const ok = await upgradeEncryption(profile.value);
  failed.value = !ok;
  message.value = ok ? "已升级并重新解密验证。主密码和密钥文件不变；请按需手动同步，并检查其他客户端兼容性。" : error.value || "升级未完成，原文件未覆盖";
  if (ok) confirmed.value = false;
}); }
</script>

<template>
  <section aria-labelledby="encryption-heading" class="border-b border-stone-200 pb-5">
    <div class="flex items-center justify-between gap-3">
      <h4 id="encryption-heading" class="font-serif text-sm font-semibold text-stone-800">密码库加密强度</h4>
      <span v-if="vaultEncryption" class="rounded-full px-2.5 py-1 text-[11px]" :class="vaultEncryption.needsUpgrade ? 'bg-[#d4a373]/15 text-[#805a33]' : 'bg-[#8b9d77]/15 text-[#526542]'">
        {{ vaultEncryption.needsUpgrade ? '建议升级' : `当前：${currentProfile?.label ?? '自定义'}` }}
      </span>
    </div>
    <details class="mt-3" data-encryption-options>
      <summary class="cursor-pointer text-xs text-stone-600">调整加密强度</summary>
    <dl v-if="vaultEncryption" class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl bg-white/60 p-3 text-xs">
      <div><dt class="text-stone-400">格式 / 数据加密</dt><dd class="mt-1 text-stone-700">{{ vaultEncryption.version }} · {{ vaultEncryption.cipher }}</dd></div>
      <div><dt class="text-stone-400">密钥派生</dt><dd class="mt-1 text-stone-700">{{ vaultEncryption.kdf }}</dd></div>
      <div><dt class="text-stone-400">内存</dt><dd class="mt-1 text-stone-700">{{ vaultEncryption.memoryMiB === null ? '不适用或未知' : `${vaultEncryption.memoryMiB} MiB` }}</dd></div>
      <div><dt class="text-stone-400">迭代 / 并行度</dt><dd class="mt-1 text-stone-700">{{ vaultEncryption.iterations ?? '未知' }} / {{ vaultEncryption.parallelism ?? '不适用' }}</dd></div>
    </dl>
    <label for="encryption-profile" class="mt-4 block text-xs font-medium text-stone-700">强度档位</label>
    <AppSelect id="encryption-profile" v-model="profile" :options="profileOptions" :disabled="working || busy" class="mt-2 w-full" />
    <p v-if="target" class="mt-2 text-xs text-stone-500" title="不会降低已有参数，保留原数据加密算法">Argon2id · {{ target.memoryMiB }} MiB · {{ target.iterations }} 次 · 并行度 {{ target.parallelism }}</p>
    <button type="button" :disabled="working || busy || !target" class="mt-3 rounded-full border border-stone-300 bg-white px-4 py-2 text-xs text-stone-700 disabled:opacity-50" title="仅测试耗时，不修改密码库" @click="measure">{{ working ? '处理中…' : '测试耗时' }}</button>
    <p v-if="measuredMs !== null" role="status" class="mt-2 text-xs text-stone-600">密钥派生约 {{ measuredMs }} ms；强度越高，解锁和保存越慢。</p>
    <p class="mt-3 text-xs leading-5 text-[#8b2332]">升级前自动备份；旧副本不变。KDBX 3 将升级为 KDBX 4，请确认其他客户端兼容。</p>
    <label class="mt-3 flex items-start gap-2 text-xs leading-5 text-stone-600">
      <input v-model="confirmed" type="checkbox" :disabled="working || busy" class="mt-1" />
      同意备份并升级当前库，旧副本不变。
    </label>
    <button type="button" :disabled="!confirmed || working || busy || !target" class="mt-3 rounded-full bg-stone-800 px-4 py-2 text-xs font-medium text-white disabled:opacity-40" @click="apply">备份并升级</button>
    </details>
    <p v-if="message" role="status" class="mt-3 rounded-xl px-3 py-2 text-xs leading-5" :class="failed ? 'bg-[#8b2332]/10 text-[#8b2332]' : 'bg-[#8b9d77]/15 text-[#526542]'">{{ message }}</p>
  </section>
</template>
