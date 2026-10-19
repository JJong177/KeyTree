/**
 * M0 加密链路独立验证（纯 Node，不依赖 Tauri/Rust）：
 * 建库 → 写条目 → 保存 → 重新打开 → 校验内容。
 * 跑法：node scripts/test-roundtrip.mjs
 */
import kdbxweb from "../vendor/kdbxweb/dist/kdbxweb.js";
import { argon2id } from "hash-wasm";

kdbxweb.CryptoEngine.setArgon2Impl(
  (password, salt, memory, iterations, length, parallelism, type) => {
    if (type === 0) {
      return Promise.reject(new Error("Argon2d not supported"));
    }
    return argon2id({
      password: new Uint8Array(password),
      salt: new Uint8Array(salt),
      iterations,
      memorySize: memory,
      parallelism,
      hashLength: length,
      outputType: "binary",
    }).then((hash) => {
      const out = new Uint8Array(hash);
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
    });
  }
);

const credentials = new kdbxweb.Credentials(
  kdbxweb.ProtectedValue.fromString("test-master-password")
);

const db = kdbxweb.Kdbx.create(credentials, "KeyLite 测试库");
db.setKdf(kdbxweb.Consts.KdfId.Argon2id); // kdbxweb 默认 Argon2d，KeyLite 统一用 Argon2id
const group = db.createGroup(db.getDefaultGroup(), "工作");
const entry = db.createEntry(group);
entry.fields.set("Title", "GitHub");
entry.fields.set("UserName", "jong@example.com");
entry.fields.set("Password", kdbxweb.ProtectedValue.fromString("x9!Kp#mZ2vQ8"));
entry.fields.set("URL", "https://github.com/login");

const t0 = performance.now();
const saved = await db.save();
const saveMs = Math.round(performance.now() - t0);

const t1 = performance.now();
const reopened = await kdbxweb.Kdbx.load(saved, credentials);
const loadMs = Math.round(performance.now() - t1);

const entries = Array.from(reopened.getDefaultGroup().allEntries());
const found = entries.find((e) => e.fields.get("Title") === "GitHub");
const pwdField = found?.fields.get("Password");
const pwdOk =
  pwdField instanceof kdbxweb.ProtectedValue &&
  pwdField.getText() === "x9!Kp#mZ2vQ8";

console.log("entry count :", entries.length);
console.log("found       :", found?.fields.get("Title"), "/", found?.fields.get("UserName"));
console.log("password ok :", pwdOk);
console.log("kdbx version:", `${reopened.header.versionMajor}.${reopened.header.versionMinor}`);
console.log("size        :", saved.byteLength, "bytes");
console.log("timing      : save", saveMs, "ms · load", loadMs, "ms");
console.log(pwdOk ? "RESULT: PASS" : "RESULT: FAIL");
