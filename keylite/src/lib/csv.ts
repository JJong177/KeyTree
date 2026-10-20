/**
 * CSV 工具：RFC 4180 解析/生成（引号、逗号、换行、"" 转义都处理）。
 * 导入兼容两种最常见格式，按表头自动识别：
 * - Chrome/Edge 导出：name,url,username,password
 * - KeePassXC 导出：Group,Title,Username,Password,URL,Notes
 * 导出用 Chrome/Edge 导入格式（最大公约数：浏览器、Bitwarden 都认）。
 */

/** RFC 4180 状态机解析。容忍 \r\n 与 \n；引号内逗号/换行按字段内容处理 */
export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    // 整行全空（两个连续换行）不算数据
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      // 引号内的 CRLF 规范化成 LF（RFC 4180 允许原样保留，但统一 LF 对备注显示/迁移更友好）
      if (ch === "\r" && text[i + 1] === "\n") {
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    if (ch === "\n") {
      pushRow();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // 文件末尾没有换行符：最后一行还在缓冲里
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

export interface CsvColumns {
  title: number;
  username: number;
  password: number;
  url: number;
  notes: number;
  group: number;
  totp: number;
}

const NO_COLUMN = -1;

/** 表头列名 → 语义列。认不出返回 NO_COLUMN，该列忽略 */
export function detectColumns(header: string[]): CsvColumns | null {
  const names = header.map((h) => h.trim().toLowerCase());
  const find = (...candidates: string[]): number => {
    for (const c of candidates) {
      const idx = names.indexOf(c);
      if (idx >= 0) return idx;
    }
    return NO_COLUMN;
  };
  const cols: CsvColumns = {
    title: find("title", "name", "账户", "标题", "login_name"),
    username: find("username", "login_username", "user", "login", "用户名", "帐号"),
    password: find("password", "login_password", "pass", "密码"),
    url: find("url", "login_uri", "uri", "website", "网址", "url"),
    notes: find("notes", "note", "备注"),
    // Bitwarden 导出的分组列叫 folder
    group: find("group", "groups", "folder", "分组"),
    totp: find("totp", "otp", "login_totp", "totp_seed", "动态码"),
  };
  // 标题和密码至少要有一样，否则认为不是可导入的表
  if (cols.title === NO_COLUMN && cols.password === NO_COLUMN) return null;
  return cols;
}

/** 生成 Chrome/Edge 导入格式的 CSV（name,url,username,password） */
export function buildChromeCsv(rows: Array<{ title: string; url: string; username: string; password: string }>): string {
  const escape = (v: string): string => {
    const s = (v ?? "").toString();
    // 包含逗号/引号/换行才加引号，和 Chrome 导出行为一致
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = ["name,url,username,password"];
  for (const r of rows) {
    lines.push([r.title, r.url, r.username, r.password].map(escape).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}
