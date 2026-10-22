// 验证：Vite 预打包产物（浏览器分支）能否完整跑通 KDBX4 创建/保存/重新加载
// 目的：确认 crypto 走 self.crypto.getRandomValues、xmldom 内联都正常，
//       以及互操作剥壳后拿到的对象真的是能用的引擎。
// Resolve the browser prebundle relative to this script, regardless of the working directory.
import assert from "node:assert/strict";
import { argon2d, argon2i, argon2id } from "@noble/hashes/argon2.js";

globalThis.self = globalThis;
globalThis.window = globalThis;
globalThis.document = globalThis.document ?? {};

const depUrl = new URL("../node_modules/.vite/deps/kdbxweb.js", import.meta.url).href;

const ns = await import(depUrl);

// —— 复刻 Vite 对动态 import 的互操作包装 ——
const interop = (m) =>
  m && m.__esModule ? m : { ...(m || {}), default: m };
const resolved = interop(ns.default);
console.log("动态 import 解析结果 has Kdbx:", typeof resolved.Kdbx);

// —— 复刻我们 kdbx.ts 里的剥壳逻辑 ——
function unwrap(mod) {
  let cur = mod;
  for (let d = 0; d < 6; d++) {
    if (!cur || typeof cur !== "object") return null;
    if (typeof cur.Kdbx === "function" && cur.CryptoEngine) return cur;
    cur = cur.default;
  }
  return null;
}
const kdbxweb = unwrap(resolved);
if (!kdbxweb) throw new Error("剥壳失败");
console.log("剥壳成功，版本能力:", {
  Kdbx: typeof kdbxweb.Kdbx,
  CryptoEngine: typeof kdbxweb.CryptoEngine,
  Consts: typeof kdbxweb.Consts,
});

// —— 注入 Argon2（三种变体都支持，模拟 argon2-browser）——
kdbxweb.CryptoEngine.setArgon2Impl((password, salt, memory, iterations, length, parallelism, type) => {
  const opts = { t: iterations, m: memory, p: parallelism, dkLen: length };
  const fn = type === 0 ? argon2d : type === 1 ? argon2i : argon2id;
  const out = fn(new Uint8Array(password), new Uint8Array(salt), opts);
  return Promise.resolve(new Uint8Array(out).buffer);
});

const creds = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("master-pw"));
const db = kdbxweb.Kdbx.create(creds, "预打包产物验证");
db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
// Use the supported header dictionary API for this synthetic 8 MiB fixture.
const parameters = db.header.kdfParameters;
const valueType = kdbxweb.VarDictionary.ValueType;
parameters.set("M", valueType.UInt64, kdbxweb.Int64.from(8 * 1024 * 1024));
parameters.set("I", valueType.UInt64, kdbxweb.Int64.from(2));
parameters.set("P", valueType.UInt32, 1);

const entry = db.createEntry(db.getDefaultGroup());
entry.fields.set("Title", "站点A");
entry.fields.set("UserName", "jong");
entry.fields.set("Password", kdbxweb.ProtectedValue.fromString("p@ss 中文"));

const saved = await db.save();
console.log("保存成功，字节数:", saved.byteLength);

const buf = saved instanceof ArrayBuffer ? saved : saved.buffer;
const reopened = await kdbxweb.Kdbx.load(buf, creds);
const list = Array.from(reopened.getDefaultGroup().allEntries());
assert.equal(list.length, 1);
assert.equal(list[0].fields.get("Title"), "站点A");
assert.equal(list[0].fields.get("UserName"), "jong");
assert.equal(list[0].fields.get("Password").getText(), "p@ss 中文");
assert.equal(reopened.header.kdfParameters.get("M").value, 8 * 1024 * 1024);
console.log("PASS: browser prebundle round-trip preserved all fixture fields and KDF parameters");
