// Run with the Vite dev server active. Uses a fresh, temporary Edge profile and synthetic data only.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const executable = process.env.KEYTREE_TEST_BROWSER || join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe");
await access(executable);
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "keytree-browser-"));
const profile = join(directory, "profile");
const processHandle = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let socket;
try {
  let port;
  for (let n = 0; n < 150; n++) {
    try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); if (port) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(port, "isolated test browser did not start");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data));
    const request = pending.get(message.id);
    if (request) { pending.delete(message.id); clearTimeout(request.timeout); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const key = ++id;
      const timeout = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timed out: ${method}`)); }, 30000);
      pending.set(key, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id: key, method, params }));
    });
  }
  async function evaluate(expression) {
    const value = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
    return value.result.value;
  }
  const url = process.env.KEYTREE_TEST_URL || "http://127.0.0.1:1427";
  await send("Page.navigate", { url });
  for (let n = 0; n < 100; n++) {
    if (await evaluate("document.readyState === 'complete' && location.href.startsWith('http')")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const result = await evaluate(`(async () => {
    const {recognizeClipboard} = await import('/src/lib/clipboard-capture.ts');
    const snap = html => ({sequence:1,text:'',html,sourceUrl:'https://sheet.example.test/doc?token=hidden',sourceApp:'chrome.exe'});
    const horizontal = recognizeClipboard(snap('<table><tr><th>账号</th><th>密码</th></tr><tr><td>demo</td><td> SYNTHETIC &amp; test </td></tr></table>'));
    const vertical = recognizeClipboard(snap('<table><tr><td>账号</td><td>demo</td></tr><tr><td>密码</td><td>SYNTHETIC</td></tr></table>'));
    const fragment = recognizeClipboard(snap('<tr><th>账号</th><th>密码</th></tr><tr><td>demo</td><td>SYNTHETIC</td></tr>'));
    const multiline = recognizeClipboard(snap('<table><tr><td>账号</td><td>demo</td></tr><tr><td>密码</td><td> SYNTHETIC<br>next </td></tr></table>'));
    const merged = recognizeClipboard(snap('<table><tr><th>账号</th><th>密码</th></tr><tr><td colspan="2">ambiguous</td></tr></table>'));
    window.__clipboardScriptExecuted = false;
    recognizeClipboard(snap('<script>window.__clipboardScriptExecuted=true</'+'script><img src="/should-never-load-fixture"><table><tr><th>账号</th><th>密码</th></tr><tr><td>demo</td><td>SYNTHETIC</td></tr></table>'));
    const {createApp,h,nextTick} = await import('/node_modules/.vite/deps/vue.js');
    const {default:Preview} = await import('/src/components/ClipboardRecognition.vue');
    const fixture = document.createElement('div'); document.body.appendChild(fixture);
    const events = [];
    const app = createApp({render:()=>h(Preview,{recognition:horizontal,onDismiss:()=>events.push('dismiss'),onAccept:index=>events.push('accept:'+index)})});
    app.mount(fixture); await nextTick();
    const initialMasked = !fixture.textContent.includes('SYNTHETIC & test');
    const button = text => [...fixture.querySelectorAll('button')].find(button=>button.textContent.trim()===text);
    button('显示密码').click(); await nextTick();
    const revealed = fixture.textContent.includes('SYNTHETIC & test');
    button('隐藏密码').click(); await nextTick();
    const hiddenAgain = !fixture.textContent.includes('SYNTHETIC & test');
    button('填入新增页').click(); button('忽略').click(); await nextTick();
    return {
      horizontal: horizontal?.records[0].username==='demo' && horizontal?.records[0].password===' SYNTHETIC & test ',
      vertical: vertical?.records[0].username==='demo' && vertical?.records[0].password==='SYNTHETIC',
      fragment: fragment?.records[0].username==='demo', mergedRejected: merged===null,
      multilinePreserved: multiline?.records[0].password===' SYNTHETIC\\nnext ',
      scriptInert: !window.__clipboardScriptExecuted,
      resourceInert: !performance.getEntriesByType('resource').some(resource=>resource.name.includes('should-never-load-fixture')),
      sourceOriginOnly: horizontal?.source.url==='https://sheet.example.test',
      initialMasked, revealed, hiddenAgain,
      acceptAndIgnore: events.join(',')==='accept:0,dismiss',
      dialogAccessible: fixture.querySelector('[role="dialog"][aria-modal="true"]')!==null,
    };
  })()`);
  for (const [name, passed] of Object.entries(result)) assert.equal(passed, true, name);
  console.log(`PASS ${Object.keys(result).length} isolated browser checks (synthetic data; no clipboard access)`);
  if (process.env.KEYTREE_TEST_SCREENSHOT) {
    await send("Emulation.setDeviceMetricsOverride", { width: 1080, height: 940, deviceScaleFactor: 1, mobile: false });
    const capture = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(process.env.KEYTREE_TEST_SCREENSHOT, Buffer.from(capture.data, "base64"));
    console.log("Synthetic preview screenshot saved");
  }
  await send("Browser.close");
} finally {
  socket?.close();
  if (processHandle.exitCode === null && processHandle.pid) {
    try { execFileSync("taskkill", ["/PID", String(processHandle.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  }
  for (let n = 0; n < 20; n++) {
    try { await rm(directory, { recursive: true, force: true }); break; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
}
