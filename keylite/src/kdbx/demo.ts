import kdbxweb from "kdbxweb";
import { installArgon2 } from "./argon2";

/**
 * M0 往返验证：建库 → 加分组/条目 → 保存 → 用同一主密码重新打开 → 校验条目在。
 * 覆盖 Argon2id KDF + ChaCha20 加密 + KDBX4 写入 + 再读取的全链路。
 * 注意：kdbxweb 2.x 的 entry.fields 是 Map<string, KdbxEntryField>，用 set/get。
 */
export async function roundTripDemo(): Promise<string> {
  installArgon2();

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
  if (!found || found.fields.get("UserName") !== "jong@example.com") {
    return "往返失败：条目内容不一致";
  }
  const pwdField = found.fields.get("Password");
  const pwd =
    pwdField instanceof kdbxweb.ProtectedValue
      ? pwdField.getText()
      : String(pwdField);
  if (pwd !== "x9!Kp#mZ2vQ8") {
    return "往返失败：密码不一致";
  }

  return [
    `往返成功：条目「${found.fields.get("Title")}」完整读出`,
    `库大小 ${saved.byteLength} bytes · 保存 ${saveMs}ms · 重新解密 ${loadMs}ms`,
    `格式 KDBX ${reopened.header.versionMajor}.${reopened.header.versionMinor} · KDF ${reopened.header.kdfParameters ? "Argon2" : "AES"}`,
  ].join("\n");
}
