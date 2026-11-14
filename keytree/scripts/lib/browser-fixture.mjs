// Isolated browser checks against the local Vite server. All fixture data must be synthetic.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export async function withBrowser(check) {
  const executable = process.env.KEYTREE_TEST_BROWSER || join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe");
  await access(executable);
  const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "keytree-entry-browser-"));
  const profile = join(directory, "profile");
  const browser = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  const pending = new Map();
  let socket;
  try {
    let port;
    for (let attempt = 0; attempt < 150; attempt++) {
      try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch {}
      if (port) break;
      if (browser.exitCode !== null) throw new Error("Isolated browser exited before opening its debug port");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(port, "isolated browser did not start");
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = pages.find(item => item.type === "page");
    assert.ok(page, "isolated browser has no page");
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Browser debug connection timed out")), 10000);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", error => { clearTimeout(timer); reject(error); }, { once: true });
    });
    let id = 0;
    socket.addEventListener("message", event => {
      const message = JSON.parse(String(event.data));
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timeout);
      message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result);
    });
    function send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const key = ++id;
        const timeout = setTimeout(() => { pending.delete(key); reject(new Error(`Browser command timed out: ${method}`)); }, 30000);
        pending.set(key, { resolve, reject, timeout });
        socket.send(JSON.stringify({ id: key, method, params }));
      });
    }
    async function evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    }
    await send("Page.navigate", { url: process.env.KEYTREE_TEST_URL || "http://127.0.0.1:1420" });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      ready = await evaluate("document.readyState === 'complete' && location.href.startsWith('http')");
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, "Vite page did not load; start the local dev server first");
    return await check({ evaluate, send });
  } finally {
    for (const request of pending.values()) clearTimeout(request.timeout);
    socket?.close();
    if (browser.exitCode === null) {
      const exited = new Promise(resolve => browser.once("exit", resolve));
      browser.kill();
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5000))]);
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
