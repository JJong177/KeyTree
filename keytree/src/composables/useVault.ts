import { computed, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { Kdbx, KdbxEntry, KdbxGroup } from "kdbxweb";
import { getKdbxweb, type Kdbxweb } from "../kdbx/kdbxweb";
import { installArgon2 } from "../kdbx/argon2";
import { applyEncryptionProfile, encryptionInfo, encryptionTarget, benchmarkEncryption, type EncryptionProfile } from "../kdbx/security";
import {
  parseLegacyTotp,
  type TotpConfig,
} from "../lib/totp";
import { dateInputValue, hostOf } from "../lib/format";
import { DEFAULT_AUTO_TYPE, parseSequence } from "../lib/autotype";
import { cacheQuickUnlock, clearQuickUnlockCache, credentialCachingAllowed } from "../lib/quick-unlock";
import { settings, upsertVault, getSyncOnLock } from "../lib/settings";
import { fetchFavicon, bytesToDataUrl } from "../lib/favicon";
import { buildChromeCsv } from "../lib/csv";
import { toast } from "../lib/toast";
import { searchEntries } from "../lib/search";
import { applyCustomFields, isReservedField, validateCustomFields, validateSequence, type CustomFieldDraft } from "../lib/entry-fields";
import { parseTotpInput, normalizeTotpInput } from "../lib/totp";
import { analyzeImport, classifyImportRecords, type ImportRow, type ImportRecord } from "../lib/import-plan";
import { healthSummary, kdfDetails } from "../lib/vault-health";
import { recordAudit } from "../lib/audit";
import { readMasterHint, writeMasterHint, publicDataSnapshot, type MasterHintResult } from "../lib/master-password-hint";

import { webdavErrorCode, webdavErrorMessage, webdavIsConflict, type WebdavState, type WebdavPrepared, type WebdavCommitted, type WebdavConfig } from "../lib/webdav";

import { summarizeSnapshot, snapshotErrorMessage, type SnapshotPreview, type SnapshotInfo, type SnapshotList } from "../lib/snapshots";
import { ciphertextFingerprint, syncLockedVault } from "../lib/lock-sync";

import { historyToken, resolveHistory, historyNote, writeHistoryNote, copySnapshotMetadata, mergeWithHistoryNotes } from "../lib/history";

export interface GroupVM {
  uuid: string;
  name: string;
  depth: number;
  /** 含子组的条目总数 */
  count: number;
}

export interface EntryVM {
  uuid: string;
  groupUuid: string;
  /** 祖先分组 uuid（含自身分组），用于按分组过滤 */
  ancestors: string[];
  title: string;
  username: string;
  url: string;
  notes: string;
  tags: string[];
  hasTotp: boolean;
  /** 是否在回收站里 */
  inTrash: boolean;
  expires: boolean;
  expiryTime: Date | null;
  updatedAt: Date | null;
  createdAt: Date | null;
  usageCount: number;
  lastUsedAt: Date | null;
  totpPeriod: number | null;
  /** 自定义图标（favicon）的 data URL；null = 没有图标，调用方降级为字母头像 */
  icon: string | null;
  /** 收藏（存 KDBX CustomData，KeePassXC 打开时忽略） */
  favorite: boolean;
}

export interface EntryDraft {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  /** 逗号分隔，提交时拆分 */
  tags: string;
  totp: string;
  groupUuid: string;
  expires: boolean;
  /** yyyy-MM-dd（date input 的值） */
  expiryDate: string;
  customFields?: CustomFieldDraft[];
  removedFields?: string[];
  autoTypeSequence?: string;
}

export interface HistoryItem {
  id: string;
  note: string;
  index: number;
  title: string;
  username: string;
  at: Date | null;
}

export type SortMode = "recent" | "title" | "used";

const db = shallowRef<Kdbx | null>(null);
const engine = shallowRef<Kdbxweb | null>(null);
const vaultPath = ref("");
const groups = ref<GroupVM[]>([]);
const entries = ref<EntryVM[]>([]);
const busy = ref(false);
/** 解锁失败的分类：UI 据此决定给不给「从备份恢复」入口，比匹配文案可靠 */
export type UnlockErrorKind =
  | "none"
  /** 主密码或密钥文件不正确 */
  | "bad-key"
  /** 文件损坏 / 被截断 */
  | "corrupt"
  /** 根本不是 KDBX */
  | "not-kdbx"
  /** KeePass 1.x 的老 .kdb 格式 */
  | "old-kdb"
  /** KDBX 版本或算法超出引擎支持 */
  | "unsupported"
  /** 读不到文件（不存在 / 被占用 / 无权限） */
  | "io"
  | "unknown";

const error = ref("");
const errorKind = ref<UnlockErrorKind>("none");
const status = ref("");
const query = ref("");
const sortMode = ref<SortMode>("recent");
const favoritesOnly = ref(false);
const selectedGroupUuid = ref("all");
const selectedUuid = ref("");
const drawer = ref<{ open: boolean; mode: "create" | "edit"; uuid: string }>({
  open: false,
  mode: "create",
  uuid: "",
});
/** 新建抽屉默认落在哪个分组 */
const pendingGroup = ref("");
/** Invalidates in-flight clipboard previews before asynchronous lock/save work starts. */
const clipboardCaptureEpoch = ref(0);
const clipboardLockRequests = ref(0);
const clipboardCaptureBlocked = computed(() => clipboardLockRequests.value > 0);
/** 回收站分组（KeePass 的 Meta.RecycleBinUuid 指向它） */
const trash = ref<{ uuid: string; count: number } | null>(null);

const entryRefs = new Map<string, KdbxEntry>();
const groupRefs = new Map<string, KdbxGroup>();

/** customIcon uuid → data URL（rebuild 频繁，避免重复转 base64） */
const iconUrls = new Map<string, string>();
/** host → customIcon uuid：同站点条目复用同一个图标，不重复抓 */
const hostIcons = new Map<string, string>();

// ==================== 外部变更同步（spec §8 文件哲学） ====================

interface VaultStat {
  mtimeMs: number;
  size: number;
  mtimeNs?: string;
}

/** 磁盘上库文件的最新 stat：等于它就是「自己写的」，不同就是「外部改的」 */
const knownStat = ref<VaultStat | null>(null);
/** 防重入：watcher 事件和保存前置检查可能同时触发合并 */
let syncing = false;

async function statOf(path: string): Promise<VaultStat | null> {
  try {
    return await invoke<VaultStat>("stat_vault", { path });
  } catch {
    return null;
  }
}

function sameStat(a: VaultStat | null, b: VaultStat | null): boolean {
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size && a.mtimeNs === b.mtimeNs;
}

/** mergeFromDisk 的结果：merged 正常、skipped 磁盘上没东西可合、failed 合不了 */
type MergeOutcome = "merged" | "skipped" | "failed" | "public-conflict";

/** 同一个磁盘版本只留一份冲突副本，避免每次保存失败都复制一遍 */
let conflictSavedFor = "";
/** 打开/成功保存时的公开元数据；条目级 merge 不负责此头部字段。 */
let knownPublicData = "";

/**
 * 用当前凭据（Credentials 实例只含 hash，无需明文密码）load 磁盘最新版，
 * 三方合并进内存库并刷新视图。不落盘——落盘由调用方决定。
 * 外部版本解不开（比如被改过密码）时留存 .conflict 副本并返回 failed。
 */
async function mergeFromDisk(): Promise<MergeOutcome> {
  const k = engine.value;
  const current = db.value;
  const path = vaultPath.value;
  if (!k || !current || !path) return "skipped";
  // 另一个合并正在进行：让调用方按失败处理（宁可中止一次保存，也不覆盖别人的版本）
  if (syncing) return "failed";
  const diskStat = await statOf(path);
  // 磁盘上根本没有可读的库（被删/被锁）：没有会被覆盖的内容，允许继续写
  if (!diskStat) return "skipped";
  syncing = true;
  try {
    const bytes = await invoke<number[]>("read_vault", { path });
    const remote = await k.Kdbx.load(
      new Uint8Array(bytes).buffer,
      current.credentials
    );
    if (db.value !== current || vaultPath.value !== path) return "skipped";
    if (!sameStat(diskStat, await statOf(path))) {
      error.value = "读取外部版本期间文件再次变化，无法合并，保存已中止，请重试";
      return "failed";
    }
    if (publicDataSnapshot(k, remote.header) !== knownPublicData) {
      error.value = "磁盘上的公开提示或其他公开元数据已被修改，无法自动合并。本次保存已中止，磁盘原件未改，请先另存当前修改，再重新打开磁盘版本";
      return "public-conflict";
    }
    mergeWithHistoryNotes(current, remote);
    knownStat.value = diskStat;
    rebuild();
    void recordAudit("merge");
    return "merged";
  } catch (e) {
    // 合不了也绝不丢掉磁盘那份：先原样留成冲突副本，用户还能手动打开捞回来
    let savedName = "";
    const key = `${path}|${diskStat.mtimeMs}|${diskStat.size}`;
    if (conflictSavedFor !== key) {
      conflictSavedFor = key;
      try {
        const savedPath = await invoke<string>("save_conflict_copy", { path });
        savedName = savedPath.split(/[\\/]/).pop() ?? savedPath;
      } catch {
        // 复制失败不能掩盖原始错误
      }
    } else {
      savedName = "（已留存过副本）";
    }
    const hint = savedName ? `，磁盘版本已另存为 ${savedName}` : "";
    const classified = classifyUnlockError(e, false);
    error.value = `外部修改无法自动合并（${
      classified.kind === "bad-key"
        ? "磁盘上的库已不是用当前凭据加密，可能被别人改过主密码"
        : classified.text
    }）${hint}，本次保存已中止`;
    return "failed";
  } finally {
    syncing = false;
  }
}

/**
 * 磁盘上的库是否真的被外部改过。
 * 关键：我们自己写盘也会触发 watcher，必须用 knownStat 把「自写事件」认出来，
 * 否则就是 保存 → 事件 → merge → 保存 的死循环（实测每 3 秒重写一次库，
 * 表现为「修改主密码」按钮跟着 busy 反复闪）。
 */
async function diskChangedSinceKnown(): Promise<boolean> {
  const path = vaultPath.value;
  if (!path) return false;
  const stat = await statOf(path);
  if (stat && sameStat(stat, knownStat.value)) return false;
  return true;
}

/**
 * watcher 事件触发的同步：合并外部修改并落盘。
 * 落盘会产生新的 watcher 事件，但 writeBytes 已把 knownStat 更新成本次写出的 stat，
 * 下一次事件在 diskChangedSinceKnown 这一关就被认出来并忽略。
 */
async function syncExternalChanges(): Promise<void> {
  if (!unlocked.value || busy.value || syncing || saveBusy) return;
  if (!(await diskChangedSinceKnown())) return;
  const outcome = await mergeFromDisk();
  if (outcome === "merged") {
    error.value = "";
    if (!(await saveVault())) return;
    status.value = `已合并磁盘上的外部修改 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
  } else if (outcome === "public-conflict") {
    status.value = "公开元数据冲突，保存已中止，磁盘原件未改";
  } else if (outcome === "failed") {
    status.value = "磁盘上的版本无法合并，保存已中止（见上方提示）";
  }
}

/** 当前库使用的密钥文件内容（第二因子）；null 表示只用主密码 */
const keyFileBytes = shallowRef<Uint8Array | null>(null);
const hasKeyFile = computed(() => !!keyFileBytes.value);

const unlocked = computed(() => db.value !== null);
const recycleBinEnabled = computed(
  () => !!db.value?.meta.recycleBinEnabled && !!trash.value
);
/** 当前选中的是不是回收站 */
const selectedIsTrash = computed(
  () => !!trash.value && selectedGroupUuid.value === trash.value.uuid
);

/** 页脚展示的真实库信息（不要写死，库可能是 AES-KDF 或 Argon2d） */
const encryptionRevision = ref(0);
const vaultEncryption = computed(() => {
  void encryptionRevision.value;
  return db.value && engine.value ? encryptionInfo(engine.value, db.value.header) : null;
});
const vaultInfo = computed(() => {
  void encryptionRevision.value;
  const current = db.value;
  if (!current) return { kdf: "", version: "" };
  const params = current.header.kdfParameters as unknown as
    | Map<string, unknown>
    | undefined;
  const uuid = params?.get?.("$UUID");
  let hex = "";
  if (uuid instanceof ArrayBuffer) {
    hex = Array.from(new Uint8Array(uuid))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  const kdfNames: Record<string, string> = {
    // KeePass 的 KDF UUID，用十六进制比对（避免大小写/字节序问题）
    "9e298b1956db4773b23dfc3ec6f0a1e6": "Argon2id",
    ef636ddf8c29444b91f7a9a403e30a0c: "Argon2d",
    c9d9f39a628a4460bf740d08c18a4fea: "AES-KDF",
  };
  return {
    kdf: kdfNames[hex] ?? "KDF",
    version: `KDBX ${current.versionMajor}.${current.versionMinor}`,
  };
});

const selectedGroup = computed<GroupVM | null>(
  () => groups.value.find((g) => g.uuid === selectedGroupUuid.value) ?? null
);

const visibleEntries = computed<EntryVM[]>(() => {
  const binUuid = trash.value?.uuid ?? "";
  let list: EntryVM[];
  if (selectedGroupUuid.value === "all") {
    // 全部条目 = 不含回收站里的
    list = entries.value.filter((e) => !e.inTrash);
  } else if (binUuid && selectedGroupUuid.value === binUuid) {
    list = entries.value.filter((e) => e.inTrash);
  } else {
    list = entries.value.filter(
      (e) => !e.inTrash && e.ancestors.includes(selectedGroupUuid.value)
    );
  }
  if (favoritesOnly.value && !selectedIsTrash.value) list = list.filter(e => e.favorite);
  return searchEntries(list, query.value, sortMode.value);
});

const selectedEntry = computed<EntryVM | null>(
  () => visibleEntries.value.find((e) => e.uuid === selectedUuid.value) ?? null
);

watch(visibleEntries, (list) => {
  if (!list.some((e) => e.uuid === selectedUuid.value)) {
    selectedUuid.value = list[0]?.uuid ?? "";
  }
});

function msg(e: unknown): string {
  const err = e as Error;
  return err?.message ? err.message : String(e);
}

/** 引擎 + Argon2 只装一次；失败会抛给调用方统一提示 */
async function ensureEngine(): Promise<Kdbxweb> {
  if (engine.value) return engine.value;
  const k = await getKdbxweb();
  await installArgon2(k);
  engine.value = k;
  return k;
}

function fieldText(entry: KdbxEntry, key: string): string {
  const value = entry.fields.get(key);
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : value.getText();
}

function iconUrlOf(iconId: string): string | null {
  const cached = iconUrls.get(iconId);
  if (cached) return cached;
  const data = db.value?.meta.customIcons.get(iconId)?.data;
  if (!data) return null;
  const url = bytesToDataUrl(data);
  iconUrls.set(iconId, url);
  return url;
}

function toVM(
  entry: KdbxEntry,
  group: KdbxGroup,
  ancestors: string[],
  inTrash: boolean
): EntryVM {
  return {
    uuid: entry.uuid.id,
    groupUuid: group.uuid.id,
    ancestors,
    title: fieldText(entry, "Title") || "(无标题)",
    username: fieldText(entry, "UserName"),
    url: fieldText(entry, "URL"),
    notes: fieldText(entry, "Notes"),
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
    hasTotp:
      !!fieldText(entry, "otp") ||
      !!fieldText(entry, "TOTP Seed"),
    inTrash,
    expires: !!entry.times.expires,
    expiryTime: entry.times.expiryTime ?? null,
    updatedAt: entry.times.lastModTime ?? null,
    createdAt: entry.times.creationTime ?? null,
    usageCount: entry.times.usageCount ?? 0,
    lastUsedAt: (entry.times.usageCount ?? 0) > 0 ? entry.times.lastAccessTime ?? null : null,
    totpPeriod: totpConfigOf(entry.uuid.id)?.period ?? null,
    icon: entry.customIcon ? iconUrlOf(entry.customIcon.id) : null,
    favorite: !!entry.customData?.get("keytree.favorite"),
  };
}

/** 从 kdbx 对象重建视图模型（任何结构变化后都要调一次） */
function rebuild(): void {
  groups.value = [];
  entries.value = [];
  entryRefs.clear();
  groupRefs.clear();
  trash.value = null;

  const current = db.value;
  if (!current) return;

  const binId = current.meta.recycleBinUuid?.id ?? "";
  const walk = (
    group: KdbxGroup,
    depth: number,
    ancestors: string[],
    inTrash: boolean
  ): { normal: number; trashed: number } => {
    const uuid = group.uuid.id;
    const chain = [...ancestors, uuid];
    groupRefs.set(uuid, group);

    const isBin = !!binId && uuid === binId;
    const nowInTrash = inTrash || isBin;

    // 回收站本身、以及回收站里的分组（含被删分组的子分组）都不进分组树，
    // 否则删掉的分组会继续留在左侧列表里
    let vm: GroupVM | null = null;
    if (!nowInTrash) {
      vm = {
        uuid,
        name: group.name || "(未命名分组)",
        depth,
        count: 0,
      };
      groups.value.push(vm);
    }

    let normal = 0;
    let trashed = 0;
    for (const child of group.groups) {
      const sub = walk(child, nowInTrash ? depth : depth + 1, chain, nowInTrash);
      normal += sub.normal;
      trashed += sub.trashed;
    }
    for (const entry of group.entries) {
      entryRefs.set(entry.uuid.id, entry);
      entries.value.push(toVM(entry, group, chain, nowInTrash));
      if (nowInTrash) trashed++;
      else normal++;
    }
    if (vm) vm.count = normal;
    return { normal, trashed };
  };

  let trashedTotal = 0;
  for (const group of current.groups) {
    trashedTotal += walk(group, 0, [], false).trashed;
  }
  if (binId && groupRefs.has(binId)) {
    trash.value = { uuid: binId, count: trashedTotal };
  }

  // 回填 host → 图标映射：重启后已带图标的站点不再重复抓
  for (const entry of entryRefs.values()) {
    if (!entry.customIcon) continue;
    const host = hostOf(fieldText(entry, "URL"));
    if (host && !hostIcons.has(host)) hostIcons.set(host, entry.customIcon.id);
  }
}

async function writeBytes(path: string, buffer: ArrayBuffer, expectedStat: VaultStat | null = null): Promise<void> {
  const fingerprint = getSyncOnLock(path) ? await ciphertextFingerprint(buffer).catch(() => null) : null;
  const written = await invoke<VaultStat | null>("write_vault", {
    path,
    bytes: Array.from(new Uint8Array(buffer)),
    expectedStat,
  });
  // 更新已知 stat：这样 watcher 收到自己写入的事件时能认出来并忽略
  if (path === vaultPath.value) {
    knownStat.value = written ?? await statOf(path);
    savedCiphertextFingerprint = fingerprint;
  }
}

// ==================== 保存管线（合并写 + 串行化） ====================

/** 高频动作（复制导致的 usageCount 递增、后台抓图标）合并到一次写盘 */
const SAVE_DEBOUNCE_MS = 500;

let saveTimer: number | undefined;
/** kdbxweb 的 save() 不能并发跑在同一个 db 上：所有写盘排成一条链 */
let saveChain: Promise<boolean> = Promise.resolve(false);
/** 写盘进行中：此时 watcher 触发的 merge 必须让路（merge 会改正在被序列化的树） */
let saveBusy = false;
/** 请求保存的修订与已确认落盘的修订分开记录；定时器消失不代表已经保存。 */
const changeRevision = ref(0);
const persistedRevision = ref(0);
const hasUnsavedChanges = computed(() => changeRevision.value !== persistedRevision.value);
let saveError = "";

function resetSaveState(): void {
  changeRevision.value = 0;
  persistedRevision.value = 0;
  saveError = "";
}

function cancelScheduledSave(): void {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer);
    saveTimer = undefined;
  }
}

/**
 * 未引用图标清理：重抓 favicon 每次都会新增一枚图标，旧的不清就永远留在库里膨胀。
 * kdbxweb 的 cleanup 会顺手写 deletedObjects（多端合并时不会把图标"复活"）。
 */
function pruneUnusedIcons(current: Kdbx): void {
  current.cleanup({ customIcons: true });
  const alive = current.meta.customIcons;
  // 缓存里可能留着刚被清掉的 id：不清掉的话下次会复用悬空图标
  for (const [host, id] of [...hostIcons]) {
    if (!alive.has(id)) hostIcons.delete(host);
  }
  for (const id of [...iconUrls.keys()]) {
    if (!alive.has(id)) iconUrls.delete(id);
  }
}

async function persist(announce: boolean): Promise<boolean> {
  const current = db.value;
  const path = vaultPath.value;
  if (!current || !path) return false;
  saveBusy = true;
  try {
    // 保存前检测（spec §8.2 双保险）：watcher 漏掉的外部变更在这里兜住。
    // 合不了必须中止——否则这一次落盘会把磁盘上的外部版本直接盖掉。
    if (knownStat.value && (await diskChangedSinceKnown())) {
      const outcome = await mergeFromDisk();
      if (outcome === "failed" || outcome === "public-conflict") {
        throw new Error("检测到外部修改但无法合并，已中止保存（磁盘版本另有副本留存）");
      }
      if (outcome === "merged") {
        status.value = "检测到外部修改，已合并后再保存";
      }
    }
    // 序列化期间仍可能有使用计数等新改动：只能确认本次开始前的修订。
    const revision = changeRevision.value;
    const previousSaveError = saveError;
    const previousStatus = status.value;
    const expectedStat = knownStat.value;
    const savedPublicData = engine.value ? publicDataSnapshot(engine.value, current.header) : knownPublicData;
    pruneUnusedIcons(current);
    const saved = await current.save();
    await writeBytes(path, saved, expectedStat);
    if (db.value === current && vaultPath.value === path) {
      persistedRevision.value = revision;
      knownPublicData = savedPublicData;
      if (error.value === previousSaveError) error.value = "";
      saveError = "";
    }
    if (announce || (previousSaveError && status.value === previousStatus)) {
      status.value = `已保存 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
    }
    return true;
  } catch (e) {
    // 合并失败时 mergeFromDisk 已经写了更具体的提示（含冲突副本文件名），
    // 别用泛化的「保存失败」把它盖掉
    if (!/无法合并/.test(msg(e))) {
      error.value = `保存失败：${msg(e)}`;
    }
    saveError = error.value;
    status.value = "有未保存的修改，请重试保存或另存 KDBX 副本";
    return false;
  } finally {
    saveBusy = false;
  }
}

