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
  initialOf,
  normalizeUrl,
  relativeTime,
  toneOf,
} from "../lib/format";
import TotpDisplay from "./TotpDisplay.vue";

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
  refreshIcon,
} = useVault();

const revealed = ref(false);
const confirmDelete = ref(false);
const confirmPurge = ref(false);

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

function copyPassword() {
  copyText(password.value);
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

async function onRestoreHistory(index: number) {
  const entry = selectedEntry.value;
  if (!entry) return;
  await restoreHistory(entry.uuid, index);
  toast("已恢复到该历史版本");
}
</script>

<template>
  <aside class="flex flex-col">
    <div v-if="selectedEntry" class="flex-1 overflow-y-auto p-4">
      <!-- 头部 -->
      <div class="mb-4 flex items-start gap-3">
        <!-- 外层只定位；圆形裁剪在内层，↻ 按钮放在裁剪容器外面才不会被裁掉 -->
        <span class="relative h-12 w-12 shrink-0">
          <span
            class="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full border border-stone-300 text-xl font-semibold text-stone-800"
            :class="
              selectedEntry.icon
                ? 'bg-white'
                : toneOf(selectedEntry.title) === 'sage'
                  ? 'bg-[#8b9d77]/30'
                  : 'bg-[#d4a373]/30'
            "
          >
            <img
              v-if="selectedEntry.icon"
              :src="selectedEntry.icon"
              alt=""
              class="h-8 w-8 object-contain"
            />
            <template v-else>{{ initialOf(selectedEntry.title) }}</template>
          </span>
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
              @click="copyText(selectedEntry.username, 0)"
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
                revealed ? 'font-medium tracking-normal' : 'font-semibold tracking-wider'
              "
            >
              {{ revealed ? password || "（空）" : "••••••••••" }}
            </div>
            <button
              class="shrink-0 rounded-full border border-stone-300 bg-white px-3 py-2 text-xs text-stone-700 transition-colors duration-300 hover:bg-stone-100"
              :title="revealed ? '隐藏' : '显示'"
              @click="revealed = !revealed"
            >
              {{ revealed ? "隐" : "眼" }}
            </button>
            <button
              class="shrink-0 rounded-full border border-stone-300 bg-white px-3 py-2 text-xs text-stone-700 transition-colors duration-300 hover:bg-stone-100"
              @click="copyPassword"
            >
              复制
            </button>
          </div>
        </div>

        <TotpDisplay v-if="totpConfig" :config="totpConfig" />
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

        <!-- 历史版本 -->
        <details
          v-if="history.length"
          class="rounded-[1rem] border border-stone-200 bg-white p-3"
        >
          <summary class="cursor-pointer text-xs text-stone-500">
            历史版本（{{ history.length }}）
          </summary>
          <ul class="mt-2 space-y-1">
            <li
              v-for="h in history"
              :key="h.index"
              class="flex items-center justify-between gap-2"
            >
              <span class="truncate text-xs text-stone-600">
                {{ dateText(h.at) }} · {{ h.username || h.title }}
              </span>
              <button
                class="shrink-0 rounded-full border border-stone-300 bg-white px-2 py-1 text-[11px] text-stone-700 transition-colors duration-300 hover:bg-stone-100"
                @click="onRestoreHistory(h.index)"
              >
                恢复
              </button>
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
      <svg width="56" height="56" viewBox="0 0 64 64" class="opacity-30">
        <path
          d="M32 10 C 18 10, 10 22, 10 34 C 10 46, 20 54, 32 54 C 44 54, 54 46, 54 34 C 54 22, 46 10, 32 10"
          fill="#8b9d77"
        />
        <path d="M32 20 L32 46" stroke="#5c4033" stroke-width="2" stroke-linecap="round" />
      </svg>
      <p class="text-sm text-stone-400">选一条看看，或新建一条</p>
    </div>
  </aside>
</template>
