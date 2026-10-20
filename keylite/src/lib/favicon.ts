/**
 * favicon 抓取：走 tauri-plugin-http（Rust 侧发请求，绕开 WebView 的 CORS 限制）。
 * 策略（从高清到低清）：
 *   1. 首页 HTML 里 <link rel="apple-touch-icon"|"icon"> 声明的图标（现代网站多为 180px PNG 或 SVG 矢量）
 *   2. 约定路径 /apple-touch-icon.png（180px）
 *   3. 约定路径 /favicon.ico（多为 16px，最后兜底）
 * 失败一律返回 null（spec：静默降级为默认图标）。
 * 不用 Google/DDG 的图标代理——国内不可达（spec §14 中国区注意）。
 */
import { fetch } from "@tauri-apps/plugin-http";
import { hostOf } from "./format";

const MAX_BYTES = 512 * 1024;
const MAX_HTML = 512 * 1024;
const TIMEOUT_MS = 5000;
const MAX_CANDIDATES = 4;

/** 主机名合法性粗检：挡掉明显的垃圾输入，不发起请求 */
function saneHost(host: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host) && host.length <= 253;
}

async function fetchBytes(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url, { method: "GET", connectTimeout: TIMEOUT_MS });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 0 && buf.byteLength <= MAX_BYTES) return buf;
  } catch {
    // 换下一个候选
  }
  return null;
}

interface IconLink {
  href: string;
  score: number;
}

/**
 * 从首页 HTML 提取 icon 声明并按清晰度排序。
 * 轻量正则解析（只找 <link>，不引 HTML 解析器）；PNG/JPG 矢量优先于未知类型。
 */
export function extractIconHrefs(html: string, baseUrl: string): string[] {
  const links: IconLink[] = [];
  const tagRe = /<link\b[^>]*>/gi;
  const attr = (tag: string, name: string): string => {
    const m = tag.match(new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
    return m ? (m[2] ?? m[3] ?? m[4] ?? "").trim() : "";
  };
  for (const tag of html.match(tagRe) ?? []) {
    const rel = attr(tag, "rel").toLowerCase();
    const href = attr(tag, "href");
    if (!href || !/\bicon\b/.test(rel) || rel.includes("mask-icon")) continue;
    const sizes = attr(tag, "sizes").toLowerCase();
    const type = attr(tag, "type").toLowerCase();
    let score = 60; // 普通 icon
    if (rel.includes("apple-touch-icon")) score = 100; // 一般 180px
    const big = sizes.match(/(\d+)x\1/);
    if (big) score = Math.max(score, Math.min(95, Number(big[1]))); // sizes 越大越优先
    if (type.includes("svg")) score = Math.max(score, 110); // SVG 矢量，任意尺寸都清晰，最优选
    if (rel.includes("shortcut")) score -= 10; // shortcut icon 通常是最老的 16px
    try {
      links.push({ href: new URL(href, baseUrl).toString(), score });
    } catch {
      // 非法 href，跳过
    }
  }
  return links
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CANDIDATES)
    .map((l) => l.href);
}

export async function fetchFavicon(url: string): Promise<ArrayBuffer | null> {
  const host = hostOf(url);
  if (!saneHost(host)) return null;
  const origin = `https://${host}`;

  // 1. 首页 HTML 声明的高清图标
  try {
    const res = await fetch(`${origin}/`, { method: "GET", connectTimeout: TIMEOUT_MS });
    if (res.ok) {
      const raw = new Uint8Array(await res.arrayBuffer());
      // 只需要 head 里的 <link>，截断省解码；不整体转小写（URL 大小写敏感），正则自带 /i
      const head = new TextDecoder("utf-8").decode(
        raw.subarray(0, Math.min(raw.length, MAX_HTML))
      );
      for (const href of extractIconHrefs(head, `${origin}/`)) {
        const bytes = await fetchBytes(href);
        if (bytes) return bytes;
      }
    }
  } catch {
    // 首页拿不到就直接走约定路径
  }

  // 2/3. 约定路径兜底
  return (
    (await fetchBytes(`${origin}/apple-touch-icon.png`)) ??
    (await fetchBytes(`${origin}/favicon.ico`))
  );
}

/** 按字节头猜 MIME，认不出按 x-icon 处理 */
export function sniffImageMime(bytes: Uint8Array): string {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49) return "image/gif";
  if (bytes.length >= 4 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  const head = new TextDecoder().decode(bytes.slice(0, 64)).trimStart();
  if (head.startsWith("<svg")) return "image/svg+xml";
  return "image/x-icon"; // ICO 的 00 00 01 00 头，或认不出时的兜底
}

export function bytesToDataUrl(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return `data:${sniffImageMime(view)};base64,${btoa(binary)}`;
}
