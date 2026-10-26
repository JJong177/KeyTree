<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from "vue";
import { useDialogFocus } from "../composables/useDialogFocus";
import { useVault } from "../composables/useVault";
import type { EntryDraft } from "../composables/useVault";
import { dateInputValue, generatePassphrase, generatePassword, passphraseStrength, strength, WORDLIST_BITS } from "../lib/format";
import { settings } from "../lib/settings";
import { parseTotpInput } from "../lib/totp";
import { validateCustomFields, validateSequence } from "../lib/entry-fields";
import AppSelect from "./AppSelect.vue";

const props = defineProps<{ clipboardDraft?: Pick<EntryDraft, "title" | "username" | "password" | "url" | "notes"> | null }>();

const {
  drawer,
  groups,
  pendingGroup,
  draftOf,
  addEntry,
  updateEntry,
  closeDrawer,
  busy,
  error,
} = useVault();
const groupOptions = computed(() => groups.value.map(group => ({ value: group.uuid, label: group.name, depth: group.depth })));

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
  customFields: [], removedFields: [], autoTypeSequence: "",
});

const revealed = ref(false);
const localError = ref("");
const dialogRoot = ref<HTMLElement | null>(null);
const submitting = ref(false);
const confirmDiscard = ref(false);
const initialDraft = ref("");
const hasDraftChanges = computed(() => JSON.stringify(form) !== initialDraft.value);
useDialogFocus(dialogRoot, () => {
  if (confirmDiscard.value) confirmDiscard.value = false;
  else requestClose();
});
function requestClose() {
  if (submitting.value || busy.value) return;
  if (!hasDraftChanges.value) { closeDrawer(); return; }
  confirmDiscard.value = true;
  void nextTick(() => dialogRoot.value?.querySelector<HTMLElement>("[data-continue-editing]")?.focus());
}
function discardChanges() {
  if (submitting.value || busy.value) return;
  closeDrawer();
}
// 生成器选项记在设置里：每次打开抽屉不再回落到默认值
const genLength = ref(settings.genLength);
const genSymbols = ref(settings.genSymbols);
const genMode = ref<"chars" | "phrase">(settings.genMode);
const genWords = ref(settings.genWords);
const wordBits = WORDLIST_BITS;

watch(genMode, (v) => (settings.genMode = v));
watch(genSymbols, (v) => (settings.genSymbols = v));
watch(genLength, (v) => {
  settings.genLength = Math.min(64, Math.max(8, Math.round(Number(v) || 20)));
});
watch(genWords, (v) => {
  settings.genWords = Math.min(12, Math.max(3, Math.round(Number(v) || 6)));
});

const isEdit = computed(() => drawer.value.mode === "edit");
// 口令（N 个词）按词数算熵，普通字符串按字符熵，两套口径别混
const meter = computed(() => passphraseStrength(form.password) ?? strength(form.password));
const canSave = computed(() => !!form.title.trim() && !busy.value && !submitting.value);

