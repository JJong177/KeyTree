// 生成 UI/回收站测试用的固定结构库（不是产品代码，仅开发期用）
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
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

const OUT = process.argv[2] ?? "D:/workbuddy/Easy/keylite/trash-test.kdbx";
const PASSWORD = "test-master-password";

const creds = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD));
const db = kdbxweb.Kdbx.create(creds, "测试库");
db.setKdf(kdbxweb.Consts.KdfId.Argon2id);

const root = db.getDefaultGroup();
const work = db.createGroup(root, "工作");
const social = db.createGroup(root, "社交");
db.createGroup(work, "子分组");

function add(group, title, username, url, notes, tags) {
  const e = db.createEntry(group);
  e.fields.set("Title", title);
  e.fields.set("UserName", username);
  e.fields.set("Password", kdbxweb.ProtectedValue.fromString(`pw-${title}`));
  e.fields.set("URL", url);
  e.fields.set("Notes", notes);
  e.tags = tags;
  return e;
}

add(work, "GitHub", "jong@example.com", "https://github.com/login", "工作账号", ["工作", "开发"]);
add(social, "Google", "jong@gmail.com", "https://accounts.google.com", "个人账号", ["社交"]);
add(social, "微博", "jong", "https://weibo.com", "", ["社交"]);

const saved = await db.save();
writeFileSync(OUT, new Uint8Array(saved));
console.log("fixture 已生成:", OUT, new Uint8Array(saved).byteLength, "bytes");
