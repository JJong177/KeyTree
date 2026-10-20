/**
 * TOTP / HOTP 实现（RFC 4226 / RFC 6238）+ Steam 变体。
 *
 * 为什么自己写而不引库：算法本身只有几十行，用浏览器原生 crypto.subtle 做 HMAC，
 * 不引入第三方依赖也不用碰 wasm；这样离线、可审计、体积为零。
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY";

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export interface TotpConfig {
  secret: Uint8Array;
  period: number;
  digits: number;
  algorithm: TotpAlgorithm;
  /** Steam 守护令牌：5 位、专用字母表 */
  steam: boolean;
  issuer: string;
  account: string;
}

export interface TotpResult {
  code: string;
  /** 当前码剩余秒数 */
  remaining: number;
  period: number;
}

/** Base32 解码（RFC 4648，容忍空格/短横线/末尾 =） */
export function base32Decode(input: string): Uint8Array {
  const clean = input
    .replace(/[\s-]/g, "")
    .replace(/=+$/g, "")
    .toUpperCase();
  if (!clean) throw new Error("密钥为空");

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index < 0) throw new Error(`密钥含非法 Base32 字符「${ch}」`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

function normalizeAlgorithm(raw: string | null): TotpAlgorithm {
  const v = (raw ?? "").toUpperCase().replace(/[-_]/g, "");
  if (v === "SHA256") return "SHA-256";
  if (v === "SHA512") return "SHA-512";
  return "SHA-1";
}

/**
 * 解析 otpauth:// URI（KeePassXC / Google Authenticator 导出的格式）。
 * 只支持基于时间的 totp（hotp 是计数器型，密码库里没有对应语义）。
 */
export function parseOtpauth(uri: string): TotpConfig | null {
  const raw = (uri ?? "").trim();
  if (!/^otpauth:\/\//i.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const kind = url.host.toLowerCase();
  if (kind !== "totp" && kind !== "steam") return null;

  const secretRaw = url.searchParams.get("secret");
  if (!secretRaw) return null;

  let secret: Uint8Array;
  try {
    secret = base32Decode(secretRaw);
  } catch {
    return null;
  }

  const label = decodeURIComponent(url.pathname.replace(/^\//, ""));
  const [labelIssuer, ...rest] = label.split(":");
  const account = (rest.length ? rest.join(":") : label).trim();
  const steam = kind === "steam";
  const digitsRaw = Number(url.searchParams.get("digits"));
  const periodRaw = Number(url.searchParams.get("period"));

  return {
    secret,
    period: Number.isFinite(periodRaw) && periodRaw > 0 ? periodRaw : 30,
    digits: steam
      ? 5
      : Number.isFinite(digitsRaw) && digitsRaw >= 4 && digitsRaw <= 10
        ? digitsRaw
        : 6,
    algorithm: normalizeAlgorithm(url.searchParams.get("algorithm")),
    steam,
    issuer: (url.searchParams.get("issuer") || labelIssuer || "").trim(),
    account,
  };
}

/**
 * 解析 KeePassXC 的旧式字段：
 *   TOTP Seed = base32
 *   TOTP Settings = "30;6" 或 "30;S"（S 表示 Steam）
 */
export function parseLegacyTotp(
  seed: string,
  settings?: string
): TotpConfig | null {
  const raw = (seed ?? "").trim();
  if (!raw) return null;

  let period = 30;
  let digits = 6;
  let steam = false;

  if (settings) {
    const [periodRaw, digitsRaw] = settings.split(";");
    const p = Number(periodRaw);
    if (Number.isFinite(p) && p > 0) period = p;
    const d = (digitsRaw ?? "").trim().toUpperCase();
    if (d === "S") {
      steam = true;
      digits = 5;
    } else {
      const n = Number(d);
      if (Number.isFinite(n) && n >= 4 && n <= 10) digits = n;
    }
  }

  let secret: Uint8Array;
  try {
    secret = base32Decode(raw);
  } catch {
    return null;
  }

  return {
    secret,
    period,
    digits,
    algorithm: "SHA-1",
    steam,
    issuer: "",
    account: "",
  };
}

/** 当前周期还剩几秒（用于倒计时环） */
export function secondsRemaining(period: number, now = Date.now()): number {
  const p = period > 0 ? period : 30;
  return p - (Math.floor(now / 1000) % p);
}

/** 生成当前动态码 */
export async function generateTotp(
  config: TotpConfig,
  now = Date.now()
): Promise<TotpResult> {
  const period = config.period > 0 ? config.period : 30;
  const counter = Math.floor(now / 1000 / period);
  const message = new ArrayBuffer(8);
  new DataView(message).setBigUint64(0, BigInt(counter), false);

  const key = await crypto.subtle.importKey(
    "raw",
    config.secret,
    { name: "HMAC", hash: config.algorithm },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, message)
  );

  // RFC 4226 §5.3 动态截断
  const offset = signature[signature.length - 1] & 0x0f;
  const binary =
    ((signature[offset] & 0x7f) << 24) |
    (signature[offset + 1] << 16) |
    (signature[offset + 2] << 8) |
    signature[offset + 3];

  let code: string;
  if (config.steam) {
    let value = binary >>> 0;
    let out = "";
    for (let i = 0; i < 5; i++) {
      out += STEAM_ALPHABET[value % STEAM_ALPHABET.length];
      value = Math.floor(value / STEAM_ALPHABET.length);
    }
    code = out;
  } else {
    code = String(binary % 10 ** config.digits).padStart(config.digits, "0");
  }

  return {
    code,
    remaining: secondsRemaining(period, now),
    period,
  };
}

/** 展示用格式：482913 → "482 913"；Steam 5 位 → "AB3 4C" */
export function formatCode(code: string): string {
  if (code.length === 6) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 5) return `${code.slice(0, 3)} ${code.slice(3)}`;
  if (code.length === 8) return `${code.slice(0, 4)} ${code.slice(4)}`;
  return code;
}
