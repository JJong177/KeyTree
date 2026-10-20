/** 条目列表/详情用的展示辅助函数 */

import { WORDS } from "./wordlist";

export function relativeTime(d: Date | null | undefined): string {
  if (!d) return "";
  const diff = Date.now() - d.getTime();
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < 0) return "刚刚";
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  if (diff < 30 * day) return `${Math.floor(diff / (7 * day))} 周前`;
  if (diff < 365 * day) return `${Math.floor(diff / (30 * day))} 个月前`;
  return `${Math.floor(diff / (365 * day))} 年前`;
}

export function dateText(d: Date | null | undefined): string {
  if (!d) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 给 <input type="date"> 用的值 */
export function dateInputValue(d: Date): string {
  return dateText(d);
}

/** 距离过期还有几天（负数表示已过期） */
export function daysUntil(d: Date | null | undefined): number | null {
  if (!d) return null;
  const day = 24 * 60 * 60 * 1000;
  const today = new Date();
  const startOfToday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate()
  ).getTime();
  return Math.floor((d.getTime() - startOfToday) / day);
}

/** 从网址取主机名，取不到就原样返回 */
export function hostOf(url: string): string {
  const raw = (url || "").trim();
  if (!raw) return "";
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    return new URL(withScheme).host.replace(/^www\./, "");
  } catch {
    return raw;
  }
}

/** 归一化网址，供「打开」按钮使用 */
export function normalizeUrl(url: string): string {
  const raw = (url || "").trim();
  if (!raw) return "";
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export function initialOf(title: string): string {
  const t = (title || "?").trim();
  return (t[0] ?? "?").toUpperCase();
}

/** 头像底色在鼠尾草绿和赭石色之间稳定轮换 */
export function toneOf(seed: string): "sage" | "tan" {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return h % 2 === 0 ? "sage" : "tan";
}

export interface Strength {
  score: number; // 0-100
  label: string;
  /** 强度条颜色（直接给 class，避免内联样式散落） */
  barClass: string;
}

function scoreBar(score: number): { score: number; label: string; barClass: string } {
  if (score < 35) return { score, label: "弱", barClass: "bg-[#8b2332]" };
  if (score < 60) return { score, label: "中", barClass: "bg-[#d4a373]" };
  if (score < 85) return { score, label: "强", barClass: "bg-[#8b9d77]" };
  return { score, label: "很强", barClass: "bg-[#8b9d77]" };
}

export function strength(pw: string): Strength {
  if (!pw) return { score: 0, label: "空", barClass: "bg-stone-300" };
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/\d/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const unique = new Set(pw).size;
  const entropy = pw.length * Math.log2(Math.max(pool, 2)) * Math.min(1, unique / 8);
  const score = Math.max(2, Math.min(100, Math.round((entropy / 80) * 100)));
  return scoreBar(score) as Strength;
}

const LOWER = "abcdefghijkmnopqrstuvwxyz"; // 去掉 l
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // 去掉 I O
const DIGITS = "23456789"; // 去掉 0 1
const SYMBOLS = "!@#$%^&*-_=+?";

/**
 * 密码生成器：用 Web Crypto 的随机源，不碰 Math.random。
 * 保证每类字符至少出现一次（避免「看起来有符号其实没有」）。
 */
export function generatePassword(len = 20, useSymbols = true): string {
  const pools = [LOWER, UPPER, DIGITS];
  if (useSymbols) pools.push(SYMBOLS);
  const all = pools.join("");
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  const chars: string[] = [];
  // 每类先各取一个
  for (let i = 0; i < pools.length && i < len; i++) {
    chars.push(pools[i][bytes[i] % pools[i].length]);
  }
  for (let i = chars.length; i < len; i++) {
    chars.push(all[bytes[i] % all.length]);
  }
  // 洗牌（就地 Fisher-Yates，用同一批随机数派生）
  for (let i = chars.length - 1; i > 0; i--) {
    const j = bytes[i] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// ==================== 口令（passphrase） ====================

const WORDSET = new Set(WORDS);

/** 词表每词贡献的熵（位），UI 展示用 */
export const WORDLIST_BITS = Math.round(Math.log2(WORDS.length));

/** 从 [0, max) 无偏取样（拒绝采样，消除模偏差） */
function randomIndex(max: number): number {
  if (max < 1) throw new Error("取样上限必须 >= 1");
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < limit) return buf[0] % max;
  }
}

/**
 * 口令生成器：随机单词 + 分隔符。每词熵 = log2(词表长度)。
 * 好记好输，适合主密码 / 口令式登录的场景。
 */
export function generatePassphrase(words = 6, separator = "-"): string {
  const count = Math.min(12, Math.max(3, Math.round(words)));
  const picked: string[] = [];
  for (let i = 0; i < count; i++) {
    picked.push(WORDS[randomIndex(WORDS.length)]);
  }
  return picked.join(separator);
}

/**
 * 若字符串看起来是本生成器产出的口令（N 个词表词 + "-" 连接），
 * 按词数算熵返回强度；认不出来返回 null（调用方回落到字符熵算法）。
 */
export function passphraseStrength(pw: string): Strength | null {
  if (!pw) return null;
  const parts = pw.toLowerCase().split("-");
  if (parts.length < 3 || !parts.every((w) => WORDSET.has(w))) return null;
  // 与 WORDLIST_BITS 同口径（每词取整），生成器 UI 提示的「N×位」才能对上
  const bits = parts.length * WORDLIST_BITS;
  const score = Math.max(2, Math.min(100, Math.round((bits / 80) * 100)));
  return { ...scoreBar(score), label: `${bits} 位熵` };
}