function enqueueSave(announce: boolean): Promise<boolean> {
  // 前一次写盘无论成败都不阻塞下一次；任务本身不会 reject（persist 内部兜底）
  const task = saveChain.catch(() => false).then(() => persist(announce));
  saveChain = task;
  return task;
}

/** 立即写盘（按钮、改密、导入导出等关键路径） */
async function saveVault(): Promise<boolean> {
  cancelScheduledSave();
  if (!db.value || !vaultPath.value) return false;
  changeRevision.value++;
  busy.value = true;
  try {
    return await enqueueSave(true);
  } finally {
    busy.value = false;
  }
}

/**
 * 合并写：500ms 内的多次调用只落一次盘。
 * 用于「用户没在改数据结构」的高频动作，避免复制一次密码就写一遍整个库。
 */
function saveSoon(): void {
  if (!db.value || !vaultPath.value) return;
  changeRevision.value++;
  cancelScheduledSave();
  saveTimer = window.setTimeout(() => {
    saveTimer = undefined;
    void enqueueSave(false);
  }, SAVE_DEBOUNCE_MS);
}

/** 等待已排队写入，并重试尚未落盘的改动（包括已结束的失败任务）。 */
async function flushSave(): Promise<boolean> {
  cancelScheduledSave();
  // 不只看 timer：它可能已经触发，写入仍在执行或刚刚失败。
  await saveChain;
  cancelScheduledSave();
  if (!hasUnsavedChanges.value) return true;
  if (!db.value || !vaultPath.value) return false;
  const saved = await enqueueSave(false);
  // 本轮序列化期间若又有改动，不得向锁定调用方假报“全部已保存”。
  return saved && !hasUnsavedChanges.value;
}

