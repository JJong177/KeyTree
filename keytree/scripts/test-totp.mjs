// TOTP 算法的 RFC 6238 标准向量验证（跑之前先用 esbuild 把 TS 编译成 tmp/totp.mjs）
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = await import(
  pathToFileURL(resolve("tmp/totp.mjs")).href + `?t=${Date.now()}`
);
const { generateTotp, parseOtpauth, parseLegacyTotp, base32Decode, formatCode } =
  mod;

const decoder = new TextDecoder();
const secret = base32Decode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
console.log("Base32 解码 =", decoder.decode(secret), "(期望 12345678901234567890)");

const cases = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

let failed = 0;
for (const [seconds, expected] of cases) {
  const { code } = await generateTotp(
    {
      secret,
      period: 30,
      digits: 8,
      algorithm: "SHA-1",
      steam: false,
      issuer: "",
      account: "",
    },
    seconds * 1000
  );
  const ok = code === expected;
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} T=${seconds} → ${code}（期望 ${expected}）`);
}

// otpauth URI 解析
const uri =
  "otpauth://totp/GitHub:jong@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&period=30&digits=6&algorithm=SHA1";
const parsed = parseOtpauth(uri);
if (!parsed || parsed.issuer !== "GitHub" || parsed.account !== "jong@example.com") {
  failed++;
  console.log("❌ otpauth 解析失败", parsed);
} else {
  const { code } = await generateTotp(parsed, 1700000000000);
  console.log(`✅ otpauth 解析：${parsed.issuer}/${parsed.account} 当前码=${formatCode(code)}`);
}

// KeePassXC 旧字段（含 Steam）
const legacy = parseLegacyTotp("JBSWY3DPEHPK3PXP", "30;S");
if (!legacy || !legacy.steam || legacy.digits !== 5) {
  failed++;
  console.log("❌ 旧字段 Steam 解析失败", legacy);
} else {
  const { code } = await generateTotp(legacy, 1700000000000);
  console.log(`✅ 旧字段 Steam：${code}（长度 ${code.length}，字母表内=${/^[23456789BCDFGHJKMNPQRTVWXY]+$/.test(code)}）`);
}

// 非法输入应返回 null 而不是抛错
const bad = parseOtpauth("https://example.com/?secret=AAAA");
const bad2 = parseOtpauth("otpauth://totp/x?secret=!!!!");
console.log(bad === null && bad2 === null ? "✅ 非法输入返回 null" : "❌ 非法输入处理有误");
if (!(bad === null && bad2 === null)) failed++;

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
