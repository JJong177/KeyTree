// Regression: run `node scripts/test-vault-save.mjs` from any directory.
// Compile current production code into an isolated temp directory; never access a real vault.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(project, "package.json"));
const { build } = require("esbuild");
const { parse, compileScript } = require("@vue/compiler-sfc");
const kdbxweb = require(join(project, "vendor/kdbxweb/dist/kdbxweb.js"));
const browser = { console, setTimeout, clearTimeout, WebAssembly, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, atob, btoa, performance };
browser.self = browser; browser.window = browser;
runInNewContext(await readFile(require.resolve("argon2-browser/dist/argon2-bundled.min.js"), "utf8"), browser);
kdbxweb.CryptoEngine.setArgon2Impl(async (pass, salt, mem, time, hashLen, parallelism, type) => {
  const result = await browser.argon2.hash({ pass: new Uint8Array(pass), salt: new Uint8Array(salt), mem, time, hashLen, parallelism, type, version: 0x13 });
  return Uint8Array.from(result.hash).buffer;
});
const output = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "keytree-save-test-"));
const outFile = join(output, "fixture.mjs");
const modules = {
  core: "export const invoke = (...args) => globalThis.__keytreeSaveTest.invoke(...args);",
  http: "export const fetch = async () => { throw new Error('Network disabled in save regression'); };",
  events: "export const listen = async (name, handler) => { globalThis.__keytreeSaveTest.listeners.set(name, handler); return () => globalThis.__keytreeSaveTest.listeners.delete(name); }; export const emitTo = async (target, name, payload) => { globalThis.__keytreeSaveTest.messages.push({ target, name, payload }); }; export const emit = async (name, payload) => { globalThis.__keytreeSaveTest.messages.push({ name, payload }); };",
  dialog: "export const save = async args => { const state = globalThis.__keytreeSaveTest; state.dialogSaves.push(args); return state.dialogSaveTarget; }; export const open = async () => null;",
  engine: "export const getKdbxweb = async () => globalThis.__keytreeSaveTest.engine;",
  argon2: "export const installArgon2 = async () => {};",
};
try {
  await build({
    stdin: {
      contents: `export { useVault } from './src/composables/useVault';
export { settings } from './src/lib/settings';
export { default as EntryDrawer } from './src/components/EntryDrawer.vue';
export { default as MainView } from './src/components/MainView.vue';
export { copyText } from './src/lib/clipboard';
export * from './src/lib/history';
export { useDialogFocus } from './src/composables/useDialogFocus';
export { useAutoLock } from './src/composables/useAutoLock';
export { useSystemGuard } from './src/composables/useSystemGuard';
export { toastText } from './src/lib/toast';
export * from './src/lib/audit';
export { usePanelHost } from './src/composables/usePanelHost';
export { default as PanelApp } from './src/panel/PanelApp.vue';
export { default as QuickPanel } from './src/components/QuickPanel.vue';
export { default as EntryDetail } from './src/components/EntryDetail.vue';
export { default as WebdavSettings } from './src/components/WebdavSettings.vue';
export { default as BackupSnapshots } from './src/components/BackupSnapshots.vue';
export { default as SyncQuickBar } from './src/components/SyncQuickBar.vue';
export { default as VaultReport } from './src/components/VaultReport.vue';
export { default as MatchContext } from './src/components/MatchContext.vue';
export { default as PublicPasswordHint } from './src/components/PublicPasswordHint.vue';
export { default as MasterPasswordHintSettings } from './src/components/MasterPasswordHintSettings.vue';
export { default as EncryptionSettings } from './src/components/EncryptionSettings.vue';
export * from './src/lib/quick-unlock';
export { createRenderer, defineComponent, nextTick, h, reactive, ref } from 'vue';`,
      resolveDir: project, loader: "ts",
    },
    outfile: outFile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    plugins: [{
      name: "save-test-adapters",
      setup(b) {
        b.onResolve({ filter: /^vue$/ }, () => ({ path: require.resolve("@vue/runtime-core") }));
        b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "core", namespace: "save-test" }));
        b.onResolve({ filter: /^@tauri-apps\/plugin-dialog$/ }, () => ({ path: "dialog", namespace: "save-test" }));
        b.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, () => ({ path: "http", namespace: "save-test" }));
        b.onResolve({ filter: /^@tauri-apps\/api\/event$/ }, () => ({ path: "events", namespace: "save-test" }));
        b.onResolve({ filter: /kdbx\/(kdbxweb|argon2)$/ }, ({ path }) => ({ path: path.endsWith("argon2") ? "argon2" : "engine", namespace: "save-test" }));
        b.onLoad({ filter: /.*/, namespace: "save-test" }, ({ path }) => ({ contents: modules[path], loader: "js" }));
        b.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
          const { descriptor } = parse(await readFile(path, "utf8"), { filename: path });
          const script = compileScript(descriptor, { id: path, genDefaultAs: "component" });
          // Mount real setup/handlers, without requiring a DOM or executing template assets.
          return { contents: `${script.content}\ncomponent.render = () => null;\nexport default component;`, loader: "ts", resolveDir: dirname(path) };
        });
      },
    }],
  });

  let fixtureId = 0;
  async function fixture() {
    const timers = new Map();
    let timerId = 0;
    globalThis.window = {
      setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
      clearTimeout(id) { timers.delete(id); },
      addEventListener() {}, removeEventListener() {},
    };
    const domListeners = new Map();
    globalThis.document = {
      activeElement: null,
      addEventListener(name, fn) { const list = domListeners.get(name) ?? []; list.push(fn); domListeners.set(name, list); },
      removeEventListener(name, fn) { domListeners.set(name, (domListeners.get(name) ?? []).filter(f => f !== fn)); },
    };
    globalThis.localStorage = { getItem: () => null, setItem() {} };
    const state = {
      failWrite: false, writes: [], watches: [], snapshots: [], db: null,
      stat: { mtimeMs: 1, size: 64, mtimeNs: "1" }, loadGate: null, vaultBytes: null, headerBytes: [], headerGate: null, headerError: null, headerCalls: [],
      listeners: new Map(), messages: [], saveGate: null, writeGate: null, csv: "",
      audit: { enabled: false, epoch: 1, events: [] }, auditGate: null, diagnosticsFailure: false, diagnosticsGate: null, failCopy: false, copies: 0, copyArgs: [], clipboardReads: 0, nativeCalls: [], helloError: null, backupBytes: [], backupFailure: false, loads: 0,
      clipboardCandidate: null, clipboardGate: null,
      syncBytes: null, prepareError: null, commitError: null, prepareGate: null, commitGate: null, commits: [],
      webdavConfig: { configured: false, url: "", username: "", hasPassword: false, lastSyncedAt: null },
      snapshotItems: [], snapshotBytes: [], snapshotReadGate: null, snapshotReadError: null, snapshotCreateError: null, snapshotExportError: null, snapshotCreates: [], snapshotExports: [], dialogSaves: [], dialogSaveTarget: null,
      realSave: false, written: [], failLoadAt: 0, snapshotGate: null, cacheWriteGate: null, cacheClearError: false, cacheEvents: [], helloGate: null, helloBytes: null,
      async invoke(name, args) {
        state.nativeCalls.push(name);
        if (name === "cancel_auto_type" || name === "clear_secret_clipboard") return;
        if (name === "quick_unlock_load") { if (state.helloGate) await state.helloGate; if (state.helloBytes) return state.helloBytes; throw state.helloError ?? "HELLO_NOT_VERIFIED"; }
        if (name === "vault_diagnostics") {
          if (state.diagnosticsGate) await state.diagnosticsGate;
          if (state.diagnosticsFailure) throw new Error("SYNTHETIC_DIAGNOSTICS_FAILURE");
          return { file: { exists: true, mtimeMs: 1, size: 64 }, backup: { exists: false, mtimeMs: 0, size: 0 }, conflicts: [] };
        }
        if (name === "webdav_cancel_sync") return;
        if (name === "webdav_get_config") return { ...state.webdavConfig };
        if (name === "webdav_save_config") { state.webdavConfig = { configured: true, url: args.url, username: args.username, hasPassword: true, lastSyncedAt: null }; return { ...state.webdavConfig }; }
        if (name === "webdav_forget_config") { state.webdavConfig = { configured: false, url: "", username: "", hasPassword: false, lastSyncedAt: null }; return; }
        if (name === "webdav_test_connection") return state.connectionResult ?? { exists: true, etagStatus: "strong" };
        if (name === "webdav_prepare_sync") {
          if (state.prepareGate) await state.prepareGate;
          if (state.prepareError) throw state.prepareError;
          if (state.syncBytes === null && !args.allowCreate) throw "WD_REMOTE_MISSING";
          return { token: "synthetic-ticket", bytes: state.syncBytes };
        }
        if (name === "webdav_commit_sync") {
          state.commits.push({ args, writes: state.writes.length });
          if (state.commitGate) await state.commitGate;
          if (state.commitError) throw state.commitError;
          return { uploadedStat: { ...args.expectedStat }, syncedAt: 1000, metadataSaved: state.metadataSaved !== false };
        }
        if (name === "snapshot_list") return { items: [...state.snapshotItems], maxCount: 30, maxTotalBytes: 268435456 };
        if (name === "snapshot_read") {
          if (state.snapshotReadGate) await state.snapshotReadGate;
          if (state.snapshotReadError) throw state.snapshotReadError;
          const item = state.snapshotItems.find(item => item.id === args.id);
          if (!item || JSON.stringify(item.stat) !== JSON.stringify(args.expectedStat)) throw "SNAP_CHANGED";
          return [...state.snapshotBytes];
        }
        if (name === "snapshot_create") {
          if (state.snapshotCreateError) throw state.snapshotCreateError;
          state.snapshotCreates.push(args);
          if (state.snapshotGate) await state.snapshotGate;
          const item = { id: `snapshot-2000000000-${state.snapshotCreates.length}.kdbx`, createdAt: 2000, size: 128, stat: { mtimeMs: 2, size: 128, mtimeNs: "200" } };
          state.snapshotItems.unshift(item); return item;
        }
        if (name === "snapshot_export") {
          if (state.snapshotExportError) throw state.snapshotExportError;
          if (state.snapshotCreateError) throw state.snapshotCreateError;
          if (!args.currentStat || JSON.stringify(args.currentStat) !== JSON.stringify(state.stat)) throw "SNAP_CHANGED";
          state.snapshotCreates.push({ vaultPath: args.vaultPath, expectedStat: args.currentStat });
          state.snapshotExports.push(args); return;
        }
        if (name === "stat_vault") return { ...state.stat };
        if (name === "read_public_header") {
          state.headerCalls.push(args.path);
          const bytes = [...state.headerBytes];
          if (state.headerGate) await state.headerGate;
          if (state.headerError) throw state.headerError;
          return bytes;
        }
        if (name === "audit_status") { if (state.auditGate) await state.auditGate; return { enabled: state.audit.enabled, epoch: state.audit.epoch }; }
        if (name === "audit_set_enabled") { state.audit.enabled = args.enabled; state.audit.epoch++; return { enabled: state.audit.enabled, epoch: state.audit.epoch }; }
        if (name === "audit_clear") { state.audit.events = []; state.audit.epoch++; return { enabled: state.audit.enabled, epoch: state.audit.epoch }; }
        if (name === "audit_append") { if (state.audit.enabled && state.audit.epoch === args.epoch) { state.audit.events.push(args); return true; } return false; }
        if (name === "audit_read") return { ...state.audit };
        if (name === "copy_secret") { if (state.failCopy) throw new Error("SYNTHETIC_COPY_DENIED"); state.copies++; state.copyArgs.push(args); return { privacyProtected: true, clearScheduled: args.clearAfterMs > 0 }; }
        if (name === "read_clipboard_candidate") { state.clipboardReads++; if (state.clipboardGate) await state.clipboardGate; return state.clipboardCandidate; }
        if (name === "backup_info") { if (state.backupFailure) throw new Error("SYNTHETIC_BACKUP_IO"); return { exists: !!state.backupBytes.length, mtimeMs: 1, size: state.backupBytes.length }; }
        if (name === "read_vault") return args.path.endsWith(".bak") ? state.backupBytes : state.vaultBytes ?? Array.from(new TextEncoder().encode(state.csv));
        if (name === "write_vault") {
          state.writes.push(args.path);
          if (state.writeGate) await state.writeGate;
          if (state.failWrite) throw new Error("SIMULATED_WRITE_FAILURE");
          if (args.expectedStat && (args.expectedStat.mtimeMs !== state.stat.mtimeMs || args.expectedStat.size !== state.stat.size || args.expectedStat.mtimeNs !== state.stat.mtimeNs)) throw new Error("文件版本已发生外部修改，保存已中止");
          state.written.push(args);
          if (state.realSave) state.vaultBytes = [...args.bytes];
          return;
        }
        if (name === "watch_vault") { state.watches.push(args.path); return; }
        if (name === "hide_panel") return;
        if (name === "quick_unlock_save") { state.cacheEvents.push("save-start"); if (state.cacheWriteGate) await state.cacheWriteGate; state.cacheEvents.push("save-end"); return; }
        if (name === "quick_unlock_clear") { state.cacheEvents.push("clear"); if (state.cacheClearError) throw new Error("SYNTHETIC_CACHE_CLEAR_FAILURE"); return; }
        if (name === "set_screenshot_protection") return;
        throw new Error(`Unexpected system call: ${name}`);
      },
      engine: {
        ...kdbxweb,
        Kdbx: class extends kdbxweb.Kdbx {
          static async load(...args) { state.loads++; if (state.loadGate) await state.loadGate; if (state.failLoadAt === state.loads) throw new Error("SYNTHETIC_VERIFY_FAILURE"); return kdbxweb.Kdbx.load(...args); }
          static create(...args) {
            const db = kdbxweb.Kdbx.create(...args);
            state.db = db;
            db.save = async () => {
              state.snapshots.push([...db.getDefaultGroup().allEntries()].map(e => e.fields.get("Title")));
              if (state.saveGate) await state.saveGate;
              if (state.realSave) return kdbxweb.Kdbx.prototype.save.call(db);
              return new ArrayBuffer(64);
            };
            return db;
          }
        },
      },
    };
    globalThis.__keytreeSaveTest = state;
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { clipboard: { writeText: async () => { throw new Error("SYNTHETIC_FALLBACK_DENIED"); }, readText: async () => { state.clipboardReads++; return ""; } } } });
    const mod = await import(`${pathToFileURL(outFile).href}?fixture=${++fixtureId}`);
    assert.equal(state.nativeCalls.includes("quick_unlock_clear"), false, "importing shared modules must not install main-window credential policy");
    mod.installQuickUnlockPolicy();
    mod.settings.quickUnlock = false;
    const vault = mod.useVault();
    assert.equal(await vault.createVault("SYNTHETIC_ONLY.kdbx", "Synthetic", "SYNTHETIC_ONLY"), true);
    state.writes.length = 0;
    state.snapshots.length = 0;
    const draft = { title: "Synthetic entry", username: "", password: "", url: "", notes: "", tags: "", totp: "", groupUuid: vault.groups.value[0].uuid, expires: false, expiryDate: "" };
    const renderer = mod.createRenderer({
      createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
      insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
      parentNode: () => null, nextSibling: () => null,
    });
    const apps = [];
    function mount(component, props) {
      const app = renderer.createApp(component, props);
      const vm = app.mount({});
      apps.push(app);
      return vm.$.setupState;
    }
    function mountControlled(component, values) {
      const props = mod.reactive(values);
      const app = renderer.createApp(mod.defineComponent({ setup() { return () => mod.h(component, props); } }));
      const root = app.mount({}); apps.push(app);
      return { props, state: root.$.subTree.component.setupState, unmount: () => app.unmount() };
    }
    return { ...mod, state, vault, draft, timers, domListeners, mount, mountControlled, cleanup: () => apps.forEach(app => app.unmount()) };
  }
  async function scenario(name, run) {
    await test(name, async () => {
      const f = await fixture();
      try { await run(f); } finally { f.cleanup(); }
    });
  }
  function gate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
  }
  async function until(predicate) {
    for (let n = 0; n < 100; n++) { if (predicate()) return; await Promise.resolve(); }
    assert.fail("Expected async save phase was not reached");
  }

  async function encryptionFixture(f) {
    const db = f.state.db;
    db.setKdf(kdbxweb.Consts.KdfId.Aes);
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set("Title", "Upgrade entry");
    entry.fields.set("Password", kdbxweb.ProtectedValue.fromString("SYNTHETIC_ENTRY"));
    f.state.vaultBytes = Array.from(new Uint8Array(await kdbxweb.Kdbx.prototype.save.call(db)));
    assert.equal(await f.vault.openVault("SYNTHETIC_ONLY.kdbx", "SYNTHETIC_ONLY"), true);
    f.state.writes.length = 0; f.state.written.length = 0;
    f.state.snapshotCreates.length = 0; f.state.nativeCalls.length = 0;
    return [...f.state.vaultBytes];
  }
  async function securityUntil(predicate) {
    for (let n = 0; n < 1000; n++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.fail("Security operation did not reach expected phase");
  }
  await scenario("new vaults use strengthened defaults and cost measurement never writes", async f => {
    assert.equal(f.vault.vaultEncryption.value.memoryMiB, 64);
    assert.equal(f.vault.vaultEncryption.value.iterations, 3);
    const before = f.state.writes.length;
    const ms = await f.vault.testEncryptionSpeed("recommended");
    assert.ok(ms > 0);
    assert.equal(f.state.writes.length, before);
    assert.equal(f.vault.hasUnsavedChanges.value, false);
  });
  await scenario("encryption UI requires confirmation and upgrade backs up then atomically writes authenticated KDBX", async f => {
    await encryptionFixture(f);
    const ui = f.mount(f.EncryptionSettings);
    await ui.apply(); assert.equal(f.state.writes.length, 0);
    ui.confirmed = true; await ui.apply();
    assert.equal(ui.failed, false, f.vault.error.value);
    assert.equal(f.state.snapshotCreates.length, 1);
    assert.equal(f.state.written.length, 1);
    assert.ok(f.state.nativeCalls.indexOf("snapshot_create") < f.state.nativeCalls.indexOf("write_vault"));
    assert.deepEqual(f.state.written[0].expectedStat, f.state.stat);
    assert.equal(f.vault.vaultEncryption.value.kdf, "Argon2id");
    assert.equal(f.vault.vaultEncryption.value.memoryMiB, 64);
    assert.equal(f.vault.draftOf(f.vault.entries.value[0].uuid).password, "SYNTHETIC_ENTRY");
    const saved = new Uint8Array(f.state.written[0].bytes).buffer;
    const reopened = await kdbxweb.Kdbx.load(saved, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("SYNTHETIC_ONLY")));
    assert.equal([...reopened.getDefaultGroup().allEntries()][0].fields.get("Password").getText(), "SYNTHETIC_ENTRY");
    assert.equal(f.vault.hasUnsavedChanges.value, false);
    await f.nextTick(); assert.equal(ui.target.memoryMiB, 64);
  });
  for (const failure of ["verify", "backup", "write", "external"]) {
    await scenario(`encryption ${failure} failure preserves original file, credentials and in-memory parameters`, async f => {
      const original = await encryptionFixture(f);
      if (failure === "verify") f.state.failLoadAt = f.state.loads + 2;
      if (failure === "backup") f.state.snapshotCreateError = "SNAP_IO";
      if (failure === "write") f.state.failWrite = true;
      if (failure === "external") f.state.stat.mtimeNs = "changed";
      assert.equal(await f.vault.upgradeEncryption("recommended"), false);
      assert.deepEqual(f.state.vaultBytes, original);
      assert.equal(f.vault.vaultEncryption.value.kdf, "AES-KDF");
      assert.equal(f.state.written.length, 0);
      assert.equal(f.vault.hasUnsavedChanges.value, false);
      assert.equal(f.vault.busy.value, false);
    });
  }
  await scenario("locking during encryption backup cancels the upgrade before writing", async f => {
    const original = await encryptionFixture(f);
    const blocked = gate(); f.state.snapshotGate = blocked.promise;
    const upgrading = f.vault.upgradeEncryption("recommended");
    await securityUntil(() => f.state.snapshotCreates.length > 0);
    const locking = f.vault.lock({ force: true });
    blocked.release();
    assert.equal(await upgrading, false); assert.equal(await locking, true);
    assert.equal(f.vault.unlocked.value, false);
    assert.equal(f.state.written.length, 0); assert.deepEqual(f.state.vaultBytes, original);
  });
  await scenario("edits arriving during native encryption write remain pending for normal save", async f => {
    await encryptionFixture(f);
    const blocked = gate(); f.state.writeGate = blocked.promise;
    const upgrading = f.vault.upgradeEncryption("recommended");
    await securityUntil(() => f.state.writes.length > 0);
    f.vault.touchUsage(f.vault.entries.value[0].uuid);
    blocked.release(); assert.equal(await upgrading, true);
    assert.equal(f.vault.hasUnsavedChanges.value, true);
    f.state.writeGate = null;
    assert.equal(await f.vault.flushSave(), true);
    assert.equal(f.vault.hasUnsavedChanges.value, false);
    assert.equal(f.vault.vaultEncryption.value.memoryMiB, 64);
  });
  await scenario("disabled quick unlock rejects cached reads, including Hello response after disabling", async f => {
    const loads = f.state.loads;
    f.state.nativeCalls.length = 0;
    assert.equal(await f.vault.helloUnlock("SYNTHETIC_ONLY.kdbx"), false);
    assert.equal(f.state.nativeCalls.includes("quick_unlock_load"), false);
    f.settings.quickUnlock = true;
    const blocked = gate(); f.state.helloGate = blocked.promise;
    f.state.helloBytes = Array.from(new TextEncoder().encode(JSON.stringify({ p: "SYNTHETIC_ONLY", k: null })));
    const pending = f.vault.helloUnlock("SYNTHETIC_ONLY.kdbx");
    f.settings.highSecurityMode = true;
    blocked.release(); assert.equal(await pending, false);
    assert.equal(f.state.loads, loads);
    assert.equal(f.settings.quickUnlock, false); assert.equal(f.settings.autoHelloUnlock, false);
  });
  await scenario("disabling credentials clears after in-flight write and reports deletion failure", async f => {
    await f.clearQuickUnlockCache(); f.state.cacheEvents.length = 0;
    f.settings.quickUnlock = true;
    const blocked = gate(); f.state.cacheWriteGate = blocked.promise;
    const caching = f.cacheQuickUnlock("SYNTHETIC_ONLY.kdbx", "SYNTHETIC_ONLY", null);
    await until(() => f.state.cacheEvents.includes("save-start"));
    f.settings.highSecurityMode = true;
    const clearing = f.clearQuickUnlockCache(); blocked.release();
    await caching; await clearing;
    assert.deepEqual(f.state.cacheEvents.slice(0, 2), ["save-start", "save-end"]);
    assert.equal(f.state.cacheEvents.at(-1), "clear");
    f.state.cacheClearError = true;
    await assert.rejects(f.clearQuickUnlockCache(), /SYNTHETIC_CACHE_CLEAR_FAILURE/);
    f.state.cacheClearError = false;
    await f.clearQuickUnlockCache();
  });
  await scenario("locking cancels an in-flight password unlock without resurrecting decrypted state", async f => {
    await encryptionFixture(f);
    const blocked = gate(); f.state.loadGate = blocked.promise;
    const loads = f.state.loads;
    const opening = f.vault.openVault("SYNTHETIC_ONLY.kdbx", "SYNTHETIC_ONLY");
    await until(() => f.state.loads > loads);
    assert.equal(await f.vault.lock({ force: true }), true);
    blocked.release(); assert.equal(await opening, false);
    assert.equal(f.vault.unlocked.value, false);
    assert.equal(f.vault.busy.value, false);
  });
  await scenario("locking cancels an in-flight creation before writing or caching credentials", async f => {
    const blocked = gate(); f.state.saveGate = blocked.promise;
    const creating = f.vault.createVault("SYNTHETIC_CANCELLED.kdbx", "Synthetic", "SYNTHETIC_ONLY");
    await until(() => f.state.snapshots.length > 0);
    assert.equal(await f.vault.lock({ force: true }), true);
    blocked.release(); assert.equal(await creating, false);
    assert.equal(f.vault.unlocked.value, false);
    assert.equal(f.state.writes.includes("SYNTHETIC_CANCELLED.kdbx"), false);
    assert.equal(f.vault.busy.value, false);
  });
  await scenario("stale Hello credentials are rejected and only that vault cache is cleared", async f => {
    await encryptionFixture(f);
    f.settings.quickUnlock = true;
    f.state.helloBytes = Array.from(new TextEncoder().encode(JSON.stringify({ p: "WRONG_SYNTHETIC_ONLY", k: null })));
    assert.equal(await f.vault.helloUnlock("SYNTHETIC_ONLY.kdbx"), false);
    assert.match(f.vault.error.value, /缓存凭据已失效/);
    assert.equal(f.vault.busy.value, false);
  });
  await scenario("locking invalidates a delayed Hello verification before vault decryption", async f => {
    f.settings.quickUnlock = true;
    const loads = f.state.loads, blocked = gate();
    f.state.helloGate = blocked.promise;
    f.state.helloBytes = Array.from(new TextEncoder().encode(JSON.stringify({ p: "SYNTHETIC_ONLY", k: null })));
    const hello = f.vault.helloUnlock("SYNTHETIC_ONLY.kdbx");
    assert.equal(await f.vault.lock({ force: true }), true);
    blocked.release(); assert.equal(await hello, false);
    assert.equal(f.vault.unlocked.value, false); assert.equal(f.state.loads, loads);
  });
  await scenario("raw key-file bytes remain unchanged when creating and applying credentials", async f => {
    const raw = new Uint8Array(32).fill(27);
    assert.equal(await f.vault.createVault("SYNTHETIC_KEY.kdbx", "Synthetic", "SYNTHETIC_ONLY", raw), true);
    assert.deepEqual(raw, new Uint8Array(32).fill(27));
    const next = new Uint8Array(32).fill(29);
    assert.equal(await f.vault.applyKeyFile(next), true);
    assert.deepEqual(next, new Uint8Array(32).fill(29));
  });
  await scenario("new entry write failure keeps drawer open, displays error, and retry creates no duplicate", async f => {
    f.vault.openCreateDrawer();
    const drawer = f.mount(f.EntryDrawer);
    drawer.form.title = "Synthetic entry";
    f.state.failWrite = true;
    await drawer.submit();
    assert.equal(f.vault.drawer.value.open, true, "failed save must not close the drawer");
    assert.match(drawer.localError, /SIMULATED_WRITE_FAILURE/);
    assert.equal(f.vault.entries.value.length, 1);
    assert.equal(f.vault.drawer.value.mode, "edit", "retry must target the already-created in-memory entry");
    assert.equal(f.vault.hasUnsavedChanges.value, true);
    f.state.failWrite = false;
    await drawer.submit();
    assert.equal(f.vault.entries.value.length, 1, "retry must not duplicate the entry");
    assert.equal(f.vault.drawer.value.open, false);
    assert.equal(f.vault.hasUnsavedChanges.value, false);
    assert.equal(f.vault.error.value, "");
  });
  await scenario("edit failure returns false and retains draft for retry", async f => {
    const id = await f.vault.addEntry(f.draft);
    f.state.failWrite = true;
    assert.equal(await f.vault.updateEntry(id, { ...f.draft, title: "Unsaved edit" }), false);
    assert.equal(f.vault.draftOf(id).title, "Unsaved edit");
    assert.equal(f.vault.hasUnsavedChanges.value, true);
    assert.match(f.vault.error.value, /SIMULATED_WRITE_FAILURE/);
    f.state.failWrite = false;
    assert.equal(await f.vault.updateEntry(id, { ...f.draft, title: "Saved retry" }), true);
    assert.equal(f.vault.hasUnsavedChanges.value, false);
  });
  await scenario("edit drawer keeps user input and shows a failed save until retry succeeds", async f => {
    const id = await f.vault.addEntry(f.draft);
    f.vault.openEditDrawer(id);
    const drawer = f.mount(f.EntryDrawer);
    drawer.form.title = "Unsaved UI edit";
    f.state.failWrite = true;
    await drawer.submit();
    assert.equal(f.vault.drawer.value.open, true);
    assert.equal(drawer.form.title, "Unsaved UI edit");
    assert.match(drawer.localError, /SIMULATED_WRITE_FAILURE/);
    f.state.failWrite = false;
    await drawer.submit();
    assert.equal(f.vault.drawer.value.open, false);
    assert.equal(f.vault.draftOf(id).title, "Unsaved UI edit");
    assert.equal(f.vault.entries.value.length, 1);
  });
  await scenario("flush retries a failed save even without a pending timer", async f => {
    f.state.failWrite = true;
    await f.vault.addEntry(f.draft);
    const attempts = f.state.writes.length;
    assert.equal(await f.vault.flushSave(), false);
    assert.ok(f.state.writes.length > attempts, "failed dirty data must be retried");
    f.state.failWrite = false;
    assert.equal(await f.vault.flushSave(), true);
    assert.equal(f.vault.hasUnsavedChanges.value, false);
    assert.equal(f.vault.error.value, "");
    assert.match(f.vault.status.value, /已保存/, "successful retry must clear stale unsaved status");
    const settled = f.state.writes.length;
    assert.equal(await f.vault.flushSave(), true);
    assert.equal(f.state.writes.length, settled, "clean flush must not rewrite the vault");
  });
  await scenario("manual lock failure keeps data, drawer, watcher and error; retry saves then locks", async f => {
    f.vault.openCreateDrawer();
    f.state.failWrite = true;
    await f.vault.addEntry(f.draft);
    assert.equal(await f.vault.lock(), false);
    assert.equal(f.vault.unlocked.value, true);
    assert.equal(f.vault.entries.value.length, 1);
    assert.equal(f.vault.drawer.value.open, true);
    assert.equal(f.state.watches.includes(null), false, "cancelled lock must keep watcher active");
    assert.match(f.vault.error.value, /SIMULATED_WRITE_FAILURE/);
    f.state.failWrite = false;
    assert.equal(await f.vault.lock(), true);
    assert.equal(f.vault.unlocked.value, false);
    assert.equal(f.state.watches.at(-1), null);
    assert.equal(f.vault.hasUnsavedChanges.value, false);
  });
  await scenario("switching vault is cancelled on failed save and preserves the selected vault", async f => {
    const main = f.mount(f.MainView);
    f.state.failWrite = true;
    await f.vault.addEntry(f.draft);
    const oldPath = f.settings.lastVaultPath;
    await main.switchTo({ path: "OTHER_SYNTHETIC.kdbx", name: "Other", lastOpenedAt: 0 });
    assert.equal(f.vault.unlocked.value, true);
    assert.equal(f.settings.lastVaultPath, oldPath);
    assert.equal(f.vault.vaultPath.value, "SYNTHETIC_ONLY.kdbx");
    f.state.failWrite = false;
    await main.switchTo({ path: "OTHER_SYNTHETIC.kdbx", name: "Other", lastOpenedAt: 0 });
    assert.equal(f.vault.unlocked.value, false);
    assert.equal(f.settings.lastVaultPath, "OTHER_SYNTHETIC.kdbx");
  });
  await scenario("manual lock awaits an in-flight write instead of clearing the vault early", async f => {
    document.hasFocus = () => true; document.hidden = false;
    f.settings.clipboardRecognition = true;
    const main = f.mount(f.MainView);
    const blocked = gate();
    f.state.writeGate = blocked.promise;
    const saving = f.vault.addEntry(f.draft);
    await until(() => f.state.writes.length === 1);
    let settled = false;
    const locking = f.vault.lock().then(value => { settled = true; return value; });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(f.vault.unlocked.value, true);
    assert.equal(f.vault.clipboardCaptureBlocked.value, true);
    main.onClipboardFocus(); await f.nextTick();
    assert.equal(f.state.clipboardReads, 0);
    blocked.release();
    await saving;
    assert.equal(await locking, true);
    assert.equal(f.vault.unlocked.value, false);
    assert.equal(f.vault.clipboardCaptureBlocked.value, false);
  });
  await scenario("changes during serialization remain dirty until a later flush saves them", async f => {
    const id = await f.vault.addEntry(f.draft);
    const blocked = gate();
    f.state.saveGate = blocked.promise;
    f.state.snapshots.length = 0;
    const saving = f.vault.saveVault();
    await until(() => f.state.snapshots.length === 1);
    await f.vault.touchUsage(id);
    blocked.release();
    await saving;
    assert.equal(f.vault.hasUnsavedChanges.value, true);
    assert.equal(await f.vault.flushSave(), true);
    assert.equal(f.vault.hasUnsavedChanges.value, false);
    assert.equal(f.state.snapshots.length, 2);
  });
  await scenario("debounced save failures are not forgotten once the timer has fired", async f => {
    const id = await f.vault.addEntry(f.draft);
    f.state.failWrite = true;
    await f.vault.touchUsage(id);
    assert.equal(f.timers.size, 1);
    const callback = f.timers.values().next().value;
    f.timers.clear();
    callback();
    await until(() => /SIMULATED_WRITE_FAILURE/.test(f.vault.error.value));
    assert.equal(f.vault.hasUnsavedChanges.value, true);
    assert.equal(await f.vault.lock(), false);
    assert.equal(f.vault.unlocked.value, true);
  });
  await scenario("unchanged failed retries preserve the bounded entry history", async f => {
    const id = await f.vault.addEntry(f.draft);
    const entry = f.state.db.getDefaultGroup().entries[0];
    for (let i = 0; i < 20; i++) {
      entry.fields.set("Title", `History ${i}`);
      entry.pushHistory();
    }
    entry.fields.set("Title", f.draft.title);
    f.state.failWrite = true;
    const changed = { ...f.draft, title: "Unsaved history edit", tags: "one,two" };
    assert.equal(await f.vault.updateEntry(id, changed), false);
    const history = f.vault.historyOf(id).map(item => item.title);
    assert.equal(history.length, 20);
    assert.equal(await f.vault.updateEntry(id, changed), false);
    assert.deepEqual(f.vault.historyOf(id).map(item => item.title), history);
    f.state.failWrite = false;
    assert.equal(await f.vault.updateEntry(id, changed), true);
    assert.deepEqual(f.vault.historyOf(id).map(item => item.title), history);
  });
  await scenario("overlapping vault switches cannot replace the rollback path", async f => {
    f.state.failWrite = true;
    await f.vault.addEntry(f.draft);
    const main = f.mount(f.MainView);
    const blocked = gate();
    f.state.writeGate = blocked.promise;
    const first = main.switchTo({ path: "FIRST_SYNTHETIC.kdbx", name: "First", lastOpenedAt: 0 });
    const second = main.switchTo({ path: "SECOND_SYNTHETIC.kdbx", name: "Second", lastOpenedAt: 0 });
    blocked.release();
    await Promise.all([first, second]);
    assert.equal(f.vault.unlocked.value, true);
    assert.equal(f.settings.lastVaultPath, "SYNTHETIC_ONLY.kdbx");
  });
  await scenario("overlapping security and manual locks agree once the vault is locked", async f => {
    f.state.failWrite = true;
    await f.vault.addEntry(f.draft);
    const [forced, manual] = await Promise.all([f.vault.lock({ force: true }), f.vault.lock()]);
    assert.equal(forced, true);
    assert.equal(manual, true);
    assert.equal(f.vault.unlocked.value, false);
    assert.doesNotMatch(f.vault.status.value, /已取消/);
    assert.match(f.vault.error.value, /未能保存/);
  });
  await scenario("custom fields and Auto-Type survive save failures and field rename retries", async f => {
    const id = await f.vault.addEntry({ ...f.draft, customFields: [{ name: "Original", value: "SYNTHETIC_FIELD", protected: true }], autoTypeSequence: "{PASSWORD}{ENTER}" });
    const entry = f.state.db.getDefaultGroup().entries[0];
    entry.fields.set("Foreign", "preserve");
    const draft = f.vault.draftOf(id);
    draft.customFields.find(f => f.name === "Original").name = "Renamed";
    f.state.failWrite = true;
    assert.equal(await f.vault.updateEntry(id, draft), false);
    const historyCount = f.vault.historyOf(id).length;
    f.state.failWrite = false;
    assert.equal(await f.vault.updateEntry(id, draft), true);
    assert.equal(entry.fields.get("Renamed").getText(), "SYNTHETIC_FIELD");
    assert.equal(entry.fields.has("Original"), false);
    assert.equal(entry.fields.get("Foreign"), "preserve");
    assert.equal(f.vault.autoTypeSequenceOf(id), "{PASSWORD}{ENTER}");
    assert.equal(f.vault.historyOf(id).length, historyCount);
  });
  await scenario("TOTP Base32 is protected and usable after entry save", async f => {
    const id = await f.vault.addEntry({ ...f.draft, totp: "JBSWY3DPEHPK3PXP" });
    assert.ok(f.vault.totpConfigOf(id));
    assert.equal(f.vault.entries.value[0].totpPeriod, 30);
    const entry = f.state.db.getDefaultGroup().entries[0];
    assert.equal(typeof entry.fields.get("otp"), "object");
    assert.match(entry.fields.get("otp").getText(), /^otpauth:/);
  });
  await scenario("CSV preview cancel makes no edits; failed confirmation retries without duplicates", async f => {
    f.state.csv = 'name,url,username,password,note\r\na,,u," p ","line1\nline2"';
    assert.equal(await f.vault.previewCsv("SYNTHETIC.csv"), true);
    assert.equal(f.vault.entries.value.length, 0);
    f.vault.cancelImport(); assert.equal(f.vault.entries.value.length, 0);
    assert.equal(await f.vault.previewCsv("SYNTHETIC.csv"), true);
    f.state.failWrite = true;
    assert.equal(await f.vault.confirmImport(), 0);
    assert.equal(f.vault.entries.value.length, 1);
    assert.equal(f.vault.importApplied.value, true);
    f.state.failWrite = false;
    assert.equal(await f.vault.confirmImport(), 1);
    assert.equal(f.vault.entries.value.length, 1);
    const id = f.vault.entries.value[0].uuid;
    assert.equal(f.vault.draftOf(id).password, " p ");
    assert.equal(f.vault.draftOf(id).notes, "line1\nline2");
    assert.equal(f.vault.importPreview.value.length, 0);
  });
  await scenario("invalid extension leaves entry and history unchanged", async f => {
    const id = await f.vault.addEntry(f.draft);
    const before = f.vault.historyOf(id).length;
    assert.equal(await f.vault.updateEntry(id, { ...f.draft, title: "Should not apply", customFields: [{ name: "Password", value: "X", protected: false }] }), false);
    assert.equal(f.vault.draftOf(id).title, f.draft.title);
    assert.equal(f.vault.historyOf(id).length, before);
  });
  await scenario("usage metadata preserves modification time and preview clears on lock", async f => {
    const id = await f.vault.addEntry(f.draft), before = f.vault.entries.value[0].updatedAt.getTime();
    await f.vault.touchUsage(id);
    assert.ok(f.vault.entries.value[0].lastUsedAt);
    assert.equal(f.vault.entries.value[0].updatedAt.getTime(), before);
    f.state.csv = 'name,password\na,p'; await f.vault.previewCsv("SYNTHETIC.csv");
    assert.equal(await f.vault.lock(), true); assert.equal(f.vault.importPreview.value.length, 0);
  });
  await scenario("import rechecks new conflicts before mutating the vault", async f => {
    f.state.csv = 'name,url,username,password\na,https://a.test,u,incoming';
    await f.vault.previewCsv("SYNTHETIC.csv");
    assert.equal(f.vault.importPreview.value[0].classification, "new");
    await f.vault.addEntry({ ...f.draft, title: "a", username: "u", url: "https://a.test", password: "existing" });
    assert.equal(await f.vault.confirmImport(), 0);
    assert.equal(f.vault.entries.value.length, 1);
    assert.equal(f.vault.importPreview.value[0].classification, "conflict");
    assert.equal(f.vault.importPreview.value[0].selected, false);
    f.vault.importPreview.value[0].selected = true;
    assert.equal(await f.vault.confirmImport(), 1);
    assert.equal(f.vault.entries.value.length, 2);
  });
  await scenario("same credentials in different CSV groups remain separately selectable", async f => {
    f.state.csv = 'Group,Title,Username,Password,URL,Notes\nWork,a,u,p,https://a.test,n\nPersonal,a,u,p,https://a.test,n';
    await f.vault.previewCsv("SYNTHETIC.csv");
    assert.equal(f.vault.importPreview.value[1].classification, "conflict");
    f.vault.importPreview.value[1].selected = true;
    assert.equal(await f.vault.confirmImport(), 2);
    assert.equal(f.vault.entries.value.length, 2);
    assert.equal(new Set(f.vault.entries.value.map(e => e.groupUuid)).size, 2);
  });
  await scenario("favorites filter does not hide nonfavorite trash entries", async f => {
    const id = await f.vault.addEntry(f.draft);
    await f.vault.removeEntry(id);
    f.vault.favoritesOnly.value = true;
    f.vault.selectGroup(f.vault.trash.value.uuid);
    assert.equal(f.vault.visibleEntries.value.length, 1);
  });
  await scenario("hidden URL and later tag matches show their matching context", async f => {
    const context = f.mount(f.MatchContext, { entry: { title: "a", username: "u", url: "https://match.test", tags: ["first", "second-match"] }, query: "match" });
    assert.match(context.context, /https:\/\/match.test/);
    assert.match(context.context, /second-match/);
  });
  await scenario("backup validation reports read failure distinctly and performs real read-only KDBX load", async f => {
    f.state.backupFailure = true;
    assert.match((await f.vault.verifyCurrentBackup()).text, /读取|权限/);
    f.state.backupFailure = false;
    assert.equal((await f.vault.verifyCurrentBackup()).kind, "missing");
    const db = f.state.db;
    // AES KDF avoids injecting test-only Argon2 while retaining actual encrypted KDBX authentication.
    db.setKdf(kdbxweb.Consts.KdfId.Aes);
    const saved = await kdbxweb.Kdbx.prototype.save.call(db);
    f.state.backupBytes = Array.from(new Uint8Array(saved));
    const writes = f.state.writes.length;
    assert.equal((await f.vault.verifyCurrentBackup()).kind, "valid");
    assert.equal(f.state.writes.length, writes);
    assert.equal(f.state.loads, 1);
    assert.equal(f.vault.vaultKdfDetails().some(p => p.label === "迭代"), true);
  });
  await scenario("local audit defaults off, records only explicit events, and clear invalidates waiting actions", async f => {
    await f.refreshAudit();
    await f.recordAudit("copy-password", "SYNTHETIC_UUID");
    assert.equal(f.state.audit.events.length, 0);
    await f.setAuditEnabled(true);
    await f.recordAudit("copy-password", "SYNTHETIC_UUID");
    assert.equal(f.state.audit.events.length, 1);
    assert.deepEqual(Object.keys(f.state.audit.events[0]).sort(), ["entryUuid", "epoch", "kind"]);
    await f.clearAudit(); assert.equal(f.state.audit.events.length, 0);
    await f.setAuditEnabled(false);
    await f.recordAudit("unlock"); assert.equal(f.state.audit.events.length, 0);
  });
  await scenario("audit clear cancels old action waiting for initial preference read", async f => {
    // A fresh module fixture starts its lazy audit load during createVault.
    const blocked = gate(); f.state.auditGate = blocked.promise;
    const refresh = f.refreshAudit();
    const before = f.state.audit.epoch;
    const clearing = f.clearAudit();
    blocked.release(); await Promise.all([refresh, clearing]);
    assert.equal(f.auditState.value.epoch, before + 1);
    assert.equal(f.state.audit.events.length, 0);
  });
  await scenario("host waits for copy acknowledgement, counts only password/TOTP, and rejects stale sessions", async f => {
    const id = await f.vault.addEntry({ ...f.draft, password: "SYNTHETIC_ONLY", username: "u" });
    f.mount(f.defineComponent({ setup() { f.usePanelHost(); return () => null; } }));
    await until(() => f.state.listeners.has("keytree:panel-request"));
    const handle = payload => f.state.listeners.get("keytree:panel-request")({ payload });
    handle({ kind: "sync" });
    await until(() => f.state.messages.some(m => m.payload.kind === "state"));
    const session = f.state.messages.filter(m => m.payload.kind === "state").at(-1).payload.session;
    handle({ kind: "copy", action: "password", id, requestId: "request-1", session });
    await until(() => f.state.messages.some(m => m.payload.requestId === "request-1"));
    assert.equal(f.vault.entries.value[0].usageCount, 0);
    handle({ kind: "copied", id, requestId: "request-1", session });
    assert.equal(f.vault.entries.value[0].usageCount, 1);
    handle({ kind: "copied", id, requestId: "request-1", session });
    assert.equal(f.vault.entries.value[0].usageCount, 1);
    handle({ kind: "copy", action: "username", id, requestId: "request-2", session });
    await until(() => f.state.messages.some(m => m.payload.requestId === "request-2"));
    handle({ kind: "copied", id, requestId: "request-2", session });
    assert.equal(f.vault.entries.value[0].usageCount, 1);
    await f.vault.lock();
    const before = f.state.messages.length;
    handle({ kind: "copy", action: "password", id, requestId: "request-old", session });
    await Promise.resolve();
    assert.equal(f.state.messages.slice(before).some(m => m.payload.kind === "copy"), false);
  });
  await scenario("panel rejects delayed secrets after locking and only acknowledges successful copy", async f => {
    const panel = f.mount(f.PanelApp);
    await panel.onResponse({ kind: "state", unlocked: true, session: 10, entries: [{ id: "e", title: "a", username: "u", url: "", tags: [], updatedAt: null, lastUsedAt: null, favorite: false, usageCount: 0, hasTotp: false, totpPeriod: null, icon: null }] });
    await panel.copyPassword();
    const request = f.state.messages.at(-1).payload;
    await panel.onResponse({ kind: "state", unlocked: false, session: 11, entries: [] });
    await panel.onResponse({ kind: "copy", action: "password", id: "e", value: "SYNTHETIC_ONLY", ttl: 0, session: 10, requestId: request.requestId });
    assert.equal(f.state.copies, 0); assert.equal(panel.entries.length, 0);
    await panel.onResponse({ kind: "state", unlocked: true, session: 12, entries: [{ id: "e", title: "a", username: "u", url: "", tags: [], updatedAt: null, lastUsedAt: null, favorite: false, usageCount: 0, hasTotp: false, totpPeriod: null, icon: null }] });
    await panel.copyPassword(); const current = f.state.messages.at(-1).payload;
    f.state.failCopy = true;
    await panel.onResponse({ kind: "copy", action: "password", id: "e", value: "SYNTHETIC_ONLY", ttl: 0, session: 12, requestId: current.requestId });
    assert.equal(f.state.messages.some(m => m.payload.kind === "copied"), false);
    f.state.failCopy = false;
    await panel.copyPassword(); const retry = f.state.messages.at(-1).payload;
    await panel.onResponse({ kind: "copy", action: "password", id: "e", value: "SYNTHETIC_ONLY", ttl: 0, session: 12, requestId: retry.requestId });
    assert.equal(f.state.copies, 1); assert.equal(f.state.messages.filter(m => m.payload.kind === "copied").length, 1);
  });
  await scenario("master hint save failure keeps draft and dirty state until successful retry", async f => {
    f.state.db.header.publicCustomData = new kdbxweb.VarDictionary();
    f.state.db.header.publicCustomData.set("foreign.example", kdbxweb.VarDictionary.ValueType.String, "keep");
    f.state.failWrite = true;
    assert.equal(await f.vault.setMasterHint("Synthetic memory clue"), false);
    assert.equal(f.vault.getMasterHint().text, "Synthetic memory clue");
    assert.equal(f.vault.hasUnsavedChanges.value, true);
    assert.match(f.vault.error.value, /SIMULATED_WRITE_FAILURE/);
    f.state.failWrite = false;
    assert.equal(await f.vault.setMasterHint("Synthetic memory clue"), true);
    assert.equal(f.vault.hasUnsavedChanges.value, false);
    assert.equal(f.state.db.header.publicCustomData.get("foreign.example"), "keep");
    assert.equal(await f.vault.setMasterHint(""), true);
    assert.equal(f.vault.getMasterHint().kind, "none");
    assert.equal(f.state.db.header.publicCustomData.get("foreign.example"), "keep");
  });
  await scenario("master hint rejects unsupported/invalid input and locked writes without upgrading", async f => {
    const before = f.state.writes.length;
    assert.equal(await f.vault.setMasterHint("x".repeat(201)), false);
    assert.equal(f.state.writes.length, before);
    f.state.db.setVersion(3);
    assert.equal(await f.vault.setMasterHint("Unsupported"), false);
    assert.equal(f.state.db.versionMajor, 3);
    assert.equal(f.state.writes.length, before);
    f.state.db.setVersion(4);
    await f.vault.lock();
    assert.equal(await f.vault.setMasterHint("Locked"), false);
  });
  await scenario("hint settings retain failed draft, retry truthfully, and can clear an overlong draft", async f => {
    const ui = f.mount(f.MasterPasswordHintSettings);
    ui.draft = "Synthetic settings clue";
    f.state.failWrite = true;
    await ui.submit(false);
    assert.equal(ui.draft, "Synthetic settings clue");
    assert.match(ui.message, /SIMULATED_WRITE_FAILURE/);
    f.state.failWrite = false;
    await ui.submit(false);
    assert.match(ui.message, /已保存/);
    assert.equal(f.vault.getMasterHint().text, "Synthetic settings clue");
    ui.draft = "x".repeat(201);
    await ui.submit(true);
    assert.equal(f.vault.getMasterHint().kind, "none");
    assert.equal(ui.draft, "");
  });
  await scenario("public hint entry is checked automatically but stays collapsed and rereads on display", async f => {
    const db = f.state.db;
    db.setKdf(kdbxweb.Consts.KdfId.Aes);
    db.header.publicCustomData = new kdbxweb.VarDictionary();
    db.header.publicCustomData.set("keytree.masterPasswordHint", kdbxweb.VarDictionary.ValueType.String, "<b>Synthetic clue</b>");
    f.state.headerBytes = Array.from(new Uint8Array(await kdbxweb.Kdbx.prototype.save.call(db)));
    const ui = f.mountControlled(f.PublicPasswordHint, { path: "A_SYNTHETIC.kdbx", mode: "open" });
    assert.equal(f.state.headerCalls.length, 1);
    await until(() => !ui.state.checking);
    assert.equal(ui.state.hasHint, true);
    assert.equal(ui.state.visible, false);
    assert.equal(ui.state.text, "");
    await ui.state.show();
    assert.equal(ui.state.text, "<b>Synthetic clue</b>");
    assert.equal(f.vault.error.value, "");
    ui.state.hide();
    assert.equal(ui.state.text, "");
    await ui.state.show();
    assert.equal(f.state.headerCalls.length, 3);
  });
  await scenario("no hint hides the entire public hint entry without changing unlock state", async f => {
    const db=f.state.db; db.setKdf(kdbxweb.Consts.KdfId.Aes);
    f.state.headerBytes=Array.from(new Uint8Array(await kdbxweb.Kdbx.prototype.save.call(db)));
    const ui=f.mountControlled(f.PublicPasswordHint,{path:"NO_HINT.kdbx",mode:"open"});
    await until(() => !ui.state.checking);
    assert.equal(f.state.headerCalls.length,1);
    assert.equal(ui.state.hasHint,false);
    assert.equal(ui.state.visible,false);
    assert.equal(ui.state.text,"");
    assert.equal(f.vault.error.value,"");
    assert.equal(f.vault.busy.value,false);
  });
  await scenario("switching to a no-hint file discards a pending earlier hint check", async f => {
    const db=f.state.db; db.setKdf(kdbxweb.Consts.KdfId.Aes);
    const noHint=Array.from(new Uint8Array(await kdbxweb.Kdbx.prototype.save.call(db)));
    db.header.publicCustomData=new kdbxweb.VarDictionary();
    db.header.publicCustomData.set("keytree.masterPasswordHint",kdbxweb.VarDictionary.ValueType.String,"A only");
    f.state.headerBytes=Array.from(new Uint8Array(await kdbxweb.Kdbx.prototype.save.call(db)));
    const blocked=gate();f.state.headerGate=blocked.promise;
    const ui=f.mountControlled(f.PublicPasswordHint,{path:"A.kdbx",mode:"open"});
    assert.equal(f.state.headerCalls.length,1);
    f.state.headerBytes=noHint;ui.props.path="B.kdbx";await f.nextTick();
    assert.equal(f.state.headerCalls.length,2);
    blocked.release();await until(() => !ui.state.checking);
    await f.nextTick();
    assert.equal(ui.state.hasHint,false);
    assert.equal(ui.state.visible,false);
    assert.equal(ui.state.text,"");
  });
  await scenario("a deleted hint is hidden when the user requests a fresh display", async f => {
    const db=f.state.db;db.setKdf(kdbxweb.Consts.KdfId.Aes);
    db.header.publicCustomData=new kdbxweb.VarDictionary();
    db.header.publicCustomData.set("keytree.masterPasswordHint",kdbxweb.VarDictionary.ValueType.String,"before delete");
    f.state.headerBytes=Array.from(new Uint8Array(await kdbxweb.Kdbx.prototype.save.call(db)));
    const ui=f.mountControlled(f.PublicPasswordHint,{path:"A.kdbx",mode:"recent"});
    await until(() => !ui.state.checking);assert.equal(ui.state.hasHint,true);
    db.header.publicCustomData.remove("keytree.masterPasswordHint");
    f.state.headerBytes=Array.from(new Uint8Array(await kdbxweb.Kdbx.prototype.save.call(db)));
    await ui.state.show();
    assert.equal(ui.state.hasHint,false);assert.equal(ui.state.visible,false);assert.equal(ui.state.text,"");
    ui.props.mode="create";await f.nextTick();
    assert.equal(ui.state.hasHint,false);
  });
  await scenario("path changes, mode changes, hiding and unmount invalidate delayed public hints", async f => {
    const db=f.state.db; db.setKdf(kdbxweb.Consts.KdfId.Aes);
    db.header.publicCustomData=new kdbxweb.VarDictionary();
    db.header.publicCustomData.set("keytree.masterPasswordHint", kdbxweb.VarDictionary.ValueType.String, "A only");
    f.state.headerBytes=Array.from(new Uint8Array(await kdbxweb.Kdbx.prototype.save.call(db)));
    for (const action of ["path", "mode", "hide", "unmount"]) {
      const blocked=gate(); f.state.headerGate=blocked.promise;
      const ui=f.mountControlled(f.PublicPasswordHint, { path:"A_SYNTHETIC.kdbx", mode:"open" });
      const pending=ui.state.show();
      if (action === "path") { ui.props.path="B_SYNTHETIC.kdbx"; await f.nextTick(); }
      else if (action === "mode") { ui.props.mode="create"; await f.nextTick(); }
      else if (action === "hide") ui.state.hide();
      else ui.unmount();
      blocked.release(); await pending;
      assert.equal(ui.state.text, ""); assert.equal(ui.state.visible, false);
    }
  });
  await scenario("hint read errors stay local and never block normal vault input state", async f => {
    const ui=f.mount(f.PublicPasswordHint,{path:"SYNTHETIC.kdbx",mode:"open"});
    for (const code of ["HEADER_IO","HEADER_INVALID","HEADER_TOO_LARGE","HEADER_UNSUPPORTED"]) {
      f.state.headerError=code; await ui.show();
      assert.ok(ui.message); assert.equal(ui.loading,false); assert.equal(f.vault.error.value,""); assert.equal(f.vault.busy.value,false);
    }
  });
  await scenario("external public metadata edits abort saving instead of overwriting hints or foreign keys", async f => {
    const current=f.state.db; current.setKdf(kdbxweb.Consts.KdfId.Aes);
    const encrypted=await kdbxweb.Kdbx.prototype.save.call(current);
    const remote=await kdbxweb.Kdbx.load(encrypted,current.credentials);
    remote.header.publicCustomData=new kdbxweb.VarDictionary();
    remote.header.publicCustomData.set("foreign.example",kdbxweb.VarDictionary.ValueType.String,"external data");
    remote.header.publicCustomData.set("keytree.masterPasswordHint",kdbxweb.VarDictionary.ValueType.String,"remote clue");
    f.state.vaultBytes=Array.from(new Uint8Array(await remote.save()));
    f.state.stat={mtimeMs:2,size:f.state.vaultBytes.length};
    const before=f.state.writes.length;
    assert.equal(await f.vault.setMasterHint("local clue"),false);
    assert.equal(f.state.writes.length,before);
    assert.match(f.vault.error.value,/公开.*修改|公开.*合并/);
    assert.equal(f.vault.getMasterHint().text,"local clue");
    assert.equal(f.vault.hasUnsavedChanges.value,true);
  });
  await scenario("external version change during serialization rejects hint write and retains unsaved state", async f => {
    const blocked=gate(); f.state.saveGate=blocked.promise;
    const start=f.state.snapshots.length;
    const pending=f.vault.setMasterHint("local pending clue");
    await until(()=>f.state.snapshots.length>start);
    f.state.stat={mtimeMs:2,size:64}; blocked.release();
    assert.equal(await pending,false);
    assert.equal(f.vault.hasUnsavedChanges.value,true);
    assert.equal(f.vault.getMasterHint().text,"local pending clue");
    assert.match(f.vault.error.value,/外部修改/);
  });
  await scenario("vault changing during decryption is not accepted as a stale public baseline", async f => {
    const db=f.state.db;db.setKdf(kdbxweb.Consts.KdfId.Aes);
    const bytes=Array.from(new Uint8Array(await kdbxweb.Kdbx.prototype.save.call(db)));
    await f.vault.lock(); f.state.vaultBytes=bytes;
    const blocked=gate(); f.state.loadGate=blocked.promise;
    const before=f.state.loads;
    const pending=f.vault.openVault("SYNTHETIC_ONLY.kdbx","SYNTHETIC_ONLY");
    await until(()=>f.state.loads>before);
    f.state.stat={mtimeMs:2,size:64}; blocked.release();
    assert.equal(await pending,false); assert.equal(f.vault.unlocked.value,false);
    assert.match(f.vault.error.value,/变化/);
  });
  await scenario("idle auto-lock uses security policy and shows the save failure warning", async f => {
    f.state.failWrite = true;
    await f.vault.addEntry(f.draft);
    f.mount(f.defineComponent({ setup() { f.useAutoLock(); return () => null; } }));
    assert.equal(f.timers.size, 1);
    const callback = f.timers.values().next().value;
    f.timers.clear();
    callback();
    await until(() => !f.vault.unlocked.value);
    await until(() => /未能保存/.test(f.toastText.value));
    assert.match(f.vault.error.value, /未能保存/);
  });

  await scenario("history annotations are independent, bounded, encrypted and survive merge/reopen", async f => {
    const id = await f.vault.addEntry({ ...f.draft, notes: "Current note" });
    await f.vault.updateEntry(id, { ...f.vault.draftOf(id), title: "Current title" });
    const selected = f.vault.historyOf(id)[0];
    const originalTime = selected.at.getTime();
    const entry = [...f.state.db.getDefaultGroup().allEntries()].find(e => e.uuid.id === id);
    assert.equal(await f.vault.setHistoryNote(id, selected.id, "😀".repeat(200)), true);
    assert.equal(f.vault.historyOf(id).length, 1);
    assert.equal(f.vault.historyOf(id)[0].at.getTime(), originalTime);
    assert.equal(f.vault.draftOf(id).notes, "Current note");
    assert.equal(await f.vault.setHistoryNote(id, selected.id, "x".repeat(201)), false);
    assert.equal(await f.vault.setHistoryNote(id, selected.id, "bad\0note"), false);
    const db = f.state.db; db.setKdf(kdbxweb.Consts.KdfId.Aes);
    const bytes = await kdbxweb.Kdbx.prototype.save.call(db);
    const reopened = await kdbxweb.Kdbx.load(bytes, db.credentials);
    const remoteEntry = [...reopened.getDefaultGroup().allEntries()].find(e => e.uuid.id === id);
    assert.equal(f.historyNote(remoteEntry.history[0]), "😀".repeat(200));
    f.writeHistoryNote(remoteEntry.history[0], "Remote synthetic annotation");
    f.mergeWithHistoryNotes(db, reopened);
    assert.equal(f.historyNote(entry.history[0]), "Remote synthetic annotation");
    f.writeHistoryNote(entry.history[0], "");
    f.mergeWithHistoryNotes(db, reopened);
    assert.equal(f.historyNote(entry.history[0]), "", "a newer clear is not resurrected by merge");
    const beforeDelete = entry.history.length;
    const selectedIndex = entry.history.findIndex(h => h.fields.get("Title") === f.draft.title);
    assert.ok(selectedIndex >= 0);
    entry.removeHistory(selectedIndex);
    const deleted = await kdbxweb.Kdbx.load(await kdbxweb.Kdbx.prototype.save.call(db), db.credentials);
    const remaining = [...deleted.getDefaultGroup().allEntries()].find(e => e.uuid.id === id).history;
    assert.equal(remaining.length, beforeDelete - 1);
    assert.equal(remaining.some(h => h.fields.get("Title") === f.draft.title), false);
  });
  await scenario("history identity survives reorder/same timestamp, deletion retries save only", async f => {
    const id = await f.vault.addEntry(f.draft);
    await f.vault.updateEntry(id, { ...f.vault.draftOf(id), title: "Version 2" });
    await f.vault.updateEntry(id, { ...f.vault.draftOf(id), title: "Version 3" });
    const entry = [...f.state.db.getDefaultGroup().allEntries()].find(e => e.uuid.id === id);
    entry.history[1].times.lastModTime = new Date(entry.history[0].times.lastModTime);
    const target = f.vault.historyOf(id).find(h => h.title === f.draft.title);
    entry.history.reverse();
    assert.equal(await f.vault.setHistoryNote(id, target.id, "Only the selected version"), true);
    assert.equal(f.vault.historyOf(id).find(h => h.id === target.id).note, "Only the selected version");
    f.state.failWrite = true;
    assert.equal(await f.vault.deleteHistory(id, target.id), false);
    assert.equal(f.vault.historyPending.value, true);
    const remaining = f.vault.historyOf(id).map(h => h.id);
    assert.equal(remaining.length, 1);
    assert.equal(await f.vault.deleteHistory(id, target.id), false);
    assert.deepEqual(f.vault.historyOf(id).map(h => h.id), remaining);
    f.state.failWrite = false;
    assert.equal(await f.vault.retryHistorySave(), true);
    assert.equal(f.vault.historyPending.value, false);
    assert.equal(await f.vault.deleteHistory(id, target.id), false, "stale target must not delete remaining version");
    assert.deepEqual(f.vault.historyOf(id).map(h => h.id), remaining);
  });
  await scenario("history restore reports failed save and retries without another snapshot", async f => {
    const id = await f.vault.addEntry({ ...f.draft, autoTypeSequence: "{PASSWORD}" });
    await f.vault.updateEntry(id, { ...f.vault.draftOf(id), title: "Changed", autoTypeSequence: "{USERNAME}" });
    const target = f.vault.historyOf(id)[0];
    f.state.failWrite = true;
    assert.equal(await f.vault.restoreHistory(id, target.id), false);
    assert.equal(f.vault.draftOf(id).title, f.draft.title);
    assert.equal(f.vault.draftOf(id).autoTypeSequence, "{PASSWORD}");
    const count = f.vault.historyOf(id).length;
    assert.equal(await f.vault.restoreHistory(id, target.id), false);
    assert.equal(f.vault.historyOf(id).length, count);
    f.state.failWrite = false;
    assert.equal(await f.vault.retryHistorySave(), true);
    assert.equal(f.vault.historyOf(id).length, count);
  });
  await scenario("clipboard opt-in, confirmation and editor prefill never save until manual submit", async f => {
    document.hasFocus = () => true;
    document.hidden = false;
    f.state.clipboardCandidate = { sequence: 11, text: "名称:Clipboard test\n账号:demo\n密码: SYNTHETIC:a,b ", html: null, sourceUrl: "https://sheet.example.test/doc", sourceApp: "excel.exe" };
    const main = f.mount(f.MainView);
    main.onClipboardFocus(); await f.nextTick();
    assert.equal(f.state.clipboardReads, 0);
    f.settings.clipboardRecognition = true;
    main.onClipboardFocus(); await until(() => !!main.clipboardRecognition);
    assert.equal(f.vault.entries.value.length, 0);
    assert.equal(f.state.writes.length, 0);
    assert.equal(main.clipboardRecognition.source.url, "https://sheet.example.test");
    main.acceptClipboardRecord(0);
    assert.equal(main.clipboardRecognition, null);
    assert.equal(f.vault.drawer.value.mode, "create");
    const drawer = f.mount(f.EntryDrawer, { clipboardDraft: main.clipboardDraft });
    assert.equal(drawer.form.username, "demo");
    assert.equal(drawer.form.password, " SYNTHETIC:a,b ");
    assert.equal(drawer.form.url, "");
    assert.equal(drawer.revealed, false);
    assert.equal(f.vault.entries.value.length, 0);
    assert.equal(f.state.writes.length, 0);
    drawer.requestClose(); assert.equal(drawer.confirmDiscard, true);
    drawer.confirmDiscard = false;
    await drawer.submit();
    assert.equal(f.vault.entries.value.length, 1);
    assert.equal(f.vault.drawer.value.open, false);
    assert.equal(main.clipboardDraft, null);
    assert.equal(f.vault.draftOf(f.vault.entries.value[0].uuid).password, " SYNTHETIC:a,b ");
    f.vault.openCreateDrawer();
    const empty = f.mount(f.EntryDrawer);
    assert.equal(empty.form.password, "");
  });
  await scenario("clipboard ignores dismissal, overlays, active edits and late results after lock begins", async f => {
    document.hasFocus = () => true; document.hidden = false;
    f.settings.clipboardRecognition = true;
    f.state.clipboardCandidate = { sequence: 12, text: "账号:demo\n密码:SYNTHETIC", html: null, sourceUrl: null, sourceApp: null };
    const main = f.mount(f.MainView);
    main.settingsOpen = true; main.onClipboardFocus();
    assert.equal(f.state.clipboardReads, 0);
    main.settingsOpen = false;
    main.onClipboardFocus(); await until(() => !!main.clipboardRecognition);
    main.clearClipboardRecognition();
    main.onClipboardFocus(); await f.nextTick();
    assert.equal(main.clipboardRecognition, null);
    assert.equal(f.vault.entries.value.length, 0);
    f.vault.openCreateDrawer(); const drawer = f.mount(f.EntryDrawer);
    drawer.form.title = "Keep my edit";
    const reads = f.state.clipboardReads;
    main.onClipboardFocus(); await f.nextTick();
    assert.equal(f.state.clipboardReads, reads);
    assert.equal(drawer.form.title, "Keep my edit");
    f.vault.closeDrawer();
    const pending = gate(); f.state.clipboardGate = pending.promise;
    f.state.clipboardCandidate.sequence = 13;
    main.onClipboardFocus();
    const locking = f.vault.lock({ force: true });
    pending.release(); await locking; await f.nextTick();
    assert.equal(main.clipboardRecognition, null);
    assert.equal(main.clipboardDraft, null);
    assert.equal(f.vault.unlocked.value, false);
  });
  await scenario("editor guards discard, blocks double submit/close while saving, security lock bypasses", async f => {
    f.vault.openCreateDrawer();
    const drawer = f.mount(f.EntryDrawer);
    drawer.requestClose(); assert.equal(f.vault.drawer.value.open, false);
    f.vault.openCreateDrawer();
    drawer.form.title = "Unsaved draft";
    drawer.requestClose(); assert.equal(drawer.confirmDiscard, true);
    assert.equal(f.vault.drawer.value.open, true);
    drawer.confirmDiscard = false;
    const blocked = gate(); f.state.saveGate = blocked.promise;
    const save = drawer.submit();
    await until(() => f.state.snapshots.length > 0);
    drawer.requestClose(); await drawer.submit();
    assert.equal(f.vault.drawer.value.open, true);
    assert.equal(f.vault.entries.value.length, 1);
    blocked.release(); await save;
    assert.equal(f.vault.drawer.value.open, false);
    f.vault.openEditDrawer(f.vault.entries.value[0].uuid);
    const edit = f.mount(f.EntryDrawer); edit.form.password = "Synthetic pending";
    edit.requestClose(); assert.equal(edit.confirmDiscard, true);
    assert.equal(await f.vault.lock({ force: true }), true);
    assert.equal(f.vault.drawer.value.open, false);
    assert.equal(f.vault.unlocked.value, false);
    assert.ok(f.state.nativeCalls.includes("cancel_auto_type"));
    assert.ok(f.state.nativeCalls.includes("clear_secret_clipboard"));
  });
  await scenario("dialog traps Tab/Escape and restores trigger focus", async f => {
    const element = () => ({ isConnected: true, matches: () => false, closest: () => null, getClientRects: () => [1], focus() { document.activeElement = this; } });
    const trigger = element(), first = element(), last = element();
    const root = { ...element(), querySelectorAll: () => [first, last], contains: el => [first, last].includes(el) };
    document.activeElement = trigger;
    let escaped = 0;
    const component = f.defineComponent({ setup() { f.useDialogFocus(f.ref(root), () => escaped++); return () => null; } });
    const ui = f.mountControlled(component, {}); await f.nextTick();
    assert.equal(document.activeElement, first);
    const keydown = f.domListeners.get("keydown").at(-1);
    let prevented = 0;
    document.activeElement = last;
    keydown({ key: "Tab", preventDefault() { prevented++; } });
    assert.equal(document.activeElement, first);
    keydown({ key: "Tab", shiftKey: true, preventDefault() { prevented++; } });
    assert.equal(document.activeElement, last);
    keydown({ key: "Escape", preventDefault() {}, stopImmediatePropagation() {} });
    assert.equal(escaped, 1); assert.equal(prevented, 2);
    ui.unmount(); assert.equal(document.activeElement, trigger);
  });
  await scenario("Hello refusal does not read vault or clear cache and safe copy uses native TTL only", async f => {
    const loads = f.state.loads;
    f.settings.quickUnlock = true;
    await f.nextTick();
    await until(() => !f.vault.busy.value);
    f.state.nativeCalls.length = 0;
    for (const code of ["HELLO_NOT_VERIFIED", "HELLO_UNAVAILABLE"]) {
      f.state.helloError = code;
      assert.equal(await f.vault.helloUnlock("Synthetic.kdbx"), false);
      assert.match(f.vault.error.value, /主密码/);
    }
    assert.equal(f.state.loads, loads);
    assert.equal(f.state.nativeCalls.includes("hello_verify"), false);
    assert.equal(f.state.nativeCalls.includes("quick_unlock_clear"), false);
    assert.equal(await f.copyText("Synthetic only", 15000), true);
    assert.equal(f.state.copyArgs.at(-1).clearAfterMs, 15000);
    f.state.failCopy = true;
    assert.equal(await f.copyText("Synthetic only"), false);
    assert.equal(f.state.clipboardReads, 0);
  });

  await scenario("health report lists every issue and returns from editing with refreshed remaining work", async f => {
    const a = await f.vault.addEntry({ ...f.draft, title: "Issue A", username: "first", password: "abc", expires: true, expiryDate: "2000-01-01" });
    const b = await f.vault.addEntry({ ...f.draft, title: "Issue B", username: "second", password: "abc" });
    const trashed = await f.vault.addEntry({ ...f.draft, title: "Trashed", password: "abc" });
    await f.vault.removeEntry(trashed);
    const ui = f.mount(f.VaultReport);
    await until(() => !ui.loading);
    assert.deepEqual(ui.issueRows.map(row => row.id).sort(), [a, b].sort());
    assert.equal(ui.issueRows.find(row => row.id === a).duplicateCount, 2);
    assert.equal(JSON.stringify(ui.issueRows).includes('"password"'), false);
    ui.filter = "expired";
    assert.deepEqual(ui.visibleIssues.map(row => row.id), [a]);
    ui.filter = "duplicate";
    ui.search = "second";
    assert.deepEqual(ui.visibleIssues.map(row => row.id), [b]);
    ui.search = "";
    ui.processEntry(b);
    assert.equal(f.vault.drawer.value.uuid, b, "must open the chosen row, not the first match");
    const editB = f.mount(f.EntryDrawer);
    editB.form.password = "M7!qR2#vT9$kL4@xN8%pB6&z";
    f.state.failWrite = true;
    await editB.submit();
    assert.equal(f.vault.drawer.value.open, true);
    assert.match(editB.localError, /SIMULATED_WRITE_FAILURE/);
    assert.equal(f.vault.hasUnsavedChanges.value, true);
    f.state.failWrite = false;
    await editB.submit(); await f.nextTick();
    assert.equal(f.vault.drawer.value.open, false);
    assert.deepEqual(ui.issueRows.map(row => row.id), [a]);
    assert.equal(ui.health.duplicate.length, 0);
    ui.filter = "all";
    ui.processEntry(a);
    const editA = f.mount(f.EntryDrawer);
    editA.form.password = "V6@jD3!tW8#rC2$yF9%hQ5&n";
    editA.form.expires = false;
    await editA.submit(); await f.nextTick();
    assert.equal(ui.issueRows.length, 0);
    assert.equal(f.vault.hasUnsavedChanges.value, false);
  });
  await scenario("health issues remain usable on diagnostics failure and delayed refresh cannot survive locking", async f => {
    const id = await f.vault.addEntry({ ...f.draft, title: "Synthetic issue", password: "abc" });
    const ui = f.mount(f.VaultReport); await until(() => !ui.loading);
    f.state.diagnosticsFailure = true;
    await ui.refresh();
    assert.ok(ui.error);
    assert.deepEqual(ui.issueRows.map(row => row.id), [id]);
    ui.processEntry(id); assert.equal(f.vault.drawer.value.uuid, id);
    f.vault.closeDrawer(); await f.nextTick();
    assert.deepEqual(ui.issueRows.map(row => row.id), [id], "cancel does not resolve an issue");
    await f.vault.removeEntry(id);
    ui.processEntry(id);
    assert.equal(f.vault.drawer.value.open, false, "stale or trashed row cannot be edited");
    assert.equal(ui.issueRows.length, 0);
    f.state.diagnosticsFailure = false;
    const blocked = gate(); f.state.diagnosticsGate = blocked.promise;
    const refresh = ui.refresh();
    await f.vault.lock({ force: true }); await f.nextTick();
    blocked.release(); await refresh;
    assert.equal(ui.health, null);
    assert.equal(ui.stats, null);
    assert.equal(ui.issueRows.length, 0);
  });
  async function encryptedRemote(f, mutate = () => {}) {
    const current = f.state.db; current.setKdf(kdbxweb.Consts.KdfId.Aes);
    const bytes = await kdbxweb.Kdbx.prototype.save.call(current);
    const remote = await kdbxweb.Kdbx.load(bytes, current.credentials);
    mutate(remote);
    return Array.from(new Uint8Array(await remote.save()));
  }
  await scenario("WebDAV merges authenticated same-vault KDBX before uploading the saved local file", async f => {
    f.state.syncBytes = await encryptedRemote(f, remote => {
      const e = remote.createEntry(remote.getDefaultGroup()); e.fields.set("Title", "Remote synthetic");
    });
    await f.vault.addEntry({ ...f.draft, title: "Local synthetic" });
    const writes = f.state.writes.length;
    assert.equal(await f.vault.syncWebdav(), true);
    assert.ok(f.vault.entries.value.some(e => e.title === "Local synthetic"));
    assert.ok(f.vault.entries.value.some(e => e.title === "Remote synthetic"));
    assert.equal(f.state.commits.length, 1);
    assert.ok(f.state.commits[0].writes > writes, "merge must be successfully saved before commit");
    assert.deepEqual(Object.keys(f.state.commits[0].args).sort(), ["expectedStat", "token", "vaultPath"]);
    assert.equal(f.vault.webdavState.value.phase, "synced");
    f.vault.saveSoon();
    assert.equal(f.vault.webdavState.value.phase, "pending");
  });
  await scenario("WebDAV network and initial local-save failures never upload", async f => {
    f.state.prepareError = "WD_NETWORK";
    assert.equal(await f.vault.syncWebdav(), false);
    assert.equal(f.vault.webdavState.value.phase, "error");
    assert.match(f.vault.webdavState.value.message, /本地密码库仍可使用/);
    f.state.prepareError = null; f.state.failWrite = true;
    await f.vault.addEntry(f.draft);
    const prepares = f.state.nativeCalls.filter(n => n === "webdav_prepare_sync").length;
    assert.equal(await f.vault.syncWebdav(), false);
    assert.equal(f.state.nativeCalls.filter(n => n === "webdav_prepare_sync").length, prepares);
    assert.equal(f.state.commits.length, 0);
  });
  await scenario("WebDAV rejects different roots, changed public data and different credentials", async f => {
    for (const reason of ["root", "public", "key"]) {
      f.state.syncBytes = await encryptedRemote(f, remote => {
        if (reason === "root") remote.getDefaultGroup().uuid = kdbxweb.KdbxUuid.random();
        if (reason === "public") { remote.header.publicCustomData = new kdbxweb.VarDictionary(); remote.header.publicCustomData.set("foreign.key", kdbxweb.VarDictionary.ValueType.String, "changed"); }
        if (reason === "key") remote.credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("OTHER_SYNTHETIC_PASSWORD"));
      });
      const writes = f.state.writes.length;
      assert.equal(await f.vault.syncWebdav(), false, reason);
      assert.equal(f.vault.webdavState.value.phase, "conflict", reason);
      assert.equal(f.state.writes.length, writes, "rejected remote must not modify local file");
      assert.equal(f.state.commits.length, 0);
    }
  });
  await scenario("WebDAV merged-save failure retains dirty data and does not commit", async f => {
    f.state.syncBytes = await encryptedRemote(f, remote => { remote.createEntry(remote.getDefaultGroup()).fields.set("Title", "Remote retained"); });
    f.state.failWrite = true;
    assert.equal(await f.vault.syncWebdav(), false);
    assert.equal(f.state.commits.length, 0);
    assert.equal(f.vault.hasUnsavedChanges.value, true);
    assert.ok(f.vault.entries.value.some(e => e.title === "Remote retained"));
    assert.match(f.vault.webdavState.value.message, /未能全部保存/);
  });
  await scenario("WebDAV 412 is a conflict, not an automatic overwrite retry", async f => {
    f.state.commitError = "WD_REMOTE_CHANGED";
    assert.equal(await f.vault.syncWebdav(true), false);
    assert.equal(f.vault.webdavState.value.phase, "conflict");
    assert.equal(f.state.commits.length, 1);
    assert.equal(f.state.nativeCalls.filter(n => n === "webdav_prepare_sync").length, 1);
  });
  await scenario("WebDAV upload confirmation does not hide modifications made during upload", async f => {
    const blocked = gate(); f.state.commitGate = blocked.promise; f.state.metadataSaved = false;
    const sync = f.vault.syncWebdav(true);
    await until(() => f.state.commits.length === 1);
    f.vault.saveSoon(); blocked.release();
    assert.equal(await sync, true);
    assert.equal(f.vault.webdavState.value.phase, "pending");
    assert.equal(f.vault.hasUnsavedChanges.value, true);
    assert.match(f.vault.webdavState.value.message, /上传已确认，但本机同步时间/);
  });
  await scenario("locking invalidates delayed WebDAV download without decrypting or uploading it", async f => {
    f.state.syncBytes = await encryptedRemote(f);
    const blocked = gate(); f.state.prepareGate = blocked.promise;
    const sync = f.vault.syncWebdav();
    await until(() => f.state.nativeCalls.includes("webdav_prepare_sync"));
    const loads = f.state.loads;
    assert.equal(await f.vault.lock({ force: true }), true);
    blocked.release(); assert.equal(await sync, false);
    assert.equal(f.state.loads, loads);
    assert.equal(f.state.commits.length, 0);
    assert.equal(f.vault.busy.value, false);
    assert.equal(f.vault.entries.value.length, 0);
  });
  await scenario("WebDAV settings keep secrets out of browser storage and clear password after save and lock", async f => {
    const writes = []; globalThis.localStorage.setItem = (...args) => writes.push(args);
    const ui = f.mount(f.WebdavSettings);
    await until(() => ui.loaded);
    ui.url = "https://example.invalid/synthetic.kdbx"; ui.username = "SYNTHETIC_USER"; ui.password = "SYNTHETIC_SECRET";
    assert.equal(ui.dirty, true);
    await ui.action("save");
    assert.equal(ui.password, ""); assert.equal(ui.dirty, false); assert.equal(writes.length, 0);
    await ui.action("test"); assert.match(ui.message, /尚未解密/);
    ui.password = "UNSAVED_SYNTHETIC_SECRET";
    await f.vault.lock({ force: true });
    assert.equal(ui.password, ""); assert.equal(ui.url, ""); assert.equal(writes.length, 0);
  });
  await scenario("WebDAV read-only diagnostics explain validator limitations without decrypting or uploading", async f => {
    const ui = f.mount(f.WebdavSettings); await until(() => ui.loaded);
    ui.url = "https://example.invalid/synthetic.kdbx"; ui.username = "SYNTHETIC"; ui.password = "SYNTHETIC_ONLY";
    await ui.action("save");
    const loads = f.state.loads;
    for (const [etagStatus, expected] of [["missing", /GET 未返回 ETag/], ["weak", /只返回弱 ETag/], ["invalid", /格式不符合强校验/], ["strong", /尚未解密、合并或上传/], [undefined, /未返回完整的 ETag 诊断/]]) {
      f.state.connectionResult = { exists: true, etagStatus }; await ui.action("test"); assert.match(ui.message, expected);
    }
    f.state.connectionResult = { exists: false, etagStatus: "not-checked" }; await ui.action("test"); assert.match(ui.message, /目标文件不存在/);
    assert.equal(f.state.loads, loads); assert.equal(f.state.commits.length, 0); assert.ok(!f.state.nativeCalls.includes("webdav_prepare_sync"));
  });
  await scenario("Nutstore compatibility is reported without claiming a completed sync and disables create-only", async f => {
    const ui = f.mount(f.WebdavSettings); await until(() => ui.loaded);
    ui.url = "https://dav.jianguoyun.com/dav/KeyTree/synthetic.kdbx"; ui.username = "SYNTHETIC"; ui.password = "SYNTHETIC_ONLY";
    await ui.action("save"); assert.equal(ui.isNutstore, true);
    f.state.connectionResult = { exists: true, etagStatus: "nutstore-compatible" }; await ui.action("test");
    assert.match(ui.message, /已识别坚果云版本标识/); assert.match(ui.message, /尚未解密、合并或上传/);
    assert.equal(f.vault.webdavState.value.phase, "unchecked"); assert.equal(f.state.commits.length, 0);
    ui.allowCreate = true; await ui.action("sync");
    assert.equal(f.state.commits.length, 0, "UI must not authorize creating on Nutstore even with stale checkbox state");
    assert.match(f.vault.webdavState.value.message, /远端文件不存在/);
  });
  function snapshotItem(id = "snapshot-1000000000-1.kdbx") {
    return { id, createdAt: 1000, size: 128, stat: { mtimeMs: 1, size: 128, mtimeNs: "100" } };
  }
  await scenario("snapshot preview compares authenticated same-vault data without changing the current vault and exports only a new copy", async f => {
    await f.vault.addEntry({ ...f.draft, title: "Shared", password: "SYNTHETIC_PASSWORD_A" });
    await f.vault.addEntry({ ...f.draft, title: "Unchanged" });
    f.state.snapshotBytes = await encryptedRemote(f, remote => {
      const shared = [...remote.getDefaultGroup().allEntries()].find(e => e.fields.get("Title") === "Shared");
      shared.fields.set("Password", kdbxweb.ProtectedValue.fromString("SYNTHETIC_PASSWORD_B"));
      remote.createEntry(remote.getDefaultGroup()).fields.set("Title", "Snapshot-only");
    });
    await f.vault.addEntry({ ...f.draft, title: "Current-only" });
    const item = snapshotItem(); f.state.snapshotItems = [item];
    const before = JSON.stringify(f.vault.entries.value), path = f.vault.vaultPath.value, writes = f.state.writes.length;
    assert.equal(await f.vault.previewBackupSnapshot(item), true);
    assert.deepEqual(f.vault.snapshotPreview.value.summary, { currentEntries: 3, snapshotEntries: 3, added: 1, removed: 1, changed: 1, currentGroups: 2, snapshotGroups: 2 });
    assert.equal(JSON.stringify(f.vault.entries.value), before); assert.equal(f.state.writes.length, writes);
    assert.equal(f.vault.hasUnsavedChanges.value, false);
    assert.ok(!JSON.stringify(f.vault.snapshotPreview.value).includes("SYNTHETIC_PASSWORD"));
    assert.equal(await f.vault.exportBackupSnapshot("SYNTHETIC_RESTORED_NEW.kdbx"), true);
    assert.equal(f.state.snapshotCreates.length, 1, "current saved version must be preserved before recovery export");
    assert.equal(f.state.snapshotExports.length, 1); assert.equal(f.state.snapshotExports[0].id, item.id);
    assert.equal(f.vault.vaultPath.value, path); assert.equal(JSON.stringify(f.vault.entries.value), before);
    assert.ok(!f.state.nativeCalls.includes("snapshot_create"), "export must preserve the selected version inside one native operation");
    assert.deepEqual(f.state.snapshotExports[0].currentStat, f.state.stat);
    assert.ok(!f.state.nativeCalls.includes("webdav_commit_sync"));
  });
  await scenario("snapshot preview refuses different roots, credentials and invalid encrypted files", async f => {
    const item = snapshotItem(); f.state.snapshotItems = [item];
    for (const kind of ["root", "key", "invalid"]) {
      f.state.snapshotBytes = kind === "invalid" ? [1, 2, 3] : await encryptedRemote(f, remote => {
        if (kind === "root") remote.getDefaultGroup().uuid = kdbxweb.KdbxUuid.random();
        else remote.credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("OTHER_SYNTHETIC_KEY"));
      });
      assert.equal(await f.vault.previewBackupSnapshot(item), false, kind);
      assert.equal(f.vault.snapshotPreview.value, null);
      assert.equal(await f.vault.exportBackupSnapshot("MUST_NOT_EXIST.kdbx"), false);
      assert.equal(f.state.snapshotExports.length, 0);
    }
  });
  await scenario("failed current save stops snapshot preview and manual backup before any native archive or export", async f => {
    f.state.failWrite = true; await f.vault.addEntry(f.draft);
    assert.equal(await f.vault.previewBackupSnapshot(snapshotItem()), false);
    assert.match(f.vault.snapshotError.value, /未能全部保存/);
    assert.equal(await f.vault.createBackupSnapshot(), false);
    assert.ok(!f.state.nativeCalls.includes("snapshot_read")); assert.ok(!f.state.nativeCalls.includes("snapshot_create"));
    assert.equal(f.state.snapshotExports.length, 0);
  });
  await scenario("locking cancels a delayed snapshot read without decrypting or publishing a preview", async f => {
    const item = snapshotItem(); f.state.snapshotItems = [item]; f.state.snapshotBytes = await encryptedRemote(f);
    const blocked = gate(); f.state.snapshotReadGate = blocked.promise;
    const pending = f.vault.previewBackupSnapshot(item);
    await until(() => f.state.nativeCalls.includes("snapshot_read")); const loads = f.state.loads;
    assert.equal(await f.vault.lock({ force: true }), true);
    blocked.release(); assert.equal(await pending, false);
    assert.equal(f.state.loads, loads); assert.equal(f.vault.snapshotPreview.value, null);
    assert.equal(f.vault.busy.value, false); assert.equal(f.state.snapshotExports.length, 0);
  });
  await scenario("local modifications invalidate snapshot authorization and changed snapshots fail closed", async f => {
    const item = snapshotItem(); f.state.snapshotItems = [item]; f.state.snapshotBytes = await encryptedRemote(f);
    assert.equal(await f.vault.previewBackupSnapshot(item), true);
    f.vault.saveSoon(); assert.equal(f.vault.snapshotPreview.value, null);
    assert.equal(await f.vault.exportBackupSnapshot("NO_STALE_EXPORT.kdbx"), false);
    assert.equal(f.state.snapshotCreates.length, 0); assert.equal(f.state.snapshotExports.length, 0);
    f.state.snapshotReadError = "SNAP_CHANGED";
    assert.equal(await f.vault.previewBackupSnapshot(item), false); assert.match(f.vault.snapshotError.value, /版本已变化/);
  });
  await scenario("snapshot recovery dialog cancellation writes nothing and existing targets do not report success", async f => {
    const item = snapshotItem(); f.state.snapshotItems = [item]; f.state.snapshotBytes = await encryptedRemote(f);
    const ui = f.mount(f.BackupSnapshots); await until(() => ui.loaded && !ui.working);
    await ui.preview(item); assert.ok(f.vault.snapshotPreview.value);
    f.state.dialogSaveTarget = null; await ui.recover();
    assert.equal(f.state.snapshotCreates.length, 0); assert.equal(f.state.snapshotExports.length, 0);
    f.state.dialogSaveTarget = "ALREADY_EXISTS.kdbx"; f.state.snapshotExportError = "SNAP_TARGET_EXISTS";
    await ui.recover(); assert.match(f.vault.snapshotError.value, /目标文件已存在/); assert.ok(!ui.message.includes("已导出"));
    f.state.dialogSaveTarget = "SYNTHETIC_NEW_COPY.kdbx"; f.state.snapshotExportError = null;
    await ui.recover(); assert.equal(f.state.snapshotExports.length, 1); assert.match(ui.message, /当前库未被替换/);
    assert.equal(f.vault.unlocked.value, true);
  });
  await scenario("quick sync opens configuration when needed, respects overlays and drafts, and reuses guarded synchronization", async f => {
    let opened = 0; const ui = f.mountControlled(f.SyncQuickBar, { blocked: false, onConfigure: () => opened++ });
    await until(() => !f.vault.webdavAvailability.value.loading);
    await ui.state.run(); assert.equal(opened, 1); assert.ok(!f.state.nativeCalls.includes("webdav_prepare_sync"));
    f.vault.setWebdavConfigSummary({ configured: true, url: "https://example.invalid/synthetic.kdbx", username: "SYNTHETIC", hasPassword: true, lastSyncedAt: 500 });
    assert.equal(ui.state.lastUpload, 500); assert.equal(f.vault.webdavState.value.phase, "unchecked");
    f.vault.openCreateDrawer(); await ui.state.run(); assert.ok(!f.state.nativeCalls.includes("webdav_prepare_sync")); f.vault.closeDrawer();
    ui.props.blocked = true; await f.nextTick(); await ui.state.run(); assert.ok(!f.state.nativeCalls.includes("webdav_prepare_sync"));
    ui.props.blocked = false; await f.nextTick(); f.state.syncBytes = await encryptedRemote(f);
    await ui.state.run(); assert.equal(f.state.commits.length, 1); assert.equal(f.vault.webdavState.value.phase, "synced");
    f.state.prepareError = "WD_NETWORK"; await ui.state.run(); assert.equal(ui.state.label, "重试同步");
  });
  for (const reason of ["lock", "suspend"]) {
    await scenario(`system ${reason} clears state and surfaces failed save`, async f => {
      f.state.failWrite = true;
      await f.vault.addEntry(f.draft);
      f.mount(f.defineComponent({ setup() { f.useSystemGuard(); return () => null; } }));
      await until(() => f.state.listeners.has("keytree:system-lock"));
      f.state.listeners.get("keytree:system-lock")({ payload: reason });
      await until(() => !f.vault.unlocked.value);
      await until(() => /未能保存/.test(f.toastText.value));
      assert.match(f.vault.error.value, /未能保存/);
    });
  }
  await scenario("tray lock cancels on save failure instead of reporting success", async f => {
    f.state.failWrite = true;
    await f.vault.addEntry(f.draft);
    f.mount(f.defineComponent({ setup() { f.useSystemGuard(); return () => null; } }));
    await until(() => f.state.listeners.has("keytree:tray-lock"));
    const attempts = f.state.writes.length;
    f.state.listeners.get("keytree:tray-lock")({});
    await until(() => f.state.writes.length > attempts);
    await until(() => /SIMULATED_WRITE_FAILURE/.test(f.toastText.value));
    assert.equal(f.vault.unlocked.value, true);
    assert.equal(f.vault.entries.value.length, 1);
  });
  await scenario("security lock still clears decrypted state on disk failure and keeps an explicit warning", async f => {
    f.state.failWrite = true;
    await f.vault.addEntry(f.draft);
    assert.equal(await f.vault.lock({ force: true }), true);
    assert.equal(f.vault.unlocked.value, false);
    assert.equal(f.vault.entries.value.length, 0);
    assert.match(f.vault.error.value, /未.*(保存|写入)|保存失败/);
    assert.ok(f.state.writes.length >= 2, "security lock also retries dirty data before clearing");
    assert.equal(f.timers.size, 0);
  });
} finally {
  delete globalThis.__keytreeSaveTest;
  await rm(output, { recursive: true, force: true });
}
