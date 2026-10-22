export interface CustomFieldDraft { name: string; value: string; protected: boolean; originalName?: string }
export const RESERVED_FIELDS = new Set(["title", "username", "password", "url", "notes", "otp", "totp seed", "totp settings"]);
export function isReservedField(name: string): boolean { return RESERVED_FIELDS.has(name.trim().toLowerCase()); }
export function validateCustomFields(fields: CustomFieldDraft[]): void {
  if (fields.length > 100) throw new Error("自定义字段最多 100 项");
  const names = new Set<string>(), originals = new Set<string>();
  for (const field of fields) {
    const name = field.name.trim(), key = name.toLowerCase();
    if (!name || name.length > 128 || /[\r\n\0]/.test(name)) throw new Error("字段名不能为空、超长或含换行");
    if (isReservedField(name)) throw new Error("自定义字段不能占用标准字段名称");
    if (names.has(key)) throw new Error("自定义字段名不能重复");
    names.add(key);
    if (field.originalName) {
      if (isReservedField(field.originalName) || originals.has(field.originalName)) throw new Error("原字段身份不合法");
      originals.add(field.originalName);
    }
  }
}
export function validateSequence(sequence: string): void {
  if (sequence.length > 2048) throw new Error("自动输入序列过长");
  for (const token of sequence.match(/\{[^}]*\}/g) ?? []) {
    if (!/^\{(?:USERNAME|PASSWORD|TAB|ENTER|DELAY\s+\d+)\}$/i.test(token)) throw new Error("仅支持 USERNAME、PASSWORD、TAB、ENTER 和 DELAY n");
    const delay = token.match(/^\{DELAY\s+(\d+)\}$/i);
    if (delay && Number(delay[1]) > 5000) throw new Error("单次延时最多 5000 毫秒");
  }
  if (/[{}]/.test(sequence.replace(/\{[^}]*\}/g, ""))) throw new Error("序列中的花括号不完整");
}
export function applyCustomFields<T>(map: Map<string, string | T>, fields: CustomFieldDraft[], removed: string[], protect: (text: string) => T): void {
  validateCustomFields(fields);
  for (const key of removed) if (isReservedField(key)) throw new Error("不能删除标准字段");
  const existing = new Set(map.keys());
  const managed = new Set([...removed, ...fields.map(f => f.originalName).filter((n): n is string => !!n)]);
  for (const field of fields) {
    if (existing.has(field.name.trim()) && !managed.has(field.name.trim())) throw new Error("字段名与已有字段冲突");
  }
  for (const key of managed) map.delete(key);
  for (const field of fields) map.set(field.name.trim(), field.protected ? protect(field.value) : field.value);
}
