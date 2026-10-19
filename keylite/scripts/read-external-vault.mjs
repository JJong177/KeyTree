/**
 * 反向互操作：用 KeyLite 的引擎（kdbxweb + argon2-browser）读取外部实现（pykeepass）写的库。
 * pykeepass 默认 Argon2d，正好验证三种 Argon2 变体的兼容性。
 * 跑法：node scripts/read-external-vault.mjs
 */
import { readFileSync } from "node:fs";
import kdbxweb from "../vendor/kdbxweb/dist/kdbxweb.js";
import { argon2d, argon2i, argon2id } from "@noble/hashes/argon2.js";

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

const raw = readFileSync("test-vault-external.kdbx");
const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);

const credentials = new kdbxweb.Credentials(
  kdbxweb.ProtectedValue.fromString("external-pass")
);

try {
  const db = await kdbxweb.Kdbx.load(buf, credentials);
  const entries = Array.from(db.getDefaultGroup().allEntries());
  const e = entries.find((x) => x.fields.get("Title") === "Firefox");
  const pwd = e?.fields.get("Password");
  const ok =
    pwd instanceof kdbxweb.ProtectedValue && pwd.getText() === "Fx!Pass2026";
  console.log("entries:", entries.map((x) => x.fields.get("Title")));
  console.log("kdbx version:", `${db.header.versionMajor}.${db.header.versionMinor}`);
  console.log("password ok:", ok);
  console.log(ok ? "REVERSE INTEROP: PASS" : "REVERSE INTEROP: FAIL");
} catch (e) {
  console.log("REVERSE INTEROP: FAIL -", e instanceof Error ? e.message : e);
}
