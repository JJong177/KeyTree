<script setup lang="ts">
import { nextTick, ref } from "vue";
import { useVault } from "../composables/useVault";
import type { GroupVM } from "../composables/useVault";
import { toast } from "../lib/toast";

const {
  groups,
  entries,
  selectedGroupUuid,
  selectGroup,
  addGroup,
  renameGroup,
  deleteGroup,
  vaultPath,
  trash,
  recycleBinEnabled,
} = useVault();

const adding = ref(false);
const draftName = ref("");
const inputRef = ref<HTMLInputElement | null>(null);

const renamingUuid = ref("");
const renameDraft = ref("");

/** 回收站关闭时，删除分组是永久的，要求二次确认 */
const pendingDelete = ref("");
let pendingTimer: number | undefined;

async function startAdd() {
  adding.value = true;
  await nextTick();
  inputRef.value?.focus();
}

async function confirmAdd() {
  const name = draftName.value.trim();
  adding.value = false;
  draftName.value = "";
  if (!name) return;
  const parent =
    selectedGroupUuid.value !== "all" && selectedGroupUuid.value !== trash.value?.uuid
      ? selectedGroupUuid.value
      : "";
  await addGroup(name, parent);
}

async function startRename(g: GroupVM) {
  renamingUuid.value = g.uuid;
  renameDraft.value = g.name;
  await nextTick();
  // 重命名输入框在 v-for 里，用 ref 拿到的是数组，直接按 class 找更稳
  const el = document.querySelector<HTMLInputElement>(".rename-input");
  el?.focus();
  el?.select();
}

async function confirmRename() {
  const uuid = renamingUuid.value;
  if (!uuid) return;
  renamingUuid.value = "";
  await renameGroup(uuid, renameDraft.value);
}

function onDelete(g: GroupVM) {
  if (recycleBinEnabled.value) {
    void deleteGroup(g.uuid);
    toast("分组已移到回收站");
    return;
  }
  if (pendingDelete.value === g.uuid) {
    pendingDelete.value = "";
    void deleteGroup(g.uuid);
    return;
  }
  pendingDelete.value = g.uuid;
  toast("回收站未启用，再点一次将永久删除", 3000);
  if (pendingTimer) window.clearTimeout(pendingTimer);
  pendingTimer = window.setTimeout(() => (pendingDelete.value = ""), 4000);
}

const vaultName = () => {
  const file = vaultPath.value.split(/[\\/]/).pop() ?? "我的密码库";
  return file.replace(/\.kdbx$/i, "");
};
</script>

