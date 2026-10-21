import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(project, "package.json"));
const { build } = require("esbuild");
const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "keytree-features-"));
try {
  const output = join(dir, "rules.mjs");
  await build({ stdin: { contents: ["search", "entry-fields", "import-plan", "vault-health", "totp", "csv"].map(n => `export * from './src/lib/${n}';`).join("\n"), resolveDir: project, loader: "ts" }, outfile: output, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  const m = await import(pathToFileURL(output).href);
  const entry = (id, extra = {}) => ({ id, title: "Github", username: "user@example.com", url: "https://github.com", tags: ["开发"], lastUsedAt: null, updatedAt: null, favorite: false, ...extra });
  await test("shared search matches multiple words across public fields", () => {
    assert.equal(m.matchScore(entry("a"), "GIT 开发" ) >= 0, true);
    assert.equal(m.matchScore(entry("a"), "git missing"), -1);
    assert.deepEqual(m.searchEntries([entry("a"), entry("b", { title: "Other" })], "github 开发").map(e => e.id), ["a", "b"]);
  });
  await test("recent access outranks frequency, then favorite and score with stable ties", () => {
    const list = [entry("a", { usageCount: 1000, lastUsedAt: 1 }), entry("b", { usageCount: 1, lastUsedAt: 2 }), entry("c", { lastUsedAt: 1, favorite: true })];
    assert.deepEqual(m.searchEntries(list, "").map(e => e.id), ["b", "c", "a"]);
    assert.equal(list[0].id, "a");
    assert.deepEqual(m.searchEntries([entry("b"), entry("a")], "").map(e => e.id), ["a", "b"]);
  });
  await test("highlight preserves original text and treats markup as text", () => {
    const text = "<img onerror=alert(1)> GitHub 开发";
    const parts = m.highlightParts(text, "git 开发");
    assert.equal(parts.map(p => p.text).join(""), text);
    assert.deepEqual(parts.filter(p => p.hit).map(p => p.text), ["Git", "开发"]);
    assert.deepEqual(m.highlightParts("abc", ""), [{ text: "abc", hit: false }]);
  });
  await test("custom field rename/protection preserves unrelated and reserved fields", () => {
    const map = new Map([["Title", "t"], ["Old", "secret"], ["Unknown", "keep"]]);
    m.applyCustomFields(map, [{ originalName: "Old", name: "New", value: "value", protected: true }], [], text => ({ protected: text }));
    assert.equal(map.get("Unknown"), "keep"); assert.equal(map.has("Old"), false);
    assert.deepEqual(map.get("New"), { protected: "value" }); assert.equal(map.get("Title"), "t");
    m.applyCustomFields(map, [], ["New"], text => text); assert.equal(map.has("New"), false);
  });
  await test("custom fields reject duplicate/reserved/colliding names without modifying map", () => {
    const f = name => ({ name, value: "x", protected: false });
    assert.throws(() => m.validateCustomFields([f("Password")]));
    assert.throws(() => m.validateCustomFields([f("a"), f(" A ")]));
    const map = new Map([["Existing", "keep"]]);
    assert.throws(() => m.applyCustomFields(map, [f("Existing")], [], text => text));
    assert.equal(map.get("Existing"), "keep");
    assert.throws(() => m.applyCustomFields(map, [], ["otp"], text => text));
  });
  await test("autotype editor validates supported subset and bounded delays", () => {
    m.validateSequence("{USERNAME}{TAB}{DELAY 500}{PASSWORD}{ENTER}");
    for (const text of ["{X}", "{DELAY 5001}", "{PASSWORD", "{DELAY -1}"]) assert.throws(() => m.validateSequence(text));
  });
  await test("raw Base32/URI have matching TOTP results and malformed labels are rejected", async () => {
    const raw = "JBSW Y3DP-EHPK3PXP";
    const uri = m.normalizeTotpInput(raw);
    const a = await m.generateTotp(m.parseTotpInput(raw), 1700000000000), b = await m.generateTotp(m.parseTotpInput(uri), 1700000000000);
    assert.equal(a.code, b.code);
    assert.equal(m.parseTotpInput("otpauth://totp/%ZZ?secret=AAAA"), null);
    assert.equal(m.parseTotpInput("otpauth://totp/x?secret=A"), null);
    assert.equal(m.parseTotpInput("!!!!"), null);
    assert.equal(m.secondsRemaining(30, 30000), 30); assert.equal(m.secondsRemaining(30, 59000), 1);
    assert.equal(m.parseTotpInput("otpauth://steam/x?secret=JBSWY3DPEHPK3PXP").steam, true);
  });
  await test("import preview classifies duplicates/conflicts and preserves secret whitespace", () => {
    const csv = 'name,url,username,password,note\r\na,https://a.test,u," p ","line1\nline2"\r\na,https://a.test,u," p ","line1\nline2"\r\na,https://a.test,u,other,note';
    const rows = m.analyzeImport(csv, []);
    assert.deepEqual(rows.map(r => r.classification), ["new", "duplicate", "conflict"]);
    assert.deepEqual(rows.map(r => r.selected), [true, false, false]);
    assert.equal(rows[0].record.password, " p "); assert.equal(rows[0].record.notes, "line1\nline2");
  });
  await test("CSV note export is symmetric and quoted", () => {
    const csv = m.buildChromeCsv([{ title: 'a,"b', url: "", username: "u", password: " p ", notes: 'note, "quoted"\nline' }]);
    assert.equal(m.parseCsv(csv)[0].at(-1), "note");
    const rows = m.analyzeImport(csv, []); assert.equal(rows[0].record.notes, 'note, "quoted"\nline'); assert.equal(rows[0].record.password, " p ");
  });
  await test("health summary excludes empty passwords from weak/duplicate and returns no secrets", () => {
    const e = (id, password, extra = {}) => ({ id, password, hasTotp: false, expires: false, expiryTime: null, ...extra });
    const report = m.healthSummary([e("a", "abc"), e("b", "abc", { hasTotp: true, expires: true, expiryTime: new Date(1) }), e("c", "")], 100);
    assert.equal(report.withPassword, 2); assert.deepEqual(report.duplicate, ["a", "b"]); assert.deepEqual(report.expired, ["b"]); assert.equal(report.withTotp, 1);
    assert.equal(JSON.stringify(report).includes('"password"'), false);
  });
  await test("health duplicate groups contain entry ids only and update after individual repairs", () => {
    const e = (id, password) => ({ id, password, hasTotp: false, expires: false, expiryTime: null });
    const report = m.healthSummary([e("a", "SYNTHETIC_FIRST"), e("b", "SYNTHETIC_SECOND"), e("c", "SYNTHETIC_FIRST"), e("d", "SYNTHETIC_SECOND"), e("empty", "")]);
    assert.deepEqual(report.duplicateGroups, [["a", "c"], ["b", "d"]]);
    assert.equal(JSON.stringify(report).includes("SYNTHETIC_"), false);
    const repaired = m.healthSummary([e("a", "NEW_SYNTHETIC"), e("c", "SYNTHETIC_FIRST")]);
    assert.deepEqual(repaired.duplicateGroups, []);
    assert.deepEqual(repaired.duplicate, []);
  });
  await test("KDF details use actual Int64 values and do not fabricate missing values", () => {
    const params = new Map([["M", { valueOf: () => 64 * 1024 * 1024 }], ["I", { valueOf: () => 3 }], ["P", 2]]);
    assert.deepEqual(m.kdfDetails({ kdfParameters: params }).map(p => p.value), ["64.0 MiB", "3", "2"]);
    assert.deepEqual(m.kdfDetails({ kdfParameters: new Map() }), []);
  });
} finally { await rm(dir, { recursive: true, force: true }); }
