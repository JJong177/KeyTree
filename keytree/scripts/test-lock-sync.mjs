// Saved-ciphertext lock upload regressions; no network or real vaults.
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
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "keytree-lock-sync-"));
try {
  const output = join(directory, "lock.mjs");
  await build({
    entryPoints: [join(project, "src/lib/lock-sync.ts")], outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    plugins: [{ name: "native-fixture", setup(b) {
      b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "native", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "export const invoke=(...args)=>globalThis.__lockSyncInvoke(...args);", loader: "js" }));
    } }],
  });
  const { syncLockedVault, ciphertextFingerprint } = await import(pathToFileURL(output).href);
  const bytes = text => [...new TextEncoder().encode(text)];
  async function fixture() {
    const state = { local: bytes("saved ciphertext"), remote: bytes("known previous ciphertext"), configured: true, active: true, calls: [], fail: "", stat: {mtimeMs: 1, size: 16, mtimeNs: "100"} };
    const savedHash = await ciphertextFingerprint(Uint8Array.from(state.local).buffer);
    const baseHash = await ciphertextFingerprint(Uint8Array.from(state.remote).buffer);
    globalThis.__lockSyncInvoke = async (name, args) => {
      state.calls.push({name, args});
      if (state.fail === name) throw "WD_NETWORK";
      if (name === "webdav_get_config") return {configured: state.configured};
      if (name === "stat_vault") return state.stat;
      if (name === "read_vault") return state.local;
      if (name === "webdav_prepare_sync") { assert.equal(args.allowCreate, false); return {token: "synthetic", bytes: state.remote}; }
      if (name === "webdav_commit_sync" || name === "webdav_cancel_sync") return;
      throw new Error("Unexpected call: " + name);
    };
    return {state, run: () => syncLockedVault("SYNTHETIC.kdbx", {mtimeMs: 1, size: 16, mtimeNs: "100"}, savedHash, baseHash, () => state.active)};
  }
  await test("lock upload uses conditional commit only when the remote matches the known baseline", async () => {
    const {state, run} = await fixture();
    assert.equal(await run(), "synced");
    assert.equal(state.calls.filter(call => call.name === "webdav_commit_sync").length, 1);
    assert.deepEqual(Object.keys(state.calls.find(call => call.name === "webdav_commit_sync").args).sort(), ["expectedStat", "token", "vaultPath"]);
  });
  await test("identical ciphertext needs no upload and releases its ticket", async () => {
    const {state, run} = await fixture(); state.remote = [...state.local];
    assert.equal(await run(), "synced");
    assert.ok(!state.calls.some(call => call.name === "webdav_commit_sync"));
    assert.ok(state.calls.some(call => call.name === "webdav_cancel_sync"));
  });
  await test("changed remote ciphertext is never overwritten", async () => {
    const {state, run} = await fixture(); state.remote = bytes("other device ciphertext");
    await assert.rejects(run, value => value === "WD_REMOTE_CHANGED");
    assert.ok(!state.calls.some(call => call.name === "webdav_commit_sync"));
  });
  await test("local changes after lock are rejected even if timestamps match", async () => {
    const {state, run} = await fixture(); state.local = bytes("modified ciphertext");
    await assert.rejects(run, value => value === "WD_LOCAL_CHANGED");
    assert.ok(!state.calls.some(call => call.name === "webdav_prepare_sync"));
  });
  await test("unconfigured lock sync does not read vault bytes or connect", async () => {
    const {state, run} = await fixture(); state.configured = false;
    assert.equal(await run(), "unconfigured");
    assert.equal(state.calls.length, 1);
  });
  await test("missing remote never creates a file", async () => {
    const {state, run} = await fixture(); state.remote = null;
    await assert.rejects(run, value => value === "WD_REMOTE_MISSING");
    assert.ok(!state.calls.some(call => call.name === "webdav_commit_sync"));
  });
  await test("inactive tasks cannot start and network errors do not cause commit retries", async () => {
    const {state, run} = await fixture(); state.active = false;
    await assert.rejects(run, value => value === "WD_CANCELLED"); assert.equal(state.calls.length, 0);
    state.active = true; state.fail = "webdav_commit_sync";
    await assert.rejects(run, value => value === "WD_NETWORK");
    assert.equal(state.calls.filter(call => call.name === "webdav_commit_sync").length, 1);
  });
} finally {
  delete globalThis.__lockSyncInvoke;
  await rm(directory, {recursive: true, force: true});
}
