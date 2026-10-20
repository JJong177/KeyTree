import { computed, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import type { Kdbx, KdbxEntry, KdbxGroup } from "kdbxweb";
import { getKdbxweb, type Kdbxweb } from "../kdbx/kdbxweb";
import { installArgon2 } from "../kdbx/argon2";
import {
  parseLegacyTotp,
  parseOtpauth,
  type TotpConfig,
} from "../lib/totp";
import { dateInputValue, hostOf } from "../lib/format";
import { DEFAULT_AUTO_TYPE, parseSequence } from "../lib/autotype";
import { settings, upsertVault } from "../lib/settings";
import { fetchFavicon, bytesToDataUrl } from "../lib/favicon";
import { parseCsv, detectColumns, buildChromeCsv } from "../lib/csv";
import { toast } from "../lib/toast";

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
  /** 自定义图标（favicon）的 data URL；null = 没有图标，调用方降级为字母头像 */
  icon: string | null;
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
}

export interface HistoryItem {
  index: number;
  title: string;
  username: string;
  at: Date | null;
}

export type SortMode = "recent" | "title";

const db = shallowRef<Kdbx | null>(null);
const engine = shallowRef<Kdbxweb | null>(null);
const vaultPath = ref("");
const groups = ref<GroupVM[]>([]);
const entries = ref<EntryVM[]>([]);
const busy = ref(false);
const error = ref("");
const status = ref("");
const query = ref("");
const sortMode = ref<SortMode>("recent");
const selectedGroupUuid = ref("all");
const selectedUuid = ref("");
const drawer = ref<{ open: boolean; mode: "create" | "edit"; uuid: string }>({
  open: false,
  mode: "create",
  uuid: "",
});
/** 新建抽屉默认落在哪个分组 */
const pendingGroup = ref("");
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
  return !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;
}

/**
 * 用当前凭据（Credentials 实例只含 hash，无需明文密码）load 磁盘最新版，
 * 三方合并进内存库并刷新视图。不落盘——落盘由调用方决定。
 * 外部版本解不开（比如被改过密码）时返回 false 并写 error。
 */
async function mergeFromDisk(): Promise<boolean> {
  const k = engine.value;
  const current = db.value;
  const path = vaultPath.value;
  if (!k || !current || !path || syncing) return false;
  syncing = true;
  try {
    const bytes = await invoke<number[]>("read_vault", { path });
    const remote = await k.Kdbx.load(
      new Uint8Array(bytes).buffer,
      current.credentials
    );
    current.merge(remote);
    rebuild();
    return true;
  } catch (e) {
    error.value = `外部修改无法自动合并（${unlockErrorText(e)}），请先保存或另存你的版本`;
    return false;
  } finally {
    syncing = false;
  }
}

/**
 * watcher 事件触发的同步：合并外部修改并落盘。
 * 落盘会产生新的 watcher 事件，但 knownStat 已更新，会被 stat 比对忽略。
 */
