/** Local, bounded clipboard recognition. No I/O, logging, storage or remote models. */
export interface ClipboardSnapshot {
  sequence: number;
  text: string;
  html: string | null;
  sourceUrl: string | null;
  sourceApp: string | null;
}
export const CLIPBOARD_FIELDS = ["title", "username", "password", "url", "notes"] as const;
export type ClipboardField = typeof CLIPBOARD_FIELDS[number];
export const CLIPBOARD_FIELD_LABELS: Record<ClipboardField, string> = {
  title: "标题", username: "账号", password: "密码", url: "登录网址", notes: "备注",
};
export interface ClipboardCandidate {
  value: string;
  evidence: string[];
  requiresConfirmation: boolean;
}
export type ClipboardChoices = Partial<Record<ClipboardField, number>>;
export interface ClipboardRecord {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  evidence: string[];
  warnings: string[];
  candidates?: Partial<Record<ClipboardField, ClipboardCandidate[]>>;
}
export interface ClipboardRecognition {
  records: ClipboardRecord[];
  source: { url: string; app: string };
  truncated: boolean;
}
const aliases: Record<ClipboardField, string[]> = {
  title: ["name", "title", "名称", "标题", "网站名称", "应用名称", "服务名称"],
  username: ["username", "user name", "user", "login", "account", "login_username", "login name", "用户名", "用户名称", "账号", "帐号", "账户", "登录账号", "登录账户", "登录名", "邮箱", "email", "e-mail"],
  password: ["password", "pass word", "pass", "pwd", "login_password", "current-password", "new-password", "密码", "口令", "登录密码"],
  url: ["url", "uri", "website", "websites", "login_uri", "login url", "网址", "网站", "登录网址", "链接"],
  notes: ["notes", "note", "备注", "说明"],
};
const MAX_TEXT = 524288;
const MAX_RECORDS = 50;
const MAX_CANDIDATES = 16;
const normalizeLabel = (text: string) => text.replace(/^\uFEFF/, "").trim().replace(/^[【\[（(]|[】\]）)]$/g, "").toLowerCase().replace(/[ _-]/g, "");
function fieldOf(label: string): ClipboardField | undefined {
  const key = normalizeLabel(label);
  return CLIPBOARD_FIELDS.find(field => aliases[field].some(alias => normalizeLabel(alias) === key));
}
function identifierField(value: string): ClipboardField | undefined {
  return fieldOf(value) ?? fieldOf(value.replace(/(?:[-_]*(?:input|field|value|link|container))$/i, ""));
}
function httpUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? value.trim() : "";
  } catch { return ""; }
}
function websiteWithoutScheme(value: string): string {
  if (/[\s@]/.test(value) || value.includes("://") || !httpUrl(`https://${value}`)) return "";
  try {
    const host = new URL(`https://${value}`).hostname;
    return host === "localhost" || host.includes(".") || /^\[[a-f\d:]+\]$/i.test(host) ? `https://${value}` : "";
  } catch { return ""; }
}
function sourceOf(snapshot: ClipboardSnapshot): ClipboardRecognition["source"] {
  let origin = "";
  try {
    const url = new URL(snapshot.sourceUrl ?? "");
    if (httpUrl(snapshot.sourceUrl ?? "")) origin = url.origin;
    else if (["chrome:", "edge:"].includes(url.protocol) && ["password-manager", "settings", "wallet"].includes(url.hostname)) origin = `${url.protocol}//${url.hostname}`;
  } catch { /* Optional, untrusted metadata; never infer the login URL from it. */ }
  return { url: origin, app: (snapshot.sourceApp ?? "").replace(/[\x00-\x1f\x7f]/g, "").slice(0, 100) };
}
interface FieldPool {
  candidates: Partial<Record<ClipboardField, ClipboardCandidate[]>>;
  hints: Set<ClipboardField>;
  warnings: Set<string>;
}
const pool = (): FieldPool => ({ candidates: {}, hints: new Set(), warnings: new Set() });
function isInstruction(text: string): boolean {
  return /^(?:请|点击|复制(?:账号|用户名|密码)?$|显示密码$|隐藏密码$|添加备注$|保存$|取消$|密码(?:至少|必须|需要|要求|应)|至少\s*\d+\s*位|请输入|重新输入|不得|建议|仅供|注意[：:]|copy\b|show password$|hide password$|enter your\b|must contain\b|at least\b)/i.test(text.trim());
}
function add(target: FieldPool, field: ClipboardField, raw: string, evidence: string, uncertain = false): void {
  target.hints.add(field);
  if (!raw) return;
  let value = field === "password" || field === "notes" ? raw : raw.trim();
  if (!value) return;
  if (field === "password" && /^[*•●·]{3,}$/.test(value)) {
    target.warnings.add("复制内容含密码遮挡符，未当作真实密码"); return;
  }
  if (field === "url") {
    const explicit = httpUrl(value);
    if (explicit) value = explicit;
    else if (websiteWithoutScheme(value)) {
      value = websiteWithoutScheme(value); uncertain = true;
      target.warnings.add("网站未标明协议，候选暂补 https://，请确认");
    } else { target.warnings.add("网址格式不明确，未自动填入"); return; }
  }
  const list = target.candidates[field] ?? (target.candidates[field] = []);
  const existing = list.find(candidate => candidate.value === value);
  if (existing) {
    if (!existing.evidence.includes(evidence) && existing.evidence.length < 6) existing.evidence.push(evidence);
    existing.requiresConfirmation = existing.requiresConfirmation && uncertain;
  } else if (list.length < MAX_CANDIDATES) list.push({ value, evidence: [evidence], requiresConfirmation: uncertain });
  else target.warnings.add(`${CLIPBOARD_FIELD_LABELS[field]}候选超过 ${MAX_CANDIDATES} 个，仅展示前 ${MAX_CANDIDATES} 个，请缩小复制范围`);
}
function mergePool(target: FieldPool, extra: FieldPool): void {
  for (const field of extra.hints) target.hints.add(field);
  for (const field of CLIPBOARD_FIELDS) for (const candidate of extra.candidates[field] ?? []) {
    for (const evidence of candidate.evidence) add(target, field, candidate.value, evidence, candidate.requiresConfirmation);
  }
  for (const warning of extra.warnings) target.warnings.add(warning);
}
function finish(target: FieldPool): ClipboardRecord | null {
  if (!target.hints.has("username") && !target.hints.has("password")) return null;
  const record: ClipboardRecord = { title: "", username: "", password: "", url: "", notes: "", evidence: [], warnings: [...target.warnings], candidates: target.candidates };
  for (const field of CLIPBOARD_FIELDS) {
    const candidates = target.candidates[field] ?? [];
    if (candidates.length === 1 && !candidates[0].requiresConfirmation) record[field] = candidates[0].value;
    if (candidates.length > 1 || candidates.some(candidate => candidate.requiresConfirmation)) record.warnings.push(`${CLIPBOARD_FIELD_LABELS[field]}存在待确认候选，请选择或明确留空`);
    if (!candidates.length && ["username", "password", "url", "title"].includes(field)) record.warnings.push(`未包含可确定的${CLIPBOARD_FIELD_LABELS[field]}值，请补充`);
    for (const candidate of candidates) for (const reason of candidate.evidence) if (!record.evidence.includes(reason)) record.evidence.push(reason);
  }
  if ((target.candidates.username?.length ?? 0) > 1 || (target.candidates.password?.length ?? 0) > 1) record.warnings.push("候选可能来自不同账号，请核对账号与密码的对应关系；不会自动配对");
  if (!record.evidence.length) record.evidence.push("发现明确的账号或密码字段标签，但未取得可确定的值");
  return record;
}
/** The confirmation boundary never trusts a caller-supplied field value. */
export function resolveClipboardRecord(record: ClipboardRecord, choices: ClipboardChoices = {}): Pick<ClipboardRecord, ClipboardField> | null {
  const result = { title: record.title, username: record.username, password: record.password, url: record.url, notes: record.notes };
  for (const field of CLIPBOARD_FIELDS) {
    const candidates = record.candidates?.[field] ?? [];
    const choice = choices[field];
    const pending = candidates.length > 1 || candidates.some(candidate => candidate.requiresConfirmation);
    if (choice !== undefined) {
      if (!Number.isInteger(choice) || choice < -1 || choice >= candidates.length) return null;
      result[field] = choice === -1 ? "" : candidates[choice].value;
    } else if (pending) return null;
    else if (candidates.length === 1) result[field] = candidates[0].value;
  }
  return result;
}

