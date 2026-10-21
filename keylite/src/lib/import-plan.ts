import { parseCsv, detectColumns } from "./csv";
import { normalizeTotpInput } from "./totp";
export interface ImportRecord { title: string; username: string; password: string; url: string; notes: string; totp: string; group: string }
export interface ImportRow { index: number; record: ImportRecord; classification: "new" | "duplicate" | "conflict" | "invalid"; selected: boolean }
export function importIdentity(r: ImportRecord): string {
  return JSON.stringify([r.title.trim().toLowerCase(), r.username.trim().toLowerCase(), r.url.trim().replace(/\/$/, "").toLowerCase()]);
}
export function importContentKey(r: ImportRecord): string {
  let otp = r.totp; try { otp = normalizeTotpInput(otp); } catch { /* 未识别的原值交给确认阶段校验 */ }
  return JSON.stringify([r.title, r.username, r.url, r.password, r.notes, otp, r.group.split("/").map(s => s.trim()).filter(Boolean).join("/")]); }
export function classifyImportRecords(records: ImportRecord[], existing: ImportRecord[]): Array<ImportRow["classification"]> {
  const seen = new Set(existing.map(importContentKey)), identities = new Set(existing.map(importIdentity));
  return records.map(record => {
    const key = importContentKey(record), identity = importIdentity(record);
    const kind = seen.has(key) ? "duplicate" : identities.has(identity) ? "conflict" : "new";
    seen.add(key); identities.add(identity);
    return kind;
  });
}
export function analyzeImport(text: string, existing: ImportRecord[]): ImportRow[] {
  const rows = parseCsv(text), cols = detectColumns(rows[0] ?? []);
  if (!cols || rows.length < 2) throw new Error("CSV 没有可识别的表头或数据");
  if (rows.length > 10001) throw new Error("每次最多预览 10000 条，请拆分文件");
  const seen = new Set(existing.map(importContentKey)), identities = new Set(existing.map(importIdentity));
  return rows.slice(1).map((row, index) => {
    const get = (i: number) => i >= 0 ? row[i] ?? "" : "";
    const record: ImportRecord = { title: get(cols.title).trim() || "(无标题)", username: get(cols.username).trim(), password: get(cols.password), url: get(cols.url).trim(), notes: get(cols.notes), totp: get(cols.totp).trim(), group: get(cols.group).trim() };
    const invalid = !get(cols.title).trim() && !record.username && !record.password;
    const key = importContentKey(record), identity = importIdentity(record);
    const classification = invalid ? "invalid" : seen.has(key) ? "duplicate" : identities.has(identity) ? "conflict" : "new";
    if (!invalid) { seen.add(key); identities.add(identity); }
    return { index, record, classification, selected: classification === "new" };
  });
}