const webdavState = ref<WebdavState>({ phase: "unchecked", message: "尚未检查远端；本地保存不代表已同步。", lastSyncedAt: null });
let webdavGeneration = 0;
let webdavInFlight = 0;
let webdavUploadedRevision = -1;
let savedCiphertextFingerprint: string | null = null;
let lockSyncBaselineFingerprint: string | null = null;
function resetWebdavSyncStatus(): void {
  webdavState.value = { phase: "unchecked", message: "尚未检查远端；本地保存不代表已同步。", lastSyncedAt: null };
  webdavUploadedRevision = -1;
}
function invalidateWebdavSync(path = vaultPath.value): void {
  webdavGeneration++;
  if (webdavInFlight) {
    webdavInFlight = 0;
    busy.value = false;
    webdavState.value = { ...webdavState.value, phase: "cancelled", message: webdavErrorMessage("WD_CANCELLED") };
  }
  if (path) void invoke("webdav_cancel_sync", { vaultPath: path }).catch(() => {});
}
watch([db, vaultPath], (_value, previous) => {
  invalidateWebdavSync(previous?.[1] || "");
  resetWebdavSyncStatus();
  savedCiphertextFingerprint = null;
  lockSyncBaselineFingerprint = null;
}, { flush: "sync" });
watch(changeRevision, revision => {
  if (webdavState.value.phase === "synced" && revision !== webdavUploadedRevision) {
    webdavState.value = { ...webdavState.value, phase: "pending", message: "有新的本地修改待同步。" };
  }
}, { flush: "sync" });

async function syncWebdav(allowCreate = false): Promise<boolean> {
  const current = db.value, k = engine.value, path = vaultPath.value;
  if (!current || !k || !path || busy.value || saveBusy || syncing || webdavInFlight || drawer.value.open) return false;
  const run = ++webdavGeneration;
  webdavInFlight = run;
  busy.value = true;
  let prepared = false, committed = false;
  const active = () => webdavInFlight === run && webdavGeneration === run && db.value === current && vaultPath.value === path;
  const check = () => { if (!active()) throw "WD_CANCELLED"; };
  const phase = (value: WebdavState["phase"], message: string) => {
    webdavState.value = { ...webdavState.value, phase: value, message };
  };
  try {
    phase("saving", "正在确认本地保存…");
    const flushed = await flushSave(); check();
    if (!flushed) throw "WD_LOCAL_SAVE";
    phase("downloading", "正在读取远端版本…");
    const remoteFile = await invoke<WebdavPrepared>("webdav_prepare_sync", { vaultPath: path, allowCreate });
    check(); prepared = true;
    if (remoteFile.bytes !== null) {
      let remote: Kdbx;
      try { remote = await k.Kdbx.load(new Uint8Array(remoteFile.bytes).buffer, current.credentials); }
      catch (e) { throw classifyUnlockError(e, hasKeyFile.value).kind === "bad-key" ? "WD_REMOTE_KEY" : "WD_REMOTE_INVALID"; }
      check();
      if (current.getDefaultGroup().uuid.id !== remote.getDefaultGroup().uuid.id) throw "WD_DIFFERENT_VAULT";
      if (publicDataSnapshot(k, remote.header) !== publicDataSnapshot(k, current.header)) throw "WD_PUBLIC_CONFLICT";
      const saved = await flushSave(); check();
      if (!saved) throw "WD_LOCAL_SAVE";
      if (saveBusy || syncing) throw "WD_BUSY";
      if (publicDataSnapshot(k, remote.header) !== publicDataSnapshot(k, current.header)) throw "WD_PUBLIC_CONFLICT";
      phase("merging", "正在合并并保存到本地…");
      // Mark dirty before merge: even a partial merge must not be mistaken for saved data.
      changeRevision.value++;
      mergeWithHistoryNotes(current, remote);
      rebuild();
      const mergedSaved = await saveVault(); check();
      busy.value = true;
      if (!mergedSaved) throw "WD_LOCAL_SAVE";
    }
    const saved = await flushSave(); check();
    if (!saved) throw "WD_LOCAL_SAVE";
    const expectedStat = await statOf(path); check();
    if (!expectedStat || !expectedStat.mtimeNs || !sameStat(expectedStat, knownStat.value)) throw "WD_LOCAL_CHANGED";
    const revision = changeRevision.value;
    phase("uploading", "正在条件上传；远端变化时不会覆盖…");
    const result = await invoke<WebdavCommitted>("webdav_commit_sync", { vaultPath: path, token: remoteFile.token, expectedStat });
    check(); committed = true;
    if (revision === changeRevision.value) lockSyncBaselineFingerprint = savedCiphertextFingerprint;
    const actualStat = await statOf(path); check();
    webdavUploadedRevision = revision;
    const pending = revision !== changeRevision.value || hasUnsavedChanges.value || !sameStat(actualStat, result.uploadedStat);
    webdavState.value = { phase: pending ? "pending" : "synced", message: pending ? "本次上传已确认，仍有新的本地修改待同步。" : "本次同步完成。", lastSyncedAt: result.syncedAt };
    if (result.metadataSaved === false) webdavState.value.message += " 上传已确认，但本机同步时间未能持久保存。";
    return true;
  } catch (e) {
    if (active()) {
      const code = webdavErrorCode(e);
      phase(code === "WD_CANCELLED" ? "cancelled" : webdavIsConflict(code) ? "conflict" : "error", webdavErrorMessage(e));
    }
    return false;
  } finally {
    if (active()) {
      if (prepared && !committed) await invoke("webdav_cancel_sync", { vaultPath: path }).catch(() => {});
      if (active()) { webdavInFlight = 0; busy.value = false; }
    }
  }
}

const snapshotPreview = ref<SnapshotPreview | null>(null);
const snapshotError = ref("");
let snapshotGeneration = 0, snapshotInFlight = 0;
let snapshotPlan: { current: Kdbx; path: string; revision: number; item: SnapshotInfo } | null = null;
function clearSnapshotPreview(): void { snapshotPreview.value = null; snapshotPlan = null; }
function invalidateSnapshots(): void {
  snapshotGeneration++;
  if (snapshotInFlight) { snapshotInFlight = 0; busy.value = false; }
  clearSnapshotPreview(); snapshotError.value = "";
}
watch([db, vaultPath], invalidateSnapshots, { flush: "sync" });
watch(changeRevision, revision => {
  if (snapshotPlan && snapshotPlan.revision !== revision) {
    clearSnapshotPreview(); snapshotError.value = snapshotErrorMessage("SNAP_CHANGED");
  }
}, { flush: "sync" });
function startSnapshotOperation() {
  const current = db.value, path = vaultPath.value, k = engine.value;
  if (!current || !path || !k) throw "SNAP_CANCELLED";
  if (busy.value || saveBusy || syncing || snapshotInFlight || drawer.value.open) throw "SNAP_BUSY";
  const run = ++snapshotGeneration; snapshotInFlight = run; busy.value = true; snapshotError.value = "";
  const active = () => snapshotInFlight === run && snapshotGeneration === run && db.value === current && vaultPath.value === path;
  return { current, path, k, active, check() { if (!active()) throw "SNAP_CANCELLED"; }, finish() { if (active()) { snapshotInFlight = 0; busy.value = false; } } };
}
async function listBackupSnapshots(): Promise<SnapshotList | null> {
  const current = db.value, path = vaultPath.value;
  if (!current || !path) return null;
  snapshotError.value = "";
  try {
    const result = await invoke<SnapshotList>("snapshot_list", { vaultPath: path });
    return db.value === current && vaultPath.value === path ? result : null;
  } catch (e) { if (db.value === current && vaultPath.value === path) snapshotError.value = snapshotErrorMessage(e); return null; }
}
async function createBackupSnapshot(): Promise<boolean> {
  let op: ReturnType<typeof startSnapshotOperation> | undefined;
  try {
    op = startSnapshotOperation(); clearSnapshotPreview();
    const saved = await flushSave(); op.check();
    if (!saved) throw "SNAP_LOCAL_SAVE";
    const expectedStat = await statOf(op.path); op.check();
    if (!expectedStat || !expectedStat.mtimeNs || !sameStat(expectedStat, knownStat.value)) throw "SNAP_CHANGED";
    await invoke<SnapshotInfo>("snapshot_create", { vaultPath: op.path, expectedStat }); op.check();
    return true;
  } catch (e) { if (!op || op.active()) snapshotError.value = snapshotErrorMessage(e); return false; }
  finally { op?.finish(); }
}
async function previewBackupSnapshot(item: SnapshotInfo): Promise<boolean> {
  let op: ReturnType<typeof startSnapshotOperation> | undefined;
  try {
    op = startSnapshotOperation(); clearSnapshotPreview();
    const saved = await flushSave(); op.check();
    if (!saved) throw "SNAP_LOCAL_SAVE";
    const revision = changeRevision.value;
    const selected: SnapshotInfo = { ...item, stat: { ...item.stat } };
    const bytes = await invoke<number[]>("snapshot_read", { vaultPath: op.path, id: selected.id, expectedStat: selected.stat }); op.check();
    let previous: Kdbx;
    try { previous = await op.k.Kdbx.load(new Uint8Array(bytes).buffer, op.current.credentials); }
    catch (e) { throw classifyUnlockError(e, hasKeyFile.value).kind === "bad-key" ? "SNAP_BAD_KEY" : "SNAP_INVALID_FILE"; }
    op.check();
    if (revision !== changeRevision.value || hasUnsavedChanges.value) throw "SNAP_CHANGED";
    const summary = summarizeSnapshot(op.current, previous);
    snapshotPlan = { current: op.current, path: op.path, revision, item: selected };
    snapshotPreview.value = { item: selected, summary };
    return true;
  } catch (e) { if (!op || op.active()) { clearSnapshotPreview(); snapshotError.value = snapshotErrorMessage(e); } return false; }
  finally { op?.finish(); }
}
async function exportBackupSnapshot(targetPath: string): Promise<boolean> {
  let op: ReturnType<typeof startSnapshotOperation> | undefined;
  try {
    op = startSnapshotOperation();
    const plan = snapshotPlan;
    if (!plan || plan.current !== op.current || plan.path !== op.path || plan.revision !== changeRevision.value || hasUnsavedChanges.value) throw "SNAP_CHANGED";
    const saved = await flushSave(); op.check();
    if (!saved) throw "SNAP_LOCAL_SAVE";
    if (snapshotPlan !== plan || plan.revision !== changeRevision.value) throw "SNAP_CHANGED";
    const expectedStat = await statOf(op.path); op.check();
    if (!expectedStat || !expectedStat.mtimeNs || !sameStat(expectedStat, knownStat.value)) throw "SNAP_CHANGED";
    // Native export buffers the selected version before archiving/rotating the current version.
    await invoke("snapshot_export", { vaultPath: op.path, id: plan.item.id, expectedStat: plan.item.stat, currentStat: expectedStat, targetPath }); op.check();
    return true;
  } catch (e) { if (!op || op.active()) snapshotError.value = snapshotErrorMessage(e); return false; }
  finally { op?.finish(); }
}

