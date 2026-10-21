import type { Kdbx, KdbxEntry, KdbxGroup, ProtectedValue } from "kdbxweb";
export interface SnapshotStat { mtimeMs: number; size: number; mtimeNs: string }
export interface SnapshotInfo { id: string; createdAt: number; size: number; stat: SnapshotStat }
export interface SnapshotList { items: SnapshotInfo[]; maxCount: number; maxTotalBytes: number }
export interface SnapshotSummary {
  currentEntries: number; snapshotEntries: number; added: number; removed: number; changed: number;
  currentGroups: number; snapshotGroups: number;
}
export interface SnapshotPreview { item: SnapshotInfo; summary: SnapshotSummary }
const messages: Record<string, string> = {
  SNAP_INVALID_ID: "备份版本无效，请刷新列表。",
  SNAP_IO: "备份读取或写入失败，请检查目录权限和可用空间。",
  SNAP_TOO_LARGE: "此操作仅支持不超过 64 MiB 的库文件。",
  SNAP_CHANGED: "备份或当前库版本已变化，请重新验证预览。",
  SNAP_INVALID_FILE: "备份不是有效的 KDBX 文件，未导出。",
  SNAP_TARGET_EXISTS: "目标文件已存在，未覆盖。请换一个新文件名。",
  SNAP_UNSUPPORTED: "此备份位置不支持安全操作，请换用普通本地目录。",
  SNAP_BAD_KEY: "当前凭据无法打开这份备份。它可能使用旧主密码或旧密钥文件，不能绕过验证。",
  SNAP_DIFFERENT_VAULT: "这份备份不属于当前密码库，未导出。",
  SNAP_LOCAL_SAVE: "当前修改未能全部保存，操作已停止。请先重试保存或另存当前库。",
  SNAP_CANCELLED: "密码库已锁定或切换，操作已取消。",
  SNAP_BUSY: "请先完成当前操作或关闭条目编辑，再管理备份。",
};
export function snapshotErrorMessage(error: unknown): string {
  const code = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return messages[code] ?? "备份操作未完成，请刷新列表后重试。";
}

function sameField(a: string | ProtectedValue | undefined, b: string | ProtectedValue | undefined): boolean {
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (a === undefined || b === undefined) return a === b;
  const left = typeof a === "string" ? new TextEncoder().encode(a) : a.getBinary();
  const right = typeof b === "string" ? new TextEncoder().encode(b) : b.getBinary();
  try { return left.length === right.length && left.every((value, i) => value === right[i]); }
  finally { left.fill(0); right.fill(0); }
}
function sameEntry(a: KdbxEntry, b: KdbxEntry): boolean {
  if (a.parentGroup?.uuid.id !== b.parentGroup?.uuid.id || a.fields.size !== b.fields.size) return false;
  for (const [key, value] of a.fields) if (!b.fields.has(key) || !sameField(value, b.fields.get(key))) return false;
  // Deliberately exclude access/save timestamps: they are not user content changes.
  const meta = (e: KdbxEntry) => JSON.stringify({
    tags: [...e.tags].sort(), expires: e.times.expires, expiry: e.times.expires ? Math.floor((e.times.expiryTime?.getTime() ?? 0) / 1000) : null,
    icon: e.icon, customIcon: e.customIcon?.id, autoType: { ...e.autoType, defaultSequence: e.autoType.defaultSequence ?? "" }, overrideUrl: e.overrideUrl ?? "",
    fg: e.fgColor ?? "", bg: e.bgColor ?? "", quality: e.qualityCheck,
    customData: [...(e.customData ?? [])].map(([key, item]) => [key, item.value]).sort(([x], [y]) => String(x).localeCompare(String(y))),
  });
  return meta(a) === meta(b);
}
function groupCount(group: KdbxGroup): number { return 1 + group.groups.reduce((n, child) => n + groupCount(child), 0); }
/** Counts only. Never return field values, entry titles, passwords, or a decrypted database. */
export function summarizeSnapshot(current: Kdbx, snapshot: Kdbx): SnapshotSummary {
  const root = current.getDefaultGroup(), previousRoot = snapshot.getDefaultGroup();
  if (root.uuid.id !== previousRoot.uuid.id) throw "SNAP_DIFFERENT_VAULT";
  const live = new Map([...root.allEntries()].map(entry => [entry.uuid.id, entry]));
  const previous = new Map([...previousRoot.allEntries()].map(entry => [entry.uuid.id, entry]));
  let added = 0, removed = 0, changed = 0;
  for (const [id, entry] of previous) { const value = live.get(id); if (!value) added++; else if (!sameEntry(value, entry)) changed++; }
  for (const id of live.keys()) if (!previous.has(id)) removed++;
  return { currentEntries: live.size, snapshotEntries: previous.size, added, removed, changed, currentGroups: groupCount(root), snapshotGroups: groupCount(previousRoot) };
}
