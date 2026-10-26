// Synthetic fixtures only: never read the system clipboard or real credentials.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(project, "package.json"));
const { build } = require("esbuild");
const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "keytree-clipboard-test-"));
try {
  const output = join(dir, "capture.mjs");
  await build({ entryPoints: [join(project, "src/lib/clipboard-capture.ts")], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const m = await import(pathToFileURL(output).href);
  const snapshot = (text, extra = {}) => ({ sequence: 7, text, html: null, sourceUrl: null, sourceApp: null, ...extra });
  await test("explicit labels preserve password characters and do not invent a login URL from source", () => {
    const result = m.recognizeClipboard(snapshot("名称：示例\n账号：demo\n密码： SYNTHETIC:a,b \n备注：本机测试", { sourceUrl: "https://sheet.example.test/doc?token=hidden#fragment", sourceApp: "chrome.exe" }));
    assert.equal(result.records[0].password, " SYNTHETIC:a,b ");
    assert.equal(result.records[0].username, "demo");
    assert.equal(result.records[0].url, "");
    assert.equal(result.source.url, "https://sheet.example.test");
    assert.ok(result.records[0].evidence.length);
  });
  await test("field semantics recognize mixed layout without requiring a particular source", () => {
    const result = m.recognizeClipboard(snapshot("操作提示：请核对后保存\n密码\n SYNTHETIC:a,b \n网站\nhttps://login.example.test\n无关说明\n登录名 = demo\n备注\n"));
    assert.equal(result?.records[0].username, "demo");
    assert.equal(result?.records[0].password, " SYNTHETIC:a,b ");
    assert.equal(result?.records[0].url, "https://login.example.test");
    assert.equal(m.recognizeClipboard(snapshot("用户名：first\n用户名：second\n密码：SYNTHETIC"))?.records[0].candidates.username.length, 2);
  });
  await test("CSV and Excel columns preserve quotes, CRLF, punctuation and spaces", () => {
    const csv = 'name,url,username,password\r\nDemo,https://login.example.test,0001," SYNTHETIC,a:""b""\r\nc "';
    const record = m.recognizeClipboard(snapshot(csv)).records[0];
    assert.equal(record.username, "0001");
    assert.equal(record.password, ' SYNTHETIC,a:"b"\r\nc ');
    assert.equal(record.url, "https://login.example.test");
    const table = m.recognizeClipboard(snapshot("标题\t账号\t密码\n甲\tdemo1\tSYNTHETIC_1\n乙\tdemo2\t SYNTHETIC_2 "));
    assert.equal(table.records.length, 2);
    assert.equal(table.records[1].password, " SYNTHETIC_2 ");
  });
  await test("vertical label/value tabs are not mistaken for a horizontal header row", () => {
    const record = m.recognizeClipboard(snapshot("账号\tdemo\n密码\tSYNTHETIC")).records[0];
    assert.equal(record.username, "demo");
    assert.equal(record.password, "SYNTHETIC");
    const multiline = m.recognizeClipboard(snapshot('账号\tdemo\n密码\t" SYNTHETIC\r\nnext "')).records[0];
    assert.equal(multiline.password, " SYNTHETIC\r\nnext ");
  });
  await test("unlabeled content, malformed CSV and unsafe URLs are not guessed", () => {
    for (const text of ["SYNTHETIC_SINGLE", "demo\tSYNTHETIC", "随便一段普通文字", 'username,password\na,"unterminated']) {
      assert.equal(m.recognizeClipboard(snapshot(text)), null);
    }
    const record = m.recognizeClipboard(snapshot("账号:demo\n密码:SYNTHETIC\n网址:javascript:alert(1)", { sourceUrl: "https://user:secret@example.test" })).records[0];
    assert.equal(record.url, "");
    assert.ok(record.warnings.length);
    assert.equal(m.recognizeClipboard(snapshot("账号:demo", { sourceUrl: "file:///private" })).source.url, "");
    assert.equal(m.recognizeClipboard(snapshot("a".repeat(524289))), null);
  });
  await test("duplicate fields remain unresolved until the user chooses or explicitly leaves them empty", () => {
    const record = m.recognizeClipboard(snapshot("账号:first\n账号:second\n密码:SYNTHETIC")).records[0];
    assert.equal(record.username, "");
    assert.deepEqual(record.candidates.username.map(c => c.value), ["first", "second"]);
    assert.equal(m.resolveClipboardRecord(record), null);
    assert.equal(m.resolveClipboardRecord(record, { username: 1 }).username, "second");
    assert.equal(m.resolveClipboardRecord(record, { username: -1 }).username, "");
    for (const choice of [2, -2, 0.5, "0", NaN]) assert.equal(m.resolveClipboardRecord(record, { username: choice }), null);
    const columns = m.recognizeClipboard(snapshot("username,account,password\nfirst,second,SYNTHETIC")).records[0];
    assert.equal(columns.username, "");
    assert.equal(columns.candidates.username.length, 2);
  });
  await test("instructions are not passwords, label-only content is incomplete, and aliases are semantic", () => {
    assert.equal(m.recognizeClipboard(snapshot("密码至少 8 位，必须包含大小写字母")), null);
    const record = m.recognizeClipboard(snapshot("登录账户\n000123\n密码\n复制密码\nSYNTHETIC\n网站\nexample.test\n备注")).records[0];
    assert.equal(record.username, "000123");
    assert.equal(record.password, "SYNTHETIC");
    assert.equal(record.url, "");
    assert.equal(record.candidates.url[0].value, "https://example.test");
    assert.equal(m.resolveClipboardRecord(record), null);
    assert.equal(m.resolveClipboardRecord(record, { url: 0 }).url, "https://example.test");
    const hints = m.recognizeClipboard(snapshot("用户名\n密码\n备注"));
    assert.equal(hints.records[0].username, "");
    assert.equal(hints.records[0].password, "");
    assert.equal(m.recognizeClipboard(snapshot("密码：••••••••")).records[0].password, "");
  });
  await test("inline labels, arbitrary order, notes and password punctuation keep evidence and boundaries", () => {
    const record = m.recognizeClipboard(snapshot("【用户名】=demo\n无关的其他信息\n口令\n SYNTHETIC:a,b=\t \n备注：说明保留\n网站：https://login.example.test")).records[0];
    assert.equal(record.username, "demo");
    assert.equal(record.password, " SYNTHETIC:a,b=\t ");
    assert.equal(record.notes, "说明保留");
    const inline = m.recognizeClipboard(snapshot("用户名:first; 密码:SYNTHETIC; 网站:https://login.example.test")).records[0];
    assert.equal(inline.username, "first");
    assert.ok(inline.candidates.password.length > 1, "ambiguous password delimiter must not silently truncate");
    assert.equal(m.resolveClipboardRecord(inline), null);
  });
  await test("multi-line password values keep the complete block as an explicit choice", () => {
    const record = m.recognizeClipboard(snapshot("账号\r\ndemo\r\n密码\r\n first \r\nsecond\r\n备注")).records[0];
    assert.equal(record.password, "");
    assert.ok(record.candidates.password.some(candidate => candidate.value === " first \r\nsecond"));
    assert.equal(m.resolveClipboardRecord(record), null);
  });
  await test("password blocks containing label-like lines are not silently shortened", () => {
    const record = m.recognizeClipboard(snapshot("账号:demo\n密码\nfirst\n备注:foo\nlast")).records[0];
    assert.equal(record.password, "");
    assert.ok(record.candidates.password.some(candidate => candidate.value === "first\n备注:foo\nlast"));
    assert.equal(m.resolveClipboardRecord(record), null);
  });
  await test("explicit website labels support domain, IPv4, IPv6 and localhost without assuming a protocol", () => {
    for (const website of ["example.test", "192.0.2.12:8080", "[2001:db8::1]:8443", "localhost:1420"]) {
      const record = m.recognizeClipboard(snapshot(`用户名\ndemo\n网站\n${website}\n密码\nSYNTHETIC`)).records[0];
      assert.equal(record.candidates.url[0].value, `https://${website}`);
      assert.equal(record.url, "");
      assert.equal(record.candidates.url[0].requiresConfirmation, true);
    }
  });
  await test("recognition caps large tables and reports truncation", () => {
    const result = m.recognizeClipboard(snapshot("username,password\n" + Array.from({ length: 60 }, (_, i) => `demo${i},SYNTHETIC`).join("\n")));
    assert.equal(result.records.length, 50);
    assert.equal(result.truncated, true);
  });
  await test("focus capture never reads when disabled/locked/editing and deduplicates current sequence", async () => {
    let allowed = false, reads = 0;
    const results = [], previous = [];
    const capture = m.createClipboardCapture({ allowed: () => allowed, read: async last => { reads++; previous.push(last); return snapshot("账号:demo\n密码:SYNTHETIC"); }, result: value => results.push(value) });
    await capture.focus(); assert.equal(reads, 0);
    allowed = true;
    await capture.focus(); await capture.focus();
    assert.equal(results.length, 1);
    assert.deepEqual(previous, [null, 7]);
    allowed = false; capture.invalidate();
    await capture.focus(); assert.equal(reads, 2);
  });
  await test("stale reads cannot display after blur, lock, disable, or a new focus session", async () => {
    let finish, allowed = true;
    const results = [];
    const capture = m.createClipboardCapture({ allowed: () => allowed, read: () => new Promise(resolve => { finish = resolve; }), result: value => results.push(value) });
    const first = capture.focus();
    capture.invalidate(); allowed = false;
    finish(snapshot("账号:old\n密码:SYNTHETIC")); await first;
    assert.equal(results.length, 0);
    allowed = true;
    const second = capture.focus();
    finish(snapshot("账号:new\n密码:SYNTHETIC", { sequence: 8 })); await second;
    assert.equal(results[0].records[0].username, "new");
  });
} finally { await rm(dir, { recursive: true, force: true }); }