const webdavAvailability = ref<{ configured: boolean | null; loading: boolean; lastSyncedAt: number | null; error: string }>({ configured: null, loading: false, lastSyncedAt: null, error: "" });
let webdavConfigGeneration = 0;
function setWebdavConfigSummary(view: WebdavConfig): void {
  webdavConfigGeneration++;
  webdavAvailability.value = { configured: view.configured, loading: false, lastSyncedAt: view.lastSyncedAt, error: "" };
}
async function refreshWebdavAvailability(): Promise<void> {
  const current = db.value, path = vaultPath.value, generation = ++webdavConfigGeneration;
  if (!current || !path) { webdavAvailability.value = { configured: null, loading: false, lastSyncedAt: null, error: "" }; return; }
  webdavAvailability.value = { ...webdavAvailability.value, loading: true, error: "" };
  try {
    const result = await invoke<WebdavConfig>("webdav_get_config", { vaultPath: path });
    if (generation === webdavConfigGeneration && db.value === current && vaultPath.value === path) setWebdavConfigSummary(result);
  } catch (e) {
    if (generation === webdavConfigGeneration && db.value === current && vaultPath.value === path) webdavAvailability.value = { configured: null, loading: false, lastSyncedAt: null, error: webdavErrorMessage(e) };
  }
}
watch([db, vaultPath], () => {
  webdavConfigGeneration++;
  webdavAvailability.value = { configured: null, loading: false, lastSyncedAt: null, error: "" };
}, { flush: "sync" });

/**
 * kdbxweb 的 KdbxError.code（BadSignature / InvalidVersion / Unsupported /
 * FileCorrupt / InvalidKey / MergeError）翻成人话。
 * 分类结果同时给 UI 用：只有「文件本身有问题」才值得摆出「从备份恢复」按钮，
 * 密码错的时候摆按钮只会让人以为能绕过密码。
 */
function classifyUnlockError(
  e: unknown,
  hasKeyFile: boolean
): { kind: UnlockErrorKind; text: string } {
  const raw = msg(e);
  const rawCode = (e as { code?: unknown } | null)?.code;
  const code =
    typeof rawCode === "string"
      ? rawCode
      : (raw.match(/Error ([A-Za-z]+)/)?.[1] ?? "");

  switch (code) {
    case "InvalidKey":
      return {
        kind: "bad-key",
        text: hasKeyFile ? "主密码或密钥文件不正确" : "主密码不正确",
      };
    case "BadSignature":
      return {
        kind: "not-kdbx",
        text: "不是有效的 KDBX 文件（文件头签名对不上）",
      };
    case "InvalidVersion":
      return {
        kind: "corrupt",
        text: "文件头的版本号读不出来，文件可能被截断或改坏了",
      };
    case "Unsupported":
      return {
        kind: "unsupported",
        text: "这个库用了当前引擎不支持的 KDBX 版本或加密算法（可能由更新的 KeePass 生成）",
      };
    case "FileCorrupt":
      return {
        kind: "corrupt",
        text: "库文件已损坏（写入中断、磁盘错误或网盘同步冲突都可能造成），可以从 .bak 备份恢复",
      };
    default:
      // 兜底：老版本或异常路径只有文本，没有 code
      if (/InvalidKey/i.test(raw)) {
        return {
          kind: "bad-key",
          text: hasKeyFile ? "主密码或密钥文件不正确" : "主密码不正确",
        };
      }
      if (/BadSignature|Not a KDBX|Invalid signature/i.test(raw)) {
        return { kind: "not-kdbx", text: "不是有效的 KDBX 文件（文件头签名对不上）" };
      }
      if (/FileCorrupt|corrupt/i.test(raw)) {
        return { kind: "corrupt", text: `库文件已损坏（${raw}），可以从 .bak 备份恢复` };
      }
      return { kind: "unknown", text: raw };
  }
}

/** KDBX 文件头签名（小端）：Sig1 0x9AA2D903，Sig2 0xB54BFB67；KDB 1.x 的 Sig2 是 0xB54BFB65 */
const SIG1 = "03d9a29a";
const SIG2_KDBX = "67fb4bb5";
const SIG2_KDB = "65fb4bb5";

/**
 * 解密前先看文件头。这样「选错文件」「文件空/被截断」「KeePass 1.x 老库」
 * 都能给出准确说法，而不是统统报成「主密码不正确」。
 */
function headerProblem(
  bytes: number[]
): { kind: UnlockErrorKind; text: string } | null {
  const hex = (from: number, to: number) =>
    bytes
      .slice(from, to)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  if (bytes.length === 0) {
    return { kind: "corrupt", text: "文件是空的（0 字节），可能没写完或已被清空" };
  }
  if (bytes.length < 12) {
    return { kind: "corrupt", text: "文件不足 12 字节，不是完整的密码库" };
  }
  if (hex(0, 4) !== SIG1) {
    return {
      kind: "not-kdbx",
      text: "这不是 KDBX 密码库（文件头签名不对，可能选错了文件，或文件已被别的程序改写）",
    };
  }
  const sig2 = hex(4, 8);
  if (sig2 === SIG2_KDB) {
    return {
      kind: "old-kdb",
      text: "这是 KeePass 1.x 的老格式（.kdb），KeyTree 只支持 KDBX；请先用 KeePass 2 另存为新格式",
    };
  }
  if (sig2 !== SIG2_KDBX) {
    return { kind: "not-kdbx", text: "文件头签名不对，不是有效的 KDBX 库" };
  }
  return null;
}

function tryLoad(
  k: Kdbxweb,
  bytes: number[],
  password: string,
  keyFile: Uint8Array | null
): Promise<Kdbx> {
  return k.Kdbx.load(
    new Uint8Array(bytes).buffer,
    new k.Credentials(k.ProtectedValue.fromString(password), keyFile?.slice())
  );
}

/**
 * 快速解锁（spec §7.1 第一阶段）：解锁成功后把凭据（主密码 + 可选密钥文件）
 * 交给 Rust，用 DPAPI 绑定当前 Windows 账户加密后存 AppData。纯优化路径，失败静默。
 */
async function stashQuickUnlock(
  path: string,
  password: string,
  keyFile: Uint8Array | null
): Promise<void> {
  try { await cacheQuickUnlock(path, password, keyFile); }
  catch { /* Saving a convenience cache must not fail the primary password unlock. */ }
}

let unlockGeneration = 0, unlockInFlight = 0;
function startUnlock(): number {
  const run = ++unlockGeneration;
  unlockInFlight = run; busy.value = true;
  return run;
}
function unlockActive(run: number): boolean { return unlockGeneration === run && unlockInFlight === run; }
function finishUnlock(run: number): void {
  if (unlockInFlight === run) { unlockInFlight = 0; busy.value = false; }
}

/** Windows Hello 验证与 DPAPI 取凭据由同一原生命令执行，前端不持有可绕过的验证门禁。 */
async function helloUnlock(path: string): Promise<boolean> {
  if (busy.value || unlockInFlight) return false;
  if (!credentialCachingAllowed()) { error.value = "快速解锁已关闭，请使用主密码和所需密钥文件解锁"; return false; }
  const run = startUnlock();
  error.value = "";
  try {
    const secretBytes = await invoke<number[]>("quick_unlock_load", { vaultPath: path });
    if (!unlockActive(run) || !credentialCachingAllowed()) return false;
    const decoded = JSON.parse(
      new TextDecoder().decode(new Uint8Array(secretBytes))
    ) as { p: string; k: number[] | null };
    const keyFile = decoded.k ? new Uint8Array(decoded.k) : null;
    const ok = await openVault(path, decoded.p, keyFile, run);
    if (!ok) {
      if (!unlockActive(run)) return false;
      // 文件 IO 或公开版本冲突不说明凭据失效，不能因此清除缓存。
      if (errorKind.value === "bad-key") {
        await clearQuickUnlockCache(path).catch(() => {});
        error.value = "快速解锁的缓存凭据已失效，请用主密码解锁";
      }
    }
    return ok;
  } catch (e) {
    if (!unlockActive(run)) return false;
    const reason = msg(e);
    error.value = reason.includes("HELLO_NOT_VERIFIED")
      ? "Windows Hello 验证未通过或已取消，可继续使用主密码解锁"
      : reason.includes("HELLO_UNAVAILABLE")
        ? "Windows Hello 当前不可用，请用主密码解锁"
        : "快速解锁不可用，请用主密码解锁";
    return false;
  } finally {
    finishUnlock(run);
  }
}

async function openVault(
  path: string,
  password: string,
  keyFile: Uint8Array | null = null,
  helloRun?: number
): Promise<boolean> {
  if (helloRun === undefined && (busy.value || unlockInFlight)) return false;
  const run = helloRun ?? startUnlock();
  const active = () => unlockActive(run) && (helloRun === undefined || credentialCachingAllowed());
  if (!active()) return false;
  error.value = "";
  errorKind.value = "none";
  status.value = "读取文件…";
  try {
    const k = await ensureEngine();
    if (!active()) return false;
    const readStat = await statOf(path);
    let bytes: number[];
    try {
      bytes = await invoke<number[]>("read_vault", { path });
    } catch (e) {
      if (!active()) return false;
      errorKind.value = "io";
      error.value = `读不到文件：${msg(e)}`;
      status.value = "";
      return false;
    }
    if (!active()) return false;
    // 先验文件头：能准确区分「选错文件」「文件被截断」「KeePass 1.x 老库」，
    // 而不是把它们一律报成主密码不正确
    const problem = headerProblem(bytes);
    if (problem) {
      errorKind.value = problem.kind;
      error.value = `打不开这个库：${problem.text}`;
      status.value = "";
      return false;
    }
    status.value = "解密中…";

    let loaded: Kdbx;
    let note = "";
    try {
      loaded = await tryLoad(k, bytes, password, keyFile);
    } catch (e) {
      if (!active()) return false;
      // 从网页/聊天窗口复制主密码时常带首尾空白，密码框里又看不出来。
      // 只在确实存在空白时重试一次，并明确告知，绝不静默修改用户密码。
      const trimmed = password.trim();
      if (!trimmed || trimmed === password) throw e;
      loaded = await tryLoad(k, bytes, trimmed, keyFile);
      note = "已忽略主密码首尾的空白字符";
    }
    if (!active()) return false;
    const openedFingerprint = await ciphertextFingerprint(Uint8Array.from(bytes).buffer);
    if (!active()) return false;

    const finalReadStat = await statOf(path);
    if (!active()) return false;
    if (!readStat || !sameStat(readStat, finalReadStat)) throw new Error("读取或解密期间文件已变化，请重新选择并解锁");
    resetSaveState();
    cancelImport();
    knownPublicData = publicDataSnapshot(k, loaded.header);
    db.value = loaded;
    vaultPath.value = path;
    savedCiphertextFingerprint = openedFingerprint;
    lockSyncBaselineFingerprint = openedFingerprint;
    keyFileBytes.value = keyFile?.slice() ?? null;
    selectedGroupUuid.value = "all";
    query.value = "";
    // 换库必须清图标缓存：host → 图标 id 是跨库不通用的 uuid
    iconUrls.clear();
    hostIcons.clear();
    rebuild();
    selectedUuid.value = visibleEntries.value[0]?.uuid ?? "";
    status.value = note;
    settings.lastVaultPath = path;
    upsertVault(path);
    // note 非空说明 trim 重试才成功，生效密码是去空白后的那个
    void stashQuickUnlock(path, note ? password.trim() : password, keyFile);
    void recordAudit("unlock");
    // 开始盯文件；版本必须与实际解密的字节对应。
    knownStat.value = finalReadStat;
    void invoke("watch_vault", { path }).catch(() => {});
    return true;
  } catch (e) {
    if (!active()) return false;
    status.value = "";
    const classified = classifyUnlockError(e, !!keyFile);
    errorKind.value = classified.kind;
    // 只针对「输入法全角 / 各种连字符变体」这类肉眼几乎看不出来的坑，
    // 别把中文主密码误判成可疑输入
    const suspicious =
      classified.kind === "bad-key" &&
      /[\uFF01-\uFF5E\u3000\u2010-\u2015]/.test(password)
        ? "；注意密码里有全角或连字符变体，可能和实际密码不是同一个字符"
        : "";
    error.value = `解锁失败：${classified.text}${suspicious}`;
    return false;
  } finally {
    if (helloRun === undefined) finishUnlock(run);
  }
}

