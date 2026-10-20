/**
 * merge/重载链路验证（纯 Node）：
 * 1. 建库存盘 → load 得 db1
 * 2. 模拟外部修改：用 db1.credentials（只含 passwordHash，无明文）load 副本并加条目保存 → 覆盖文件（模拟另一台设备）
 * 3. 本地 db1 加另一个条目（本地未落盘的修改）
 * 4. 用 db1.credentials 重新 load 磁盘新版本（验证复用凭据实例可行）
 * 5. db1.merge(remote) → 校验双方条目都在 → save
 * 跑法：node scripts/test-merge-reload.mjs
 */
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

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} ${detail}`);
  }
}

const credentials = new kdbxweb.Credentials(
  kdbxweb.ProtectedValue.fromString("test-master-password")
);
const db1 = kdbxweb.Kdbx.create(credentials, "合并测试库");
db1.setKdf(kdbxweb.Consts.KdfId.Argon2id);
const localEntry = db1.createEntry(db1.getDefaultGroup());
localEntry.fields.set("Title", "本地条目");
const saved1 = await db1.save();

// 模拟另一台设备：用同一凭据（hash）打开同一初始版本，加一个外部条目并落盘
const remote1 = await kdbxweb.Kdbx.load(saved1, credentials);
check("复用 credentials 实例 load（无需明文密码）", !!remote1);
const extEntry = remote1.createEntry(remote1.getDefaultGroup());
extEntry.fields.set("Title", "外部条目");
extEntry.fields.set("UserName", "from-other-device");
const saved2 = await remote1.save();

// 本地继续改（本地此刻还不知道外部版本）
const anotherLocal = db1.createEntry(db1.getDefaultGroup());
anotherLocal.fields.set("Title", "本地条目2");

// watcher 触发的重载：用同一个 credentials 实例 load 磁盘最新版
const remote2 = await kdbxweb.Kdbx.load(saved2, credentials);
check("重新 load 磁盘新版本（复用凭据）", !!remote2);

// 三方合并：本地（含未落盘修改）← 磁盘新版本
db1.merge(remote2);
const titles = [];
for (const group of db1.groups) {
  for (const e of group.allEntries()) titles.push(e.fields.get("Title"));
}
check("合并后：本地条目在", titles.includes("本地条目"));
check("合并后：本地条目2 在", titles.includes("本地条目2"));
check("合并后：外部条目在", titles.includes("外部条目"));
check("合并后条目总数 = 3", titles.length === 3, JSON.stringify(titles));

// 合并结果可正常保存并重开
const merged = await db1.save();
const reopened = await kdbxweb.Kdbx.load(merged, credentials);
const reopenTitles = [];
for (const group of reopened.groups) {
  for (const e of group.allEntries()) reopenTitles.push(e.fields.get("Title"));
}
check("合并结果保存后重开完整", reopenTitles.length === 3, JSON.stringify(reopenTitles));

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
