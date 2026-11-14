import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { parseWebUrl } from "./entry-identity";

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const HARD_MAX_BYTES = 2 * 1024 * 1024;
const MAX_EXTRACT_CHARS = 512 * 1024;
const MAX_TITLE_LENGTH = 160;

export interface SiteTitleOptions {
  signal?: AbortSignal;
  fetch?: typeof import("@tauri-apps/plugin-http").fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Return the parsed host (including a non-default port), without changing stored input. */
export function websiteHost(input: string): string {
  try {
    return parseWebUrl(input)?.host ?? "";
  } catch {
    return "";
  }
}

/** Site-title lookup is intentionally HTTPS-only. */
export function canFetchSiteTitle(input: string): boolean {
  try {
    return parseWebUrl(input)?.protocol === "https:";
  } catch {
    return false;
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", apos: "'", gt: ">", lt: "<", quot: '"', nbsp: " ",
  copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", yen: "¥",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", bull: "•", middot: "·", raquo: "»", laquo: "«",
  eacute: "é", Eacute: "É", aacute: "á", Aacute: "Á", oacute: "ó", Oacute: "Ó",
  uacute: "ú", Uacute: "Ú", ntilde: "ñ", Ntilde: "Ñ", ccedil: "ç", Ccedil: "Ç",
  deg: "°", times: "×", divide: "÷", plusmn: "±",
};

function decodeHtmlEntities(value: string): string {
  // Parse only escaped text in an inert, detached document; never place source markup in the UI.
  if (typeof DOMParser !== "undefined") {
    try {
      const escapedText = value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const decoded = new DOMParser().parseFromString(`<!doctype html><body>${escapedText}</body>`, "text/html").body.textContent;
      if (decoded !== null) return decoded;
    } catch {
      // Fall back to the small common-entity table for non-browser runtimes.
    }
  }
  return value.replace(/&(#(?:x[\da-f]+|\d+)|[a-z][a-z\d]+);/gi, (entity, key: string) => {
    if (key[0] !== "#") return NAMED_ENTITIES[key] ?? entity;
    const hex = key[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(key.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      return "\uFFFD";
    }
    return String.fromCodePoint(codePoint);
  });
}
function isUnavailableTitle(title: string): boolean {
  const normalized = title.toLowerCase().replace(/[.!…]+$/g, "").trim();
  return /^(?:please )?(?:log ?in|sign ?in|signin)\b/.test(normalized) ||
    /^(?:authentication required|access denied|access forbidden|forbidden|403 forbidden|401 unauthorized|verify (?:that )?you are human|checking your browser|just a moment|security check|captcha|robot check|attention required|request blocked|service unavailable|temporarily unavailable)(?:$|[\s|:—.-])/.test(normalized);
}

function cleanTitle(value: string): string | null {
  const decoded = decodeHtmlEntities(value.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]*>/g, " "));
  const normalized = decoded
    .replace(/[\t\n\r\f\v]+/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || isUnavailableTitle(normalized)) return null;
  return Array.from(normalized).slice(0, MAX_TITLE_LENGTH).join("");
}

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  const body = tag.replace(/^<meta\b/i, "").replace(/\s*\/?\s*>\s*$/, "");
  const attributePattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of body.matchAll(attributePattern)) {
    const name = match[1].toLowerCase();
    if (!result.has(name)) result.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

/** Extract likely site branding from inert source text; markup is never inserted or executed. */
export function extractSiteTitle(html: string): string | null {
  const source = html.slice(0, MAX_EXTRACT_CHARS)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const metas: Array<{ kind: "property" | "name"; content: string }> = [];
  for (const match of source.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    const content = attrs.get("content");
    if (content === undefined) continue;
    if (attrs.get("property")?.trim().toLowerCase() === "og:site_name") metas.push({ kind: "property", content });
    else if (attrs.get("name")?.trim().toLowerCase() === "og:site_name") metas.push({ kind: "name", content });
  }
  for (const meta of [...metas.filter((item) => item.kind === "property"), ...metas.filter((item) => item.kind === "name")]) {
    const title = cleanTitle(meta.content);
    if (title) return title;
  }
  const titleMatch = source.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  return titleMatch ? cleanTitle(titleMatch[1]) : null;
}

const INTERRUPTED = Symbol("site-title-interrupted");

type FetchResponse = Response;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function cancelBody(response: FetchResponse): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Best-effort release of an unread response body.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Best-effort release of a response body that is already closing.
  }
}

