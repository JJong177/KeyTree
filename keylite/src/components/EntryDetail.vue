<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { useVault } from "../composables/useVault";
import { copyText } from "../lib/clipboard";
import { toast } from "../lib/toast";
import {
  dateText,
  daysUntil,
  hostOf,
  normalizeUrl,
  relativeTime,
} from "../lib/format";
import TotpDisplay from "./TotpDisplay.vue";
import EntryAvatar from "./EntryAvatar.vue";
import EmptyState from "./EmptyState.vue";
import { recordAudit } from "../lib/audit";

const {
  selectedEntry,
  openEditDrawer,
  removeEntry,
  restoreEntry,
  purgeEntry,
  draftOf,
  totpConfigOf,
  historyOf,
  restoreHistory,
  setHistoryNote, deleteHistory, historyPending, retryHistorySave, busy, error,
  refreshIcon,
  touchUsage,
  toggleFavorite,
} = useVault();

const revealed = ref(false);
const confirmDelete = ref(false);
const confirmPurge = ref(false);
const editingHistory = ref("");
const historyDraft = ref("");
const deletingHistory = ref("");
const historyWorking = ref(false);
const historyError = ref("");
const historyNoteLength = computed(() => [...historyDraft.value].length);
watch(() => selectedEntry.value?.uuid, () => {
  editingHistory.value = ""; historyDraft.value = ""; deletingHistory.value = ""; historyError.value = "";
});

watch(selectedEntry, () => {
  revealed.value = false;
  confirmDelete.value = false;
  confirmPurge.value = false;
});

const url = computed(() => selectedEntry.value?.url ?? "");
const host = computed(() => hostOf(url.value));
const password = computed(() =>
  selectedEntry.value ? (draftOf(selectedEntry.value.uuid)?.password ?? "") : ""
);
const totpConfig = computed(() =>
  selectedEntry.value ? totpConfigOf(selectedEntry.value.uuid) : null
);
const history = computed(() =>
  selectedEntry.value ? historyOf(selectedEntry.value.uuid) : []
);
const expiryDays = computed(() =>
  selectedEntry.value ? daysUntil(selectedEntry.value.expiryTime) : null
);
const expiryText = computed(() => {
  const days = expiryDays.value;
  if (days === null) return "";
  if (days < 0) return `已过期 ${Math.abs(days)} 天`;
  if (days === 0) return "今天到期";
  return `${days} 天后到期`;
});
const expiryUrgent = computed(() => (expiryDays.value ?? 0) <= 7);

async function copyPassword() {
  const entry = selectedEntry.value;
  if (!entry) return;
  if (await copyText(password.value)) { void touchUsage(entry.uuid); void recordAudit("copy-password", entry.uuid); }
}
async function copyUsername() {
  const entry = selectedEntry.value;
  if (entry) await copyText(entry.username, 0);
}
const customFields = computed(() => selectedEntry.value ? draftOf(selectedEntry.value.uuid)?.customFields ?? [] : []);
const revealedFields = ref<string[]>([]);
watch(selectedEntry, () => { revealedFields.value = []; });
function toggleField(name: string) { revealedFields.value = revealedFields.value.includes(name) ? revealedFields.value.filter(n => n !== name) : [...revealedFields.value, name]; }

async function toggleFav() {
  const entry = selectedEntry.value;
  if (!entry) return;
  await toggleFavorite(entry.uuid);
  toast(selectedEntry.value?.favorite ? "已收藏" : "已取消收藏");
}

async function openUrl() {
  const target = normalizeUrl(url.value);
  if (!target) return;
  try {
    await invoke("open_url", { url: target });
  } catch (e) {
    toast(typeof e === "string" ? e : "打开链接失败");
  }
}

async function doDelete() {
  const entry = selectedEntry.value;
  if (!entry) return;
  if (!confirmDelete.value) {
    confirmDelete.value = true;
    window.setTimeout(() => (confirmDelete.value = false), 4000);
    return;
  }
  await removeEntry(entry.uuid);
  confirmDelete.value = false;
}

async function doPurge() {
  const entry = selectedEntry.value;
  if (!entry) return;
  if (!confirmPurge.value) {
    confirmPurge.value = true;
    window.setTimeout(() => (confirmPurge.value = false), 4000);
    return;
  }
  await purgeEntry(entry.uuid);
  confirmPurge.value = false;
}

