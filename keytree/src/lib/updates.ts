import { getVersion as tauriGetVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { computed, reactive, type ComputedRef } from "vue";

export interface UpdateRelease {
  tag: string;
  version: string;
  name: string;
  notes: string;
  pageUrl: string;
  downloadUrl: string | null;
}

export interface UpdateState {
  currentVersion: string | null;
  checking: boolean;
  status: "unchecked" | "current" | "available" | "failed" | "unavailable";
  release: UpdateRelease | null;
  checkedAt: number | null;
  error: string;
}

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
  /** Canonical version without a leading v or build metadata. */
  version: string;
}

export interface UpdateServiceOptions {
  getVersion?: () => Promise<string>;
  fetch?: typeof import("@tauri-apps/plugin-http").fetch;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  now?: () => number;
  openUrl?: (url: string) => Promise<void>;
  timeoutMs?: number;
  maxBytes?: number;
}

export interface UpdateService {
  state: UpdateState;
  hasUpdate: ComputedRef<boolean>;
  initialize(): Promise<void>;
  check(options?: { force?: boolean }): Promise<void>;
  openRelease(): Promise<boolean>;
  openDownload(): Promise<boolean>;
}

const RELEASE_API = "https://api.github.com/repos/JJong177/KeyTree/releases/latest";
const REPOSITORY = "JJong177/KeyTree";
const CACHE_KEY = "keytree.updates.v1";
const CACHE_SCHEMA = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SERVER_BACKOFF_MS = DAY_MS;
const DEFAULT_BACKOFF_MS = 15 * 60 * 1000;
const MIN_BACKOFF_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 8_000;
const HARD_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 512 * 1024;
const HARD_MAX_BYTES = 512 * 1024;
const MAX_NOTES_LENGTH = 12_000;
const MAX_CACHE_CHARS = 1024 * 1024;

const ERROR_VERSION = "无法读取有效的应用版本，暂时无法检查更新";
const ERROR_NETWORK = "暂时无法检查更新，请稍后重试";
const ERROR_TIMEOUT = "检查更新超时，请稍后重试";
const ERROR_RATE_LIMIT = "GitHub 请求已限流，请稍后重试";
const ERROR_INVALID_RELEASE = "无法验证最新版本信息，请稍后重试";

type FailureCode = "network" | "timeout" | "rate-limit" | "invalid-release";
type CacheFailureCode = FailureCode | null;

interface UpdateCache {
  schema: 1;
  applicationVersion: string;
  lastAttemptAt: number | null;
  checkedAt: number | null;
  release: UpdateRelease | null;
  lastFailure: CacheFailureCode;
  backoffUntil: number | null;
}

interface NativeRequestInit extends RequestInit {
  maxRedirections: number;
  connectTimeout: number;
}

class RequestFailure extends Error {
  readonly code: FailureCode;
  readonly backoffUntil: number | null;

  constructor(code: FailureCode, backoffUntil: number | null = null) {
    super(code);
    this.code = code;
    this.backoffUntil = backoffUntil;
  }
}

/** Parse a strict safe semver, accepting an optional v prefix and two-part shorthand. */
export function parseVersion(input: string): ParsedVersion | null {
  if (typeof input !== "string" || input.length === 0 || input.length > 128) return null;
  const match = input.match(
    /^[vV]?((?:0|[1-9]\d*))\.((?:0|[1-9]\d*))(?:\.((?:0|[1-9]\d*)))?(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
  );
  if (!match) return null;

  const core = [match[1], match[2], match[3] ?? "0"];
  const numbers = core.map((part) => Number(part));
  if (numbers.some((value) => !Number.isSafeInteger(value) || value < 0)) return null;

  const prerelease = match[4] ? match[4].split(".") : [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && (!Number.isSafeInteger(Number(identifier)) || identifier.length > 1 && identifier.startsWith("0"))) {
      return null;
    }
  }

  const version = `${numbers[0]}.${numbers[1]}.${numbers[2]}${prerelease.length ? `-${prerelease.join(".")}` : ""}`;
  return { major: numbers[0], minor: numbers[1], patch: numbers[2], prerelease, version };
}

function compareParsedVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    if (left.prerelease.length === right.prerelease.length) return 0;
    return left.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      if (a.length !== b.length) return a.length < b.length ? -1 : 1;
      return a < b ? -1 : 1;
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  if (left.prerelease.length === right.prerelease.length) return 0;
  return left.prerelease.length < right.prerelease.length ? -1 : 1;
}

/** Compare valid versions by semver precedence; return null if either input is invalid. */
export function compareVersions(left: string, right: string): number | null {
  const parsedLeft = parseVersion(left);
  const parsedRight = parseVersion(right);
  return parsedLeft && parsedRight ? compareParsedVersions(parsedLeft, parsedRight) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanPlainText(value: string, maxLength: number): string {
  const plain = value
    .replace(/!\[([^\]]*)\]\([^\n)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^\n)]*\)/g, "$1")
    .replace(/<https?:\/\/[^>\s]+>/gi, "")
    .replace(/<\/?[A-Za-z][^>]*>/g, " ")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return Array.from(plain).slice(0, maxLength).join("");
}

function versionForTag(tag: string): ParsedVersion | null {
  if (tag.length > 128) return null;
  const parsed = parseVersion(tag);
  return parsed && parsed.prerelease.length === 0 ? parsed : null;
}

function pageUrlForTag(tag: string): string {
  return `https://github.com/${REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`;
}

function downloadUrlForTag(tag: string): string {
  return `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/KeyTree-Setup.exe`;
}

function trustedUrl(input: unknown, expected: string): input is string {
  if (typeof input !== "string" || input.length > 512 || input !== expected) return false;
  try {
    const parsed = new URL(input);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" && parsed.port === "" &&
      parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "" && parsed.href === expected;
  } catch {
    return false;
  }
}

/** Validate a GitHub latest-release response and retain only public, trusted metadata. */
export function parseRelease(value: unknown): UpdateRelease | null {
  if (!isRecord(value) || value.draft !== false || value.prerelease !== false) return null;
  if (typeof value.tag_name !== "string" || value.tag_name.length > 128) return null;
  const parsedVersion = versionForTag(value.tag_name);
  if (!parsedVersion) return null;

  const pageUrl = pageUrlForTag(value.tag_name);
  if (!trustedUrl(value.html_url, pageUrl)) return null;

  if (value.name !== undefined && value.name !== null && typeof value.name !== "string") return null;
  if (typeof value.body !== "undefined" && value.body !== null && typeof value.body !== "string") return null;
  const name = typeof value.name === "string" ? cleanPlainText(value.name, 256) : "";
  const notes = typeof value.body === "string" ? cleanPlainText(value.body, MAX_NOTES_LENGTH) : "";

  let downloadUrl: string | null = null;
  if (Array.isArray(value.assets)) {
    for (const asset of value.assets) {
      if (!isRecord(asset) || asset.name !== "KeyTree-Setup.exe") continue;
      const candidate = downloadUrlForTag(value.tag_name);
      if (trustedUrl(asset.browser_download_url, candidate)) {
        downloadUrl = candidate;
        break;
      }
    }
  }

  return {
    tag: value.tag_name,
    version: parsedVersion.version,
    name,
    notes,
    pageUrl,
    downloadUrl,
  };
}

function parseCachedRelease(value: unknown): UpdateRelease | null {
  if (!isRecord(value) || typeof value.tag !== "string" || value.tag.length > 128) return null;
  const parsed = versionForTag(value.tag);
  if (!parsed || value.version !== parsed.version) return null;
  const pageUrl = pageUrlForTag(value.tag);
  if (!trustedUrl(value.pageUrl, pageUrl)) return null;
  if (typeof value.name !== "string" || Array.from(value.name).length > 256) return null;
  if (typeof value.notes !== "string" || Array.from(value.notes).length > MAX_NOTES_LENGTH) return null;
  let downloadUrl: string | null = null;
  if (value.downloadUrl !== null) {
    const candidate = downloadUrlForTag(value.tag);
    if (!trustedUrl(value.downloadUrl, candidate)) return null;
    downloadUrl = candidate;
  }
  const name = typeof value.name === "string" ? cleanPlainText(value.name, 256) : "";
  const notes = cleanPlainText(value.notes, MAX_NOTES_LENGTH);
  return { tag: value.tag, version: parsed.version, name, notes, pageUrl, downloadUrl };
}

