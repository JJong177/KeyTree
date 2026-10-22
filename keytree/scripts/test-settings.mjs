// Regression: preserve pre-rebrand settings without writing to the legacy key.
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
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "keytree-settings-test-"));
const output = join(directory, "settings.mjs");
const currentKey = "keytree.settings.v1";
// Historical key is intentionally kept for existing users, not a current brand name.
const legacyKey = "keylite.settings.v1";
const originalStorage = globalThis.localStorage;
let fixtureId = 0;

async function fixture(values) {
  const data = new Map(Object.entries(values));
  const writes = [];
  globalThis.localStorage = {
    getItem(key) { return data.get(key) ?? null; },
    setItem(key, value) { writes.push(key); data.set(key, value); },
  };
  const module = await import(`${pathToFileURL(output).href}?fixture=${++fixtureId}`);
  return { ...module, data, writes };
}

try {
  await build({
    stdin: {
      contents: "export { settings } from './src/lib/settings'; export { nextTick } from 'vue';",
      resolveDir: project, loader: "ts",
    },
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
  });

  await test("loads the historical settings key and writes changes only to the KeyTree key", async () => {
    const old = JSON.stringify({ autoLockMinutes: 5, clipboardSeconds: 60, quickUnlock: false, lastVaultPath: "C:\\demo\\vault.kdbx" });
    const { settings, nextTick, data, writes } = await fixture({ [legacyKey]: old });
    assert.equal(settings.autoLockMinutes, 5);
    assert.equal(settings.clipboardSeconds, 60);
    assert.equal(settings.quickUnlock, false);
    assert.equal(settings.lastVaultPath, "C:\\demo\\vault.kdbx");
    settings.autoLockMinutes = 15;
    await nextTick();
    assert.equal(JSON.parse(data.get(currentKey)).autoLockMinutes, 15);
    assert.equal(data.get(legacyKey), old);
    assert.deepEqual(writes, [currentKey]);
  });

  await test("prefers KeyTree settings when both keys exist", async () => {
    const { settings } = await fixture({ [currentKey]: JSON.stringify({ autoLockMinutes: 30 }), [legacyKey]: JSON.stringify({ autoLockMinutes: 5 }) });
    assert.equal(settings.autoLockMinutes, 30);
  });

  await test("uses safe defaults without stored settings", async () => {
    const { settings } = await fixture({});
    assert.equal(settings.autoLockMinutes, 10);
    assert.equal(settings.clipboardSeconds, 30);
    assert.deepEqual([...settings.vaults], []);
  });

  await test("falls back to defaults on malformed settings", async () => {
    const { settings } = await fixture({ [currentKey]: "{invalid" });
    assert.equal(settings.autoLockMinutes, 10);
    assert.equal(settings.genLength, 20);
  });
} finally {
  if (originalStorage === undefined) delete globalThis.localStorage;
  else globalThis.localStorage = originalStorage;
  await rm(directory, { recursive: true, force: true });
}