async function createVault(
  path: string,
  name: string,
  password: string,
  keyFile: Uint8Array | null = null
): Promise<boolean> {
  if (busy.value || unlockInFlight) return false;
  const run = startUnlock();
  error.value = "";
  status.value = "创建数据库…";
  try {
    const k = await ensureEngine();
    if (!unlockActive(run)) return false;
    const credentials = new k.Credentials(
      k.ProtectedValue.fromString(password),
      keyFile?.slice()
    );
    const created = k.Kdbx.create(credentials, name || "我的密码库");
    applyEncryptionProfile(k, created, "recommended");
    status.value = "加密中（Argon2id · 64 MiB · 3 次迭代）…";
    const saved = await created.save();
    if (!unlockActive(run)) return false;
    status.value = "写入磁盘…";
    await writeBytes(path, saved);
    const createdFingerprint = await ciphertextFingerprint(saved);
    if (!unlockActive(run)) return false;
    const createdStat = await statOf(path);
    if (!unlockActive(run)) return false;

    resetSaveState();
    cancelImport();
    knownPublicData = publicDataSnapshot(k, created.header);
    db.value = created;
    vaultPath.value = path;
    savedCiphertextFingerprint = createdFingerprint;
    lockSyncBaselineFingerprint = createdFingerprint;
    keyFileBytes.value = keyFile?.slice() ?? null;
    selectedGroupUuid.value = "all";
    query.value = "";
    rebuild();
    selectedUuid.value = visibleEntries.value[0]?.uuid ?? "";
    status.value = "";
    settings.lastVaultPath = path;
    upsertVault(path);
    void stashQuickUnlock(path, password, keyFile);
    void recordAudit("unlock");
    knownStat.value = createdStat;
    void invoke("watch_vault", { path }).catch(() => {});
    return true;
  } catch (e) {
    if (!unlockActive(run)) return false;
    error.value = `创建失败：${msg(e)}`;
    return false;
  } finally {
    finishUnlock(run);
  }
}

let encryptionGeneration = 0;
watch([db, vaultPath], () => { encryptionGeneration++; }, { flush: "sync" });
function encryptionPreview(profile: EncryptionProfile) {
  const current = db.value, k = engine.value;
  if (!current || !k) throw new Error("请先解锁密码库");
  return encryptionTarget(k, current.header, profile);
}
async function testEncryptionSpeed(profile: EncryptionProfile): Promise<number | null> {
  const current = db.value, k = engine.value;
  if (!current || !k || busy.value || saveBusy || syncing) return null;
  const run = ++encryptionGeneration;
  busy.value = true; error.value = "";
  const task = saveChain.catch(() => false).then(async () => {
    if (run !== encryptionGeneration || db.value !== current) return null;
    saveBusy = true;
    try {
      const ms = await benchmarkEncryption(k, encryptionTarget(k, current.header, profile));
      return run === encryptionGeneration && db.value === current ? ms : null;
    } catch {
      if (run === encryptionGeneration) error.value = "本机成本测试失败（可能内存不足），密码库未修改";
      return null;
    } finally { saveBusy = false; }
  });
  saveChain = task.then(() => false);
  try { return await task; } finally { busy.value = false; }
}

/** Exclusive queue job. Only adopt the new header after authenticated round-trip and atomic write. */
async function upgradeEncryption(profile: EncryptionProfile): Promise<boolean> {
  const current = db.value, k = engine.value, path = vaultPath.value;
  if (!current || !k || !path || busy.value || saveBusy || syncing || webdavInFlight || snapshotInFlight || drawer.value.open) return false;
  const run = ++encryptionGeneration;
  const active = () => run === encryptionGeneration && db.value === current && vaultPath.value === path;
  const check = () => { if (!active()) throw new Error("密码库已锁定或切换，升级已取消"); };
  busy.value = true; error.value = ""; cancelScheduledSave();
  const task = saveChain.catch(() => false).then(async () => {
    try {
      check();
      // Flush existing edits through the normal merge/atomic-save pipeline first.
      if (hasUnsavedChanges.value && !(await persist(false))) throw new Error("尚有未保存的修改，请先重试保存");
      check();
      if (hasUnsavedChanges.value) throw new Error("密码库仍在变化，请稍后再升级");
      saveBusy = true;
      const revision = changeRevision.value;
      const expectedStat = knownStat.value;
      if (!expectedStat?.mtimeNs || !sameStat(expectedStat, await statOf(path))) throw new Error("磁盘版本已变化，请重新打开密码库后升级");
      const bytes = await invoke<number[]>("read_vault", { path }); check();
      const candidate = await k.Kdbx.load(new Uint8Array(bytes).buffer, current.credentials); check();
      if (candidate.getDefaultGroup().uuid.id !== current.getDefaultGroup().uuid.id || publicDataSnapshot(k, candidate.header) !== knownPublicData) throw new Error("磁盘版本与当前库不一致，请重新打开后升级");
      const target = applyEncryptionProfile(k, candidate, profile);
      status.value = "正在生成增强密文并验证，请勿退出…";
      const saved = await candidate.save(); check();
      const verified = await k.Kdbx.load(saved, current.credentials); check();
      const info = encryptionInfo(k, verified.header);
      if (info.kdf !== "Argon2id" || info.memoryMiB !== target.memoryMiB || info.iterations !== target.iterations || info.parallelism !== target.parallelism || verified.getDefaultGroup().uuid.id !== current.getDefaultGroup().uuid.id) throw new Error("新密文校验未通过，原文件未覆盖");
      if (revision !== changeRevision.value || !sameStat(expectedStat, await statOf(path))) throw new Error("验证期间密码库发生变化，请重试");
      check();
      // Explicit backup is mandatory even though normal native writes also archive old versions.
      await invoke("snapshot_create", { vaultPath: path, expectedStat }); check();
      if (revision !== changeRevision.value) throw new Error("备份期间密码库发生变化，请重试");
      await writeBytes(path, saved, expectedStat);
      current.header = verified.header;
      current.meta.headerHash = undefined;
      current.meta.settingsChanged = candidate.meta.settingsChanged;
      changeRevision.value++;
      // Edits arriving during native write remain dirty; only this snapshot is confirmed.
      persistedRevision.value = revision + 1;
      knownPublicData = publicDataSnapshot(k, current.header);
      encryptionRevision.value++;
      error.value = ""; saveError = "";
      status.value = "加密强度已升级并验证。旧备份仍使用原来的参数，请按需手动同步";
      return true;
    } catch (e) {
      if (active()) { error.value = `加密升级未完成：${msg(e)}`; status.value = "原加密参数保持不变；已保存的数据仍可正常解锁"; }
      return false;
    } finally { saveBusy = false; }
  });
  saveChain = task;
  try { return await task; } finally { busy.value = false; }
}

/** 修改主密码：先用旧密码（连同当前密钥文件）重解一遍验证，再换新密码落盘 */
async function changeMasterPassword(
  currentPassword: string,
  newPassword: string
): Promise<boolean> {
  const current = db.value;
  const k = engine.value;
  if (!current || !k) return false;
  error.value = "";

  try {
    const bytes = await invoke<number[]>("read_vault", { path: vaultPath.value });
    await k.Kdbx.load(
      new Uint8Array(bytes).buffer,
      new k.Credentials(
        k.ProtectedValue.fromString(currentPassword),
        keyFileBytes.value?.slice()
      )
    );
  } catch {
    error.value = "当前主密码不正确";
    return false;
  }

  try {
    await current.credentials.setPassword(
      k.ProtectedValue.fromString(newPassword)
    );
    const ok = await saveVault();
    if (ok) {
      status.value = "主密码已更新（文件已用新密码重新加密）";
      // 快速解锁缓存里还是旧密码，换成新的
      void stashQuickUnlock(vaultPath.value, newPassword, keyFileBytes.value);
    }
    return ok;
  } catch (e) {
    error.value = `修改主密码失败：${msg(e)}`;
    return false;
  }
}

/** 启用 / 移除密钥文件（第二因子），会立即重新加密落盘 */
async function applyKeyFile(bytes: Uint8Array | null): Promise<boolean> {
  const current = db.value;
  if (!current) return false;
  error.value = "";
  try {
    await current.credentials.setKeyFile(bytes?.slice());
    keyFileBytes.value = bytes?.slice() ?? null;
    const ok = await saveVault();
    if (ok) {
      status.value = bytes
        ? "已启用密钥文件：以后打开这个库必须同时提供它"
        : "已移除密钥文件";
      // 缓存的解锁凭据已过期（密钥文件变了），只清这个库的，其他库不动
      await clearQuickUnlockCache(vaultPath.value).catch(() => {});
    }
    return ok;
  } catch (e) {
    error.value = `设置密钥文件失败：${msg(e)}`;
    return false;
  }
}

/** 生成一个 KeePass 兼容的 .keyx 密钥文件写到磁盘，并立即启用 */
async function createKeyFile(path: string): Promise<boolean> {
  const k = engine.value;
  if (!k) return false;
  try {
    const bytes = await k.Credentials.createRandomKeyFile();
    await invoke("write_vault", { path, bytes: Array.from(bytes) });
    return await applyKeyFile(bytes);
  } catch (e) {
    error.value = `生成密钥文件失败：${msg(e)}`;
    return false;
  }
}

const FAVORITE_KEY = "keytree.favorite";

/** 收藏/取消收藏条目（存 KDBX CustomData，其他客户端无感） */
async function toggleFavorite(uuid: string): Promise<void> {
  const entry = entryRefs.get(uuid);
  if (!entry) return;
  error.value = "";
  try {
    // 旧库没有 CustomData 节点时是 undefined，必须先建 Map（?. 会静默跳过写入）
    if (!entry.customData) entry.customData = new Map();
    if (entry.customData.get(FAVORITE_KEY)) {
      entry.customData.delete(FAVORITE_KEY);
    } else {
      entry.customData.set(FAVORITE_KEY, { value: "1" });
    }
    entry.times.update();
    rebuild();
    await saveVault();
  } catch (e) {
    error.value = `收藏失败：${msg(e)}`;
  }
}

/**
 * 使用一次（复制密码/动态码/Auto-Type）：usageCount +1，500ms 合并落盘。
 * 快速面板按「最近使用 > 收藏」排序（spec §6.2），这就是排序依据。
 *
 * 注意只动 lastAccessTime，不用 times.update()——那会把 lastModTime 也刷成现在，
 * 复制一次密码就把条目顶到「最近修改」最前面，语义不对。
 */
async function touchUsage(uuid: string): Promise<void> {
  const entry = entryRefs.get(uuid);
  if (!entry) return;
  try {
    entry.times.usageCount = (entry.times.usageCount ?? 0) + 1;
    entry.times.lastAccessTime = new Date();
    // 只改这一条 VM，不整库 rebuild：复制动作必须轻
    const vm = entries.value.find((item) => item.uuid === uuid);
    if (vm) {
      vm.usageCount = entry.times.usageCount;
      vm.lastUsedAt = entry.times.lastAccessTime;
    }
    saveSoon();
  } catch {
    // 统计失败不影响主流程
  }
}

/** 历史最多留 20 条，超出丢最旧的（KeePassXC 默认行为类似） */
const HISTORY_LIMIT = 20;