<template>
  <aside class="flex min-h-0 flex-col">
    <div class="flex items-center justify-between px-4 pb-2 pt-4">
      <h3 class="font-serif text-xs font-semibold uppercase tracking-wide text-stone-500">
        分组
      </h3>
      <button
        class="flex h-6 w-6 items-center justify-center rounded-full border border-stone-200 text-sm leading-none text-stone-500 transition-colors duration-300 hover:bg-stone-100 hover:text-stone-700"
        title="新建分组"
        @click="startAdd"
      >
        +
      </button>
    </div>

    <ul class="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3 text-sm">
      <!-- 全部条目（库本身） -->
      <li>
        <button
          class="flex w-full items-center justify-between gap-2 rounded-[1rem] px-3 py-2 text-left transition-colors duration-300"
          :class="
            selectedGroupUuid === 'all'
              ? 'border border-stone-300 bg-[#faf6f1] font-medium'
              : 'border border-transparent hover:bg-stone-100'
          "
          @click="selectGroup('all')"
        >
          <span class="flex min-w-0 items-center gap-2">
            <svg width="14" height="14" viewBox="0 0 14 14" class="shrink-0">
              <path
                d="M7 1.5 C 4 1.5, 2 3.8, 2 7 C 2 10, 4.5 12.5, 7 12.5 C 9.5 12.5, 12 10, 12 7 C 12 3.8, 10 1.5, 7 1.5"
                fill="#8b9d77"
                opacity="0.35"
              />
              <path d="M7 3.5 L7 11" stroke="#5c4033" stroke-width="1.2" stroke-linecap="round" />
            </svg>
            <span class="truncate">{{ vaultName() }}</span>
          </span>
          <span
            class="shrink-0 rounded-full px-2 py-0.5 text-xs"
            :class="
              selectedGroupUuid === 'all'
                ? 'bg-stone-800 text-stone-50'
                : 'text-stone-400'
            "
          >
            {{ entries.filter((e) => !e.inTrash).length }}
          </span>
        </button>
      </li>

      <!-- 分组 -->
      <li v-for="g in groups" :key="g.uuid">
        <div v-if="renamingUuid === g.uuid" class="px-2 py-1">
          <input
            v-model="renameDraft"
            class="rename-input w-full rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs text-stone-800 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
            @keyup.enter="confirmRename"
            @keyup.esc="renamingUuid = ''"
            @blur="confirmRename"
          />
        </div>
        <div v-else class="group flex items-center gap-1">
          <button
            class="flex min-w-0 flex-1 items-center justify-between gap-2 rounded-[1rem] py-2 pr-2 text-left transition-colors duration-300"
            :style="{ paddingLeft: `${12 + (g.depth + 1) * 12}px` }"
            :class="
              selectedGroupUuid === g.uuid
                ? 'border border-stone-300 bg-[#faf6f1] font-medium'
                : 'border border-transparent hover:bg-stone-100'
            "
            @click="selectGroup(g.uuid)"
          >
            <span class="flex min-w-0 items-center gap-2">
              <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-[#d4a373]" />
              <span class="truncate">{{ g.name }}</span>
            </span>
            <span
              class="shrink-0 rounded-full px-2 py-0.5 text-xs"
              :class="
                selectedGroupUuid === g.uuid
                  ? 'bg-stone-800 text-stone-50'
                  : 'text-stone-400'
              "
            >
              {{ g.count }}
            </span>
          </button>
          <div
            class="flex shrink-0 gap-0.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100"
          >
            <button
              class="flex h-6 w-6 items-center justify-center rounded-full text-stone-400 hover:bg-white hover:text-stone-700"
              title="重命名"
              @click.stop="startRename(g)"
            >
              <svg width="12" height="12" viewBox="0 0 16 16">
                <path
                  d="M2 14 L3 10 L11 2 L14 5 L6 13 Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <button
              class="flex h-6 w-6 items-center justify-center rounded-full text-stone-400 hover:bg-white"
              :class="pendingDelete === g.uuid ? 'text-[#8b2332]' : 'hover:text-[#8b2332]'"
              :title="pendingDelete === g.uuid ? '再点一次永久删除' : '删除分组'"
              @click.stop="onDelete(g)"
            >
              <svg width="12" height="12" viewBox="0 0 16 16">
                <path
                  d="M3 5 L13 5 M6 5 L6 3 L10 3 L10 5 M5 5 L5.8 13 L10.2 13 L11 5"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </li>

      <!-- 新建分组输入 -->
      <li v-if="adding" class="px-3 pt-1">
        <input
          ref="inputRef"
          v-model="draftName"
          class="w-full rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs text-stone-800 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
          placeholder="分组名，回车确认"
          @keyup.enter="confirmAdd"
          @keyup.esc="adding = false; draftName = ''"
          @blur="confirmAdd"
        />
      </li>
    </ul>

    <!-- 回收站：固定在底部 -->
    <div v-if="trash" class="shrink-0 border-t border-stone-200 px-3 py-2">
      <button
        class="flex w-full items-center justify-between gap-2 rounded-[1rem] px-3 py-2 text-left text-sm transition-colors duration-300"
        :class="
          selectedGroupUuid === trash.uuid
            ? 'border border-stone-300 bg-[#faf6f1] font-medium'
            : 'border border-transparent text-stone-500 hover:bg-stone-100'
        "
        @click="selectGroup(trash.uuid)"
      >
        <span class="flex items-center gap-2">
          <svg width="13" height="13" viewBox="0 0 16 16">
            <path
              d="M3 5 L13 5 M6 5 L6 3 L10 3 L10 5 M5 5 L5.8 13 L10.2 13 L11 5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          回收站
        </span>
        <span
          class="shrink-0 rounded-full px-2 py-0.5 text-xs"
          :class="
            selectedGroupUuid === trash.uuid
              ? 'bg-stone-800 text-stone-50'
              : 'text-stone-400'
          "
        >
          {{ trash.count }}
        </span>
      </button>
    </div>
  </aside>
</template>
