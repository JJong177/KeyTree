// 验证：密钥文件启用/移除、主密码修改后的重新加密是否真的生效
import { createRequire } from "node:module";
import { argon2d, argon2i, argon2id } from "@noble/hashes/argon2.js";

const require = createRequire("D:/workbuddy/Easy/keylite/package.json");
const kdbxweb = require("D:/workbuddy/Easy/keylite/vendor/kdbxweb/dist/kdbxweb.js");

kdbxweb.CryptoEngine.setArgon2Impl((p, s, mem, iter, len, par, type) => {
  const fn = type === 0 ? argon2d : type === 1 ? argon2i : argon2id;
  return Promise.resolve(
    new Uint8Array(
      fn(new Uint8Array(p), new Uint8Array(s), { t: iter, m: mem, p: par, dkLen: len })
    ).buffer
  );
});

const pv = (text) => kdbxweb.ProtectedValue.fromString(text);
const toBuf = (v) =>
  v instanceof ArrayBuffer
    ? v
    : v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength);

async function tryLoad(buffer, password, keyFile) {
  try {
    const db = await kdbxweb.Kdbx.load(
      buffer.slice(0),
      new kdbxweb.Credentials(password === null ? null : pv(password), keyFile ?? null)
    );
    return { ok: true, db };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

let failed = 0;
const check = (label, actual, expected) => {
  const pass = actual === expected;
  if (!pass) failed++;
  console.log(`${pass ? "✅" : "❌"} ${label}（实际 ${actual}，期望 ${expected}）`);
};

// 1. 生成密钥文件并建库
const keyFile = await kdbxweb.Credentials.createRandomKeyFile();
const keyFileText = new TextDecoder().decode(keyFile);
console.log(`密钥文件：${keyFile.byteLength} bytes，XML 格式=${/KeyFile/.test(keyFileText)}`);

const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(pv("old-password"), keyFile), "密钥文件测试");
db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
const entry = db.createEntry(db.getDefaultGroup());
entry.fields.set("Title", "凭据测试");
entry.fields.set("Password", pv("secret-value"));
const saved = toBuf(await db.save());

// 2. 正确凭据可开
check("密码 + 密钥文件可打开", (await tryLoad(saved, "old-password", keyFile)).ok, true);
// 3. 少了密钥文件打不开
const noKey = await tryLoad(saved, "old-password");
check("只给密码打不开", noKey.ok, false);
console.log(`   ↳ 错误信息：${noKey.error}`);

// 4. 改主密码（复用同一 db 实例的 credentials）
const reopened = (await tryLoad(saved, "old-password", keyFile)).db;
await reopened.credentials.setPassword(pv("new-password"));
const rotated = toBuf(await reopened.save());

check("新密码 + 密钥文件可打开", (await tryLoad(rotated, "new-password", keyFile)).ok, true);
check("旧密码已失效", (await tryLoad(rotated, "old-password", keyFile)).ok, false);

// 5. 移除密钥文件
await reopened.credentials.setKeyFile(null);
const noKeyFile = toBuf(await reopened.save());
check("移除密钥文件后仅凭密码可开", (await tryLoad(noKeyFile, "new-password")).ok, true);
// 6. 移除后再多给一个密钥文件，复合密钥就不对了，应当失败
check(
  "移除后额外塞密钥文件应失败",
  (await tryLoad(noKeyFile, "new-password", keyFile)).ok,
  false
);

// 7. 内容完整性
const finalDb = (await tryLoad(noKeyFile, "new-password")).db;
const titles = Array.from(finalDb.getDefaultGroup().allEntries()).map((e) => e.fields.get("Title"));
check("条目仍在", titles.join(","), "凭据测试");

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
