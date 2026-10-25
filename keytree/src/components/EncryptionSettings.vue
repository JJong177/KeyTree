<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useVault } from "../composables/useVault";
import { ENCRYPTION_PROFILES, type EncryptionProfile } from "../kdbx/security";

const emit = defineEmits<{ working: [value: boolean] }>();
const { vaultEncryption, vaultPath, busy, encryptionPreview, testEncryptionSpeed, upgradeEncryption, error } = useVault();
const profile = ref<EncryptionProfile>("recommended");
const working = ref(false), confirmed = ref(false), message = ref(""), failed = ref(false);
const measuredMs = ref<number | null>(null);
const target = computed(() => { void vaultEncryption.value; try { return encryptionPreview(profile.value); } catch { return null; } });
watch(profile, () => { confirmed.value = false; measuredMs.value = null; message.value = ""; });
watch(vaultPath, () => { confirmed.value = false; measuredMs.value = null; message.value = ""; });
async function run(action: () => Promise<void>) {
  if (working.value || busy.value) return;
  working.value = true; emit("working", true); message.value = ""; failed.value = false;
  try { await action(); }
  catch { message.value = "操作未完成，请重试"; failed.value = true; }
  finally { working.value = false; emit("working", false); }
}
function measure() { return run(async () => {
  measuredMs.value = await testEncryptionSpeed(profile.value);
  if (measuredMs.value === null) { failed.value = true; message.value = error.value || "测试已取消，密码库未修改"; }
}); }
function apply() { return run(async () => {
  if (!confirmed.value) return;
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
        {{ vaultEncryption.needsUpgrade ? '建议升级' : '达到推荐成本' }}
      </span>
    </div>
    <p class="mt-2 text-xs leading-5 text-stone-500">保留标准 KDBX，增加数据库泄露后猜测主密码的成本，不替代强主密码或设备安全。</p>
    <dl v-if="vaultEncryption" class="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 rounded-2xl bg-white/60 p-3 text-xs">
      <div><dt class="text-stone-400">格式 / 数据加密</dt><dd class="mt-1 text-stone-700">{{ vaultEncryption.version }} · {{ vaultEncryption.cipher }}</dd></div>
      <div><dt class="text-stone-400">密钥派生</dt><dd class="mt-1 text-stone-700">{{ vaultEncryption.kdf }}</dd></div>
      <div><dt class="text-stone-400">内存</dt><dd class="mt-1 text-stone-700">{{ vaultEncryption.memoryMiB === null ? '不适用或未知' : `${vaultEncryption.memoryMiB} MiB` }}</dd></div>
      <div><dt class="text-stone-400">迭代 / 并行度</dt><dd class="mt-1 text-stone-700">{{ vaultEncryption.iterations ?? '未知' }} / {{ vaultEncryption.parallelism ?? '不适用' }}</dd></div>
    </dl>
    <label for="encryption-profile" class="mt-4 block text-xs font-medium text-stone-700">升级最低成本档位</label>
    <select id="encryption-profile" v-model="profile" :disabled="working || busy" class="mt-2 w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-700">
      <option v-for="item in ENCRYPTION_PROFILES" :key="item.id" :value="item.id">{{ item.label }} · {{ item.memoryMiB }} MiB · 至少 3 次迭代</option>
    </select>
    <p v-if="target" class="mt-2 text-xs leading-5 text-stone-500">实际目标：Argon2id · {{ target.memoryMiB }} MiB · {{ target.iterations }} 次 · 并行度 {{ target.parallelism }}。已有更高参数不降低，保留原数据加密算法。</p>
    <button type="button" :disabled="working || busy || !target" class="mt-3 rounded-full border border-stone-300 bg-white px-4 py-2 text-xs text-stone-700 disabled:opacity-50" @click="measure">{{ working ? '处理中…' : '测试本机耗时（不修改库）' }}</button>
    <p v-if="measuredMs !== null" role="status" class="mt-2 text-xs leading-5 text-stone-600">单次密钥派生约 {{ measuredMs }} ms。可参考 1–2 秒选择档位；这是本次测量，不是安全评分。升级包含加密和解密验证，保存、解锁及同步也会变慢。</p>
    <p class="mt-3 text-xs leading-5 text-[#8b2332]">升级前自动备份当前密文，验证通过才覆盖原文件。旧备份、云端历史与其他副本不会自动增强；KDBX 3 将升级为 KDBX 4，请先确认其他客户端支持。</p>
    <label class="mt-3 flex items-start gap-2 text-xs leading-5 text-stone-600">
      <input v-model="confirmed" type="checkbox" :disabled="working || busy" class="mt-1" />
      我理解旧副本不受影响，并同意备份、验证后重新加密当前库。
    </label>
    <button type="button" :disabled="!confirmed || working || busy || !target" class="mt-3 rounded-full bg-stone-800 px-4 py-2 text-xs font-medium text-white disabled:opacity-40" @click="apply">备份并升级加密强度</button>
    <p v-if="message" role="status" class="mt-3 rounded-xl px-3 py-2 text-xs leading-5" :class="failed ? 'bg-[#8b2332]/10 text-[#8b2332]' : 'bg-[#8b9d77]/15 text-[#526542]'">{{ message }}</p>
  </section>
</template>