// ==================== favicon（自定义图标） ====================

/**
 * 抓条目站点的 favicon 存为 KDBX 自定义图标（KeePassXC 同款机制，互通）。
 * 同 host 复用同一个图标；失败静默降级为默认字母头像（spec §5）。
 * 纯后台优化路径，不阻塞保存。返回是否更新了图标。
 * 注意：改完 kdbx 对象必须 rebuild()——VM 里的 icon 是 rebuild 时算的 data URL，
 * 不 rebuild 就是「数据换了 UI 不动」（实测踩过：↻ 点了像没点一样）。
 */
async function maybeFetchIcon(uuid: string): Promise<boolean> {
  const current = db.value;
  const entry = entryRefs.get(uuid);
  if (!current || !entry) return false;
  const host = hostOf(fieldText(entry, "URL"));
  if (!host) return false;

  // 这个站已有图标：直接复用（本会话内或条目上已有的）
  const known = hostIcons.get(host);
  if (known) {
    if (entry.customIcon?.id !== known) {
      // KdbxUuid 构造器接受 base64 id 字符串
      entry.customIcon = new engine.value!.KdbxUuid(known);
      entry.times.update();
      saveSoon();
      rebuild();
      return true;
    }
    return false;
  }

  try {
    const bytes = await fetchFavicon(fieldText(entry, "URL"));
    if (!bytes || db.value !== current || entryRefs.get(uuid) !== entry) return false;
    const iconUuid = engine.value!.KdbxUuid.random();
    db.value.meta.customIcons.set(iconUuid.id, { data: bytes, name: host });
    entry.customIcon = iconUuid;
    hostIcons.set(host, iconUuid.id);
    saveSoon();
    rebuild();
    status.value = `已更新站点图标：${host}`;
    return true;
  } catch {
    return false;
  }
}

/** 手动重新抓图标（详情页按钮）：清掉 host 缓存强制重来，结果用 toast 明确反馈 */
async function refreshIcon(uuid: string): Promise<void> {
  const entry = entryRefs.get(uuid);
  if (!entry) return;
  const host = hostOf(fieldText(entry, "URL"));
  if (host) hostIcons.delete(host);
  const ok = await maybeFetchIcon(uuid);
  if (ok) {
    toast(`已更新 ${host} 的站点图标`);
  } else {
    toast(`没抓到 ${host} 的新图标，保留了原图标`);
  }
}

// ==================== 导入 / 导出（spec §5 进出） ====================

/** KDBX 另存：完整副本（含分组/历史/回收站/自定义图标） */
async function exportKdbx(path: string): Promise<boolean> {
  const current = db.value;
  if (!current) return false;
  try {
    const saved = await current.save();
    await writeBytes(path, saved);
    status.value = `已另存副本到 ${path}`;
    return true;
  } catch (e) {
    error.value = `另存失败：${msg(e)}`;
    return false;
  }
}

/** 导出 CSV（Chrome/Edge 导入格式）。密码是明文，调用方负责双确认与警告 */
async function exportCsv(path: string): Promise<boolean> {
  const current = db.value;
  if (!current) return false;
  try {
    const rows = entries.value
      .filter((vm) => !vm.inTrash)
      .map((vm) => ({
        title: vm.title,
        url: vm.url,
        username: vm.username,
        password: fieldText(entryRefs.get(vm.uuid)!, "Password"),
        notes: vm.notes,
      }));
    const text = buildChromeCsv(rows);
    await invoke("write_vault", {
      path,
      bytes: Array.from(new TextEncoder().encode(text)),
    });
    status.value = `已导出 ${rows.length} 条到 CSV（明文，注意保管）`;
    return true;
  } catch (e) {
    error.value = `导出失败：${msg(e)}`;
    return false;
  }
}

/** 按分组路径逐级建组（KeePassXC 导出的 Group 列用 "/" 分层） */
function ensureGroupPath(parts: string[]): KdbxGroup {
  const current = db.value!;
  let node = current.getDefaultGroup();
  for (const raw of parts) {
    const name = (raw ?? "").trim();
    if (!name) continue;
    const existing = node.groups.find((g) => g.name === name);
    node = existing ?? current.createGroup(node, name);
  }
  return node;
}

export const importPreview = ref<ImportRow[]>([]);
const importApplied = ref(false);
const importCount = ref(0);
let importOwner: Kdbx | null = null;
let importingCsv = false;
function groupPath(group: KdbxGroup | undefined): string {
  const parts: string[] = [];
  while (group?.parentGroup) { parts.unshift(group.name ?? ""); group = group.parentGroup; }
  return parts.join("/");
}
function existingImportRecords(): ImportRecord[] {
  return entries.value.filter(e => !e.inTrash).map(e => ({
    title: e.title, username: e.username, password: fieldText(entryRefs.get(e.uuid)!, "Password"),
    url: e.url, notes: e.notes, totp: fieldText(entryRefs.get(e.uuid)!, "otp"),
    group: groupPath(entryRefs.get(e.uuid)?.parentGroup),
  }));
}
function cancelImport(): void {
  importPreview.value = [];
  importOwner = null;
  importApplied.value = false;
  importCount.value = 0;
}
async function previewCsv(path: string): Promise<boolean> {
  const current = db.value;
  if (!current || importingCsv) return false;
  cancelImport();
  error.value = "";
  try {
    const bytes = await invoke<number[]>("read_vault", { path });
    if (db.value !== current) return false;
    if (bytes.length > 20 * 1024 * 1024) throw new Error("CSV 文件过大，请拆分导入");
    importPreview.value = analyzeImport(new TextDecoder().decode(new Uint8Array(bytes)), existingImportRecords());
    importOwner = current;
    return true;
  } catch (e) { error.value = `预览失败：${msg(e)}`; return false; }
}
async function confirmImport(): Promise<number> {
  const current = db.value;
  if (!current || importOwner !== current || importingCsv) return 0;
  importingCsv = true;
  error.value = "";
  try {
    if (!importApplied.value) {
      const chosen = importPreview.value.filter(row => row.selected && row.classification !== "invalid");
      if (!chosen.length) { error.value = "请选择要导入的条目"; return 0; }
      // 先全部验证，再修改库；不静默覆盖任何已有条目。
      for (const row of chosen) validateEntryDraft({ ...row.record, tags: "", groupUuid: "", expires: false, expiryDate: "" });
      // 预览后库可能变化；完全相同的内容仍跳过。
      const kinds = classifyImportRecords(chosen.map(row => row.record), existingImportRecords());
      let needsConsent = false;
      chosen.forEach((row, index) => {
        if (kinds[index] === "conflict" && row.classification !== "conflict") {
          row.classification = "conflict"; row.selected = false; needsConsent = true;
        }
      });
      if (needsConsent) { error.value = "预览后出现新的账号冲突，请重新选择冲突行，再确认导入"; return 0; }
      const analyzed = chosen.map((row, index) => ({ ...row, classification: kinds[index] }));
      let count = 0;
      for (const row of analyzed) {
        if (row.classification === "duplicate") continue;
        const r = row.record, group = r.group ? ensureGroupPath(r.group.split("/")) : current.getDefaultGroup();
        const entry = current.createEntry(group);
        applyDraft(entry, { ...r, tags: "", groupUuid: group.uuid.id, expires: false, expiryDate: "" });
        count++;
      }
      importApplied.value = true;
      importCount.value = count;
      rebuild();
    }
    if (importCount.value && !(await saveVault())) return 0;
    const count = importCount.value;
    status.value = count ? `已导入并保存 ${count} 条` : "所选内容已存在，未重复导入";
    cancelImport();
    return count;
  } catch (e) { error.value = `导入失败：${msg(e)}`; return 0; }
  finally { importingCsv = false; }
}
async function importCsv(path: string): Promise<number> {
  if (!(await previewCsv(path))) return 0;
  return confirmImport();
}

function validateEntryDraft(draft: EntryDraft): void {
  if (!draft.title.trim()) throw new Error("标题不能为空");
  if (draft.customFields) validateCustomFields(draft.customFields);

  if (draft.totp.trim() && !parseTotpInput(draft.totp)) throw new Error("TOTP 密钥无法识别");
}

function pushHistory(entry: KdbxEntry): void {
  entry.pushHistory();
  copySnapshotMetadata(entry, entry.history[entry.history.length - 1]);
  const overflow = entry.history.length - HISTORY_LIMIT;
  if (overflow > 0) entry.removeHistory(0, overflow);
}

function applyDraft(entry: KdbxEntry, draft: EntryDraft): void {
  const k = engine.value;
  if (!k) return;
  // 字段操作先在副本上验证，失败不能半改标准字段。
  if (draft.customFields) {
    const next = new Map(entry.fields);
    applyCustomFields(next, draft.customFields, draft.removedFields ?? [], value => k.ProtectedValue.fromString(value));
    entry.fields = next;
    // 草稿可能因写盘失败被再次提交；身份应跟随已经应用到内存的重命名。
    for (const field of draft.customFields) field.originalName = field.name.trim();
    draft.removedFields = [];
  }
  if (draft.autoTypeSequence !== undefined) entry.autoType.defaultSequence = draft.autoTypeSequence.trim() || undefined;
  entry.fields.set("Title", draft.title.trim());
  entry.fields.set("UserName", draft.username.trim());
  entry.fields.set("Password", k.ProtectedValue.fromString(draft.password));
  entry.fields.set("URL", draft.url.trim());
  entry.fields.set("Notes", draft.notes);
  if (draft.totp.trim()) {
    entry.fields.set("otp", k.ProtectedValue.fromString(normalizeTotpInput(draft.totp)));
  } else {
    entry.fields.delete("otp");
  }
  entry.tags = draft.tags
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);

  // 过期：日期取当天 23:59:59，避免「设了今天却刚过零点就过期」
  entry.times.expires = draft.expires;
  if (draft.expires && draft.expiryDate) {
    const [year, month, day] = draft.expiryDate.split("-").map(Number);
    entry.times.expiryTime = new Date(year, month - 1, day, 23, 59, 59);
  } else {
    entry.times.expiryTime = undefined;
  }
  entry.times.update();
}

async function addEntry(draft: EntryDraft): Promise<string | null> {
  const current = db.value;
  if (!current) return null;
  error.value = "";
  try {
    validateEntryDraft(draft);
    if (draft.autoTypeSequence !== undefined) validateSequence(draft.autoTypeSequence);
    const group = groupRefs.get(draft.groupUuid) ?? current.getDefaultGroup();
    const entry = current.createEntry(group);
    applyDraft(entry, draft);
    rebuild();
    selectedUuid.value = entry.uuid.id;
    // 新建已经存在于内存；失败后将原抽屉指向它，重试不得再创建一条。
    if (drawer.value.open && drawer.value.mode === "create") {
      drawer.value = { open: true, mode: "edit", uuid: entry.uuid.id };
    }
    if (!(await saveVault())) return null;
    // 站点图标后台补抓，不阻塞保存
    void maybeFetchIcon(entry.uuid.id);
    return entry.uuid.id;
  } catch (e) {
    error.value = `新建条目失败：${msg(e)}`;
    return null;
  }
}

/** 比较规范化后的表单，不缓存明文；相同失败草稿重试不能重复淘汰历史。 */
function matchesDraft(uuid: string, draft: EntryDraft): boolean {
  const before = draftOf(uuid);
  if (!before) return false;
  const tags = draft.tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean).join(", ");
  const normalizeFields = (fields: CustomFieldDraft[]) => fields.map(f => [f.name.trim(), f.value, f.protected]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const extensionsMatch = (draft.customFields === undefined || JSON.stringify(normalizeFields(before.customFields ?? [])) === JSON.stringify(normalizeFields(draft.customFields))) &&
    (draft.autoTypeSequence === undefined || (before.autoTypeSequence ?? "") === draft.autoTypeSequence.trim()) &&
    !(draft.removedFields ?? []).some(name => entryRefs.get(uuid)?.fields.has(name));
  return extensionsMatch && before.title === draft.title.trim() &&
    before.username === draft.username.trim() &&
    before.password === draft.password &&
    before.url === draft.url.trim() &&
    before.notes === draft.notes &&
    before.tags === tags &&
    before.totp === normalizeTotpInput(draft.totp) &&
    before.groupUuid === draft.groupUuid &&
    before.expires === draft.expires &&
    (!draft.expires || before.expiryDate === draft.expiryDate);
}