function validTimestamp(value: unknown, now: number): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= now);
}

function parseCache(raw: string | null, now: number): UpdateCache | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CACHE_CHARS) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.schema !== CACHE_SCHEMA || typeof value.applicationVersion !== "string") return null;
    const applicationVersion = parseVersion(value.applicationVersion);
    if (!applicationVersion || applicationVersion.version !== value.applicationVersion) return null;
    if (!validTimestamp(value.lastAttemptAt, now) || !validTimestamp(value.checkedAt, now)) return null;
    if (value.lastFailure !== null && value.lastFailure !== "network" && value.lastFailure !== "timeout" && value.lastFailure !== "rate-limit" && value.lastFailure !== "invalid-release") return null;
    if (value.checkedAt !== null && value.lastAttemptAt !== null &&
      (value.lastFailure === null ? value.checkedAt < value.lastAttemptAt : value.checkedAt > value.lastAttemptAt)) return null;
    if (value.lastAttemptAt === null && (value.lastFailure !== null || value.checkedAt !== null)) return null;
    if (value.lastAttemptAt !== null && value.lastFailure === null && value.checkedAt === null) return null;
    if (value.lastFailure === "rate-limit") {
      if (typeof value.backoffUntil !== "number" || !Number.isSafeInteger(value.backoffUntil) || value.backoffUntil < 0 || value.backoffUntil > now + MAX_SERVER_BACKOFF_MS) return null;
    } else if (value.backoffUntil !== null) {
      return null;
    }
    const release = value.release === null ? null : parseCachedRelease(value.release);
    if (value.release !== null && !release) return null;
    if (value.checkedAt !== null && !release) return null;
    return {
      schema: CACHE_SCHEMA,
      applicationVersion: applicationVersion.version,
      lastAttemptAt: value.lastAttemptAt,
      checkedAt: value.checkedAt,
      release,
      lastFailure: value.lastFailure as CacheFailureCode,
      backoffUntil: value.backoffUntil as number | null,
    };
  } catch {
    return null;
  }
}

function boundedOption(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function cancelResponse(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // Best-effort cancellation for a response that is not being read.
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // Best-effort cancellation for an interrupted stream.
  }
}

function responseUrlIsTrusted(response: Response): boolean {
  if (!response.url) return true;
  try {
    const parsed = new URL(response.url);
    return parsed.href === RELEASE_API && parsed.protocol === "https:" && parsed.hostname === "api.github.com" &&
      parsed.port === "" && parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "";
  } catch {
    return false;
  }
}

function rateLimitBackoff(response: Response, now: number): number {
  const retryAfter = response.headers.get("retry-after");
  let requested: number | null = null;
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter.trim())) {
      requested = now + Number(retryAfter.trim()) * 1000;
    } else {
      const parsedDate = Date.parse(retryAfter);
      if (Number.isFinite(parsedDate)) requested = parsedDate;
    }
  }
  const reset = response.headers.get("x-ratelimit-reset");
  if (reset && /^\d+$/.test(reset.trim())) {
    const resetAt = Number(reset.trim()) * 1000;
    if (Number.isSafeInteger(resetAt)) requested = Math.max(requested ?? 0, resetAt);
  }
  const lowerBound = now + MIN_BACKOFF_MS;
  const upperBound = now + MAX_SERVER_BACKOFF_MS;
  const target = requested !== null && Number.isFinite(requested) ? Math.max(lowerBound, requested) : now + DEFAULT_BACKOFF_MS;
  return Math.min(upperBound, target);
}