/** Strict CSV/TSV: preserve secret whitespace, quotes and CRLF byte-for-character. */
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
function tablePools(rows: string[][], origin: string): FieldPool[] {
  if (rows.length < 2 || rows[0].length < 2) return [];
  if (rows.every(row => row.length === 2 && fieldOf(row[0]))) {
    const target = pool();
    for (const row of rows) add(target, fieldOf(row[0])!, row[1], `${origin}：字段与相邻单元格`);
    return [target];
  }
  const columns = rows[0].map(fieldOf);
  if (!columns.some(field => field === "username" || field === "password")) return [];
  const result: FieldPool[] = [];
  for (const row of rows.slice(1, MAX_RECORDS + 2)) {
    if (row.length !== columns.length) continue;
    const target = pool();
    columns.forEach((field, index) => { if (field) add(target, field, row[index], `${origin}：${CLIPBOARD_FIELD_LABELS[field]}表头`); });
    if (finish(target)) result.push(target);
  }
  return result;
}
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const labelPattern = [...new Set(Object.values(aliases).flat())].sort((a, b) => b.length - a.length).map(escaped).join("|");
interface Marker { field: ClipboardField; start: number; end: number; spaced: boolean }
function markers(line: string): Marker[] {
  const expression = new RegExp(`(^|[\\t ;；,，|])(?:[【\\[(])?(${labelPattern})(?:[】\\])])?([ \\t]*[:：=]|[ \\t]+|$)`, "gi");
  return [...line.matchAll(expression)].flatMap(match => {
    const field = fieldOf(match[2]);
    return field ? [{ field, start: match.index! + match[1].length, end: match.index! + match[0].length, spaced: !/[:：=]/.test(match[3]) && !!match[3] }] : [];
  });
}
function textPool(text: string, origin: string): FieldPool {
  const target = pool();
  const lines = text.split(/\r\n|\n|\r/);
  const lineEndings = text.match(/\r\n|\n|\r/g) ?? [];
  const consumed = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (consumed.has(i) || !lines[i].trim()) continue;
    const line = lines[i].replace(/^[ \t]*(?:[-•*]|\d+[.)、])[ \t]+/, "");
    const found = markers(line);
    for (let j = 0; j < found.length; j++) {
      const marker = found[j];
      const rawSlice = line.slice(marker.end, found[j + 1]?.start ?? line.length);
      const raw = j + 1 < found.length && marker.field !== "password" ? rawSlice.replace(/[ \t;；,，|]+$/, "") : rawSlice;
      if (raw.trim()) {
        if (isInstruction(raw) || (marker.spaced && /^(?:至少|必须|需要|要求|应|must\b|should\b|at least\b)/i.test(raw.trim()))) continue;
        // Inline field boundaries can also occur inside a password: expose both interpretations.
        const inlineAmbiguous = marker.field === "password" && j + 1 < found.length;
        add(target, marker.field, raw, `${origin}第 ${i + 1} 行：${CLIPBOARD_FIELD_LABELS[marker.field]}标签同侧`, marker.spaced || inlineAmbiguous);
        if (inlineAmbiguous) {
          add(target, marker.field, raw.replace(/[ \t;；,，|]+$/, ""), `${origin}第 ${i + 1} 行：去除字段间分隔符（待确认）`, true);
          add(target, marker.field, line.slice(marker.end), `${origin}第 ${i + 1} 行：保留完整密码尾部（边界待确认）`, true);
        }
        continue;
      }
      target.hints.add(marker.field);
      if (found.length !== 1) continue;
      let count = 0;
      const valueLines: number[] = [];
      for (let next = i + 1; next < lines.length && next <= i + 6; next++) {
        if (!lines[next].trim()) continue;
        if (markers(lines[next]).length || fieldOf(lines[next])) {
          // A label-looking line followed by unlabelled text may itself belong to a multi-line secret.
          if (marker.field === "password" && valueLines.length && markers(lines[next]).some(item => lines[next].slice(item.end).trim())
            && lines[next + 1]?.trim() && !markers(lines[next + 1]).length && !fieldOf(lines[next + 1]) && !isInstruction(lines[next + 1])) {
            let complete = "";
            for (let n = valueLines[0]; n <= next + 1; n++) complete += lines[n] + (n < next + 1 ? lineEndings[n] ?? "\n" : "");
            add(target, "password", complete, `${origin}：字段样式文字也可能属于完整密码（待确认）`, true);
          }
          break;
        }
        if (isInstruction(lines[next])) continue;
        if (marker.field !== "password" && marker.field !== "url" && /^[\p{L}\p{N} _-]{1,32}[:：=]/u.test(lines[next]) && !/^https?:\/\//i.test(lines[next].trim())) break;
        valueLines.push(next);
        add(target, marker.field, lines[next], `${origin}第 ${i + 1} 行标签 → 第 ${next + 1} 行相邻内容`);
        consumed.add(next);
        if (++count >= 3) break;
      }
      if (marker.field === "password" && valueLines.length > 1) {
        const first = valueLines[0], last = valueLines[valueLines.length - 1];
        let complete = "";
        for (let n = first; n <= last; n++) complete += lines[n] + (n < last ? lineEndings[n] ?? "\n" : "");
        add(target, "password", complete, `${origin}：保留标签后完整多行密码（边界待确认）`, true);
      }
    }
  }
  return target;
}