async function updateEntry(uuid: string, draft: EntryDraft): Promise<boolean> {
  const current = db.value;
  const entry = entryRefs.get(uuid);
  if (!current || !entry) return false;
  error.value = "";
  try {
    validateEntryDraft(draft);
    if (draft.autoTypeSequence !== undefined && draft.autoTypeSequence !== (entry.autoType.defaultSequence ?? "")) validateSequence(draft.autoTypeSequence);
    // 验证自定义字段碰撞，早于移动/压历史；失败不改变当前条目。
    if (draft.customFields && engine.value) applyCustomFields(new Map(entry.fields), draft.customFields, draft.removedFields ?? [], value => engine.value!.ProtectedValue.fromString(value));
    const retryUnchanged = hasUnsavedChanges.value && matchesDraft(uuid, draft);
    if (!retryUnchanged) {
      const target = groupRefs.get(draft.groupUuid);
      if (target && entry.parentGroup?.uuid.id !== target.uuid.id) {
        current.move(entry, target);
      }
      pushHistory(entry);
      applyDraft(entry, draft);
      rebuild();
    }
    selectedUuid.value = uuid;
    if (!(await saveVault())) return false;
    // 网址变了才重新抓图标（maybeFetchIcon 内部按 host 缓存自行判断）
    void maybeFetchIcon(uuid);
    return true;
  } catch (e) {
    error.value = `保存条目失败：${msg(e)}`;
    return false;
  }
}

async function removeEntry(uuid: string): Promise<void> {
  const current = db.value;
  const entry = entryRefs.get(uuid);
  if (!current || !entry) return;
  error.value = "";
  const toTrash = recycleBinEnabled.value;
  try {
    // 回收站启用时 remove 只是「移到回收站」，否则才是真删除（见 kdbxweb 实现）
    current.remove(entry);
    rebuild();
    await saveVault();
    status.value = toTrash ? "已移到回收站" : "已彻底删除";
  } catch (e) {
    error.value = `删除失败：${msg(e)}`;
  }
}

/** 分组（含其祖先）是否位于回收站内 */
function groupIsInTrash(group: KdbxGroup | undefined): boolean {
  const binId = trash.value?.uuid;
  if (!binId) return false;
  let cursor: KdbxGroup | undefined = group;
  while (cursor) {
    if (cursor.uuid.id === binId) return true;
    cursor = cursor.parentGroup;
  }
  return false;
}

/** 从回收站恢复：优先回到删除前所在分组 */
async function restoreEntry(uuid: string): Promise<void> {
  const current = db.value;
  const entry = entryRefs.get(uuid);
  if (!current || !entry) return;
  error.value = "";
  try {
    const previous = entry.previousParentGroup
      ? current.getGroup(entry.previousParentGroup)
      : undefined;
    const target =
      previous && !groupIsInTrash(previous)
        ? previous
        : current.getDefaultGroup();
    current.move(entry, target);
    rebuild();
    await saveVault();
    status.value = `已恢复到「${target.name || "默认分组"}」`;
  } catch (e) {
    error.value = `恢复失败：${msg(e)}`;
  }
}

/** 彻底删除（不可恢复）：move 到 undefined 会给对象打墓碑 */
async function purgeEntry(uuid: string): Promise<void> {
  const current = db.value;
  const entry = entryRefs.get(uuid);
  if (!current || !entry) return;
  error.value = "";
  try {
    current.move(entry, undefined);
    rebuild();
    await saveVault();
    status.value = "已彻底删除";
  } catch (e) {
    error.value = `删除失败：${msg(e)}`;
  }
}

async function emptyTrash(): Promise<void> {
  const current = db.value;
  const bin = trash.value;
  if (!current || !bin) return;
  const group = groupRefs.get(bin.uuid);
  if (!group) return;
  error.value = "";
  try {
    // 先复制列表：move 会改动原 container
    for (const entry of [...group.entries]) current.move(entry, undefined);
    for (const sub of [...group.groups]) current.move(sub, undefined);
    rebuild();
    await saveVault();
    status.value = "回收站已清空";
  } catch (e) {
    error.value = `清空回收站失败：${msg(e)}`;
  }
}

async function renameGroup(uuid: string, name: string): Promise<void> {
  const group = groupRefs.get(uuid);
  const trimmed = name.trim();
  if (!group || !trimmed) return;
  error.value = "";
  try {
    group.name = trimmed;
    group.times.update();
    rebuild();
    await saveVault();
  } catch (e) {
    error.value = `重命名失败：${msg(e)}`;
  }
}

async function deleteGroup(uuid: string): Promise<boolean> {
  const current = db.value;
  const group = groupRefs.get(uuid);
  if (!current || !group || busy.value) return false;
  if (group.uuid.id === current.getDefaultGroup().uuid.id) {
    error.value = "根分组不能删除";
    return false;
  }
  error.value = "";
  const toTrash = recycleBinEnabled.value;
  try {
    current.remove(group);
    rebuild();
    if (!groups.value.some((g) => g.uuid === selectedGroupUuid.value)) {
      selectedGroupUuid.value = "all";
    }
    const saved = await saveVault();
    if (saved) status.value = toTrash ? "分组已移到回收站" : "分组已删除";
    return saved;
  } catch (e) {
    error.value = `删除分组失败：${msg(e)}`;
    return false;
  }
}

/** 移动分组及其完整子树；失败的写盘保留为未保存修改，由现有保存管线重试。 */
async function moveGroup(
  uuid: string,
  targetUuid = "",
  position: "inside" | "before" | "after" = "inside"
): Promise<boolean> {
  const current = db.value;
  const source = groupRefs.get(uuid);
  if (!current || busy.value || !source) return false;
  error.value = "";
  try {
    if (!source.parentGroup || groupIsInTrash(source)) throw new Error("不能移动库根分组或回收站分组");
    if (!["inside", "before", "after"].includes(position)) throw new Error("无效的移动位置");
    const target = targetUuid ? groupRefs.get(targetUuid) : current.getDefaultGroup();
    if (!target || groupIsInTrash(target)) throw new Error("目标分组不存在或位于回收站");
    if (target === source) throw new Error("不能将分组移动到自身");
    const parent = position === "inside" ? target : target.parentGroup;
    if (!parent) throw new Error("不能在库根分组之前或之后插入分组");
    for (let ancestor: KdbxGroup | undefined = parent; ancestor; ancestor = ancestor.parentGroup) {
      if (ancestor === source) throw new Error("不能将分组移动到自己的子分组中");
    }
    const siblings = parent.groups.filter((group) => group !== source);
    const targetIndex = siblings.indexOf(target);
    const index = position === "inside" ? siblings.length : targetIndex + (position === "after" ? 1 : 0);
    if (source.parentGroup === parent && parent.groups.indexOf(source) === index) {
      return hasUnsavedChanges.value ? await saveVault() : true;
    }
    current.move(source, parent, index);
    rebuild();
    const saved = await saveVault();
    if (saved) status.value = "分组已移动";
    return saved;
  } catch (e) {
    error.value = `移动分组失败：${msg(e)}`;
    return false;
  }
}

async function addGroup(name: string, parentUuid = ""): Promise<void> {
  const current = db.value;
  if (!current || !name.trim()) return;
  try {
    const parent = groupRefs.get(parentUuid) ?? current.getDefaultGroup();
    current.createGroup(parent, name.trim());
    rebuild();
    await saveVault();
  } catch (e) {
    error.value = `新建分组失败：${msg(e)}`;
  }
}

/** 取某个条目的可编辑内容（密码要解出来，编辑表单需要明文） */
function draftOf(uuid: string): EntryDraft | null {
  const entry = entryRefs.get(uuid);
  if (!entry) return null;
  const expiry = entry.times.expiryTime;
  return {
    title: fieldText(entry, "Title"),
    username: fieldText(entry, "UserName"),
    password: fieldText(entry, "Password"),
    url: fieldText(entry, "URL"),
    notes: fieldText(entry, "Notes"),
    tags: entry.tags.join(", "),
    totp: fieldText(entry, "otp"),
    groupUuid: entry.parentGroup?.uuid.id ?? "",
    expires: !!entry.times.expires,
    expiryDate: expiry ? dateInputValue(expiry) : "",
    autoTypeSequence: entry.autoType.defaultSequence ?? "",
    customFields: [...entry.fields].filter(([name]) => !isReservedField(name)).map(([name, value]) => ({ name, originalName: name, value: typeof value === "string" ? value : value.getText(), protected: typeof value !== "string" })),
    removedFields: [],
  };
}

/** 条目的 TOTP 配置：优先 otpauth URI，其次 KeePassXC 的 TOTP Seed/Settings */
function totpConfigOf(uuid: string): TotpConfig | null {
  const entry = entryRefs.get(uuid);
  if (!entry) return null;

  const otp = fieldText(entry, "otp").trim();
  if (otp) {
    const parsed = parseTotpInput(otp);
    if (parsed) return parsed;
  }

  const seed = fieldText(entry, "TOTP Seed").trim();
  if (seed) {
    return parseLegacyTotp(seed, fieldText(entry, "TOTP Settings"));
  }
  return null;
}

/** 条目的 Auto-Type 序列（KDBX 的 DefaultSequence，缺省用标准序列） */
function autoTypeSequenceOf(uuid: string): string {
  const entry = entryRefs.get(uuid);
  const sequence = entry?.autoType?.defaultSequence;
  return (sequence && sequence.trim()) || DEFAULT_AUTO_TYPE;
}

/**
 * 触发自动输入。真正的按键注入在 Rust 侧：先收起面板、把焦点还给上一个前台窗口，
 * 再按解析出来的片段敲键（否则会往 KeyTree 自己身上打）。
 */
async function autoType(uuid: string): Promise<boolean> {
  const entry = entryRefs.get(uuid);
  if (!entry) return false;
  error.value = "";
  try {
    const parts = parseSequence(autoTypeSequenceOf(uuid), {
      username: fieldText(entry, "UserName"),
      password: fieldText(entry, "Password"),
    });
    await invoke("auto_type", { parts });
    void touchUsage(uuid);
    status.value = "已发送自动输入";
    void recordAudit("auto-type", uuid);
    return true;
  } catch (e) {
    error.value = `自动输入失败：${msg(e)}`;
    return false;
  }
}

const historyPending = ref(false);
watch(hasUnsavedChanges, dirty => { if (!dirty) historyPending.value = false; });
let historyMutating = false;

/** 历史记录（新的在前）；id 只代表本会话中的实际快照，不依赖数组位置或时间戳。 */
function historyOf(uuid: string): HistoryItem[] {
  return (entryRefs.get(uuid)?.history ?? []).map((snapshot, index) => ({
    id: historyToken(snapshot), note: historyNote(snapshot), index,
    title: fieldText(snapshot, "Title"), username: fieldText(snapshot, "UserName"),
    at: snapshot.times.lastModTime ?? null,
  })).reverse();
}

async function mutateHistory(uuid: string, id: string, action: (entry: KdbxEntry, index: number) => void, message: string): Promise<boolean> {
  if (historyMutating || busy.value || historyPending.value) return false;
  const entry = entryRefs.get(uuid);
  if (!entry) return false;
  historyMutating = true;
  error.value = "";
  try {
    const index = resolveHistory(entry, id);
    action(entry, index);
    rebuild();
    const ok = await saveVault();
    historyPending.value = !ok;
    if (ok) status.value = message;
    return ok;
  } catch (e) {
    error.value = `历史操作失败：${msg(e)}`;
    return false;
  } finally { historyMutating = false; }
}