async function fetchLatestRelease(
  fetcher: typeof import("@tauri-apps/plugin-http").fetch,
  timeoutMs: number,
  maxBytes: number,
  now: () => number,
): Promise<unknown> {
  const controller = new AbortController();
  let stopped = false;
  let currentResponse: Response | null = null;
  let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let finishTimeout!: () => void;
  const timeoutSignal = new Promise<symbol>((resolve) => {
    finishTimeout = () => resolve(TIMED_OUT);
  });
  const requestInit: NativeRequestInit = {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "KeyTree-update-check",
    },
    credentials: "omit",
    referrer: "",
    referrerPolicy: "no-referrer",
    cache: "no-store",
    redirect: "error",
    maxRedirections: 0,
    connectTimeout: timeoutMs,
    signal: controller.signal,
  };

  const interrupt = () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    if (currentReader) cancelReader(currentReader);
    else if (currentResponse) cancelResponse(currentResponse);
    finishTimeout();
  };
  const timer = setTimeout(interrupt, timeoutMs);

  const run = async (): Promise<unknown> => {
    try {
      const pending = Promise.resolve().then(() => fetcher(RELEASE_API, requestInit));
      void pending.then((lateResponse) => { if (stopped) cancelResponse(lateResponse); }, () => undefined);
      const response = await pending;
      if (stopped) {
        cancelResponse(response);
        throw new RequestFailure("timeout");
      }
      currentResponse = response;
      if (response.redirected || !responseUrlIsTrusted(response)) {
        cancelResponse(response);
        currentResponse = null;
        throw new RequestFailure("network");
      }

      if (response.status === 429 || response.status === 403 &&
        (response.headers.get("x-ratelimit-remaining")?.trim() === "0" || response.headers.has("retry-after"))) {
        const backoffUntil = rateLimitBackoff(response, now());
        cancelResponse(response);
        currentResponse = null;
        throw new RequestFailure("rate-limit", backoffUntil);
      }
      if (!response.ok) {
        cancelResponse(response);
        currentResponse = null;
        throw new RequestFailure("network");
      }
      const contentType = response.headers.get("content-type");
      if (!contentType || !/^\s*application\/json(?:\s*;|\s*$)/i.test(contentType)) {
        cancelResponse(response);
        currentResponse = null;
        throw new RequestFailure("network");
      }
      const lengthHeader = response.headers.get("content-length");
      if (lengthHeader && /^\d+$/.test(lengthHeader.trim()) && Number(lengthHeader.trim()) > maxBytes) {
        cancelResponse(response);
        currentResponse = null;
        throw new RequestFailure("network");
      }
      if (!response.body) {
        currentResponse = null;
        throw new RequestFailure("network");
      }

      const reader = response.body.getReader();
      currentReader = reader;
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (stopped) throw new RequestFailure("timeout");
          if (done) break;
          if (!value) continue;
          if (total + value.byteLength > maxBytes) {
            cancelReader(reader);
            throw new RequestFailure("network");
          }
          chunks.push(value);
          total += value.byteLength;
        }
      } finally {
        if (currentReader === reader) currentReader = null;
        try { reader.releaseLock(); } catch { /* The reader may have been cancelled by timeout. */ }
      }
      if (stopped) throw new RequestFailure("timeout");
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      let body: string;
      try {
        body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new RequestFailure("network");
      }
      currentResponse = null;
      try {
        return JSON.parse(body) as unknown;
      } catch {
        throw new RequestFailure("network");
      }
    } catch (error) {
      if (currentReader) cancelReader(currentReader);
      else if (currentResponse) cancelResponse(currentResponse);
      currentReader = null;
      currentResponse = null;
      if (error instanceof RequestFailure) throw error;
      if (stopped) throw new RequestFailure("timeout");
      throw new RequestFailure("network");
    }
  };

  try {
    const result = await Promise.race([run(), timeoutSignal]);
    if (result === TIMED_OUT) throw new RequestFailure("timeout");
    return result;
  } finally {
    clearTimeout(timer);
    stopped = true;
    if (currentReader) cancelReader(currentReader);
    else if (currentResponse) cancelResponse(currentResponse);
  }
}

const TIMED_OUT = Symbol("update-request-timeout");

