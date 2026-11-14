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
const scratch = process.env.PI_SCRATCH_DIR || tmpdir();
const directory = await mkdtemp(join(scratch, "keytree-updates-"));
try {
  const output = join(directory, "updates.mjs");
  await build({
    entryPoints: [resolve(project, "src/lib/updates.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
    plugins: [{
      name: "inert-tauri-update-test-stubs",
      setup(builder) {
        builder.onResolve({ filter: /^@tauri-apps\/api\/app$/ }, () => ({ path: "app", namespace: "update-test" }));
        builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "core", namespace: "update-test" }));
        builder.onResolve({ filter: /^@tauri-apps\/plugin-http$/ }, () => ({ path: "http", namespace: "update-test" }));
        builder.onLoad({ filter: /.*/, namespace: "update-test" }, ({ path }) => {
          if (path === "app") return { contents: "export async function getVersion(){globalThis.__updateNativeVersionCalls=(globalThis.__updateNativeVersionCalls||0)+1;return '0.2.0'}", loader: "js" };
          if (path === "http") return { contents: "export async function fetch(){globalThis.__updateNativeFetchCalls=(globalThis.__updateNativeFetchCalls||0)+1;throw new Error('unexpected native fetch')}", loader: "js" };
          return { contents: "export async function invoke(){globalThis.__updateNativeOpenCalls=(globalThis.__updateNativeOpenCalls||0)+1}", loader: "js" };
        });
      },
    }],
  });
  globalThis.__updateNativeVersionCalls = 0;
  globalThis.__updateNativeFetchCalls = 0;
  globalThis.__updateNativeOpenCalls = 0;
  const updates = await import(pathToFileURL(output).href);
  assert.equal(globalThis.__updateNativeVersionCalls, 0);
  assert.equal(globalThis.__updateNativeFetchCalls, 0);
  assert.equal(globalThis.__updateNativeOpenCalls, 0);
  const { createUpdateService, useUpdates, parseVersion, compareVersions, parseRelease } = updates;
  const release = (tag = "v0.3.0", overrides = {}) => ({
    draft: false,
    prerelease: false,
    tag_name: tag,
    name: "KeyTree update",
    body: "Improvements and fixes",
    html_url: `https://github.com/JJong177/KeyTree/releases/tag/${encodeURIComponent(tag)}`,
    assets: [{ name: "KeyTree-Setup.exe", browser_download_url: `https://github.com/JJong177/KeyTree/releases/download/${encodeURIComponent(tag)}/KeyTree-Setup.exe` }],
    ...overrides,
  });
  const response = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
  const memoryStorage = (initial = null) => {
    const values = new Map();
    if (initial !== null) values.set("keytree.updates.v1", initial);
    return {
      values,
      reads: 0,
      writes: 0,
      getItem(key) { this.reads += 1; return values.get(key) ?? null; },
      setItem(key, value) { this.writes += 1; values.set(key, value); },
    };
  };
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const BASE_TIME = 1_800_000_000_000;

  await test("elapsed successful requests and Unicode notes restore across restart without another automatic request", async () => {
    const storage = memoryStorage();
    let now = BASE_TIME, requests = 0;
    const options = { getVersion: async () => "0.2.0", storage, now: () => now,
      fetch: async () => { requests++; now += 750; return response(release("v0.3.0", { name: "🌳".repeat(256), body: "🌳".repeat(12_000) })); } };
    const first = createUpdateService(options);
    await first.check();
    assert.equal(first.state.checkedAt, BASE_TIME + 750);
    const restarted = createUpdateService(options);
    await restarted.initialize();
    assert.equal(restarted.state.status, "available");
    assert.equal(restarted.state.release.notes, "🌳".repeat(12_000));
    await restarted.check();
    assert.equal(requests, 1);
    assert.equal(restarted.hasUpdate.value, true);
  });

  await test("GitHub secondary 403 rate limits respect Retry-After even with remaining quota", async () => {
    let now = BASE_TIME, requests = 0;
    const storage = memoryStorage();
    const options = { getVersion: async () => "0.2.0", storage, now: () => now,
      fetch: async () => { requests++; return response({}, 403, { "retry-after": "120", "x-ratelimit-remaining": "59" }); } };
    const first = createUpdateService(options);
    await first.check();
    assert.match(first.state.error, /限流/);
    await first.check({ force: true });
    const restarted = createUpdateService(options);
    await restarted.check({ force: true });
    assert.equal(requests, 1);
    now += 120_001;
    await restarted.check({ force: true });
    assert.equal(requests, 2);
  });

  await test("strict safe version parsing and semver precedence", () => {
    assert.equal(parseVersion("v0.2.0").version, "0.2.0");
    assert.equal(parseVersion("1.2").version, "1.2.0");
    assert.equal(parseVersion("1.2.3+build.42").version, "1.2.3");
    assert.equal(compareVersions("0.9.0", "0.10.0"), -1);
    assert.equal(compareVersions("1.2.3", "v1.2.3+different"), 0);
    assert.equal(compareVersions("1.2.3-rc.2", "1.2.3-rc.10"), -1);
    assert.equal(compareVersions("1.2.3-rc.1", "1.2.3-rc.alpha"), -1);
    assert.equal(compareVersions("1.2.3-rc.1", "1.2.3"), -1);
    assert.equal(compareVersions("1.2.3", "1.2.3-rc.9"), 1);
    for (const invalid of ["", " 1.2.3", "1.2.3 ", "v", "1", "01.2.3", "1.02.3", "1.2.03", "1.2.3-01", "1.2.3+", "1.2.3-.", "9007199254740992.0.0", "1.2.3.4"]) {
      assert.equal(parseVersion(invalid), null, invalid);
    }
    assert.equal(compareVersions("bad", "1.0.0"), null);
  });

  await test("release validation requires a formal stable release and exact trusted URLs", () => {
    const parsed = parseRelease(release("v0.10.0", { body: "<b>Safe</b> [notes](https://evil.test)\n\nMore" }));
    assert.equal(parsed.version, "0.10.0");
    assert.equal(parsed.pageUrl, "https://github.com/JJong177/KeyTree/releases/tag/v0.10.0");
    assert.equal(parsed.downloadUrl, "https://github.com/JJong177/KeyTree/releases/download/v0.10.0/KeyTree-Setup.exe");
    assert.equal(parsed.notes.includes("<b>"), false);
    assert.equal(parsed.notes.includes("https://evil.test"), false);
    assert.equal(parsed.notes.includes("[notes]"), false);
    assert.equal(parsedReleaseWithoutAsset().downloadUrl, null);

    for (const bad of [
      release("v1.0.0", { draft: true }),
      release("v1.0.0", { prerelease: true }),
      release("v1.0.0-rc.1"),
      release("not-a-version"),
      release("v1.0.0", { html_url: "https://evil.test/JJong177/KeyTree/releases/tag/v1.0.0" }),
      release("v1.0.0", { html_url: "https://user@github.com/JJong177/KeyTree/releases/tag/v1.0.0" }),
      release("v1.0.0", { html_url: "https://github.com/JJong177/KeyTree/releases/tag/v1.0.0?token=x" }),
      release("v1.0.0", { html_url: "https://github.com:444/JJong177/KeyTree/releases/tag/v1.0.0" }),
      release("v1.0.0", { html_url: "https://github.com/other/repo/releases/tag/v1.0.0" }),
    ]) assert.equal(parseRelease(bad), null);

    const wrongAsset = parseRelease(release("v1.0.0", { assets: [{ name: "KeyTree-Setup.exe", browser_download_url: "https://evil.test/installer.exe" }] }));
    assert.equal(wrongAsset.downloadUrl, null);
    const hugeNotes = parseRelease(release("v1.0.0", { body: "x".repeat(20_000) }));
    assert.equal(hugeNotes.notes.length, 12_000);
    const longName = parseRelease(release("v1.0.0", { name: "n".repeat(400) }));
    assert.equal(longName.name.length, 256);
  });

  function parsedReleaseWithoutAsset() {
    return parseRelease(release("v0.3.0", { assets: [] }));
  }

  await test("cold module import and factory construction perform no native, cache, or network I/O", async () => {
    globalThis.__updateNativeVersionCalls = 0;
    globalThis.__updateNativeFetchCalls = 0;
    globalThis.__updateNativeOpenCalls = 0;
    const storage = memoryStorage();
    const service = createUpdateService({ storage });
    assert.equal(service.state.status, "unchecked");
    assert.equal(storage.reads, 0);
    assert.equal(storage.writes, 0);
    assert.equal(globalThis.__updateNativeVersionCalls, 0);
    assert.equal(globalThis.__updateNativeFetchCalls, 0);
    assert.equal(globalThis.__updateNativeOpenCalls, 0);
    assert.equal(useUpdates(), useUpdates());
    assert.equal(globalThis.__updateNativeVersionCalls, 0);
    assert.equal(globalThis.__updateNativeFetchCalls, 0);
  });

  await test("initialize reads version/cache only, while check uses fixed public GitHub request safeguards", async () => {
    const storage = memoryStorage();
    let fetchCalls = 0;
    let requestUrl;
    let requestInit;
    const service = createUpdateService({
      getVersion: async () => "v0.2.0+build.5",
      storage,
      now: () => BASE_TIME,
      fetch: async (url, init) => {
        fetchCalls += 1;
        requestUrl = url;
        requestInit = init;
        return response(release());
      },
    });
    await service.initialize();
    assert.equal(service.state.currentVersion, "0.2.0");
    assert.equal(service.state.status, "unchecked");
    assert.equal(fetchCalls, 0);
    assert.equal(storage.reads, 1);
    await service.check();
    assert.equal(fetchCalls, 1);
    assert.equal(requestUrl, "https://api.github.com/repos/JJong177/KeyTree/releases/latest");
    assert.equal(requestInit.method, "GET");
    assert.equal(requestInit.headers.Accept, "application/vnd.github+json");
    assert.equal(requestInit.headers["X-GitHub-Api-Version"], "2022-11-28");
    assert.equal(requestInit.headers["User-Agent"], "KeyTree-update-check");
    assert.equal(requestInit.credentials, "omit");
    assert.equal(requestInit.referrer, "");
    assert.equal(requestInit.referrerPolicy, "no-referrer");
    assert.equal(requestInit.redirect, "error");
    assert.equal(requestInit.maxRedirections, 0);
    assert.equal(requestInit.signal.aborted, false);
    assert.equal(service.state.status, "available");
    assert.equal(service.hasUpdate.value, true);
    assert.equal(service.state.checkedAt, BASE_TIME);
    assert.equal(storage.values.has("keytree.updates.v1"), true);
    assert.deepEqual([...storage.values.keys()], ["keytree.updates.v1"]);
  });

  await test("version read failures and invalid versions are unavailable, retryable, and never call the API", async () => {
    let versions = 0;
    let requests = 0;
    const service = createUpdateService({
      getVersion: async () => { versions += 1; if (versions === 1) throw new Error("sensitive native detail"); return versions === 2 ? "not-version" : "0.2.0"; },
      fetch: async () => { requests += 1; return response(release()); },
      storage: memoryStorage(),
    });
    await service.initialize();
    assert.equal(service.state.status, "unavailable");
    assert.equal(service.state.currentVersion, null);
    assert.equal(service.state.error.includes("sensitive"), false);
    await service.initialize();
    assert.equal(versions, 2);
    await service.initialize();
    assert.equal(versions, 3);
    assert.equal(service.state.status, "unchecked", "a successful retry clears the prior unavailable status");
    assert.equal(service.state.currentVersion, "0.2.0");
    assert.equal(requests, 0);
    let invalidRequests = 0;
    const invalidCheck = createUpdateService({
      getVersion: async () => "0.0.0.0",
      fetch: async () => { invalidRequests += 1; return response(release()); },
      storage: memoryStorage(),
    });
    await invalidCheck.check();
    assert.equal(invalidCheck.state.status, "unavailable");
    assert.equal(invalidRequests, 0);
  });

  await test("concurrent checks share one request and latest-not-newer is current", async () => {
    const gate = deferred();
    let requests = 0;
    const service = createUpdateService({
      getVersion: async () => "0.3.0",
      storage: memoryStorage(),
      now: () => BASE_TIME,
      fetch: async () => { requests += 1; return gate.promise; },
    });
    const first = service.check();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = service.check({ force: true });
    assert.equal(requests, 1);
    gate.resolve(response(release("v0.3.0")));
    await Promise.all([first, second]);
    assert.equal(requests, 1);
    assert.equal(service.state.status, "current");
    assert.equal(service.hasUpdate.value, false);
  });

  await test("automatic checks persist 24-hour throttling, manual checks bypass it, and app-version changes recheck", async () => {
    const storage = memoryStorage();
    let clock = BASE_TIME;
    let currentVersion = "0.2.0";
    let requests = 0;
    const makeService = () => createUpdateService({
      getVersion: async () => currentVersion,
      storage,
      now: () => clock,
      fetch: async () => { requests += 1; return response(release("v0.3.0")); },
    });
    const first = makeService();
    await first.check();
    assert.equal(requests, 1);

    const restarted = makeService();
    await restarted.initialize();
    assert.equal(restarted.hasUpdate.value, true);
    await restarted.check();
    assert.equal(requests, 1);
    await restarted.check({ force: true });
    assert.equal(requests, 2);

    clock += 24 * 60 * 60 * 1000 + 1;
    await makeService().check();
    assert.equal(requests, 3);

    currentVersion = "0.3.0";
    const upgraded = makeService();
    await upgraded.initialize();
    assert.equal(upgraded.state.currentVersion, "0.3.0");
    assert.equal(upgraded.hasUpdate.value, false);
    assert.equal(upgraded.state.status, "current");
    await upgraded.check();
    assert.equal(requests, 4, "application version changes bypass an earlier version's automatic throttle");
  });

  await test("failed refresh preserves known update and successful checkedAt; failed attempts throttle across restart", async () => {
    const storage = memoryStorage();
    let clock = BASE_TIME;
    let requests = 0;
    let fail = false;
    const options = {
      getVersion: async () => "0.2.0",
      storage,
      now: () => clock,
      fetch: async () => {
        requests += 1;
        if (fail) throw new Error("remote body with secret token");
        return response(release("v0.4.0"));
      },
    };
    const service = createUpdateService(options);
    await service.check();
    const successfulAt = service.state.checkedAt;
    clock += 60 * 60 * 1000;
    fail = true;
    await service.check({ force: true });
    assert.equal(service.state.status, "failed");
    assert.equal(service.state.error.includes("secret"), false);
    assert.equal(service.state.checkedAt, successfulAt);
    assert.equal(service.hasUpdate.value, true);

    const saved = JSON.parse(storage.values.get("keytree.updates.v1"));
    assert.equal(saved.lastAttemptAt, clock);
    assert.equal(saved.checkedAt, successfulAt);
    assert.equal(saved.lastFailure, "network");
    const restarted = createUpdateService(options);
    await restarted.initialize();
    assert.equal(restarted.state.status, "failed");
    assert.equal(restarted.hasUpdate.value, true);
    await restarted.check();
    assert.equal(requests, 2, "the failed attempt, not successful checkedAt, gates automatic retry");
    await restarted.check({ force: true });
    assert.equal(requests, 3);
    assert.equal(restarted.state.checkedAt, successfulAt, "a repeated failure is not recorded as a successful check");
  });

  await test("corrupt, future-dated, and malicious cache entries are ignored and safely rechecked", async () => {
    const invalidCaches = [
      "{not json",
      JSON.stringify({ schema: 1, applicationVersion: "0.2.0", lastAttemptAt: BASE_TIME + 10, checkedAt: BASE_TIME + 10, release: null, lastFailure: null, backoffUntil: null }),
      JSON.stringify({ schema: 1, applicationVersion: "0.2.0", lastAttemptAt: BASE_TIME, checkedAt: BASE_TIME, release: null, lastFailure: null, backoffUntil: null }),
      JSON.stringify({ schema: 1, applicationVersion: "0.2.0", lastAttemptAt: BASE_TIME, checkedAt: BASE_TIME, release: { tag: "v9.0.0", version: "9.0.0", name: "", notes: "", pageUrl: "https://evil.test/", downloadUrl: null }, lastFailure: null, backoffUntil: null }),
    ];
    for (const raw of invalidCaches) {
      let requests = 0;
      const storage = memoryStorage(raw);
      const service = createUpdateService({
        getVersion: async () => "0.2.0",
        storage,
        now: () => BASE_TIME,
        fetch: async () => { requests += 1; return response(release("v0.3.0")); },
      });
      await service.initialize();
      assert.equal(service.hasUpdate.value, false);
      await service.check();
      assert.equal(requests, 1);
      assert.equal(service.state.status, "available");
    }
  });

  await test("rate limits use safe messages and explicit backoff blocks even forced requests", async () => {
    let clock = BASE_TIME;
    let requests = 0;
    const storage = memoryStorage();
    const service = createUpdateService({
      getVersion: async () => "0.2.0",
      storage,
      now: () => clock,
      fetch: async () => {
        requests += 1;
        return requests === 1
          ? response({ message: "private remote details" }, 403, { "x-ratelimit-remaining": "0", "retry-after": "120" })
          : response(release());
      },
    });
    await service.check();
    assert.equal(service.state.status, "failed");
    assert.match(service.state.error, /限流/);
    assert.equal(service.state.error.includes("private"), false);
    await service.check({ force: true });
    assert.equal(requests, 1);
    clock += 121_000;
    await service.check({ force: true });
    assert.equal(requests, 2);
    assert.equal(service.state.status, "available");
  });

  await test("total timeout terminates a fetch that ignores AbortSignal", async () => {
    let signal;
    const service = createUpdateService({
      getVersion: async () => "0.2.0",
      storage: memoryStorage(),
      timeoutMs: 20,
      fetch: async (_url, init) => { signal = init.signal; return new Promise(() => {}); },
    });
    const started = Date.now();
    await service.check();
    assert.equal(signal.aborted, true);
    assert.equal(service.state.status, "failed");
    assert.match(service.state.error, /超时/);
    assert.ok(Date.now() - started < 1_000);
  });

  await test("total timeout cancels a body stream that never produces bytes", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const service = createUpdateService({
      getVersion: async () => "0.2.0",
      storage: memoryStorage(),
      timeoutMs: 20,
      fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
    });
    await service.check();
    assert.equal(cancelled, true);
    assert.equal(service.state.status, "failed");
  });

  await test("streamed response bytes are capped without Content-Length and cancel overflow", async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(7)); },
      cancel() { cancelled = true; },
    });
    const service = createUpdateService({
      getVersion: async () => "0.2.0",
      storage: memoryStorage(),
      maxBytes: 10,
      fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
    });
    await service.check();
    assert.equal(service.state.status, "failed");
    assert.equal(cancelled, true);
    assert.ok(pulls <= 3);
  });

  await test("only JSON and a matching response URL are accepted; non-OK bodies are cancelled", async () => {
    for (const fetch of [
      async () => new Response("<h1>secret</h1>", { headers: { "content-type": "text/html" } }),
      async () => new Response("secret", { status: 500, headers: { "content-type": "application/json" } }),
      async () => {
        const result = response(release());
        Object.defineProperty(result, "url", { value: "https://evil.test/releases/latest" });
        return result;
      },
    ]) {
      const service = createUpdateService({ getVersion: async () => "0.2.0", storage: memoryStorage(), fetch });
      await service.check();
      assert.equal(service.state.status, "failed");
      assert.equal(service.state.error.includes("secret"), false);
    }
  });

  await test("openers revalidate current state and trusted release/asset URLs; no asset is fetched", async () => {
    const opened = [];
    let fetchCalls = 0;
    const service = createUpdateService({
      getVersion: async () => "0.2.0",
      storage: memoryStorage(),
      fetch: async () => { fetchCalls += 1; return response(release("v0.3.0")); },
      openUrl: async (url) => { opened.push(url); },
    });
    await service.check();
    assert.equal(await service.openRelease(), true);
    assert.equal(await service.openDownload(), true);
    assert.deepEqual(opened, [
      "https://github.com/JJong177/KeyTree/releases/tag/v0.3.0",
      "https://github.com/JJong177/KeyTree/releases/download/v0.3.0/KeyTree-Setup.exe",
    ]);
    assert.equal(fetchCalls, 1);

    service.state.release.pageUrl = "https://evil.test/";
    assert.equal(await service.openRelease(), false);
    service.state.release.pageUrl = "https://github.com/JJong177/KeyTree/releases/tag/v0.3.0";
    service.state.currentVersion = "0.3.0";
    assert.equal(service.hasUpdate.value, false);
    assert.equal(await service.openRelease(), false);
    assert.equal(await service.openDownload(), false);
    assert.equal(opened.length, 2);

    const fallback = createUpdateService({
      getVersion: async () => "0.2.0",
      storage: memoryStorage(),
      fetch: async () => response(release("v0.3.0", { assets: [] })),
      openUrl: async (url) => { opened.push(url); },
    });
    await fallback.check();
    assert.equal(fallback.state.release.downloadUrl, null);
    assert.equal(await fallback.openDownload(), false);
    assert.equal(await fallback.openRelease(), true);
    assert.equal(opened.length, 3);
  });

  await test("network failure preserves known metadata but never reports current", async () => {
    const service = createUpdateService({
      getVersion: async () => "0.2.0",
      storage: memoryStorage(),
      now: () => BASE_TIME,
      fetch: async () => response(release("v0.3.0")),
    });
    await service.check();
    const previousRelease = service.state.release;
    service.state.currentVersion = "0.2.0";
    const unavailableNetwork = createUpdateService({
      getVersion: async () => "0.2.0",
      storage: memoryStorage(),
      fetch: async () => { throw new Error("raw server exception"); },
    });
    await unavailableNetwork.check();
    assert.equal(unavailableNetwork.state.status, "failed");
    assert.equal(unavailableNetwork.state.error.includes("raw server"), false);
    assert.notEqual(previousRelease, null);
  });
} finally {
  await rm(directory, { recursive: true, force: true });
}