const totpConfig = computed(() => {
  const raw = form.totp.trim();
  if (!raw) return null;
  return parseTotpInput(raw);
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
    customFields: [], removedFields: [], autoTypeSequence: "",
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
  if (submitting.value || busy.value) return;
  if (!canSave.value) {
    localError.value = "标题不能为空";
    return;
  }
  localError.value = "";
  try {
    validateCustomFields(form.customFields ?? []);
    // 不改动从其他客户端继承的未知序列；只有用户改动后才校验本工具支持的子集。
    const previous = isEdit.value ? draftOf(drawer.value.uuid)?.autoTypeSequence : "";
    if ((form.autoTypeSequence ?? "") !== (previous ?? "")) validateSequence(form.autoTypeSequence ?? "");
    if (form.totp.trim() && !totpValid.value) throw new Error("请检查 TOTP 密钥格式");
  } catch (e) { localError.value = (e as Error).message; return; }
  submitting.value = true;
  try {
    const ok = isEdit.value
      ? await updateEntry(drawer.value.uuid, form)
      : !!(await addEntry(form));
    if (ok) closeDrawer();
    else localError.value = error.value || "尚未保存到磁盘，请重试或另存 KDBX 副本";
  } catch {
    localError.value = "保存未完成，请重试或另存 KDBX 副本";
  } finally { submitting.value = false; }
}

function removeField(index: number) {
  const field = form.customFields?.[index];
  if (field?.originalName) (form.removedFields ??= []).push(field.originalName);
  form.customFields?.splice(index, 1);
}
onMounted(() => {
  init();
  initialDraft.value = JSON.stringify(form);
  // Treat imported fields as unsaved edits: closing must keep the existing discard confirmation.
  if (!isEdit.value && props.clipboardDraft) {
    const { title, username, password, url, notes } = props.clipboardDraft;
    Object.assign(form, { title, username, password, url, notes });
  }
});

</script>

<template>
  <div class="fixed inset-0 z-40 flex justify-end bg-stone-800/20 p-4 md:p-8">
    <div
      ref="dialogRoot" role="dialog" aria-modal="true" aria-labelledby="entry-drawer-title" tabindex="-1" :aria-busy="submitting"
      class="drawer flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-[2rem] border border-stone-200 bg-[#faf6f1]"
    >
      <!-- 标题区 -->
      <div class="flex items-center justify-between border-b border-stone-200 px-6 py-4">
        <h3 id="entry-drawer-title" class="font-serif text-xl font-semibold text-stone-800">
          {{ isEdit ? "编辑条目" : "新建条目" }}
        </h3>
        <button
          class="flex h-9 w-9 items-center justify-center rounded-full border border-stone-300 bg-white text-stone-700 transition-colors duration-300 hover:bg-stone-100"
          @click="requestClose" :disabled="submitting || busy"
        >
          ✕
        </button>
      </div>

      <!-- 表单 -->
      <fieldset :disabled="submitting || busy" :inert="confirmDiscard" class="min-h-0 min-w-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
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
              class="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-stone-300 bg-white text-stone-500 transition-colors duration-300 hover:bg-stone-100 hover:text-stone-700"
              :title="revealed ? '隐藏密码' : '显示密码'"
              :aria-label="revealed ? '隐藏密码' : '显示密码'"
              @click="revealed = !revealed"
            >
              <svg
                v-if="revealed"
                width="18"
                height="18"
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
                width="18"
                height="18"
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
          <div class="min-w-0">
            <label for="entry-group" class="mb-1 block text-sm font-medium text-stone-700">分组</label>
            <AppSelect id="entry-group" v-model="form.groupUuid" :options="groupOptions" aria-label="分组" :disabled="submitting || busy || confirmDiscard" size="large" class="w-full" />
          </div>
          <div class="min-w-0">
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
            高级
          </summary>
          <div class="mt-3 space-y-3">
            <div>
              <label class="mb-1 block text-xs text-stone-500" for="autotype-sequence" title="支持 {USERNAME}、{PASSWORD}、{TAB}、{ENTER}、{DELAY n}；延迟不超过 5000 毫秒">自动输入序列</label>
              <input id="autotype-sequence" v-model="form.autoTypeSequence" class="w-full rounded-full border border-stone-200 bg-white px-4 py-2 font-mono text-xs" placeholder="{USERNAME}{TAB}{PASSWORD}{ENTER}" />
            </div>
            <div class="rounded-[1rem] border border-stone-200 bg-white p-3">
              <div class="mb-2 flex items-center justify-between"><span class="text-xs text-stone-600">自定义字段</span><button class="rounded-full border border-stone-300 px-3 py-1 text-xs" @click="(form.customFields ??= []).push({ name: '', value: '', protected: true })">＋ 字段</button></div>
              <div v-for="(field, index) in form.customFields" :key="index" class="mb-3 space-y-2 border-b border-stone-100 pb-3 last:border-0">
                <div class="flex gap-2"><input v-model="field.name" :aria-label="`字段 ${index + 1} 名称`" class="min-w-0 flex-1 rounded-full border border-stone-200 px-3 py-2 text-xs" placeholder="例如：恢复码" /><button class="text-xs text-[#8b2332]" @click="removeField(index)">移除</button></div>
                <input v-model="field.value" :type="field.protected ? 'password' : 'text'" :aria-label="`字段 ${index + 1} 内容`" class="w-full rounded-full border border-stone-200 px-3 py-2 text-xs" placeholder="字段内容" />
                <label class="flex items-center gap-2 text-xs text-stone-500"><input v-model="field.protected" type="checkbox" />隐藏字段内容</label>
              </div>
            </div>
            <div>
              <label class="mb-1 block text-xs text-stone-500">
                TOTP 密钥
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
                支持 otpauth:// 链接或 Base32 密钥。
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

        <p v-if="localError" class="text-xs text-[#8b2332]" role="alert">{{ localError }}</p>
      </fieldset>

      <div v-if="confirmDiscard" data-dialog-confirmation class="border-t border-amber-200 bg-amber-50 px-6 py-4" role="alert">
        <p class="text-sm text-amber-900">有尚未保存的修改，要放弃吗？</p>
        <div class="mt-3 flex flex-wrap gap-3">
          <button data-continue-editing class="rounded-full bg-stone-800 px-4 py-2 text-sm text-white" @click="confirmDiscard = false">继续编辑</button>
          <button class="rounded-full border border-amber-300 px-4 py-2 text-sm text-amber-900" @click="discardChanges">放弃修改</button>
        </div>
      </div>
      <!-- 底部按钮 -->
      <div class="flex gap-3 border-t border-stone-200 px-6 py-4">
        <button
          class="flex-1 rounded-full bg-stone-800 px-6 py-3 font-medium text-stone-50 transition-colors duration-300 hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="!canSave"
          @click="submit"
        >
          {{ submitting || busy ? "保存中…" : "保存" }}
        </button>
        <button
          class="rounded-full border border-stone-300 bg-transparent px-6 py-3 font-medium text-stone-800 transition-colors duration-300 hover:bg-stone-100"
          @click="requestClose" :disabled="submitting || busy"
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