function setHistoryNote(uuid: string, id: string, text: string): Promise<boolean> {
  return mutateHistory(uuid, id, (entry, index) => writeHistoryNote(entry.history[index], text), "历史备注已保存");
}

function deleteHistory(uuid: string, id: string): Promise<boolean> {
  return mutateHistory(uuid, id, (entry, index) => entry.removeHistory(index), "已删除所选历史版本");
}

function restoreHistory(uuid: string, id: string): Promise<boolean> {
  return mutateHistory(uuid, id, (entry, index) => {
    const snapshot = entry.history[index];
    pushHistory(entry);
    entry.copyFrom(snapshot);
    entry.times.update();
  }, "已恢复到该历史版本");
}

async function retryHistorySave(): Promise<boolean> {
  if (historyMutating || busy.value) return false;
  historyMutating = true;
  busy.value = true;
  try {
    const ok = await flushSave();
    historyPending.value = !ok;
    return ok;
  } finally { historyMutating = false; busy.value = false; }
}

function selectEntry(uuid: string): void {
  selectedUuid.value = uuid;
}

function selectGroup(uuid: string): void {
  selectedGroupUuid.value = uuid;
  selectedUuid.value = "";
}

function openCreateDrawer(): void {
  const selected = selectedGroupUuid.value;
  const inTrash = !!trash.value && selected === trash.value.uuid;
  const groupUuid =
    selected !== "all" && !inTrash ? selected : (groups.value[0]?.uuid ?? "");
  drawer.value = { open: true, mode: "create", uuid: "" };
  pendingGroup.value = groupUuid;
}

function openEditDrawer(uuid: string): void {
  drawer.value = { open: true, mode: "edit", uuid };
}

function closeDrawer(): void {
  drawer.value.open = false;
}

/**
 * 手动锁定/切库先确认落盘，失败保留解密态供重试或另存。
 * 锁屏/休眠/空闲锁定传 force：保存失败也必须清除解密态，并保留明确警告。
 * 返回值只表示是否已经锁定，不表示强制锁定前保存一定成功。
 */
async function lock(options: { force?: boolean } = {}): Promise<boolean> {
  clipboardLockRequests.value++;
  try {
    clipboardCaptureEpoch.value++;
    unlockGeneration++;
    encryptionGeneration++;
    invalidateWebdavSync();
    invalidateSnapshots();
    // Before any asynchronous save, cancel injection and conditionally clear only our clipboard.
    void invoke("cancel_auto_type").catch(() => {});
    void invoke("clear_secret_clipboard").catch(() => { toast("锁定时剪贴板清理失败，请手动清理", 6000); });
    const current = db.value;
    const flushed = await flushSave();
    // 并行锁定已完成时，直接回报实际状态，不覆盖另一调用的失败警告。
    if (db.value !== current) return !unlocked.value;
    if (!flushed && !options.force) {
      if (!error.value) error.value = "仍有未保存的修改，已取消锁定，请重试保存或另存 KDBX 副本";
      status.value = "锁定已取消：修改尚未全部写入磁盘";
      return false;
    }
    const lastSaveError = error.value;
    const lockSyncPath = vaultPath.value;
    const lockSyncStat = knownStat.value;
    const lockSyncFingerprint = savedCiphertextFingerprint;
    const lockSyncBaseline = lockSyncBaselineFingerprint;
    const shouldSyncOnLock = !!current && flushed && getSyncOnLock(lockSyncPath);
    // 只有真正执行锁定才停 watcher，取消锁定时保留外部变更监听。
    void invoke("watch_vault", { path: null }).catch(() => {});
    cancelScheduledSave();
    resetSaveState();
    cancelImport();
    favoritesOnly.value = false;
    knownStat.value = null;
    knownPublicData = "";
    db.value = null;
    vaultPath.value = "";
    keyFileBytes.value = null;
    groups.value = [];
    entries.value = [];
    entryRefs.clear();
    groupRefs.clear();
    trash.value = null;
    iconUrls.clear();
    hostIcons.clear();
    query.value = "";
    selectedGroupUuid.value = "all";
    selectedUuid.value = "";
    drawer.value.open = false;
    historyPending.value = false;
    error.value = "";
    status.value = "";
    if (!flushed) {
      error.value = `为保护密码库已强制锁定，但最近的修改未能保存${lastSaveError ? `：${lastSaveError}` : ""}`;
    }
    if (shouldSyncOnLock && lockSyncStat?.mtimeNs) {
      const generation = unlockGeneration;
      const active = () => db.value === null && unlockGeneration === generation && getSyncOnLock(lockSyncPath);
      void syncLockedVault(lockSyncPath, { ...lockSyncStat, mtimeNs: lockSyncStat.mtimeNs }, lockSyncFingerprint, lockSyncBaseline, active)
        .then(result => { if (active() && result === "synced") toast("已锁定，同步完成"); })
        .catch(reason => {
          if (!active() || reason === "WD_CANCELLED") return;
          error.value = reason === "WD_REMOTE_CHANGED"
            ? "已锁定；远端有变化，请解锁后手动同步。"
            : `已锁定，自动同步未完成：${webdavErrorMessage(reason)}`;
          toast(error.value, 6000);
        });
    }
    return true;
  } finally { clipboardLockRequests.value--; }
}

/** 查询同目录滚动备份（解锁失败时决定要不要给「从备份恢复」入口） */
function backupInfoOf(
  path: string
): Promise<{ exists: boolean; mtimeMs: number; size: number }> {
  return invoke<{ exists: boolean; mtimeMs: number; size: number }>("backup_info", {
    path,
  }).catch(() => ({ exists: false, mtimeMs: 0, size: 0 }));
}

/**
 * 用 `<库>.kdbx.bak` 覆盖当前文件（spec §7 损坏库的恢复路径）。
 * 损坏的原文件会被改名成 `.corrupt-<时间戳>` 留证，不会直接删。
 */
async function restoreBackup(path: string): Promise<boolean> {
  error.value = "";
  try {
    await invoke("restore_backup", { path });
    status.value = "已用备份覆盖当前文件，请重新解锁";
    return true;
  } catch (e) {
    error.value = `恢复备份失败：${msg(e)}`;
    return false;
  }
}

function vaultHealth() {
  return healthSummary(entries.value.filter(e => !e.inTrash).map(e => ({ id: e.uuid, password: fieldText(entryRefs.get(e.uuid)!, "Password"), expires: e.expires, expiryTime: e.expiryTime, hasTotp: !!totpConfigOf(e.uuid) })));
}
function vaultKdfDetails() { return db.value ? kdfDetails(db.value.header) : []; }
async function verifyCurrentBackup(): Promise<{ kind: string; text: string }> {
  const current = db.value, path = vaultPath.value, k = engine.value;
  if (!current || !k || !path) return { kind: "cancelled", text: "请先解锁" };
  try {
    const info = await invoke<{ exists: boolean; mtimeMs: number; size: number }>("backup_info", { path });
    if (!info.exists) return { kind: "missing", text: "尚无备份文件" };
    const bytes = await invoke<number[]>("read_vault", { path: `${path}.bak` });
    const problem = headerProblem(bytes);
    if (problem) return { kind: "invalid", text: "备份文件头损坏或版本不支持" };
    await k.Kdbx.load(new Uint8Array(bytes).buffer, current.credentials);
    if (db.value !== current || vaultPath.value !== path) return { kind: "cancelled", text: "密码库已切换或锁定，请重新检查" };
    const after = await backupInfoOf(path);
    if (after.mtimeMs !== info.mtimeMs || after.size !== info.size) return { kind: "changed", text: "备份在验证期间变化，请重新验证" };
    return { kind: "valid", text: "这份备份可用：已用当前凭据成功解密（仅验证，未写入）" };
  } catch (e) {
    if (db.value !== current || vaultPath.value !== path) return { kind: "cancelled", text: "密码库已切换或锁定" };
    const kind = classifyUnlockError(e, false).kind;
    return { kind, text: kind === "bad-key" ? "当前凭据无法打开备份：备份可能使用旧密码或密钥文件，不代表文件损坏" : kind === "corrupt" || kind === "unsupported" ? "备份损坏或格式不受支持" : "备份读取或验证失败，请检查文件权限" };
  }
}

function getMasterHint(): MasterHintResult {
  return db.value ? readMasterHint(db.value.header) : { kind: "none", text: "" };
}
async function setMasterHint(text: string): Promise<boolean> {
  const current = db.value, k = engine.value;
  if (!current || !k) { error.value = "请先解锁密码库后再编辑提示"; return false; }
  if (busy.value || saveBusy || syncing) { error.value = "密码库正在处理其他操作，请稍后再保存提示"; return false; }
  error.value = "";
  try {
    writeMasterHint(k, current.header, text);
    const saved = await saveVault();
    if (!saved || db.value !== current) return false;
    status.value = text.trim() ? "主密码提示已写入 KDBX（公开可读）" : "当前库的主密码提示已删除，旧备份可能仍保留旧提示";
    return true;
  } catch (e) {
    // 规则错误是固定文案，不包含输入的提示内容。
    error.value = e instanceof Error ? e.message : "提示保存失败，请重试";
    return false;
  }
}

function clearError(): void {
  error.value = "";
  errorKind.value = "none";
}

export function useVault() {
  return {
    // 状态
    unlocked,
    vaultPath,
    vaultInfo,
    vaultEncryption,
    encryptionPreview,
    testEncryptionSpeed,
    upgradeEncryption,
    groups,
    entries,
    visibleEntries,
    selectedGroup,
    selectedEntry,
    selectedGroupUuid,
    selectedUuid,
    query,
    sortMode,
    favoritesOnly,
    busy,
    hasUnsavedChanges,
    webdavState,
    webdavAvailability,
    refreshWebdavAvailability,
    setWebdavConfigSummary,
    snapshotPreview,
    snapshotError,
    listBackupSnapshots,
    createBackupSnapshot,
    previewBackupSnapshot,
    exportBackupSnapshot,
    clearSnapshotPreview,
    cancelBackupOperations: invalidateSnapshots,
    syncWebdav,
    resetWebdavSyncStatus,
    error,
    errorKind,
    status,
    drawer,
    pendingGroup,
    trash,
    recycleBinEnabled,
    selectedIsTrash,
    hasKeyFile,
    getMasterHint,
    setMasterHint,
    // 动作
    openVault,
    helloUnlock,
    refreshIcon,
    exportKdbx,
    exportCsv,
    importCsv,
    importPreview,
    importApplied,
    importCount,
    previewCsv,
    confirmImport,
    cancelImport,
    vaultHealth,
    vaultKdfDetails,
    verifyCurrentBackup,
    syncExternalChanges,
    createVault,
    saveVault,
    saveSoon,
    flushSave,
    backupInfoOf,
    restoreBackup,
    changeMasterPassword,
    applyKeyFile,
    createKeyFile,
    addEntry,
    updateEntry,
    removeEntry,
    restoreEntry,
    purgeEntry,
    emptyTrash,
    addGroup,
    moveGroup,
    renameGroup,
    deleteGroup,
    draftOf,
    totpConfigOf,
    autoTypeSequenceOf,
    autoType,
    historyOf,
    restoreHistory,
    setHistoryNote,
    deleteHistory,
    historyPending,
    retryHistorySave,
    toggleFavorite,
    touchUsage,
    selectEntry,
    selectGroup,
    openCreateDrawer,
    clipboardCaptureEpoch,
    clipboardCaptureBlocked,
    openEditDrawer,
    closeDrawer,
    lock,
    clearError,
  };
}
