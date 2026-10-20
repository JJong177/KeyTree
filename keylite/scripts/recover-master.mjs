/**
 * 主密码找回脚本（纯本地运行，密码不会离开本机）：
 * 1. 从 recovery-candidates.txt 读取你记得的候选密码（每行一个）
 * 2. 自动从 scripts/*.mjs|py、src-tauri 中提取开发期硬编码的字符串作为候选
 * 3. 对每个候选生成常见变体（大小写、常见前后缀）
 * 4. 逐一尝试解锁 我的密码库.kdbx
 * 成功时把密码写入 recovery-result.txt（自己打开查看），控制台不打印密码。
 *
 * 跑法：node scripts/recover-master.mjs
 */
import kdbxweb from "../vendor/kdbxweb/dist/kdbxweb.js";
import { argon2d, argon2i, argon2id } from "@noble/hashes/argon2.js";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

kdbxweb.CryptoEngine.setArgon2Impl(
  (password, salt, memory, iterations, length, parallelism, type) => {
    const impl = type === 0 ? argon2d : type === 1 ? argon2i : argon2id;
    const out = impl(new Uint8Array(password), new Uint8Array(salt), {
      t: iterations,
      m: memory,
      p: parallelism,
      dkLen: length,
    });
    return Promise.resolve(
      out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
    );
  }
);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VAULT = join(root, "我的密码库.kdbx");
const CANDIDATES_FILE = join(root, "recovery-candidates.txt");
const RESULT_FILE = join(root, "recovery-result.txt");

// ---------- 收集候选 ----------
const candidates = new Set();

// 1) 用户手工填的候选
if (existsSync(CANDIDATES_FILE)) {
  for (const line of readFileSync(CANDIDATES_FILE, "utf8").split(/\r?\n/)) {
    const v = line.trim();
    if (v && !v.startsWith("#")) candidates.add(v);
  }
}

// 2) 从开发脚本里抠硬编码字符串（本地处理，不打印）
const SKIP = new Set([
  "utf8", "utf-8", "Title", "UserName", "Password", "URL", "Notes",
  "RESULT: PASS", "RESULT: FAIL",
]);
const looksLikePath = (s) =>
  /[\\/]/.test(s) || /\.(mjs|js|py|rs|kdbx|txt|json|html|css|png|ico)$/i.test(s) ||
  /^https?:/i.test(s) || s.includes(" ") || s.length < 4 || s.length > 64;

function extractFrom(file) {
  try {
    const src = readFileSync(file, "utf8");
    for (const m of src.matchAll(/["'`]([^"'`]{4,64})["'`]/g)) {
      const s = m[1];
      if (!SKIP.has(s) && !looksLikePath(s) && !/^[a-z]+(-[a-z]+)*$/.test(s)) {
        candidates.add(s);
      }
    }
  } catch {}
}
const scriptsDir = join(root, "scripts");
for (const f of readdirSync(scriptsDir)) {
  if (/\.(mjs|py)$/.test(f) && f !== "recover-master.mjs") {
    extractFrom(join(scriptsDir, f));
  }
}

// 3) 常见变体
const bases = [...candidates];
const SUFFIXES = ["", "1", "12", "123", "1234", "!", "@", "#", "!!", "2024", "2025", "2026", "@123", "!123"];
for (const b of bases) {
  for (const suf of SUFFIXES) {
    candidates.add(b + suf);
    candidates.add(b.toLowerCase() + suf);
    candidates.add(b.toUpperCase() + suf);
    candidates.add(b[0].toUpperCase() + b.slice(1) + suf);
  }
}

const list = [...candidates];
console.log(`vault      : ${VAULT}`);
console.log(`candidates : ${list.length}`);
console.log("trying... (每个候选约需 0.1~1 秒，Argon2 解密开销)");

// ---------- 逐一尝试 ----------
const data = readFileSync(VAULT);
const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);

let tried = 0;
for (const pw of list) {
  tried++;
  try {
    const creds = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(pw));
    await kdbxweb.Kdbx.load(buf, creds);
    writeFileSync(RESULT_FILE, pw, "utf8");
    console.log(`\nSUCCESS after ${tried} attempts.`);
    console.log(`主密码已写入: ${RESULT_FILE}`);
    console.log("（刻意不在控制台打印密码，请自己打开该文件查看，用完即删）");
    process.exit(0);
  } catch {
    if (tried % 50 === 0) console.log(`  ...${tried}/${list.length} 未命中`);
  }
}

console.log(`\nFAIL: ${list.length} 个候选全部不对。`);
console.log(`把你记得的密码线索（旧密码、生日、手机号、常用组合）写进 ${CANDIDATES_FILE}，每行一个，再跑一次。`);
process.exit(1);
