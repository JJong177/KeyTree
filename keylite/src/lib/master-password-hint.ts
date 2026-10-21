import type { KdbxHeader } from "kdbxweb";
import type { Kdbxweb } from "../kdbx/kdbxweb";
export const MASTER_HINT_KEY = "keytree.masterPasswordHint";
export const MAX_HINT_CHARS = 200;
export const MAX_PUBLIC_HEADER_BYTES = 1024 * 1024;
export type MasterHintResult = { kind: "hint"; text: string } | { kind: "none" | "unsupported" | "invalid" | "too-large"; text: "" };
export function validateMasterHint(text: string): string {
  if ([...text].length > MAX_HINT_CHARS || text.includes("\0")) throw new Error("主密码提示最多 200 个字符，且不能含空字符");
  return text.trim() ? text : "";
}
export function readMasterHint(header: Pick<KdbxHeader, "versionMajor" | "publicCustomData">): MasterHintResult {
  if (header.versionMajor !== 4) return { kind: "unsupported", text: "" };
  const value = header.publicCustomData?.get(MASTER_HINT_KEY);
  if (value === undefined || value === "") return { kind: "none", text: "" };
  if (typeof value !== "string") return { kind: "invalid", text: "" };
  try { return validateMasterHint(value) ? { kind: "hint", text: value } : { kind: "none", text: "" }; }
  catch { return { kind: "invalid", text: "" }; }
}
export function writeMasterHint(k: Kdbxweb, header: KdbxHeader, text: string): void {
  if (header.versionMajor !== 4) throw new Error("主密码提示仅支持 KDBX 4，不会自动升级当前库");
  const value = validateMasterHint(text);
  if (!value) { header.publicCustomData?.remove(MASTER_HINT_KEY); return; }
  header.publicCustomData ??= new k.VarDictionary();
  header.publicCustomData.set(MASTER_HINT_KEY, k.VarDictionary.ValueType.String, value);
}
/** 保守比较完整公开字典，保证条目级 merge 不静默丢掉外部公开元数据。 */
export function publicDataSnapshot(k: Kdbxweb, header: Pick<KdbxHeader, "publicCustomData">): string {
  if (!header.publicCustomData?.length) return "";
  const stream = new k.BinaryStream(); header.publicCustomData.write(stream);
  return Array.from(new Uint8Array(stream.getWrittenBytes()), b => b.toString(16).padStart(2, "0")).join("");
}
/** 在调用引擎前验证字典中的每个长度；不让截断 readBytes 被宽容处理。 */
function validDictionary(data: Uint8Array): boolean {
  if (data.length < 3 || data[1] !== 1) return false;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength), keys = new Set<string>();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let at = 2;
  try {
    for (let count = 0; count < MAX_PUBLIC_HEADER_BYTES; count++) {
      if (at >= data.length) return false;
      const type = data[at++];
      if (type === 0) return at === data.length;
      if (at + 4 > data.length) return false;
      const keyLength = view.getInt32(at, true); at += 4;
      if (keyLength <= 0 || keyLength > data.length - at) return false;
      const key = decoder.decode(data.subarray(at, at + keyLength)); at += keyLength;
      if (keys.has(key)) return false; keys.add(key);
      if (at + 4 > data.length) return false;
      const length = view.getInt32(at, true); at += 4;
      if (length < 0 || length > data.length - at) return false;
      const fixed: Record<number, number> = { 4: 4, 5: 8, 8: 1, 12: 4, 13: 8 };
      if (type in fixed) { if (length !== fixed[type]) return false; }
      else if (type === 0x18) decoder.decode(data.subarray(at, at + length));
      else if (type !== 0x42) return false;
      at += length;
    }
  } catch { return false; }
  return false;
}
export function parseMasterHint(k: Kdbxweb, bytes: Uint8Array): MasterHintResult {
  if (bytes.length < 12) return { kind: "invalid", text: "" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 0x9aa2d903 || view.getUint32(4, true) !== 0xb54bfb67) return { kind: "invalid", text: "" };
  const version = view.getUint32(8, true), major = version >>> 16;
  if (major !== 4 || (version & 0xffff) > 1) return { kind: "unsupported", text: "" };
  let at = 12;
  const fields = new Set<number>();
  try {
    while (at < bytes.length) {
      if (at + 5 > MAX_PUBLIC_HEADER_BYTES) return { kind: "too-large", text: "" };
      if (at + 5 > bytes.length) return { kind: "invalid", text: "" };
      const id = bytes[at++], length = view.getUint32(at, true); at += 4;
      if (length > MAX_PUBLIC_HEADER_BYTES - at) return { kind: "too-large", text: "" };
      if (fields.has(id) || length > bytes.length - at) return { kind: "invalid", text: "" };
      fields.add(id);
      const data = bytes.subarray(at, at + length); at += length;
      if (id === 0) {
        if (length !== 4 || ![[13, 10, 13, 10], [0, 208, 173, 10]].some(end => end.every((b, i) => b === data[i]))) return { kind: "invalid", text: "" };
        const buffer = bytes.slice(0, at).buffer;
        const header = k.KdbxHeader.read(new k.BinaryStream(buffer), new k.KdbxContext({ kdbx: new k.Kdbx() }));
        return readMasterHint(header);
      }
      if ((id === 11 || id === 12) && !validDictionary(data)) return { kind: "invalid", text: "" };
    }
  } catch { return { kind: "invalid", text: "" }; }
  return { kind: "invalid", text: "" };
}