/** Detached parsing only: never mount imported HTML, run scripts or fetch its resources. */
function htmlPools(html: string): { tables: FieldPool[]; fields: FieldPool } {
  const result = { tables: [] as FieldPool[], fields: pool() };
  if (typeof document === "undefined" || html.length > 1048576) return result;
  const template = document.createElement("template");
  const fragment = html.replace(/^(?:\s|<!--[\s\S]*?-->)+/, "");
  template.innerHTML = /^<(?:tr|td|th|tbody|thead|tfoot)\b/i.test(fragment)
    ? (/^<(?:td|th)\b/i.test(fragment) ? `<table><tr>${fragment}</tr></table>` : `<table>${fragment}</table>`) : html;
  const root = template.content;
  root.querySelectorAll("script,style,iframe,object,embed,template,button,cr-icon-button").forEach(el => el.remove());
  for (const table of [...root.querySelectorAll("table")].slice(0, 5)) {
    if ([...table.rows].some(row => [...row.cells].some(cell => cell.colSpan !== 1 || cell.rowSpan !== 1))) continue;
    const rows = [...table.rows].slice(0, MAX_RECORDS + 2).map(row => [...row.cells].map(cell => {
      const copy = cell.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("br").forEach(br => br.replaceWith("\n"));
      return copy.textContent ?? "";
    }));
    result.tables.push(...tablePools(rows, "HTML 表格"));
  }
  const labelElements = [...root.querySelectorAll("label")].slice(0, 512);
  const conflictingElements = new WeakSet<Element>();
  function ownField(el: Element): ClipboardField | undefined {
    const hints = ["autocomplete", "name", "id", "aria-label", "label"].map(attribute => identifierField(el.getAttribute(attribute) ?? "")).filter((field): field is ClipboardField => !!field);
    if (el.getAttribute("type") === "password") hints.push("password");
    if (el.id) for (const label of labelElements) if (label.htmlFor === el.id) {
      const field = fieldOf(label.textContent ?? ""); if (field) hints.push(field);
    }
    const parentLabel = el.closest("label");
    if (parentLabel) { const field = fieldOf(parentLabel.textContent ?? ""); if (field) hints.push(field); }
    const distinct = [...new Set(hints)];
    if (distinct.length > 1) { conflictingElements.add(el); result.fields.warnings.add("HTML 控件的字段标记冲突，未自动归类"); return undefined; }
    return distinct[0];
  }
  for (const el of [...root.querySelectorAll("input,textarea,[value],cr-input,credential-field,credential-note")].slice(0, 512)) {
    let field = ownField(el);
    let parent = el.parentElement;
    for (let depth = 0; !field && parent && depth < 3 && !conflictingElements.has(el); depth++, parent = parent.parentElement) {
      field = ownField(parent);
      if (conflictingElements.has(parent)) { conflictingElements.add(el); break; }
    }
    if (conflictingElements.has(el)) continue;
    if (!field) continue;
    result.fields.hints.add(field);
    const raw = el.getAttribute("value") ?? (el.tagName.toLowerCase() === "textarea" ? el.textContent ?? "" : "");
    add(result.fields, field, raw, `HTML 控件：明确的${CLIPBOARD_FIELD_LABELS[field]}语义标记`);
  }
  for (const anchor of [...root.querySelectorAll("a[href]")].slice(0, 128)) {
    const parent = anchor.parentElement;
    const direct = ownField(anchor);
    const field = conflictingElements.has(anchor) ? undefined : direct ?? (parent ? ownField(parent) : undefined);
    if (field === "url") add(result.fields, "url", anchor.getAttribute("href") ?? "", "HTML：明确网站字段中的链接");
  }
  // Visible label/value neighbours, independent of browser-specific custom elements.
  for (const el of [...root.querySelectorAll("dt,label,span,strong,b,p,div")].slice(0, 1024)) {
    if (el.children.length) continue;
    const field = fieldOf(el.textContent ?? "");
    if (!field) continue;
    result.fields.hints.add(field);
    const sibling = el.nextElementSibling;
    if (!sibling || fieldOf(sibling.textContent ?? "") || sibling.matches("input,textarea,button")) continue;
    const value = sibling.textContent ?? "";
    if (value && !isInstruction(value)) add(result.fields, field, value, "HTML：字段标签的相邻内容");
  }
  // HTML display text complements plain text; controls have already supplied serialized values.
  const display = root.cloneNode(true) as DocumentFragment;
  display.querySelectorAll("table,input,textarea").forEach(el => el.remove());
  display.querySelectorAll("br").forEach(el => el.replaceWith("\n"));
  display.querySelectorAll("div,p,li,dt,dd,label,section,article,h1,h2,h3").forEach(el => { el.prepend("\n"); el.append("\n"); });
  mergePool(result.fields, textPool(display.textContent ?? "", "HTML 文本"));
  return result;
}
export function recognizeClipboard(snapshot: ClipboardSnapshot): ClipboardRecognition | null {
  if (snapshot.text.length > MAX_TEXT) return null;
  const text = snapshot.text.replace(/^\uFEFF/, "");
  let tables: FieldPool[] = [];
  let malformedTable = false;
  for (const separator of ["\t", ","]) {
    if (!text.includes(separator)) continue;
    const rows = delimited(text, separator);
    const header = delimited(text.split(/\r\n|\n|\r/, 1)[0], separator)?.[0] ?? [];
    const explicitHeader = header.length > 1 && header.every(cell => !!fieldOf(cell));
    if (explicitHeader && !rows) malformedTable = true;
    if (rows) tables = tablePools(rows, separator === "\t" ? "制表符表格" : "CSV");
    if (tables.length) break;
  }
  const html = snapshot.html ? htmlPools(snapshot.html) : { tables: [] as FieldPool[], fields: pool() };
  const fields = tables.length || malformedTable ? pool() : textPool(text, "纯文本");
  const textHasAccount = !!fields.candidates.username?.length, textHasPassword = !!fields.candidates.password?.length;
  const htmlHasAccount = !!html.fields.candidates.username?.length, htmlHasPassword = !!html.fields.candidates.password?.length;
  const crossSourcePair = (textHasAccount && !textHasPassword && htmlHasPassword && !htmlHasAccount)
    || (textHasPassword && !textHasAccount && htmlHasAccount && !htmlHasPassword);
  mergePool(fields, html.fields);
  if (crossSourcePair) {
    for (const field of ["username", "password"] as const) for (const candidate of fields.candidates[field] ?? []) candidate.requiresConfirmation = true;
    fields.warnings.add("账号与密码分别来自不同内容格式，请确认属于同一账号后再填入");
  }
  if (!tables.length && html.tables.length) tables = html.tables;
  else if (tables.length && html.tables.length) {
    // Never associate rows by position: merge only uniquely matching credential identities.
    for (const row of tables) {
      const identity = finish(row);
      const matches = html.tables.filter(other => {
        const candidate = finish(other);
        return identity && candidate && identity.username && identity.username === candidate.username
          && identity.url && candidate.url && identity.url === candidate.url;
      });
      if (matches.length === 1) mergePool(row, matches[0]);
    }
  }
  if (tables.length === 1) mergePool(tables[0], fields);
  const records = tables.length ? tables.flatMap(row => { const record = finish(row); return record ? [record] : []; }) : (() => { const record = finish(fields); return record ? [record] : []; })();
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
      } catch { /* Clipboard busy/unsupported: never log payloads or native errors. */ }
      finally { if (active === ticket) active = null; }
    },
  };
}