function editHistory(id: string, note: string) {
  editingHistory.value = id; historyDraft.value = note; deletingHistory.value = ""; historyError.value = "";
}
async function historyAction(kind: "note" | "delete" | "restore" | "retry", id = "") {
  const entry = selectedEntry.value;
  if (!entry || historyWorking.value || busy.value) return;
  historyWorking.value = true;
  historyError.value = "";
  try {
    const ok = kind === "retry" ? await retryHistorySave()
      : kind === "note" ? await setHistoryNote(entry.uuid, id, historyDraft.value)
      : kind === "delete" ? await deleteHistory(entry.uuid, id)
      : await restoreHistory(entry.uuid, id);
    if (selectedEntry.value?.uuid !== entry.uuid) return;
    if (ok) {
      editingHistory.value = ""; historyDraft.value = ""; deletingHistory.value = "";
      toast(kind === "retry" ? "历史改动已保存" : kind === "note" ? "历史备注已保存" : kind === "delete" ? "已删除所选历史版本" : "已恢复到该历史版本");
    } else historyError.value = error.value || "操作未完成，请重新选择历史版本";
  } finally { historyWorking.value = false; }
}
watch(history, items => {
  if (editingHistory.value && !items.some(h => h.id === editingHistory.value)) { editingHistory.value = ""; historyDraft.value = ""; }
  if (deletingHistory.value && !items.some(h => h.id === deletingHistory.value)) deletingHistory.value = "";
});
function historyDate(at: Date | null) { return at ? at.toLocaleString("zh-CN", { hour12: false }) : "时间未知"; }

</script>

