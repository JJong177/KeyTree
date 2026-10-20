<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useVault } from "../composables/useVault";
import type { EntryDraft } from "../composables/useVault";
import { dateInputValue, generatePassphrase, generatePassword, passphraseStrength, strength, WORDLIST_BITS } from "../lib/format";
import { parseLegacyTotp, parseOtpauth } from "../lib/totp";

const {
  drawer,
  groups,
  pendingGroup,
  draftOf,
  addEntry,
  updateEntry,
  closeDrawer,
  busy,
} = useVault();

const form = reactive<EntryDraft>({
  title: "",
  username: "",
  password: "",
  url: "",
  notes: "",
  tags: "",
  totp: "",
  groupUuid: "",
  expires: false,
  expiryDate: "",
});

const revealed = ref(false);
const localError = ref("");
const genLength = ref(20);
const genSymbols = ref(true);
const genMode = ref<"chars" | "phrase">("chars");
const genWords = ref(6);
const wordBits = WORDLIST_BITS;

const isEdit = computed(() => drawer.value.mode === "edit");
// 口令（N 个词）按词数算熵，普通字符串按字符熵，两套口径别混
const meter = computed(() => passphraseStrength(form.password) ?? strength(form.password));
const canSave = computed(() => !!form.title.trim() && !busy.value);

const totpConfig = computed(() => {
  const raw = form.totp.trim();
  if (!raw) return null;
  return raw.toLowerCase().startsWith("otpauth://")
    ? parseOtpauth(raw)
    : parseLegacyTotp(raw);
});
const totpValid = computed(() => !!totpConfig.value);
const totpHint = computed(() => {
  const cfg = totpConfig.value;
  if (!cfg) {
    return "无法识别这个密钥：otpauth 链接格式不对，或 Base32 里有非法字符";
  }
  const parts = [cfg.steam ? "Steam 令牌" : `${cfg.period} 秒 / ${cfg.digits} 位`];
  if (cfg.issuer) parts.push(cfg.issuer);
  if (cfg.account) parts.push(cfg.account);
  return `已识别：${parts.join(" · ")}`;
});

// 勾了过期但没选日期时，默认给一个 90 天后的日期，避免空值
watch(
  () => form.expires,
  (on) => {
    if (on && !form.expiryDate) {
      const d = new Date();
      d.setDate(d.getDate() + 90);
      form.expiryDate = dateInputValue(d);
    }
  }
);

function init() {
  if (isEdit.value) {
    const draft = draftOf(drawer.value.uuid);
    if (draft) Object.assign(form, draft);
    return;
  }
  const fallback = pendingGroup.value || groups.value[0]?.uuid || "";
  Object.assign(form, {
    title: "",
    username: "",
    password: "",
    url: "",
    notes: "",
    tags: "",
    totp: "",
    groupUuid: fallback,
    expires: false,
    expiryDate: "",
  });
}

function generate() {
  if (genMode.value === "phrase") {
    const count = Math.min(12, Math.max(3, Math.round(genWords.value || 6)));
    form.password = generatePassphrase(count);
  } else {
    const length = Math.min(64, Math.max(8, Math.round(genLength.value || 20)));
    form.password = generatePassword(length, genSymbols.value);
  }
  revealed.value = true;
}

async function submit() {
  if (!canSave.value) {
    localError.value = "标题不能为空";
    return;
  }
  localError.value = "";
  const ok = isEdit.value
    ? await updateEntry(drawer.value.uuid, form)
    : !!(await addEntry(form));
  if (ok) closeDrawer();
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") closeDrawer();
}

