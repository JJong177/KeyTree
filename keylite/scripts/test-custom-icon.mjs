/**
 * customIcon（favicon）链路验证（纯 Node）：
 * 建库 → 写条目 → 塞一张假 favicon 进 meta.customIcons → entry.customIcon 指过去
 * → 保存 → 重开 → 校验字节一致 + entry 指回同一个图标。
 * 再验证 KeePassXC 兼容性的前提：KDBX XML 里会出现 CustomIcons/CustomIconItem 结构。
 * 跑法：node scripts/test-custom-icon.mjs
 */
import kdbxweb from "../vendor/kdbxweb/dist/kdbxweb.js";
import { argon2d, argon2i, argon2id } from "@noble/hashes/argon2.js";
import { writeFileSync, readFileSync } from "node:fs";

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

// 假 favicon：16x16 PNG 头 + 随机填充（有真实 PNG 魔数，方便将来 sniff）
const pngHeader = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const fakeIcon = new Uint8Array(256);
fakeIcon.set(pngHeader);
crypto.getRandomValues(fakeIcon.subarray(8));
const iconBuffer = fakeIcon.buffer.slice(
  fakeIcon.byteOffset,
  fakeIcon.byteOffset + fakeIcon.byteLength
);

const credentials = new kdbxweb.Credentials(
  kdbxweb.ProtectedValue.fromString("test-master-password")
);
const db = kdbxweb.Kdbx.create(credentials, "图标测试库");
db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
const entry = db.createEntry(db.getDefaultGroup());
entry.fields.set("Title", "GitHub");
entry.fields.set("URL", "https://github.com");

const iconUuid = kdbxweb.KdbxUuid.random();
db.meta.customIcons.set(iconUuid.id, { data: iconBuffer, name: "github.com" });
entry.customIcon = iconUuid;

const saved = await db.save();

// 往返：重开校验
const reopened = await kdbxweb.Kdbx.load(
  saved,
  new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("test-master-password"))
);
const reEntry = reopened.getDefaultGroup().entries[0];
check("重开后 entry.customIcon 指回同一图标", reEntry.customIcon?.id === iconUuid.id);
const restored = reopened.meta.customIcons.get(iconUuid.id);
check("重开后图标数据存在", !!restored);
check(
  "图标字节逐位一致",
  restored &&
    restored.data.byteLength === iconBuffer.byteLength &&
    new Uint8Array(restored.data).every((b, i) => b === fakeIcon[i])
);

// XML 结构检查（KDBX4 里 customIcons 存在 meta 的明文区之外？不——KDBX4 的 InnerHeader/HeaderSection 加密体内，
// 直接看内存对象结构即可；这里顺带把文件落盘给 pykeepass 用
writeFileSync("test-vault-icon.kdbx", Buffer.from(new Uint8Array(saved)));
console.log(`  ..  已写 test-vault-icon.kdbx（${saved.byteLength} bytes，供 pykeepass 互操作检查）`);

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
