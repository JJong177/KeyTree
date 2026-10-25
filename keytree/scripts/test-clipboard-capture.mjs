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
  await test("unlabeled content, duplicate fields, malformed CSV and unsafe URLs are not guessed", () => {
    for (const text of ["SYNTHETIC_SINGLE", "demo\tSYNTHETIC", "随便一段普通文字", "账号:a\n账号:b\n密码:c", 'username,password\na,"unterminated', "username,account,password\na,b,c"]) {
      assert.equal(m.recognizeClipboard(snapshot(text)), null);
    }
    const record = m.recognizeClipboard(snapshot("账号:demo\n密码:SYNTHETIC\n网址:javascript:alert(1)", { sourceUrl: "https://user:secret@example.test" })).records[0];
    assert.equal(record.url, "");
    assert.ok(record.warnings.length);
    assert.equal(m.recognizeClipboard(snapshot("账号:demo", { sourceUrl: "file:///private" })).source.url, "");
    assert.equal(m.recognizeClipboard(snapshot("a".repeat(524289))), null);
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