onMounted(() => {
  init();
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="fixed inset-0 z-40 flex justify-end bg-stone-800/20 p-4 md:p-8">
    <div
      class="drawer flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-[2rem] border border-stone-200 bg-[#faf6f1]"
    >
      <!-- 标题区 -->
      <div class="flex items-center justify-between border-b border-stone-200 px-6 py-4">
        <h3 class="font-serif text-xl font-semibold text-stone-800">
          {{ isEdit ? "编辑条目" : "新建条目" }}
        </h3>
        <button
          class="flex h-9 w-9 items-center justify-center rounded-full border border-stone-300 bg-white text-stone-700 transition-colors duration-300 hover:bg-stone-100"
          @click="closeDrawer"
        >
          ✕
        </button>
      </div>

      <!-- 表单 -->
      <div class="flex-1 space-y-4 overflow-y-auto px-6 py-5">
        <div>
          <label class="mb-1 block text-sm font-medium text-stone-700">
            标题 <span class="text-[#8b2332]">*</span>
          </label>
          <input
            v-model="form.title"
            class="w-full rounded-full border border-stone-200 bg-white px-5 py-3 text-stone-800 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
            placeholder="例如 GitHub"
            @keyup.enter="submit"
          />
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium text-stone-700">用户名</label>
          <input
            v-model="form.username"
            class="w-full rounded-full border border-stone-200 bg-white px-5 py-3 text-stone-800 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
            placeholder="邮箱或账号"
          />
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium text-stone-700">密码</label>
          <div class="flex gap-2">
            <input
              v-model="form.password"
              :type="revealed ? 'text' : 'password'"
              class="min-w-0 flex-1 rounded-full border border-stone-200 bg-white px-5 py-3 font-semibold tracking-wider text-stone-800 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
              placeholder="留空表示不设密码"
            />
            <button
              class="shrink-0 rounded-full border border-stone-300 bg-[#d4a373] px-4 py-3 text-sm font-medium text-stone-800 transition-colors duration-300 hover:bg-[#d4a373]/80"
              title="生成随机密码"
              @click="generate"
            >
              🎲 生成
            </button>
            <button
              class="shrink-0 rounded-full border border-stone-300 bg-white px-4 py-3 text-sm text-stone-700 transition-colors duration-300 hover:bg-stone-100"
              @click="revealed = !revealed"
            >
              {{ revealed ? "隐" : "眼" }}
            </button>
          </div>
          <div class="mt-2 flex items-center gap-2">
            <div
              class="h-3 flex-1 overflow-hidden rounded-full border border-stone-200 bg-[#faf6f1]"
            >
              <div
                class="h-full transition-all duration-300"
                :class="meter.barClass"
                :style="{ width: `${meter.score}%` }"
              />
            </div>
            <span class="shrink-0 text-xs font-medium text-[#5c4033]">
              {{ meter.label }} · {{ form.password.length }} 位
            </span>
          </div>
          <div class="mt-1 flex flex-wrap items-center gap-3 text-xs text-stone-500">
            <div class="flex gap-1 rounded-full bg-white p-0.5">
              <button
                type="button"
                class="rounded-full px-2.5 py-0.5 transition-colors duration-300"
                :class="
                  genMode === 'chars'
                    ? 'bg-stone-800 text-stone-50'
                    : 'text-stone-600 hover:bg-stone-100'
                "
                @click="genMode = 'chars'"
              >
                随机字符
              </button>
              <button
                type="button"
                class="rounded-full px-2.5 py-0.5 transition-colors duration-300"
                :class="
                  genMode === 'phrase'
                    ? 'bg-stone-800 text-stone-50'
                    : 'text-stone-600 hover:bg-stone-100'
                "
                @click="genMode = 'phrase'"
              >
                单词口令
              </button>
            </div>
            <template v-if="genMode === 'chars'">
              <label class="flex items-center gap-1">
                生成长度
                <input
                  v-model.number="genLength"
                  type="number"
                  min="8"
                  max="64"
                  class="w-14 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-center text-xs focus:border-stone-400 focus:outline-none"
                />
              </label>
              <label class="flex items-center gap-1">
                <input v-model="genSymbols" type="checkbox" class="h-3 w-3" />
                含符号
              </label>
            </template>
            <template v-else>
              <label class="flex items-center gap-1">
                单词数
                <input
                  v-model.number="genWords"
                  type="number"
                  min="3"
                  max="12"
                  class="w-14 rounded-full border border-stone-200 bg-white px-2 py-0.5 text-center text-xs focus:border-stone-400 focus:outline-none"
                />
              </label>
              <span class="text-stone-400">好记好输，约 {{ genWords }}×{{ wordBits }} 位熵</span>
            </template>
          </div>
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium text-stone-700">网址</label>
          <input
            v-model="form.url"
            class="w-full rounded-full border border-stone-200 bg-white px-5 py-3 text-stone-800 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
            placeholder="https://"
          />
        </div>

        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label class="mb-1 block text-sm font-medium text-stone-700">分组</label>
            <select
              v-model="form.groupUuid"
              class="w-full rounded-full border border-stone-200 bg-white px-5 py-3 text-stone-800 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
            >
              <option v-for="g in groups" :key="g.uuid" :value="g.uuid">
                {{ "　".repeat(g.depth) }}{{ g.name }}
              </option>
            </select>
          </div>
          <div>
            <label class="mb-1 block text-sm font-medium text-stone-700">
              标签（逗号分隔）
            </label>
            <input
              v-model="form.tags"
              class="w-full rounded-full border border-stone-200 bg-white px-5 py-3 text-stone-800 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
              placeholder="工作, 开发"
            />
          </div>
        </div>

        <div>
          <label class="mb-1 block text-sm font-medium text-stone-700">备注</label>
          <textarea
            v-model="form.notes"
            class="h-20 w-full resize-none rounded-[1rem] border border-stone-200 bg-white px-5 py-3 text-stone-800 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
            placeholder="可选"
          />
        </div>

        <details
          class="rounded-[1rem] border border-stone-200 bg-white p-3"
          :open="!!form.totp || form.expires"
        >
          <summary class="cursor-pointer text-sm font-medium text-stone-700">
            高级 ▼
          </summary>
          <div class="mt-3 space-y-3">
            <div>
              <label class="mb-1 block text-xs text-stone-500">
                TOTP 密钥（粘 otpauth:// 链接，或直接填 Base32 密钥）
              </label>
              <input
                v-model="form.totp"
                class="w-full rounded-full border border-stone-200 bg-[#faf6f1] px-5 py-2 text-xs text-stone-800 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
                placeholder="otpauth://totp/... 或 JBSWY3DPEHPK3PXP"
              />
              <p v-if="form.totp.trim()" class="mt-1 text-xs" :class="totpValid ? 'text-[#5c4033]' : 'text-[#8b2332]'">
                {{ totpHint }}
              </p>
              <p v-else class="mt-1 text-xs text-stone-400">
                密钥随条目一起加密保存，详情页会实时显示动态码
              </p>
            </div>

            <div>
              <label class="mb-1 flex items-center gap-2 text-xs text-stone-500">
                <input v-model="form.expires" type="checkbox" class="h-3.5 w-3.5" />
                启用过期提醒（到期后列表里会标红）
              </label>
              <input
                v-if="form.expires"
                v-model="form.expiryDate"
                type="date"
                class="w-full rounded-full border border-stone-200 bg-[#faf6f1] px-5 py-2 text-xs text-stone-800 transition-all duration-300 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
              />
            </div>
          </div>
        </details>

        <p v-if="localError" class="text-xs text-[#8b2332]">{{ localError }}</p>
      </div>

      <!-- 底部按钮 -->
      <div class="flex gap-3 border-t border-stone-200 px-6 py-4">
        <button
          class="flex-1 rounded-full bg-stone-800 px-6 py-3 font-medium text-stone-50 transition-colors duration-300 hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!canSave"
          @click="submit"
        >
          {{ busy ? "保存中…" : "保存" }}
        </button>
        <button
          class="rounded-full border border-stone-300 bg-transparent px-6 py-3 font-medium text-stone-800 transition-colors duration-300 hover:bg-stone-100"
          @click="closeDrawer"
        >
          取消
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.drawer {
  animation: drawer-in 0.26s ease-out;
}
@keyframes drawer-in {
  from {
    transform: translateX(24px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .drawer {
    animation: none;
  }
}
</style>
