// Isolated crypto policy tests: never read a user vault or credentials.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, writeFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import { argon2id } from "@noble/hashes/argon2.js";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(project, "package.json"));
const { build } = require("esbuild");
const k = require(join(project, "vendor/kdbxweb/dist/kdbxweb.js"));
const dir = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "keytree-encryption-"));
try {
  await build({ entryPoints: [join(project, "src/kdbx/security.ts")], outfile: join(dir, "security.mjs"), bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const { applyEncryptionProfile, encryptionInfo, encryptionTarget, benchmarkEncryption } = await import(pathToFileURL(join(dir, "security.mjs")).href);
  const fresh = () => k.Kdbx.create(new k.Credentials(k.ProtectedValue.fromString("synthetic-only")), "Synthetic");
  await test("recommended profile is KDBX4 Argon2id, 64 MiB, 3 iterations, p=1", () => {
    const db = fresh(); applyEncryptionProfile(k, db, "recommended");
    assert.deepEqual(encryptionInfo(k, db.header), { kdf: "Argon2id", cipher: "AES-256", memoryMiB: 64, iterations: 3, parallelism: 1, version: "KDBX 4.0", needsUpgrade: false });
    assert.equal(db.header.kdfParameters.get("V"), 0x13);
    assert.equal(db.header.kdfParameters.get("S").byteLength, 32);
    assert.throws(() => encryptionTarget(k, db.header, "invalid"), /档位/);
  });
  await test("profiles preserve stronger existing costs and cipher, including Argon2d conversion", () => {
    const db = fresh(); db.setKdf(k.Consts.KdfId.Argon2d);
    db.header.dataCipherUuid = new k.KdbxUuid(k.Consts.CipherId.ChaCha20);
    db.header.kdfParameters.set("M", k.VarDictionary.ValueType.UInt64, new k.Int64(512 * 1024 * 1024));
    db.header.kdfParameters.set("I", k.VarDictionary.ValueType.UInt64, new k.Int64(8));
    db.header.kdfParameters.set("P", k.VarDictionary.ValueType.UInt32, 4);
    applyEncryptionProfile(k, db, "recommended");
    assert.equal(encryptionInfo(k, db.header).cipher, "ChaCha20");
    assert.deepEqual(encryptionTarget(k, db.header, "maximum"), { memoryMiB: 512, iterations: 8, parallelism: 4 });
  });
  await test("existing UInt64 costs survive dictionary serialization without 32-bit truncation", () => {
    const db = fresh(); db.setKdf(k.Consts.KdfId.Argon2id);
    db.header.kdfParameters.set("M", k.VarDictionary.ValueType.UInt64, k.Int64.from(8 * 1024 * 1024 * 1024));
    db.header.kdfParameters.set("I", k.VarDictionary.ValueType.UInt64, k.Int64.from(0x100000001));
    applyEncryptionProfile(k, db, "recommended");
    const stream = new k.BinaryStream(); db.header.kdfParameters.write(stream);
    const parsed = k.VarDictionary.read(new k.BinaryStream(stream.getWrittenBytes()));
    assert.equal(parsed.get("M").value, 8589934592);
    assert.equal(parsed.get("I").value, 4294967297);
  });
  await test("legacy AES KDF upgrades to KDBX4; missing memory is unknown, not a valid zero", () => {
    const db = fresh(); db.setVersion(3);
    assert.equal(encryptionInfo(k, db.header).needsUpgrade, true);
    applyEncryptionProfile(k, db, "strong");
    assert.equal(db.versionMajor, 4);
    assert.equal(encryptionInfo(k, db.header).memoryMiB, 128);
    const weak = fresh(); weak.setKdf(k.Consts.KdfId.Argon2id);
    assert.equal(encryptionInfo(k, weak.header).needsUpgrade, true);
    weak.header.kdfParameters.remove("M");
    assert.equal(encryptionInfo(k, weak.header).memoryMiB, null);
  });
  // Execute the installed browser bundle in a browser-shaped VM: identical inline WASM path.
  const context = { console, setTimeout, clearTimeout, WebAssembly, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa, performance };
  context.self = context; context.window = context;
  runInNewContext(await readFile(require.resolve("argon2-browser/dist/argon2-bundled.min.js"), "utf8"), context);
  const wasm = context.argon2;
  k.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type) => {
    const out = await wasm.hash({ pass: new Uint8Array(password), salt: new Uint8Array(salt), mem: memory, time: iterations, hashLen: length, parallelism, type, version: 0x13 });
    return Uint8Array.from(out.hash).buffer;
  });
  for (const [profile, memoryMiB] of [["recommended", 64], ["strong", 128], ["maximum", 256]]) {
    await test(`browser WASM ${memoryMiB} MiB authenticates KDBX, preserves key file and rejects tampering`, async () => {
      const keyFile = new Uint8Array(32).fill(19);
      const credentials = () => new k.Credentials(k.ProtectedValue.fromString("synthetic-only"), keyFile.slice());
      const db = k.Kdbx.create(credentials(), "Synthetic");
      const entry = db.createEntry(db.getDefaultGroup());
      entry.fields.set("Title", "Synthetic entry");
      entry.fields.set("Password", k.ProtectedValue.fromString("synthetic-entry-only"));
      applyEncryptionProfile(k, db, profile);
      const started = performance.now(), saved = await db.save();
      const reopened = await k.Kdbx.load(saved, credentials());
      assert.equal(encryptionInfo(k, reopened.header).memoryMiB, memoryMiB);
      assert.equal([...reopened.getDefaultGroup().allEntries()][0].fields.get("Password").getText(), "synthetic-entry-only");
      assert.deepEqual(keyFile, new Uint8Array(32).fill(19));
      await assert.rejects(k.Kdbx.load(saved, new k.Credentials(k.ProtectedValue.fromString("wrong-synthetic"), keyFile.slice())));
      await assert.rejects(k.Kdbx.load(saved, new k.Credentials(k.ProtectedValue.fromString("synthetic-only"))));
      const damaged = new Uint8Array(saved.slice(0)); damaged[damaged.length - 50] ^= 1;
      await assert.rejects(k.Kdbx.load(damaged.buffer, credentials()));
      const path = join(dir, `${profile}.kdbx`), keyPath = join(dir, "synthetic.key");
      await writeFile(path, new Uint8Array(saved)); await writeFile(keyPath, keyFile);
      if (process.env.KEYTREE_KEEPASSXC_CLI) {
        const output = execFileSync(process.env.KEYTREE_KEEPASSXC_CLI, ["show", "-q", "-k", keyPath, path, "Synthetic entry", "-a", "Title"], { input: "synthetic-only\n", encoding: "utf8", timeout: 60000, windowsHide: true });
        assert.match(output, /Synthetic entry/);
      }
      console.log(`${memoryMiB} MiB round-trip + negative cases: ${Math.round(performance.now() - started)} ms`);
    });
  }
  await test("browser WASM output matches independent Argon2id at recommended cost", async () => {
    const pass = new Uint8Array(32).fill(13), salt = new Uint8Array(32).fill(23);
    const result = await wasm.hash({ pass, salt, mem: 65536, time: 3, hashLen: 32, parallelism: 1, type: 2, version: 0x13 });
    const reference = argon2id(pass, salt, { m: 65536, t: 3, p: 1, dkLen: 32 });
    assert.deepEqual(Uint8Array.from(result.hash), reference);
    assert.ok(await benchmarkEncryption(k, { memoryMiB: 64, iterations: 3, parallelism: 1 }) > 0);
  });
} finally { await rm(dir, { recursive: true, force: true }); }
