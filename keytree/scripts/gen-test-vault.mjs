/**
 * 生成互操作测试库：用 KeyTree 的加密链路（kdbxweb + argon2-browser Argon2id）
 * 写一个真实的 .kdbx 文件到磁盘，供 pykeepass / KeePassXC 打开验证。
 *
 * 跑法：node scripts/gen-test-vault.mjs <输出路径> [主密码]
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import kdbxweb from "../vendor/kdbxweb/dist/kdbxweb.js";
import { argon2d, argon2i, argon2id } from "@noble/hashes/argon2.js";

const outPath = resolve(process.argv[2] ?? "test-vault.kdbx");
const master = process.argv[3] ?? "test-master-password";

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

const credentials = new kdbxweb.Credentials(
  kdbxweb.ProtectedValue.fromString(master)
);

const db = kdbxweb.Kdbx.create(credentials, "KeyTree 互操作测试库");
db.setKdf(kdbxweb.Consts.KdfId.Argon2id);

const work = db.createGroup(db.getDefaultGroup(), "工作");
const social = db.createGroup(db.getDefaultGroup(), "社交");

const gh = db.createEntry(work);
gh.fields.set("Title", "GitHub");
gh.fields.set("UserName", "jong@example.com");
gh.fields.set("Password", kdbxweb.ProtectedValue.fromString("x9!Kp#mZ2vQ8"));
gh.fields.set("URL", "https://github.com/login");
gh.fields.set("Notes", "由 KeyTree 写入，供 KeePassXC 验证");

const google = db.createEntry(social);
google.fields.set("Title", "Google");
google.fields.set("UserName", "jong@gmail.com");
google.fields.set("Password", kdbxweb.ProtectedValue.fromString("G00gle!Pass#2026"));

const saved = await db.save();
writeFileSync(outPath, Buffer.from(saved));
console.log(`written: ${outPath}`);
console.log(`size   : ${saved.byteLength} bytes`);
console.log(`entries: GitHub / Google`);
