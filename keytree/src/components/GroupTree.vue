<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import {
  ContextMenuRoot, ContextMenuTrigger, ContextMenuPortal,
  ContextMenuContent, ContextMenuItem,
  AlertDialogRoot, AlertDialogPortal, AlertDialogOverlay,
  AlertDialogContent, AlertDialogTitle, AlertDialogDescription, AlertDialogCancel,
} from "radix-vue";
import { useVault } from "../composables/useVault";
import type { GroupVM } from "../composables/useVault";
import { toast } from "../lib/toast";

const {
  groups,
  selectedGroupUuid,
  selectGroup,
  addGroup,
  moveGroup,
  renameGroup,
  deleteGroup,
  trash,
  recycleBinEnabled,
  busy,
  error,
} = useVault();

// 根分组仍保留在密码库及编辑器数据中，侧栏只展示用户分组。
const visibleGroups = computed(() => groups.value.filter((group) => group.depth > 0));

function toggleGroup(uuid: string) {
  selectGroup(selectedGroupUuid.value === uuid ? "all" : uuid);
}

const adding = ref(false);
const draftName = ref("");
const addParentUuid = ref("");
const inputRef = ref<HTMLInputElement | null>(null);

const renamingUuid = ref("");
const renameDraft = ref("");

const pendingDelete = ref<GroupVM | null>(null);
const deleteToTrash = ref(true);
const deleting = ref(false);
const deleteError = ref("");
let deleteOriginUuid = "";

type DropPosition = "inside" | "before" | "after";
const draggingUuid = ref("");
const dropTarget = ref("");
const dropPosition = ref<DropPosition>("inside");
const moving = ref(false);
const dragType = "application/x-keytree-group";

function endDrag() {
  draggingUuid.value = "";
  dropTarget.value = "";
}

function startDrag(event: DragEvent, group: GroupVM) {
  if (group.depth === 0 || moving.value || adding.value || renamingUuid.value || !event.dataTransfer) {
    event.preventDefault();
    return;
  }
  draggingUuid.value = group.uuid;
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData(dragType, group.uuid);
}

function canDrop(targetUuid: string, position: DropPosition): boolean {
  if (!draggingUuid.value || moving.value || targetUuid === draggingUuid.value) return false;
  if (!targetUuid) return true;
  const sourceIndex = groups.value.findIndex((g) => g.uuid === draggingUuid.value);
  const targetIndex = groups.value.findIndex((g) => g.uuid === targetUuid);
  if (sourceIndex < 0 || targetIndex < 0) return false;
  const source = groups.value[sourceIndex]!;
  const target = groups.value[targetIndex]!;
  if (target.depth === 0 && position !== "inside") return false;
  // 展平的树按先序排列；祖先与其连续的后代不能形成循环。
  for (let index = sourceIndex + 1; index < groups.value.length; index++) {
    if (groups.value[index]!.depth <= source.depth) break;
    if (index === targetIndex) return false;
  }
  return true;
}

function positionAt(event: DragEvent, targetUuid: string): DropPosition {
  if (!targetUuid) return "inside";
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const ratio = (event.clientY - bounds.top) / bounds.height;
  return ratio < 0.25 ? "before" : ratio > 0.75 ? "after" : "inside";
}

function dragOver(event: DragEvent, targetUuid: string) {
  const position = positionAt(event, targetUuid);
  if (!canDrop(targetUuid, position)) {
    dropTarget.value = "";
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
    return;
  }
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  dropTarget.value = targetUuid || "all";
  dropPosition.value = position;
}

async function dropGroup(event: DragEvent, targetUuid: string) {
  const uuid = draggingUuid.value;
  const position = positionAt(event, targetUuid);
  const valid = canDrop(targetUuid, position) && event.dataTransfer?.getData(dragType) === uuid;
  event.preventDefault();
  endDrag();
  if (!valid) return;
  moving.value = true;
  try {
    if (await moveGroup(uuid, targetUuid, position)) toast("分组已移动");
  } finally {
    moving.value = false;
  }
}

async function startAdd(parentUuid = "") {
  addParentUuid.value = parentUuid;
  adding.value = true;
  await nextTick();
  inputRef.value?.focus();
}

async function confirmAdd() {
  const name = draftName.value.trim();
  adding.value = false;
  draftName.value = "";
  if (!name) return;
  await addGroup(name, addParentUuid.value);
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
function onContextMenuKey(event: KeyboardEvent) {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
  event.preventDefault();
  const trigger = event.currentTarget as HTMLElement;
  const bounds = trigger.getBoundingClientRect();
  trigger.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, button: 2,
    clientX: bounds.left + 16, clientY: bounds.top + bounds.height / 2,
  }));
}


function onMenuDelete(group: GroupVM) {
  if (group.depth === 0 || busy.value || moving.value || deleting.value) return;
  pendingDelete.value = { ...group };
  deleteOriginUuid = group.uuid;
  deleteToTrash.value = recycleBinEnabled.value;
  deleteError.value = "";
}

