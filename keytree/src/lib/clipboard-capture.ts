/** Clipboard recognition is deliberately conservative. No I/O, logging or persistence. */
export interface ClipboardSnapshot {
  sequence: number;
  text: string;
  html: string | null;
  sourceUrl: string | null;
  sourceApp: string | null;
}
export interface ClipboardRecord {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  evidence: string[];
  warnings: string[];
}
export interface ClipboardRecognition {
  records: ClipboardRecord[];
  source: { url: string; app: string };
  truncated: boolean;
}
type Field = "title" | "username" | "password" | "url" | "notes";
const aliases: Record<Field, string[]> = {
  title: ["name", "title", "名称", "标题", "网站名称", "应用名称"],
  username: ["username", "user", "login", "account", "login_username", "用户名", "账号", "帐号", "账户", "登录账号", "登录名", "邮箱", "email"],
  password: ["password", "pass", "pwd", "login_password", "密码", "口令", "登录密码"],
  url: ["url", "uri", "website", "login_uri", "网址", "网站", "登录网址", "链接"],
  notes: ["notes", "note", "备注", "说明"],
};
const MAX_TEXT = 524288;
const MAX_RECORDS = 50;
function fieldOf(label: string): Field | undefined {
  const key = label.replace(/^\uFEFF/, "").trim().toLowerCase();
  return (Object.keys(aliases) as Field[]).find(field => aliases[field].includes(key));
}
function safeUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    return value.trim();
  } catch { return ""; }
}
function sourceOf(snapshot: ClipboardSnapshot): ClipboardRecognition["source"] {
  const url = safeUrl(snapshot.sourceUrl ?? "");
  return {
    // Do not expose query, fragment, user info or paths that can contain credentials.
    url: url ? new URL(url).origin : "",
    app: (snapshot.sourceApp ?? "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100),
  };
}
function recordOf(values: Partial<Record<Field, string>>, evidence: string[]): ClipboardRecord | null {
  if (!values.username && !values.password) return null;
  const warnings: string[] = [];
  const rawUrl = values.url ?? "";
  const url = safeUrl(rawUrl);
  if (rawUrl && !url) warnings.push("网址格式不明确，未自动填入");
  if (!values.username) warnings.push("缺少账号，请在新增页补充");
  if (!values.password) warnings.push("缺少密码，请在新增页补充");
  if (!url) warnings.push("缺少账号对应网址；复制来源不会自动作为登录网址");
  if (!values.title) warnings.push("缺少标题，请在新增页补充");
  return { title: values.title ?? "", username: values.username ?? "", password: values.password ?? "", url, notes: values.notes ?? "", evidence, warnings };
}
/** Strict CSV/TSV parser; unlike display-oriented parsers, secret CRLF/whitespace is untouched. */
function delimited(text: string, delimiter: string): string[][] | null {
  const rows: string[][] = [];
  let row: string[] = [], field = "", quoted = false, endedQuote = false;
  const pushField = () => { row.push(field); field = ""; endedQuote = false; };
  const pushRow = () => { pushField(); if (row.some(value => value !== "")) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; endedQuote = true; }
      } else field += ch;
      continue;
    }
    if (ch === delimiter) { pushField(); continue; }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushRow(); continue;
    }
    if (endedQuote) return null;
    if (ch === '"') { if (field) return null; quoted = true; }
    else field += ch;
  }
  if (quoted) return null;
  if (field || row.length || endedQuote) pushRow();
  return rows;
}
function tableRecords(rows: string[][], kind: string): ClipboardRecord[] {
  if (rows.length < 2) return [];
  // A two-column account/password detail list is not a header plus data rows.
  if (rows.every(row => row.length === 2 && fieldOf(row[0]))) return pairRecords(rows);
  const columns = rows[0].map(fieldOf);
  const known = columns.filter((field): field is Field => !!field);
  // Duplicated semantic columns are ambiguous; do not silently choose one.
  if (new Set(known).size !== known.length || !known.some(field => field === "username" || field === "password")) return [];
  const records: ClipboardRecord[] = [];
  for (const row of rows.slice(1, MAX_RECORDS + 2)) {
    if (row.length !== columns.length) continue;
    const values: Partial<Record<Field, string>> = {};
    const evidence: string[] = [];
    columns.forEach((field, i) => {
      if (!field) return;
      values[field] = row[i];
      evidence.push(`${field === "password" ? "密码" : field === "username" ? "账号" : field === "url" ? "网址" : field === "title" ? "标题" : "备注"}：${kind}表头`);
    });
    const record = recordOf(values, evidence);
    if (record) records.push(record);
  }
  return records;
}
function pairRecords(rows: string[][]): ClipboardRecord[] {
  const values: Partial<Record<Field, string>> = {};
  const evidence: string[] = [];
  for (const row of rows) {
    const field = fieldOf(row[0]);
    if (!field || row.length !== 2 || values[field] !== undefined) return [];
    values[field] = row[1];
    evidence.push(`${row[0].trim()}：明确字段标签`);
  }
  const record = recordOf(values, evidence);
  return record ? [record] : [];
}
function labelRecords(text: string): ClipboardRecord[] {
  const values: Partial<Record<Field, string>> = {};
  const evidence: string[] = [];
  let unknown = false;
  for (const line of text.split(/\r\n|\n|\r/)) {
    if (!line.trim()) continue;
    const match = /^\s*([^:：\t]{1,32})[:：\t](.*)$/.exec(line);
    const field = match ? fieldOf(match[1]) : undefined;
    if (!field || !match) { unknown = true; continue; }
    if (values[field] !== undefined) return []; // Could be multiple accounts; do not merge them.
    values[field] = field === "password" ? match[2] : match[2].trim();
    evidence.push(`${match[1].trim()}：明确字段标签`);
  }
  const record = recordOf(values, evidence);
  if (record && unknown) record.warnings.push("部分行未识别，未自动填入，请核对是否遗漏");
  return record ? [record] : [];
}
function htmlRecords(html: string): ClipboardRecord[] {
  if (typeof document === "undefined" || html.length > 1048576) return [];
  // A detached template never runs scripts or loads images; never insert imported markup into the DOM.
  const template = document.createElement("template");
  const fragment = html.replace(/^(?:\s|<!--[\s\S]*?-->)+/, "");
  template.innerHTML = /^<(?:tr|td|th|tbody|thead|tfoot)\b/i.test(fragment)
    ? (/^<(?:td|th)\b/i.test(fragment) ? `<table><tr>${fragment}</tr></table>` : `<table>${fragment}</table>`)
    : html;
  template.content.querySelectorAll("script,style,iframe,object,embed,template").forEach(el => el.remove());
  for (const table of [...template.content.querySelectorAll("table")].slice(0, 5)) {
    if ([...table.rows].some(row => [...row.cells].some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1))) continue;
    const rows = [...table.rows].slice(0, MAX_RECORDS + 2).map(row => [...row.cells].map(cell => {
      cell.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
      return cell.textContent ?? "";
    }));
    const records = tableRecords(rows, "HTML 表格");
    if (records.length) return records;
  }
  return [];
}
export function recognizeClipboard(snapshot: ClipboardSnapshot): ClipboardRecognition | null {
  if (snapshot.text.length > MAX_TEXT) return null;
  const text = snapshot.text.replace(/^\uFEFF/, "");
  let records: ClipboardRecord[] = [];
  for (const separator of ["\t", ","]) {
    if (!text.includes(separator)) continue;
    const rows = delimited(text, separator);
    if (rows) records = tableRecords(rows, separator === "\t" ? "制表符表格" : "CSV ");
    if (records.length) break;
  }
  if (!records.length) records = labelRecords(text);
  if (!records.length && snapshot.html) records = htmlRecords(snapshot.html);
  if (!records.length) return null;
  return { records: records.slice(0, MAX_RECORDS), source: sourceOf(snapshot), truncated: records.length > MAX_RECORDS };
}

/** Public lifecycle seam: a result cannot escape an invalidated focus/unlock session. */
export function createClipboardCapture(options: {
  allowed: () => boolean;
  read: (lastSequence: number | null) => Promise<ClipboardSnapshot | null>;
  result: (value: ClipboardRecognition) => void;
}): { focus: () => Promise<void>; invalidate: () => void } {
  let generation = 0;
  let active: number | null = null;
  let lastSequence: number | null = null;
  return {
    invalidate() { generation++; active = null; },
    async focus() {
      if (!options.allowed() || active !== null) return;
      const ticket = ++generation;
      active = ticket;
      try {
        const snapshot = await options.read(lastSequence);
        if (ticket !== generation || !options.allowed() || !snapshot || snapshot.sequence === lastSequence) return;
        lastSequence = snapshot.sequence;
        const result = recognizeClipboard(snapshot);
        if (result && ticket === generation && options.allowed()) options.result(result);
      } catch { /* Clipboard busy/unsupported: fail quietly; never log payload or native errors. */ }
      finally { if (active === ticket) active = null; }
    },
  };
}