function errorFor(code: FailureCode | null): string {
  switch (code) {
    case "timeout": return ERROR_TIMEOUT;
    case "rate-limit": return ERROR_RATE_LIMIT;
    case "invalid-release": return ERROR_INVALID_RELEASE;
    default: return ERROR_NETWORK;
  }
}

function hasVersionUpdate(currentVersion: string | null, release: UpdateRelease | null): boolean {
  if (!currentVersion || !release) return false;
  const comparison = compareVersions(release.version, currentVersion);
  return comparison !== null && comparison > 0;
}

function currentStorage(options: UpdateServiceOptions): Pick<Storage, "getItem" | "setItem"> | null {
  if (options.storage !== undefined) return options.storage;
  try {
    return typeof globalThis.localStorage === "undefined" ? null : globalThis.localStorage;
  } catch {
    return null;
  }
}

/** Create an isolated update service. Construction is inert; initialize/check perform all I/O. */
export function createUpdateService(options: UpdateServiceOptions = {}): UpdateService {
  const state = reactive<UpdateState>({
    currentVersion: null,
    checking: false,
    status: "unchecked",
    release: null,
    checkedAt: null,
    error: "",
  });
  const hasUpdate = computed(() => hasVersionUpdate(state.currentVersion, state.release));
  const getVersion = options.getVersion ?? tauriGetVersion;
  const fetcher = options.fetch ?? tauriFetch;
  const opener = options.openUrl ?? (async (url: string) => { await invoke<void>("open_url", { url }); });
  const timeoutMs = boundedOption(options.timeoutMs, DEFAULT_TIMEOUT_MS, HARD_TIMEOUT_MS);
  const maxBytes = boundedOption(options.maxBytes, DEFAULT_MAX_BYTES, HARD_MAX_BYTES);

  let cache: UpdateCache | null = null;
  let initializePromise: Promise<void> | null = null;
  let checkPromise: Promise<void> | null = null;

  const readNow = (): number => {
    try {
      const value = options.now?.() ?? Date.now();
      return Number.isSafeInteger(value) && value >= 0 ? value : Date.now();
    } catch {
      return Date.now();
    }
  };

  const readCache = (now: number): UpdateCache | null => {
    try {
      const storage = currentStorage(options);
      return storage ? parseCache(storage.getItem(CACHE_KEY), now) : null;
    } catch {
      return null;
    }
  };

  const writeCache = (): void => {
    if (!cache) return;
    try {
      currentStorage(options)?.setItem(CACHE_KEY, JSON.stringify(cache));
    } catch {
      // Storage is a best-effort optimization; it never blocks checking or UI state.
    }
  };

  const restoreCacheState = (restored: UpdateCache | null): void => {
    cache = restored;
    if (!restored) return;
    state.release = restored.release;
    state.checkedAt = restored.checkedAt;
    if (restored.lastFailure !== null) {
      state.status = "failed";
      state.error = errorFor(restored.lastFailure);
      return;
    }
    if (restored.checkedAt !== null) {
      state.status = hasVersionUpdate(state.currentVersion, restored.release) ? "available" : "current";
      state.error = "";
    } else if (restored.lastAttemptAt !== null) {
      // A process may have stopped after persisting an attempt but before its result.
      state.status = "failed";
      state.error = ERROR_NETWORK;
    }
  };

  const initialize = (): Promise<void> => {
    if (state.currentVersion !== null) return Promise.resolve();
    if (initializePromise) return initializePromise;
    const task = (async () => {
      try {
        const rawVersion = await getVersion();
        const parsed = typeof rawVersion === "string" ? parseVersion(rawVersion) : null;
        if (!parsed) {
          state.currentVersion = null;
          state.status = "unavailable";
          state.error = ERROR_VERSION;
          return;
        }
        state.currentVersion = parsed.version;
        state.status = "unchecked";
        state.release = null;
        state.checkedAt = null;
        state.error = "";
        restoreCacheState(readCache(readNow()));
      } catch {
        state.currentVersion = null;
        state.status = "unavailable";
        state.error = ERROR_VERSION;
      }
    })();
    initializePromise = task;
    void task.then(() => { if (initializePromise === task) initializePromise = null; });
    return task;
  };

  const runCheck = async (force: boolean): Promise<void> => {
    try {
      await initialize();
      const currentVersion = state.currentVersion;
      if (!currentVersion) return;

      const now = readNow();
      if (cache?.lastFailure === "rate-limit" && cache.backoffUntil !== null && now < cache.backoffUntil) {
        state.status = "failed";
        state.error = ERROR_RATE_LIMIT;
        return;
      }
      if (!force && cache?.applicationVersion === currentVersion && cache.lastAttemptAt !== null && now >= cache.lastAttemptAt && now - cache.lastAttemptAt < DAY_MS) {
        return;
      }

      const attemptAt = now;
      cache = {
        schema: CACHE_SCHEMA,
        applicationVersion: currentVersion,
        lastAttemptAt: attemptAt,
        checkedAt: cache?.checkedAt ?? state.checkedAt,
        release: cache?.release ?? state.release,
        // Persist a safe failure marker before network I/O so an interrupted process is never restored as current.
        lastFailure: "network",
        backoffUntil: null,
      };
      writeCache();
      state.checking = true;

      try {
        const payload = await fetchLatestRelease(fetcher, timeoutMs, maxBytes, readNow);
        const release = parseRelease(payload);
        if (!release) throw new RequestFailure("invalid-release");
        const checkedAt = readNow();
        cache = {
          schema: CACHE_SCHEMA,
          applicationVersion: currentVersion,
          lastAttemptAt: attemptAt,
          checkedAt,
          release,
          lastFailure: null,
          backoffUntil: null,
        };
        state.release = release;
        state.checkedAt = checkedAt;
        state.status = hasVersionUpdate(currentVersion, release) ? "available" : "current";
        state.error = "";
        writeCache();
      } catch (error) {
        const failure = error instanceof RequestFailure ? error : new RequestFailure("network");
        cache = {
          schema: CACHE_SCHEMA,
          applicationVersion: currentVersion,
          lastAttemptAt: attemptAt,
          checkedAt: cache?.checkedAt ?? state.checkedAt,
          release: cache?.release ?? state.release,
          lastFailure: failure.code,
          backoffUntil: failure.code === "rate-limit" ? failure.backoffUntil ?? readNow() + DEFAULT_BACKOFF_MS : null,
        };
        state.status = "failed";
        state.error = errorFor(failure.code);
        writeCache();
      } finally {
        state.checking = false;
      }
    } catch {
      // Public service methods are deliberately non-rejecting.
      state.checking = false;
      if (!state.currentVersion) {
        state.status = "unavailable";
        state.error = ERROR_VERSION;
      } else {
        state.status = "failed";
        state.error = ERROR_NETWORK;
      }
    }
  };

  const check = async (checkOptions: { force?: boolean } = {}): Promise<void> => {
    if (checkPromise) {
      await checkPromise;
      return;
    }
    const task = runCheck(checkOptions.force === true);
    checkPromise = task;
    try {
      await task;
    } finally {
      if (checkPromise === task) checkPromise = null;
    }
  };

  const openRelease = async (): Promise<boolean> => {
    try {
      const release = state.release ? parseCachedRelease(state.release) : null;
      if (!hasUpdate.value || !release || !trustedUrl(release.pageUrl, pageUrlForTag(release.tag))) return false;
      await opener(release.pageUrl);
      return true;
    } catch {
      return false;
    }
  };

  const openDownload = async (): Promise<boolean> => {
    try {
      const release = state.release ? parseCachedRelease(state.release) : null;
      if (!hasUpdate.value || !release || !release.downloadUrl || !trustedUrl(release.downloadUrl, downloadUrlForTag(release.tag))) return false;
      await opener(release.downloadUrl);
      return true;
    } catch {
      return false;
    }
  };

  return { state, hasUpdate, initialize, check, openRelease, openDownload };
}

let sharedService: UpdateService | null = null;

/** Return the shared lazy/default service; merely importing this module performs no I/O. */
export function useUpdates(): UpdateService {
  if (!sharedService) sharedService = createUpdateService();
  return sharedService;
}