function cancelDelete() {
  if (deleting.value) return;
  pendingDelete.value = null;
  deleteError.value = "";
}

function onDeleteDialogOpenChange(open: boolean) {
  if (!open) cancelDelete();
}

function restoreDeleteFocus(event: Event) {
  event.preventDefault();
  const row = [...document.querySelectorAll<HTMLElement>("[data-group-uuid]")]
    .find((element) => element.dataset.groupUuid === deleteOriginUuid);
  const trigger = row?.querySelector<HTMLButtonElement>("button")
    ?? document.querySelector<HTMLButtonElement>("[data-group-root]");
  trigger?.focus();
}

function onMenuCloseAutoFocus(event: Event) {
  if (adding.value || renamingUuid.value || pendingDelete.value) event.preventDefault();
}

async function confirmDelete() {
  const group = pendingDelete.value;
  if (!group || deleting.value || busy.value || moving.value) return;
  // 确认期间设置可能变化，必须先展示最新的删除后果，不能静默变成永久删除。
  if (deleteToTrash.value !== recycleBinEnabled.value) {
    deleteToTrash.value = recycleBinEnabled.value;
    deleteError.value = "回收站设置已变化，请核对后再次确认。";
    return;
  }
  deleting.value = true;
  deleteError.value = "";
  try {
    const saved = await deleteGroup(group.uuid);
    if (saved) {
      pendingDelete.value = null;
      toast(deleteToTrash.value ? "分组已移到回收站" : "分组已删除");
    } else if (!groups.value.some((item) => item.uuid === group.uuid)) {
      // 已在内存中删除但落盘失败：由全局错误和未保存提示引导重试保存。
      pendingDelete.value = null;
    } else {
      deleteError.value = error.value || "删除失败，请稍后重试。";
    }
  } finally {
    deleting.value = false;
  }
}

</script>

