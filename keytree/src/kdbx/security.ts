import type { Kdbx, KdbxHeader } from "kdbxweb";
import type { Kdbxweb } from "./kdbxweb";

export const ENCRYPTION_PROFILES = [
  { id: "recommended", label: "推荐", memoryMiB: 64 },
  { id: "strong", label: "加强", memoryMiB: 128 },
  { id: "maximum", label: "高成本", memoryMiB: 256 },
] as const;
export type EncryptionProfile = typeof ENCRYPTION_PROFILES[number]["id"];
export interface EncryptionTarget { memoryMiB: number; iterations: number; parallelism: number }

function numeric(value: unknown): number | null {
  const n = typeof value === "number" ? value : value && typeof value === "object" && "value" in value ? value.value : null;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
}
export function encryptionInfo(k: Kdbxweb, header: KdbxHeader) {
  const params = header.kdfParameters;
  const uuid = params?.get("$UUID");
  const id = uuid instanceof ArrayBuffer ? k.ByteUtils.bytesToBase64(uuid) : "";
  const argon = id === k.Consts.KdfId.Argon2id || id === k.Consts.KdfId.Argon2d;
  const memory = argon ? numeric(params?.get("M")) : null;
  const iterations = numeric(params?.get(argon ? "I" : "R")) ?? (header.versionMajor < 4 ? numeric(header.keyEncryptionRounds) : null);
  const parallelism = argon ? numeric(params?.get("P")) : null;
  const kdf = id === k.Consts.KdfId.Argon2id ? "Argon2id" : id === k.Consts.KdfId.Argon2d ? "Argon2d" : header.versionMajor < 4 || id === k.Consts.KdfId.Aes ? "AES-KDF" : "未知";
  const cipherId = header.dataCipherUuid?.toString();
  return {
    kdf,
    cipher: cipherId === k.Consts.CipherId.Aes ? "AES-256" : cipherId === k.Consts.CipherId.ChaCha20 ? "ChaCha20" : "未知",
    memoryMiB: memory === null ? null : memory / 1024 / 1024,
    iterations, parallelism,
    version: `KDBX ${header.versionMajor}.${header.versionMinor}`,
    needsUpgrade: header.versionMajor < 4 || kdf !== "Argon2id" || memory === null || memory < 64 * 1024 * 1024 || iterations === null || iterations < 3,
  };
}

/** Profiles are floors, not replacements: never lower existing Argon2 costs. */
export function encryptionTarget(k: Kdbxweb, header: KdbxHeader, profile: EncryptionProfile): EncryptionTarget {
  const selected = ENCRYPTION_PROFILES.find(item => item.id === profile);
  if (!selected) throw new Error("未知的加密强度档位");
  const info = encryptionInfo(k, header);
  if (info.kdf === "未知" || info.cipher === "未知") throw new Error("当前算法无法安全升级，请保留原库并使用兼容客户端处理");
  return {
    memoryMiB: Math.max(selected.memoryMiB, info.memoryMiB ?? 0),
    iterations: info.kdf.startsWith("Argon2") ? Math.max(3, info.iterations ?? 0) : 3,
    parallelism: info.parallelism ?? 1,
  };
}
export function applyEncryptionProfile(k: Kdbxweb, db: Kdbx, profile: EncryptionProfile): EncryptionTarget {
  const target = encryptionTarget(k, db.header, profile);
  if (db.versionMajor < 4) db.setVersion(4);
  db.setKdf(k.Consts.KdfId.Argon2id);
  const params = db.header.kdfParameters!;
  params.set("M", k.VarDictionary.ValueType.UInt64, k.Int64.from(target.memoryMiB * 1024 * 1024));
  params.set("I", k.VarDictionary.ValueType.UInt64, k.Int64.from(target.iterations));
  params.set("P", k.VarDictionary.ValueType.UInt32, target.parallelism);
  return target;
}

/** One KDF invocation, not total unlock/save time. Uses no vault secrets. */
export async function benchmarkEncryption(k: Kdbxweb, target: EncryptionTarget): Promise<number> {
  const pass = k.CryptoEngine.random(32), salt = k.CryptoEngine.random(32);
  const started = performance.now();
  try {
    const output = await k.CryptoEngine.argon2(pass, salt, target.memoryMiB * 1024, target.iterations, 32, target.parallelism, k.CryptoEngine.Argon2TypeArgon2id, 0x13);
    new Uint8Array(output).fill(0);
    return Math.max(1, Math.round(performance.now() - started));
  } finally {
    pass.fill(0); salt.fill(0);
  }
}
