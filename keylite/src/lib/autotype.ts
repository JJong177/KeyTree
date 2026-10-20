/**
 * Auto-Type 序列解析。
 * 支持的占位符（v1 就这五个，和 spec §5 一致）：
 *   {USERNAME} {PASSWORD} {TAB} {ENTER} {DELAY n}
 * 其他花括号内容按普通文本处理。
 */

export type AutoTypePart =
  | { kind: "text"; value: string }
  | { kind: "tab" }
  | { kind: "enter" }
  | { kind: "delay"; ms: number };

export const DEFAULT_AUTO_TYPE = "{USERNAME}{TAB}{PASSWORD}{ENTER}";

const TOKEN = /\{(USERNAME|PASSWORD|TAB|ENTER|DELAY\s+\d+)\}/gi;

export function parseSequence(
  sequence: string,
  values: { username: string; password: string }
): AutoTypePart[] {
  const source = (sequence || "").trim() || DEFAULT_AUTO_TYPE;
  const parts: AutoTypePart[] = [];

  const pushText = (text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last && last.kind === "text") {
      last.value += text;
    } else {
      parts.push({ kind: "text", value: text });
    }
  };

  let cursor = 0;
  for (const match of source.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    pushText(source.slice(cursor, index));

    const token = (match[1] ?? "").toUpperCase();
    if (token === "USERNAME") {
      pushText(values.username);
    } else if (token === "PASSWORD") {
      pushText(values.password);
    } else if (token === "TAB") {
      parts.push({ kind: "tab" });
    } else if (token === "ENTER") {
      parts.push({ kind: "enter" });
    } else {
      const ms = Number(token.replace(/\D/g, "")) || 0;
      if (ms > 0) parts.push({ kind: "delay", ms });
    }

    cursor = index + match[0].length;
  }

  pushText(source.slice(cursor));
  return parts;
}