<template>
  <aside class="flex flex-col">
    <div v-if="selectedEntry" class="flex-1 overflow-y-auto p-4">
      <!-- 头部 -->
      <div class="mb-4 flex items-start gap-3">
        <!-- 外层只定位；圆形裁剪在内层，↻ 按钮放在裁剪容器外面才不会被裁掉 -->
        <span class="relative h-12 w-12 shrink-0">
          <EntryAvatar :title="selectedEntry.title" :icon="selectedEntry.icon" :size="48" />
          <button
            v-if="host"
            class="absolute -bottom-1 -right-1 flex h-4.5 w-4.5 items-center justify-center rounded-full border border-stone-300 bg-white text-[9px] leading-none text-stone-600 transition-colors duration-300 hover:bg-stone-100"
            title="重新抓取站点图标"
            @click="refreshIcon(selectedEntry.uuid)"
          >
            ↻
          </button>
        </span>
        <div class="min-w-0 flex-1">
          <h3 class="truncate font-serif text-xl font-semibold text-stone-800">
            {{ selectedEntry.title }}
            <button
              class="ml-1 inline-flex align-middle text-base transition-colors duration-300"
              :class="selectedEntry.favorite ? 'text-[#d4a373]' : 'text-stone-300 hover:text-[#d4a373]'"
              :title="selectedEntry.favorite ? '取消收藏' : '收藏'"
              @click="toggleFav"
            >
              ★
            </button>
          </h3>
          <p class="truncate text-xs text-stone-500">
            <span
              v-if="selectedEntry.inTrash"
              class="mr-1 rounded-full border border-stone-300 bg-stone-100 px-2 py-0.5 text-[11px] text-stone-500"
            >
              回收站
            </span>
            <template v-if="host">{{ host }} · </template>
            {{ relativeTime(selectedEntry.updatedAt) }}修改
            <span
              v-if="selectedEntry.expires && expiryText"
              class="ml-1 rounded-full px-2 py-0.5 text-[11px]"
              :class="
                expiryUrgent
                  ? 'bg-[#8b2332]/10 text-[#8b2332]'
                  : 'bg-[#d4a373]/20 text-[#5c4033]'
              "
            >
              {{ expiryText }}
            </span>
          </p>
        </div>
      </div>

      <!-- 字段 -->
      <div class="space-y-3">
        <div v-if="selectedEntry.username">
          <div class="mb-1 text-xs text-stone-500">用户名</div>
          <div class="flex items-center gap-2">
            <div
              class="min-w-0 flex-1 truncate rounded-full border border-stone-200 bg-[#faf6f1] px-4 py-2 text-sm text-stone-800"
            >
              {{ selectedEntry.username }}
            </div>
            <button
              class="shrink-0 rounded-full border border-stone-300 bg-white px-3 py-2 text-xs text-stone-700 transition-colors duration-300 hover:bg-stone-100"
              @click="copyUsername"
            >
              复制
            </button>
          </div>
        </div>

        <div>
          <div class="mb-1 text-xs text-stone-500">密码</div>
          <div class="flex items-center gap-2">
            <div
              class="min-w-0 flex-1 truncate rounded-full border border-stone-200 bg-[#faf6f1] px-4 py-2 text-sm text-stone-800"
              :class="
                revealed ? 'secret-reveal font-medium tracking-normal' : 'font-semibold tracking-wider'
              "
            >
              {{ revealed ? password || "（空）" : "••••••••••" }}
            </div>
            <button
              class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-stone-300 bg-white text-stone-500 transition-colors duration-300 hover:bg-stone-100 hover:text-stone-700"
              :title="revealed ? '隐藏密码' : '显示密码'"
              :aria-label="revealed ? '隐藏密码' : '显示密码'"
              @click="revealed = !revealed"
            >
              <svg
                v-if="revealed"
                width="16"
                height="16"
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
                width="16"
                height="16"
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
            <button
              class="shrink-0 rounded-full border border-stone-300 bg-white px-3 py-2 text-xs text-stone-700 transition-colors duration-300 hover:bg-stone-100"
              @click="copyPassword"
            >
              复制
            </button>
          </div>
        </div>

        <TotpDisplay v-if="totpConfig" :config="totpConfig" :entry-uuid="selectedEntry.uuid" />
        <div
          v-else-if="selectedEntry.hasTotp"
          class="rounded-[1rem] border border-[#8b2332]/30 bg-[#8b2332]/10 p-3 text-xs text-[#8b2332]"
        >
          TOTP 密钥无法解析，去「编辑此条目 → 高级」检查一下格式
        </div>

        <div v-if="url">
          <div class="mb-1 text-xs text-stone-500">网址</div>
          <div class="flex items-center gap-2">
            <div
              class="min-w-0 flex-1 truncate rounded-full border border-stone-200 bg-[#faf6f1] px-4 py-2 text-sm text-[#5c4033]"
            >
              {{ url }}
            </div>
            <button
              class="shrink-0 rounded-full border border-stone-300 bg-white px-3 py-2 text-xs text-stone-700 transition-colors duration-300 hover:bg-stone-100"
              @click="openUrl"
            >
              打开
            </button>
          </div>
        </div>

        <div v-if="selectedEntry.notes">
          <div class="mb-1 text-xs text-stone-500">备注</div>
          <div
            class="whitespace-pre-wrap rounded-[1rem] border border-stone-200 bg-[#faf6f1] px-4 py-2 text-sm text-stone-800"
          >
            {{ selectedEntry.notes }}
          </div>
        </div>

        <div v-if="selectedEntry.tags.length">
          <div class="mb-1 text-xs text-stone-500">标签</div>
          <div class="flex flex-wrap gap-2">
            <span
              v-for="tag in selectedEntry.tags"
              :key="tag"
              class="rounded-full border border-[#8b2332]/40 bg-[#8b2332]/10 px-2 py-1 text-xs text-[#8b2332]"
            >
              {{ tag }}
            </span>
          </div>
        </div>

        <div v-for="field in customFields" :key="field.name" class="rounded-[1rem] border border-stone-200 bg-[#faf6f1] p-3">
          <div class="mb-2 text-xs text-stone-500">{{ field.name }} <span v-if="field.protected">· 已保护</span></div>
          <div class="flex items-center gap-2"><span class="min-w-0 flex-1 whitespace-pre-wrap break-all text-sm text-stone-800">{{ field.protected && !revealedFields.includes(field.name) ? '••••••••' : field.value }}</span><button v-if="field.protected" class="text-xs text-[#5c4033]" @click="toggleField(field.name)">{{ revealedFields.includes(field.name) ? '隐藏' : '显示' }}</button><button class="rounded-full border border-stone-300 bg-white px-3 py-1 text-xs" @click="copyText(field.value)">复制</button></div>
        </div>

        <!-- 历史版本 -->
        <details class="rounded-[1rem] border border-stone-200 bg-white p-3">
          <summary class="cursor-pointer text-xs text-stone-500">历史版本（{{ history.length }}）</summary>
          <p class="mt-2 text-[11px] text-stone-400">最多保留 20 条。备注随密码库加密保存，与当前条目备注独立。删除仅影响当前库，不会擦除旧副本。</p>
          <div v-if="historyPending" class="mt-2 rounded-xl bg-amber-50 p-3 text-xs text-amber-900" role="status">
            历史改动已应用，但尚未写入磁盘。重试只保存，不会重复删除或恢复。
            <button class="mt-2 rounded-full border border-amber-300 px-3 py-1 disabled:opacity-50" :disabled="historyWorking || busy" @click="historyAction('retry')">{{ historyWorking ? '保存中…' : '重试保存' }}</button>
          </div>
          <p v-if="historyError" class="mt-2 text-xs text-[#8b2332]" role="alert">{{ historyError }}</p>
          <p v-if="!history.length" class="mt-3 text-xs text-stone-500">暂无历史版本</p>
          <ul class="mt-2 space-y-3">
            <li v-for="h in history" :key="h.id" class="border-t border-stone-100 pt-2">
              <p class="break-words text-xs text-stone-600">{{ historyDate(h.at) }} · {{ h.username || h.title }}</p>
              <p v-if="h.note && editingHistory !== h.id" class="mt-1 whitespace-pre-wrap break-words text-xs text-stone-500">{{ h.note }}</p>
              <fieldset v-if="editingHistory === h.id" class="mt-2 space-y-2" :disabled="historyWorking || busy || historyPending">
                <textarea v-model="historyDraft" aria-label="历史版本备注" rows="3" class="w-full rounded-xl border border-stone-200 p-2 text-xs" placeholder="给这个版本写备注（最多 200 字）" />
                <p class="text-[11px]" :class="historyNoteLength > 200 ? 'text-[#8b2332]' : 'text-stone-400'">{{ historyNoteLength }}/200</p>
                <div class="flex flex-wrap gap-2 text-xs">
                  <button class="rounded-full border px-3 py-1 disabled:opacity-50" :disabled="historyNoteLength > 200" @click="historyAction('note', h.id)">保存备注</button>
                  <button class="rounded-full border px-3 py-1" @click="historyDraft = ''">清空</button>
                  <button class="px-2 py-1" @click="editingHistory = ''; historyDraft = ''">取消</button>
                </div>
              </fieldset>
              <fieldset v-else class="mt-2 flex flex-wrap gap-2 text-[11px]" :disabled="historyWorking || busy || historyPending">
                <button class="rounded-full border border-stone-300 px-3 py-1" @click="editHistory(h.id, h.note)">编辑备注</button>
                <button class="rounded-full border border-stone-300 px-3 py-1" @click="historyAction('restore', h.id)">恢复</button>
                <button class="rounded-full border border-stone-300 px-3 py-1 text-[#8b2332]" @click="deletingHistory = h.id">删除</button>
              </fieldset>
              <div v-if="deletingHistory === h.id" class="mt-2 rounded-xl bg-red-50 p-2 text-xs text-[#8b2332]" role="alert">
                确认删除这个历史版本？无法撤销。
                <div class="mt-2 flex flex-wrap gap-2">
                  <button class="rounded-full border border-red-200 px-3 py-1 disabled:opacity-50" :disabled="historyWorking || busy || historyPending" @click="historyAction('delete', h.id)">确认删除</button>
                  <button class="px-2 py-1" :disabled="historyWorking" @click="deletingHistory = ''">取消</button>
                </div>
              </div>
            </li>
          </ul>
        </details>
      </div>

      <!-- 时间 -->
      <div class="mb-4 mt-4 border-t border-stone-200 pt-3 text-xs text-stone-400">
        创建：{{ dateText(selectedEntry.createdAt) }} · 修改：{{
          relativeTime(selectedEntry.updatedAt)
        }}
        <template v-if="selectedEntry.usageCount">
          · 使用：{{ selectedEntry.usageCount }} 次
        </template>
      </div>

      <!-- 操作：回收站里的条目只能恢复或彻底删除 -->
      <template v-if="selectedEntry.inTrash">
        <p class="mb-3 rounded-[1rem] bg-stone-100 px-3 py-2 text-xs text-stone-500">
          这条在回收站里，恢复后会回到删除前所在的分组。
        </p>
        <button
          class="w-full rounded-full bg-stone-800 px-6 py-3 font-medium text-stone-50 transition-colors duration-300 hover:bg-stone-700"
          @click="restoreEntry(selectedEntry.uuid)"
        >
          恢复此条目
        </button>
        <button
          class="mt-2 w-full rounded-full border px-6 py-2.5 text-sm transition-colors duration-300"
          :class="
            confirmPurge
              ? 'border-[#8b2332] bg-[#8b2332] text-white hover:bg-[#7a1d2b]'
              : 'border-stone-300 bg-white text-stone-600 hover:bg-stone-100'
          "
          @click="doPurge"
        >
          {{ confirmPurge ? "再点一次永久删除" : "彻底删除" }}
        </button>
      </template>
      <template v-else>
        <button
          class="w-full rounded-full bg-stone-800 px-6 py-3 font-medium text-stone-50 transition-colors duration-300 hover:bg-stone-700"
          @click="openEditDrawer(selectedEntry.uuid)"
        >
          编辑此条目
        </button>
        <button
          class="mt-2 w-full rounded-full border px-6 py-2.5 text-sm transition-colors duration-300"
          :class="
            confirmDelete
              ? 'border-[#8b2332] bg-[#8b2332] text-white hover:bg-[#7a1d2b]'
              : 'border-stone-300 bg-white text-stone-600 hover:bg-stone-100'
          "
          @click="doDelete"
        >
          {{ confirmDelete ? "再点一次确认删除" : "删除此条目" }}
        </button>
      </template>
    </div>

    <!-- 空态 -->
    <div
      v-else
      class="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
    >
      <EmptyState title="选一把钥匙，看看它的故事" description="从左边选择条目，或新建一条。" />
    </div>
  </aside>
</template>
