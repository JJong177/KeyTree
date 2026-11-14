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
const dir = await mkdtemp(join(scratch, "keytree-site-title-"));
try {
  const output = join(dir, "site-title.mjs");
  await build({
    entryPoints: [resolve(project, "src/lib/site-title.ts")],
    outfile: output,
    bundle: true,
    format: "esm",
    platform: "node",
    logLevel: "silent",
  });
  const { websiteHost, canFetchSiteTitle, extractSiteTitle, fetchSiteTitle } = await import(pathToFileURL(output).href);
  const htmlResponse = (body, headers = { "content-type": "text/html; charset=utf-8" }) => new Response(body, { headers });

  await test("host and HTTPS checks use shared URL parsing without mutating input", () => {
    assert.equal(websiteHost("example.test:8443/path?q=x"), "example.test:8443");
    assert.equal(websiteHost("http://127.0.0.1:8080/a"), "127.0.0.1:8080");
    assert.equal(websiteHost("not a web address"), "");
    assert.equal(canFetchSiteTitle("example.test/path"), true);
    assert.equal(canFetchSiteTitle("http://example.test"), false);
    assert.equal(canFetchSiteTitle("mailto:user@example.test"), false);
  });

  await test("HTTP and invalid inputs never invoke the injected fetch", async () => {
    let calls = 0;
    const fetch = async () => { calls += 1; throw new Error("must not fetch"); };
    assert.equal(await fetchSiteTitle("http://example.test/private", { fetch }), null);
    assert.equal(await fetchSiteTitle("mailto:user@example.test", { fetch }), null);
    assert.equal(await fetchSiteTitle("not a URL", { fetch }), null);
    assert.equal(calls, 0);
  });

  await test("HTTPS lookup strips user info, path, query, fragment and sensitive request headers", async () => {
    let requestUrl;
    let requestInit;
    const input = "https://alice:secret@example.test/private/path?token=secret#fragment";
    assert.equal(await fetchSiteTitle(input, {
      fetch: async (url, init) => {
        requestUrl = url;
        requestInit = init;
        return htmlResponse("<title>Example Home</title>");
      },
    }), "Example Home");
    assert.equal(requestUrl, "https://example.test/");
    assert.equal(requestInit.method, "GET");
    assert.equal(requestInit.credentials, "omit");
    assert.equal(requestInit.referrerPolicy, "no-referrer");
    assert.equal(requestInit.redirect, "manual");
    assert.equal(requestInit.maxRedirections, 0);
    assert.equal(requestInit.headers.Cookie, undefined);
    assert.equal(requestInit.headers.Authorization, undefined);
    assert.equal(requestInit.headers.Referer, undefined);
    assert.equal(JSON.stringify(requestInit).includes("secret"), false);
  });

  await test("site_name metadata wins and HTML entities, whitespace, controls and bidi are cleaned", () => {
    const title = extractSiteTitle(`<title>Page title</title><meta name="og:site_name" content="Name metadata"><meta content="  Example&#32; &amp; Co.\u202e  " property="og:site_name">`);
    assert.equal(title, "Example & Co.");
    assert.equal(extractSiteTitle("<meta name='og:site_name' content='Name &quot;Here&quot;' />"), 'Name "Here"');
    assert.equal(extractSiteTitle("<title> A &lt;B&gt; &#x1F41F; </title>"), "A <B> 🐟");
  });

  await test("untrusted markup is text only; scripts are neither run nor returned as title markup", () => {
    globalThis.siteTitleScriptRan = false;
    const title = extractSiteTitle(`<script>globalThis.siteTitleScriptRan = true</script><meta property="og:site_name" content="&lt;script&gt;alert(1)&lt;/script&gt;"><title><img src=x onerror=alert(2)> Safe</title>`);
    assert.equal(title, "<script>alert(1)</script>");
    assert.equal(globalThis.siteTitleScriptRan, false);
    assert.equal(extractSiteTitle("<title>Just a moment...</title>"), null);
    assert.equal(extractSiteTitle("<title>Access Denied</title>"), null);
    assert.equal(extractSiteTitle("<title>Sign in to Example</title>"), null);
    delete globalThis.siteTitleScriptRan;
  });

  await test("native homepage requests use a browser identity instead of script-only fallback pages", async () => {
    const title = await fetchSiteTitle("https://www.baidu.com/", {
      fetch: async (_url, init) => {
        const agent = new Headers(init.headers).get("user-agent");
        return htmlResponse(agent?.startsWith("Mozilla/5.0")
          ? "<head><title>百度一下，你就知道</title></head>"
          : "<html><head><script>location.replace('http://www.baidu.com/')</script></head></html>");
      },
    });
    assert.equal(title, "百度一下，你就知道");
  });

  await test("large homepages yield head metadata without downloading the entire body", async () => {
    const encoder = new TextEncoder();
    let cancelled = false, pulls = 0;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        controller.enqueue(pulls === 1
          ? encoder.encode('<head><title>页面标题</title><meta property="og:site_name" content="百度"></head>')
          : new Uint8Array(65536).fill(120));
      },
      cancel() { cancelled = true; },
    });
    const title = await fetchSiteTitle("https://www.baidu.com/", {
      fetch: async () => new Response(body, { headers: { "content-type": "text/html; charset=utf-8", "content-length": "7340032" } }),
    });
    assert.equal(title, "百度");
    assert.equal(cancelled, true);
    assert.ok(pulls <= 3, "stop the response after its head rather than reading the body");
  });

  await test("head titles survive oversized chunks and split UTF-8 characters", async () => {
    const bytes = new TextEncoder().encode("<head><title>百度一下，你就知道</title></head><body>" + "x".repeat(400000));
    const split = new TextEncoder().encode("<head><title>").length + 1;
    let part = 0, cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        controller.enqueue(part++ === 0 ? bytes.subarray(0, split) : bytes.subarray(split));
      },
      cancel() { cancelled = true; },
    });
    assert.equal(await fetchSiteTitle("https://www.baidu.com/", {
      maxBytes: 256,
      fetch: async () => new Response(body, { headers: { "content-type": "text/html" } }),
    }), "百度一下，你就知道");
    assert.equal(cancelled, true);
  });

  await test("unusable responses and titles outside the byte budget return null", async () => {
    assert.equal(await fetchSiteTitle("https://example.test", { fetch: async () => htmlResponse("<title>   </title>") }), null);
    assert.equal(await fetchSiteTitle("https://example.test", { fetch: async () => htmlResponse("<title>not html</title>", { "content-type": "application/json" }) }), null);
    assert.equal(await fetchSiteTitle("https://example.test", { fetch: async () => new Response("denied", { status: 403 }) }), null);
    assert.equal(await fetchSiteTitle("https://example.test", {
      maxBytes: 8,
      fetch: async () => new Response("<title>x</title>", { headers: { "content-type": "text/html", "content-length": "80" } }),
    }), null);
  });

  await test("streamed responses are capped even without Content-Length", async () => {
    let cancelled = false;
    let chunks = 0;
    const body = new ReadableStream({
      pull(controller) {
        if (chunks < 2) {
          chunks += 1;
          controller.enqueue(new Uint8Array(7));
        }
      },
      cancel() { cancelled = true; },
    });
    assert.equal(await fetchSiteTitle("https://example.test", {
      maxBytes: 10,
      fetch: async () => new Response(body, { headers: { "content-type": "text/html" } }),
    }), null);
    assert.equal(cancelled, true);
  });

  await test("total timeout covers fetch headers that never settle", async () => {
    let internalSignal;
    const start = Date.now();
    const result = await fetchSiteTitle("https://example.test", {
      timeoutMs: 25,
      fetch: async (_url, init) => {
        internalSignal = init.signal;
        return new Promise(() => {});
      },
    });
    assert.equal(result, null);
    assert.equal(internalSignal.aborted, true);
    assert.ok(Date.now() - start < 1_000);
  });

  await test("total timeout covers a body stream that never produces bytes", async () => {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    const result = await fetchSiteTitle("https://example.test", {
      timeoutMs: 25,
      fetch: async () => new Response(body, { headers: { "content-type": "text/html" } }),
    });
    assert.equal(result, null);
    assert.equal(cancelled, true);
  });

  await test("external abort is benign and aborts the in-flight request", async () => {
    const controller = new AbortController();
    let internalSignal;
    const pending = fetchSiteTitle("https://example.test", {
      signal: controller.signal,
      timeoutMs: 2_000,
      fetch: async (_url, init) => {
        internalSignal = init.signal;
        return new Promise(() => {});
      },
    });
    setTimeout(() => controller.abort(), 10);
    assert.equal(await pending, null);
    assert.equal(internalSignal.aborted, true);
  });

  await test("same-origin redirects are manually followed without query or fragment", async () => {
    const urls = [];
    const initValues = [];
    const title = await fetchSiteTitle("https://example.test/private?input=secret#fragment", {
      fetch: async (url, init) => {
        urls.push(url);
        initValues.push(init);
        if (urls.length === 1) return new Response(null, { status: 302, headers: { location: "/home?session=secret#x" } });
        return htmlResponse("<title>Home</title>");
      },
    });
    assert.equal(title, "Home");
    assert.deepEqual(urls, ["https://example.test/", "https://example.test/home"]);
    assert.ok(initValues.every((init) => init.maxRedirections === 0 && init.redirect === "manual"));
  });

  await test("cross-origin, downgraded, credentialed and excess redirects are rejected", async () => {
    for (const location of ["https://other.test/", "http://example.test/", "https://user@example.test/"]) {
      let calls = 0;
      const result = await fetchSiteTitle("https://example.test", {
        fetch: async () => {
          calls += 1;
          return new Response(null, { status: 302, headers: { location } });
        },
      });
      assert.equal(result, null);
      assert.equal(calls, 1);
    }
    let calls = 0;
    const result = await fetchSiteTitle("https://example.test", {
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 302, headers: { location: "/again" } });
      },
    });
    assert.equal(result, null);
    assert.equal(calls, 4);
  });
} finally {
  await rm(dir, { recursive: true, force: true });
}
