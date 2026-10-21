import type { Kdbx, KdbxEntry } from "kdbxweb";

const NOTE_KEY = "keytree.historyNote";
const tokens = new WeakMap<KdbxEntry, string>();
let nextToken = 0;
let lastNoteTime = 0;

export function historyToken(snapshot: KdbxEntry): string {
  let token = tokens.get(snapshot);
  if (!token) { token = `history-${++nextToken}`; tokens.set(snapshot, token); }
  return token;
}

export function resolveHistory(entry: KdbxEntry, token: string): number {
  const matches = entry.history.flatMap((snapshot, i) => historyToken(snapshot) === token ? [i] : []);
  if (matches.length !== 1) throw new Error("历史版本已变化，请刷新后重新选择");
  return matches[0];
}

function noteData(snapshot: KdbxEntry): { text: string; modified: number } | null {
  const raw = snapshot.customData?.get(NOTE_KEY)?.value;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.text === "string" && Number.isFinite(parsed.modified)) return parsed;
  } catch { /* Earlier plain-text annotations are still readable. */ }
  return { text: raw, modified: 0 };
}

export function historyNote(snapshot: KdbxEntry): string { return noteData(snapshot)?.text ?? ""; }

export function writeHistoryNote(snapshot: KdbxEntry, text: string): void {
  if (text.includes("\0")) throw new Error("历史备注不能包含 NUL 字符");
  if ([...text].length > 200) throw new Error("历史备注最多 200 个字符");
  const modified = lastNoteTime = Math.max(Date.now(), lastNoteTime + 1, (noteData(snapshot)?.modified ?? 0) + 1);
  snapshot.customData ??= new Map();
  // An explicit empty annotation is a clear operation, not missing metadata.
  snapshot.customData.set(NOTE_KEY, { value: JSON.stringify({ text, modified }), lastModified: new Date(modified) });
}

export function copySnapshotMetadata(source: KdbxEntry, target: KdbxEntry): void {
  target.customData = source.customData ? new Map([...source.customData].filter(([key]) => key !== NOTE_KEY).map(([key, value]) => [key, { ...value }])) : undefined;
}

// Only used transiently during merge; never persisted, logged or used as a UI identifier.
function contentKey(snapshot: KdbxEntry): string {
  const valueKey = (v: unknown): unknown => {
    if (v && typeof v === "object" && "getText" in v) return (v as { getText(): string }).getText();
    if (v instanceof ArrayBuffer) return [...new Uint8Array(v)];
    if (v && typeof v === "object" && "hash" in v) return (v as { hash: string }).hash;
    return v;
  };
  return JSON.stringify([snapshot.times.lastModTime ? Math.floor(snapshot.times.lastModTime.getTime() / 1000) : null, [...snapshot.fields].sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => [k,valueKey(v)]), [...snapshot.binaries].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => [k,valueKey(v)]), snapshot.tags, snapshot.autoType, snapshot.icon, snapshot.customIcon?.id, snapshot.times.expires, snapshot.times.expiryTime ? Math.floor(snapshot.times.expiryTime.getTime() / 1000) : null, snapshot.fgColor || "", snapshot.bgColor || "", snapshot.overrideUrl || ""]);
}

export function mergeWithHistoryNotes(current: Kdbx, remote: Kdbx): void {
  const notes = new Map<string, Map<string, { text: string; modified: number }>>();
  for (const database of [remote, current]) {
    for (const entry of database.getDefaultGroup().allEntries()) {
      const byContent = notes.get(entry.uuid.id) ?? new Map();
      const counts = new Map<string, number>();
      for (const snapshot of entry.history) { const key = contentKey(snapshot); counts.set(key, (counts.get(key) ?? 0) + 1); }
      for (const snapshot of entry.history) {
        const data = noteData(snapshot);
        if (!data) continue;
        const key = contentKey(snapshot);
        if (counts.get(key) !== 1) throw new Error("历史备注目标存在歧义，无法自动合并，请先另存当前库");
        if (!byContent.has(key) || data.modified >= byContent.get(key)!.modified) byContent.set(key, data);
      }
      notes.set(entry.uuid.id, byContent);
    }
  }
  // Refuse before mutation if another indistinguishable snapshot could receive the note.
  for (const database of [current, remote]) {
    for (const entry of database.getDefaultGroup().allEntries()) {
      const counts = new Map<string, number>();
      for (const snapshot of entry.history) { const key = contentKey(snapshot); counts.set(key, (counts.get(key) ?? 0) + 1); }
      for (const [key, count] of counts) if (count > 1 && notes.get(entry.uuid.id)?.has(key)) throw new Error("历史备注目标存在歧义，无法自动合并，请先另存当前库");
    }
  }
  // KDBX stores seconds. Align only uniquely matching content, including the live state,
  // so loading our own saved replica cannot manufacture a duplicate millisecond version.
  const remoteEntries = new Map([...remote.getDefaultGroup().allEntries()].map(entry => [entry.uuid.id, entry]));
  for (const entry of current.getDefaultGroup().allEntries()) {
    const counterpart = remoteEntries.get(entry.uuid.id);
    if (!counterpart) continue;
    const align = (local: KdbxEntry, other: KdbxEntry) => {
      const before = local.times.lastModTime?.getTime();
      const after = other.times.lastModTime?.getTime();
      if (before === undefined || after === undefined || before === after) return;
      local.times.lastModTime = new Date(after);
      if (entry._editState) {
        entry._editState.added = entry._editState.added.map(time => time === before ? after : time);
        entry._editState.deleted = entry._editState.deleted.map(time => time === before ? after : time);
      }
    };
    if (contentKey(entry) === contentKey(counterpart)) align(entry, counterpart);
    for (const snapshot of entry.history) {
      const key = contentKey(snapshot);
      const localMatches = entry.history.filter(item => contentKey(item) === key);
      const remoteMatches = counterpart.history.filter(item => contentKey(item) === key);
      if (localMatches.length === 1 && remoteMatches.length === 1) align(snapshot, remoteMatches[0]);
    }
  }
  current.merge(remote);
  for (const entry of current.getDefaultGroup().allEntries()) {
    const byContent = notes.get(entry.uuid.id);
    if (!byContent?.size) continue;
    for (const snapshot of entry.history) {
      const data = byContent.get(contentKey(snapshot));
      if (!data) continue;
      snapshot.customData ??= new Map();
      snapshot.customData.set(NOTE_KEY, { value: JSON.stringify(data), lastModified: new Date(data.modified) });
    }
  }
}
