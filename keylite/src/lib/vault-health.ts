import { passphraseStrength, strength } from "./format";
export interface HealthEntry { id: string; password: string; expires: boolean; expiryTime: Date | null; hasTotp: boolean }
export function healthSummary(entries: HealthEntry[], now = Date.now()) {
  const passwords = entries.filter(e => !!e.password), counts = new Map<string, number>();
  const groups = new Map<string, string[]>();
  for (const e of passwords) {
    counts.set(e.password, (counts.get(e.password) ?? 0) + 1);
    const ids = groups.get(e.password) ?? [];
    ids.push(e.id); groups.set(e.password, ids);
  }
  return {
    total: entries.length, withPassword: passwords.length,
    weak: passwords.filter(e => (passphraseStrength(e.password) ?? strength(e.password)).score < 60).map(e => e.id),
    duplicate: passwords.filter(e => (counts.get(e.password) ?? 0) > 1).map(e => e.id),
    expired: entries.filter(e => e.expires && e.expiryTime && e.expiryTime.getTime() < now).map(e => e.id),
    duplicateGroups: [...groups.values()].filter(ids => ids.length > 1),
    withTotp: entries.filter(e => e.hasTotp).length,
  };
}
export function kdfDetails(header: { kdfParameters?: { get(key: string): unknown }; keyEncryptionRounds?: number }): Array<{ label: string; value: string }> {
  const params = header.kdfParameters;
  const number = (key: string) => { try { const n = Number(params?.get(key)); return Number.isFinite(n) && n >= 0 ? n : null; } catch { return null; } };
  if (!params) return [{ label: "迭代", value: String(header.keyEncryptionRounds ?? "未知") }];
  const out: Array<{ label: string; value: string }> = [];
  const memory = number("M"), iterations = number("I") ?? number("R"), parallelism = number("P");
  if (memory !== null) out.push({ label: "内存", value: `${(memory / 1024 / 1024).toFixed(1)} MiB` });
  if (iterations !== null) out.push({ label: "迭代", value: String(iterations) });
  if (parallelism !== null) out.push({ label: "并行度", value: String(parallelism) });
  return out;
}