async function syncExternalChanges(): Promise<void> {
  if (!unlocked.value || busy.value || syncing) return;
  const merged = await mergeFromDisk();
  if (merged) {
    await saveVault();
    status.value = `已合并磁盘上的外部修改 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
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
const vaultInfo = computed(() => {
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
  const q = query.value.trim().toLowerCase();
  if (q) {
    list = list.filter((e) =>
      [e.title, e.username, e.url, e.notes, ...e.tags]
        .join("\n")
        .toLowerCase()
        .includes(q)
    );
  }
  const sorted = [...list];
  if (sortMode.value === "title") {
    sorted.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN"));
  } else {
    sorted.sort(
      (a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0)
    );
  }
  return sorted;
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
    icon: entry.customIcon ? iconUrlOf(entry.customIcon.id) : null,
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

async function writeBytes(path: string, buffer: ArrayBuffer): Promise<void> {
  await invoke("write_vault", {
    path,
    bytes: Array.from(new Uint8Array(buffer)),
  });
  // 更新已知 stat：这样 watcher 收到自己写入的事件时能认出来并忽略
  if (path === vaultPath.value) {
    knownStat.value = await statOf(path);
  }
}

/** kdbxweb 的 InvalidKey = 复合密钥摘要不匹配，翻成人话 */
function unlockErrorText(e: unknown): string {
  const text = msg(e);
  if (/InvalidKey/i.test(text)) {
    return "主密码不正确（也可能是这个文件不是有效的 KDBX 库）";
  }
  return text;
}

function tryLoad(
  k: Kdbxweb,
  bytes: number[],
  password: string,
  keyFile: Uint8Array | null
): Promise<Kdbx> {
  return k.Kdbx.load(
    new Uint8Array(bytes).buffer,
    new k.Credentials(k.ProtectedValue.fromString(password), keyFile)
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
  try {
    if (!settings.quickUnlock) {
      await invoke("quick_unlock_clear").catch(() => {});
      return;
    }    const secret = JSON.stringify({
      p: password,
      k: keyFile ? Array.from(keyFile) : null,
    });
    await invoke("quick_unlock_save", {
      vaultPath: path,
      secret: Array.from(new TextEncoder().encode(secret)),
    });
  } catch {
    // 存不进去就回到纯主密码解锁，不影响主流程
  }
}

/** Windows Hello 快速解锁：Hello 验证通过后（由 UI 先调 hello_verify）用缓存凭据直接开库 */
async function helloUnlock(path: string): Promise<boolean> {
  busy.value = true;
  error.value = "";
  try {
    const secretBytes = await invoke<number[]>("quick_unlock_load", { vaultPath: path });
    const decoded = JSON.parse(
      new TextDecoder().decode(new Uint8Array(secretBytes))
    ) as { p: string; k: number[] | null };
    const keyFile = decoded.k ? new Uint8Array(decoded.k) : null;
    const ok = await openVault(path, decoded.p, keyFile);
    if (!ok) {
      // 缓存凭据失效（改过密码 / 换过密钥文件）：清掉这个库的，避免按钮一直误导
      await invoke("quick_unlock_clear", { vaultPath: path }).catch(() => {});
      error.value = "快速解锁的缓存凭据已失效，请用主密码解锁";
    }
    return ok;
  } catch (e) {
    error.value = `快速解锁不可用：${msg(e)}，请用主密码解锁`;
    return false;
  } finally {
    busy.value = false;
  }
}

async function openVault(
  path: string,
  password: string,
  keyFile: Uint8Array | null = null
): Promise<boolean> {
  busy.value = true;
  error.value = "";
  status.value = "读取文件…";
  try {
    const k = await ensureEngine();
    const bytes = await invoke<number[]>("read_vault", { path });
    status.value = "解密中…";

    let loaded: Kdbx;
    let note = "";
    try {
      loaded = await tryLoad(k, bytes, password, keyFile);
    } catch (e) {
      // 从网页/聊天窗口复制主密码时常带首尾空白，密码框里又看不出来。
      // 只在确实存在空白时重试一次，并明确告知，绝不静默修改用户密码。
      const trimmed = password.trim();
      if (!trimmed || trimmed === password) throw e;
      loaded = await tryLoad(k, bytes, trimmed, keyFile);
      note = "已忽略主密码首尾的空白字符";
    }

    db.value = loaded;
    vaultPath.value = path;
    keyFileBytes.value = keyFile;
    selectedGroupUuid.value = "all";
    query.value = "";
    rebuild();
    selectedUuid.value = visibleEntries.value[0]?.uuid ?? "";
    status.value = note;
    settings.lastVaultPath = path;
    upsertVault(path);
    // note 非空说明 trim 重试才成功，生效密码是去空白后的那个
    void stashQuickUnlock(path, note ? password.trim() : password, keyFile);
    // 开始盯文件（外部修改 → 自动合并）
    knownStat.value = await statOf(path);
    void invoke("watch_vault", { path }).catch(() => {});
    return true;
  } catch (e) {
    status.value = "";
    // 只针对「输入法全角 / 各种连字符变体」这类肉眼几乎看不出来的坑，
    // 别把中文主密码误判成可疑输入
    const suspicious = /[\uFF01-\uFF5E\u3000\u2010-\u2015]/.test(password)
      ? "；注意密码里有全角或连字符变体，可能和实际密码不是同一个字符"
      : "";
    error.value = `解锁失败：${unlockErrorText(e)}${suspicious}`;
    return false;
  } finally {
    busy.value = false;
  }
}

async function createVault(
  path: string,
  name: string,
  password: string,
  keyFile: Uint8Array | null = null
): Promise<boolean> {
  busy.value = true;
  error.value = "";
  status.value = "创建数据库…";
  try {
    const k = await ensureEngine();
    const credentials = new k.Credentials(
      k.ProtectedValue.fromString(password),
      keyFile
    );
    const created = k.Kdbx.create(credentials, name || "我的密码库");
    // kdbxweb 默认 Argon2d，KeyTree 统一用 Argon2id（KeePassXC 同款默认）
    created.setKdf(k.Consts.KdfId.Argon2id);
    status.value = "加密中（Argon2id，约 1-2 秒）…";
    const saved = await created.save();
    status.value = "写入磁盘…";
    await writeBytes(path, saved);

    db.value = created;
    vaultPath.value = path;
    keyFileBytes.value = keyFile;
    selectedGroupUuid.value = "all";
    query.value = "";
    rebuild();
    selectedUuid.value = visibleEntries.value[0]?.uuid ?? "";
    status.value = "";
    settings.lastVaultPath = path;
    upsertVault(path);
    void stashQuickUnlock(path, password, keyFile);
    knownStat.value = await statOf(path);
    void invoke("watch_vault", { path }).catch(() => {});
    return true;
  } catch (e) {
    error.value = `创建失败：${msg(e)}`;
    return false;
  } finally {
    busy.value = false;
  }
}

async function saveVault(): Promise<boolean> {
  const current = db.value;
  if (!current || !vaultPath.value) return false;
  busy.value = true;
  try {
    // 保存前检测（spec §8.2 双保险）：watcher 漏掉的外部变更在这里兜住
    if (knownStat.value) {
      const stat = await statOf(vaultPath.value);
      if (stat && !sameStat(stat, knownStat.value)) {
        busy.value = false;
        const merged = await mergeFromDisk();
        if (merged) {
          status.value = "检测到外部修改，已合并后再保存";
        }
        busy.value = true;
      }
    }
    const saved = await current.save();
    await writeBytes(vaultPath.value, saved);
    status.value = `已保存 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
    return true;
  } catch (e) {
    error.value = `保存失败：${msg(e)}`;
    return false;
  } finally {
    busy.value = false;
  }
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
        keyFileBytes.value
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
    await current.credentials.setKeyFile(bytes);
    keyFileBytes.value = bytes;
    const ok = await saveVault();
    if (ok) {
      status.value = bytes
        ? "已启用密钥文件：以后打开这个库必须同时提供它"
        : "已移除密钥文件";
      // 缓存的解锁凭据已过期（密钥文件变了），只清这个库的，其他库不动
      await invoke("quick_unlock_clear", { vaultPath: vaultPath.value }).catch(() => {});
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
      await saveVault();
      rebuild();
      return true;
    }
    return false;
  }

  try {
    const bytes = await fetchFavicon(fieldText(entry, "URL"));
    if (!bytes || !db.value) return false;
    const iconUuid = engine.value!.KdbxUuid.random();
    db.value.meta.customIcons.set(iconUuid.id, { data: bytes, name: host });
    entry.customIcon = iconUuid;
    hostIcons.set(host, iconUuid.id);
    await saveVault();
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

/**
 * 导入 CSV：表头自动识别（Chrome/Edge 的 name,url,username,password、
 * KeePassXC 的 Group,Title,Username,Password,URL,Notes 都行），Group 列可分层建组。
 * 返回导入条数；失败返回 0 并把原因写进 error。
 */
async function importCsv(path: string): Promise<number> {
  const current = db.value;
  if (!current) return 0;
  try {
    const bytes = await invoke<number[]>("read_vault", { path });
    const text = new TextDecoder("utf-8").decode(new Uint8Array(bytes));
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error("CSV 里没有数据行");
    const cols = detectColumns(rows[0]);
    if (!cols) {
      throw new Error("认不出表头：需要包含 title/name、username、password、url 之类的列");
    }
    let imported = 0;
    for (const row of rows.slice(1)) {
      const get = (idx: number): string =>
        idx >= 0 && row[idx] ? row[idx].trim() : "";
      const title = get(cols.title);
      const username = get(cols.username);
      const password = get(cols.password);
      if (!title && !username && !password) continue;
      const group =
        cols.group >= 0
          ? ensureGroupPath((row[cols.group] ?? "").split("/"))
          : current.getDefaultGroup();
      const entry = current.createEntry(group);
      applyDraft(entry, {
        title: title || "(无标题)",
        username,
        password,
        url: get(cols.url),
        notes: get(cols.notes),
        tags: "",
        totp: get(cols.totp),
        groupUuid: group.uuid.id,
        expires: false,
        expiryDate: "",
      });
      imported++;
    }
    rebuild();
    await saveVault();
    status.value = `已导入 ${imported} 条`;
    return imported;
  } catch (e) {
    error.value = `导入失败：${msg(e)}`;
    return 0;
  }
}

function pushHistory(entry: KdbxEntry): void {
  entry.pushHistory();
  const overflow = entry.history.length - HISTORY_LIMIT;
  if (overflow > 0) entry.removeHistory(0, overflow);
}

function applyDraft(entry: KdbxEntry, draft: EntryDraft): void {
  const k = engine.value;
  if (!k) return;
  entry.fields.set("Title", draft.title.trim());
  entry.fields.set("UserName", draft.username.trim());
  entry.fields.set("Password", k.ProtectedValue.fromString(draft.password));
  entry.fields.set("URL", draft.url.trim());
  entry.fields.set("Notes", draft.notes);
  if (draft.totp.trim()) {
    entry.fields.set("otp", draft.totp.trim());
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
    const group = groupRefs.get(draft.groupUuid) ?? current.getDefaultGroup();
    const entry = current.createEntry(group);
    applyDraft(entry, draft);
    rebuild();
    selectedUuid.value = entry.uuid.id;
    await saveVault();
    // 站点图标后台补抓，不阻塞保存
    void maybeFetchIcon(entry.uuid.id);
    return entry.uuid.id;
  } catch (e) {
    error.value = `新建条目失败：${msg(e)}`;
    return null;
  }
}

async function updateEntry(uuid: string, draft: EntryDraft): Promise<boolean> {
  const current = db.value;
  const entry = entryRefs.get(uuid);
  if (!current || !entry) return false;
  error.value = "";
  try {
    const target = groupRefs.get(draft.groupUuid);
    if (target && entry.parentGroup?.uuid.id !== target.uuid.id) {
      current.move(entry, target);
    }
    pushHistory(entry);
    applyDraft(entry, draft);
    rebuild();
    selectedUuid.value = uuid;
    await saveVault();
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

async function deleteGroup(uuid: string): Promise<void> {
  const current = db.value;
  const group = groupRefs.get(uuid);
  if (!current || !group) return;
  if (group.uuid.id === current.getDefaultGroup().uuid.id) {
    error.value = "根分组不能删除";
    return;
  }
  error.value = "";
  const toTrash = recycleBinEnabled.value;
  try {
    current.remove(group);
    rebuild();
    if (!groups.value.some((g) => g.uuid === selectedGroupUuid.value)) {
      selectedGroupUuid.value = "all";
    }
    await saveVault();
    status.value = toTrash ? "分组已移到回收站" : "分组已删除";
  } catch (e) {
    error.value = `删除分组失败：${msg(e)}`;
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
  };
}

/** 条目的 TOTP 配置：优先 otpauth URI，其次 KeePassXC 的 TOTP Seed/Settings */
function totpConfigOf(uuid: string): TotpConfig | null {
  const entry = entryRefs.get(uuid);
  if (!entry) return null;

  const otp = fieldText(entry, "otp").trim();
  if (otp) {
    const parsed = parseOtpauth(otp);
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
    status.value = "已发送自动输入";
    return true;
  } catch (e) {
    error.value = `自动输入失败：${msg(e)}`;
    return false;
  }
}

/** 历史记录（新的在前） */
function historyOf(uuid: string): HistoryItem[] {
  const entry = entryRefs.get(uuid);
  if (!entry) return [];
  return entry.history
    .map((snapshot, index) => ({
      index,
      title: fieldText(snapshot, "Title"),
      username: fieldText(snapshot, "UserName"),
      at: snapshot.times.lastModTime ?? null,
    }))
    .reverse();
}

/** 把某条历史快照写回当前条目（当前状态会先入历史，可再撤回） */
async function restoreHistory(uuid: string, index: number): Promise<void> {
  const entry = entryRefs.get(uuid);
  if (!entry) return;
  const snapshot = entry.history[index];
  if (!snapshot) return;
  error.value = "";
  try {
    pushHistory(entry);
    entry.fields = new Map(snapshot.fields);
    entry.tags = [...snapshot.tags];
    entry.times.update();
    rebuild();
    selectedUuid.value = uuid;
    await saveVault();
    status.value = "已恢复到该历史版本";
  } catch (e) {
    error.value = `恢复历史失败：${msg(e)}`;
  }
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

function lock(): void {
  // 注意：快速解锁密钥副本此时不删——它是 DPAPI 密文，锁定态下仍可用于
  // Hello 快速解锁（spec §7.1 日常体验）；真正弃用发生在改密 / 换密钥文件 / 退出应用
  if (vaultPath.value) {
    void invoke("watch_vault", { path: null }).catch(() => {});
  }
  knownStat.value = null;
  db.value = null;
  vaultPath.value = "";
  keyFileBytes.value = null;
  groups.value = [];
  entries.value = [];
  entryRefs.clear();
  groupRefs.clear();
  trash.value = null;
  query.value = "";
  selectedGroupUuid.value = "all";
  selectedUuid.value = "";
  drawer.value.open = false;
  error.value = "";
  status.value = "";
}

function clearError(): void {
  error.value = "";
}

export function useVault() {
  return {
    // 状态
    unlocked,
    vaultPath,
    vaultInfo,
    groups,
    entries,
    visibleEntries,
    selectedGroup,
    selectedEntry,
    selectedGroupUuid,
    selectedUuid,
    query,
    sortMode,
    busy,
    error,
    status,
    drawer,
    pendingGroup,
    trash,
    recycleBinEnabled,
    selectedIsTrash,
    hasKeyFile,
    // 动作
    openVault,
    helloUnlock,
    refreshIcon,
    exportKdbx,
    exportCsv,
    importCsv,
    syncExternalChanges,
    createVault,
    saveVault,
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
    renameGroup,
    deleteGroup,
    draftOf,
    totpConfigOf,
    autoTypeSequenceOf,
    autoType,
    historyOf,
    restoreHistory,
    selectEntry,
    selectGroup,
    openCreateDrawer,
    openEditDrawer,
    closeDrawer,
    lock,
    clearError,
  };
}