/** Fetch only an HTTPS origin's home page, with bounded redirects, time and head bytes. */
export async function fetchSiteTitle(input: string, options: SiteTitleOptions = {}): Promise<string | null> {
  let parsed: URL | null;
  try {
    parsed = parseWebUrl(input);
  } catch {
    return null;
  }
  if (!parsed || parsed.protocol !== "https:") return null;

  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);
  const fetcher = options.fetch ?? tauriFetch;
  const origin = parsed.origin;
  let target = `${origin}/`;
  const controller = new AbortController();
  let currentResponse: FetchResponse | null = null;
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let stopped = false;
  let resolveInterrupted!: (value: typeof INTERRUPTED) => void;
  const interruption = new Promise<typeof INTERRUPTED>((resolve) => { resolveInterrupted = resolve; });

  const interrupt = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    if (currentReader) cancelReader(currentReader);
    else if (currentResponse) cancelBody(currentResponse);
    resolveInterrupted(INTERRUPTED);
  };
  if (options.signal?.aborted) return null;
  const onExternalAbort = () => interrupt();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });
  if (options.signal?.aborted) interrupt();
  const timer = setTimeout(interrupt, timeoutMs);

  const run = async (): Promise<string | null> => {
    try {
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        if (stopped) return null;
        const requestUrl = target;
        const init: RequestInit & { maxRedirections: number; connectTimeout: number } = {
          method: "GET",
          headers: {
            Accept: "text/html, application/xhtml+xml;q=0.9",
            // Some public sites return script-only fallback pages to unidentified clients.
            "User-Agent": typeof navigator !== "undefined" && navigator.userAgent.startsWith("Mozilla/5.0")
              ? navigator.userAgent
              : "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
          },
          credentials: "omit",
          referrerPolicy: "no-referrer",
          cache: "no-store",
          redirect: "manual",
          signal: controller.signal,
          maxRedirections: 0,
          connectTimeout: timeoutMs,
        };
        const request = Promise.resolve().then(() => fetcher(requestUrl, init));
        // A test/custom fetch may ignore AbortSignal; release any body it yields after timeout.
        void request.then((lateResponse) => { if (stopped) cancelBody(lateResponse); }, () => undefined);
        const fetched = await Promise.race([request, interruption]);
        if (fetched === INTERRUPTED || stopped) return null;
        const response = fetched as FetchResponse;
        currentResponse = response;

        if (response.redirected) {
          cancelBody(response);
          currentResponse = null;
          return null;
        }
        if (response.url) {
          try {
            if (new URL(response.url).origin !== origin || new URL(response.url).protocol !== "https:") {
              cancelBody(response);
              currentResponse = null;
              return null;
            }
          } catch {
            cancelBody(response);
            currentResponse = null;
            return null;
          }
        }

        if (response.status >= 300 && response.status < 400 && response.status !== 304) {
          const location = response.headers.get("location");
          cancelBody(response);
          currentResponse = null;
          if (!location || redirects === 3) return null;
          let next: URL;
          try {
            next = new URL(location, requestUrl);
          } catch {
            return null;
          }
          if (next.protocol !== "https:" || next.origin !== origin || next.username || next.password) return null;
          // Keep a same-origin destination path, but never propagate query or fragment data.
          next.search = "";
          next.hash = "";
          target = next.toString();
          continue;
        }

        if (!response.ok) {
          cancelBody(response);
          currentResponse = null;
          return null;
        }
        const contentType = response.headers.get("content-type");
        if (contentType !== null && !/^\s*(?:text\/html|application\/xhtml\+xml)(?:\s*;|\s*$)/i.test(contentType)) {
          cancelBody(response);
          currentResponse = null;
          return null;
        }
        if (!response.body) {
          currentResponse = null;
          return null;
        }

        const reader = response.body.getReader();
        currentReader = reader;
        const decoder = new TextDecoder("utf-8");
        let html = "";
        let totalBytes = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (stopped) return null;
            if (done) { html += decoder.decode(); break; }
            if (!value) continue;
            const prefix = value.subarray(0, maxBytes - totalBytes);
            totalBytes += prefix.byteLength;
            html += decoder.decode(prefix, { stream: true });
            const headEnd = html.search(/<\/head\s*>|<body\b/i);
            if (headEnd >= 0 || totalBytes >= maxBytes) {
              html = headEnd >= 0 ? html.slice(0, headEnd) : html + decoder.decode();
              cancelReader(reader);
              break;
            }
          }
        } finally {
          if (currentReader === reader) currentReader = null;
          try { reader.releaseLock(); } catch { /* Reader may already be released by cancellation. */ }
        }
        if (stopped) return null;
        currentResponse = null;
        return extractSiteTitle(html);
      }
    } catch {
      if (currentReader) cancelReader(currentReader);
      else if (currentResponse) cancelBody(currentResponse);
      currentReader = null;
      currentResponse = null;
      return null;
    }
    return null;
  };

  try {
    const result = await Promise.race([run(), interruption]);
    return result === INTERRUPTED ? null : result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onExternalAbort);
    stopped = true;
  }
}