<template>
  <aside class="flex min-h-0 min-w-0 flex-col">
    <div class="flex items-center justify-between px-4 pb-2 pt-4">
      <h3 class="font-serif text-xs font-semibold uppercase tracking-wide text-stone-500">
        <button
          data-group-root
          class="rounded-md px-1 py-0.5 text-left transition-colors hover:bg-stone-100 hover:text-stone-700"
          title="查看全部；拖到这里移回一级"
          aria-label="查看全部条目"
          :aria-pressed="selectedGroupUuid === 'all'"
          :style="dropTarget === 'all' ? { outline: '2px solid #8b9d77', background: '#edf2e8' } : {}"
          @click="selectGroup('all')"
          @dragover="dragOver($event, '')"
          @dragleave="dropTarget = ''"
          @drop="dropGroup($event, '')"
        >
          分组
        </button>
      </h3>
      <button
        class="flex h-6 w-6 items-center justify-center rounded-full border border-stone-200 text-sm leading-none text-stone-500 transition-colors duration-300 hover:bg-stone-100 hover:text-stone-700"
        title="新建一级分组"
        aria-label="新建一级分组"
        @click="startAdd()"
      >
        +
      </button>
    </div>

    <ul class="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-3 text-sm">
      <!-- 分组 -->
      <li v-for="g in visibleGroups" :key="g.uuid" :data-group-uuid="g.uuid">
        <div v-if="renamingUuid === g.uuid" class="px-2 py-1">
          <input
            v-model="renameDraft"
            class="rename-input w-full rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs text-stone-800 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
            @keyup.enter="confirmRename"
            @keyup.esc="renamingUuid = ''"
            @blur="confirmRename"
          />
        </div>
        <ContextMenuRoot v-else :modal="false">
          <ContextMenuTrigger as-child>
          <button
            class="flex w-full min-w-0 items-start justify-between gap-2 rounded-[1rem] py-2 pr-2 text-left transition-colors duration-300"
            :style="{
              paddingLeft: `${12 + Math.min(Math.max(g.depth - 1, 0), 4) * 10}px`,
              opacity: draggingUuid === g.uuid ? 0.45 : 1,
              ...(dropTarget === g.uuid ? dropPosition === 'inside'
                ? { outline: '2px solid #8b9d77', background: '#edf2e8' }
                : dropPosition === 'before' ? { boxShadow: 'inset 0 3px #8b9d77' } : { boxShadow: 'inset 0 -3px #8b9d77' } : {}),
            }"
            :title="g.name"
            @keydown="onContextMenuKey"
            :aria-pressed="selectedGroupUuid === g.uuid"
            :draggable="g.depth > 0 && !moving && !adding && !renamingUuid"
            @dragstart="startDrag($event, g)"
            @dragend="endDrag"
            @dragover="dragOver($event, g.uuid)"
            @dragleave="dropTarget = ''"
            @drop="dropGroup($event, g.uuid)"
            :class="
              selectedGroupUuid === g.uuid
                ? 'border border-stone-300 bg-[#faf6f1] font-medium'
                : 'border border-transparent hover:bg-stone-100'
            "
            @click="toggleGroup(g.uuid)"
          >
            <span class="flex min-w-0 flex-1 items-start gap-2">
              <span
                data-group-drag-handle
                class="flex h-5 w-3 shrink-0 items-center justify-center text-stone-400"
                :class="g.depth > 0 && !moving && !adding && !renamingUuid ? 'cursor-grab active:cursor-grabbing' : 'cursor-default'"
                :title="g.depth > 0 ? '拖动以移动分组' : '库根分组不可移动'"
                aria-hidden="true"
              >
                <svg width="12" height="16" viewBox="0 0 12 16" fill="currentColor">
                  <circle cx="3" cy="3" r="1.2" />
                  <circle cx="9" cy="3" r="1.2" />
                  <circle cx="3" cy="8" r="1.2" />
                  <circle cx="9" cy="8" r="1.2" />
                  <circle cx="3" cy="13" r="1.2" />
                  <circle cx="9" cy="13" r="1.2" />
                </svg>
              </span>
              <span class="min-w-0 whitespace-normal leading-5 [overflow-wrap:anywhere]">{{ g.name }}</span>
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
          </ContextMenuTrigger>
          <ContextMenuPortal>
            <ContextMenuContent
              class="z-50 min-w-40 rounded-xl border border-stone-200 bg-white p-1 text-sm text-stone-700 shadow-lg"
              :aria-label="`${g.name} 的分组操作`"
              :collision-padding="8"
              @close-auto-focus="onMenuCloseAutoFocus"
            >
              <ContextMenuItem
                class="cursor-default rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-stone-100 data-[disabled]:opacity-40"
                :disabled="busy || moving"
                @select="startAdd(g.uuid)"
              >
                新建子分组
              </ContextMenuItem>
              <ContextMenuItem
                class="cursor-default rounded-lg px-3 py-2 outline-none data-[highlighted]:bg-stone-100 data-[disabled]:opacity-40"
                :disabled="busy || moving"
                @select="startRename(g)"
              >
                重命名
              </ContextMenuItem>
              <ContextMenuItem
                class="cursor-default rounded-lg px-3 py-2 text-[#8b2332] outline-none data-[highlighted]:bg-[#8b2332]/10 data-[disabled]:opacity-40"
                :disabled="g.depth === 0 || busy || moving"
                @select="onMenuDelete(g)"
              >
                {{ recycleBinEnabled ? '移到回收站' : '删除分组' }}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenuPortal>
        </ContextMenuRoot>
      </li>

      <!-- 新建分组输入 -->
      <li v-if="adding" class="px-3 pt-1">
        <input
          ref="inputRef"
          v-model="draftName"
          class="w-full rounded-full border border-stone-300 bg-white px-3 py-1.5 text-xs text-stone-800 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-200"
          :placeholder="addParentUuid ? '子分组名，回车确认' : '一级分组名，回车确认'"
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
    <AlertDialogRoot :open="pendingDelete !== null" @update:open="onDeleteDialogOpenChange">
      <AlertDialogPortal>
        <AlertDialogOverlay class="fixed inset-0 z-[60] bg-stone-900/30" />
        <AlertDialogContent
          class="fixed left-1/2 top-1/2 z-[61] w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-stone-200 bg-white p-6 text-stone-800 shadow-xl"
          @close-auto-focus="restoreDeleteFocus"
          @escape-key-down="deleting && $event.preventDefault()"
        >
          <AlertDialogTitle class="font-serif text-lg font-semibold">
            {{ deleteToTrash ? '确认删除分组？' : '确认永久删除分组？' }}
          </AlertDialogTitle>
          <AlertDialogDescription class="mt-3 whitespace-normal text-sm leading-relaxed text-stone-600 [overflow-wrap:anywhere]">
            分组「{{ pendingDelete?.name }}」及其所有子分组和条目
            {{ deleteToTrash ? '将移到回收站，不会立即永久删除。' : '将被永久删除，此操作无法撤销。' }}
          </AlertDialogDescription>
          <p v-if="deleteError" role="alert" class="mt-3 text-sm text-[#8b2332]">{{ deleteError }}</p>
          <div class="mt-5 flex justify-end gap-2">
            <AlertDialogCancel as-child>
              <button class="rounded-full border border-stone-200 px-4 py-2 text-sm disabled:opacity-50" :disabled="deleting">取消</button>
            </AlertDialogCancel>
            <button
              data-group-delete-confirm
              class="rounded-full bg-[#8b2332] px-4 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="deleting || busy || moving"
              @click="confirmDelete"
            >
              {{ deleting ? '正在删除…' : deleteToTrash ? '确认移到回收站' : '永久删除' }}
            </button>
          </div>
        </AlertDialogContent>
      </AlertDialogPortal>
    </AlertDialogRoot>
  </aside>
</template>
