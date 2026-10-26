// Real Vue controls with synthetic vault/native adapters in an isolated Edge profile.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(project, "package.json"));
const { build } = require("esbuild");
const { parse, compileScript } = require("@vue/compiler-sfc");
const executable = process.env.KEYTREE_TEST_BROWSER || join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe");
await access(executable);
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "keytree-auto-sync-browser-"));
let browser, socket;
try {
  const result = await build({
    stdin: { contents: `export { createApp, nextTick } from 'vue';
export { default as Settings } from './src/components/WebdavSettings.vue';
export { getSyncOnLock, settings } from './src/lib/settings';
import { ref } from 'vue';
const config = {configured:true,url:'https://example.invalid/fixture.kdbx',username:'SYNTHETIC',hasPassword:true,lastSyncedAt:null};
export const vault = globalThis.__autoSyncUiVault = {
  vaultPath:ref('C:/synthetic-a.kdbx'),unlocked:ref(true),busy:ref(false),hasUnsavedChanges:ref(false),
  webdavState:ref({phase:'unchecked',message:'未检查远端',lastSyncedAt:null}),
  syncWebdav:async()=>{throw new Error('Network disabled in UI fixture')},resetWebdavSyncStatus(){},setWebdavConfigSummary(){},
};
globalThis.__autoSyncUiInvoke=async name=>{if(name==='webdav_get_config')return {...config};throw new Error('Unexpected native call: '+name)};`, resolveDir: project, loader: "ts" },
    bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent",
    plugins: [{ name: "synthetic-ui", setup(b) {
      b.onResolve({ filter: /composables\/useVault$/ }, () => ({ path: "vault", namespace: "fixture" }));
      b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "core", namespace: "fixture" }));
      b.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: path === "vault" ? "export const useVault=()=>globalThis.__autoSyncUiVault;" : "export const invoke=(...args)=>globalThis.__autoSyncUiInvoke(...args);", loader: "js" }));
      b.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
        const { descriptor } = parse(await readFile(path, "utf8"), { filename: path });
        return { contents: compileScript(descriptor, { id: path, inlineTemplate: true }).content, loader: "ts", resolveDir: dirname(path) };
      });
    } }],
  });
  const profile = join(directory, "profile");
  browser = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
  let port;
  for (let n = 0; n < 150; n++) {
    try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); if (port) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(port, "isolated browser did not start");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(String(event.data)); const request = pending.get(message.id);
    if (request) { pending.delete(message.id); clearTimeout(request.timeout); message.error ? request.reject(new Error(message.error.message)) : request.resolve(message.result); }
  });
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const key = ++id; const timeout = setTimeout(() => { pending.delete(key); reject(new Error(`CDP timed out: ${method}`)); }, 30000);
      pending.set(key, { resolve, reject, timeout }); socket.send(JSON.stringify({ id: key, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
  await send("Page.navigate", { url: process.env.KEYTREE_TEST_URL || "http://127.0.0.1:1420" });
  for (let n = 0; n < 100; n++) {
    if (await evaluate("document.readyState === 'complete' && location.href.startsWith('http')")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const moduleCode = result.outputFiles[0].text;
  const checks = await evaluate(`(async()=>{
    document.querySelector('#app')?.__vue_app__?.unmount(); document.body.replaceChildren();
    const blobUrl=URL.createObjectURL(new Blob([${JSON.stringify(moduleCode)}],{type:'text/javascript'}));
    const {createApp,nextTick,Settings,vault,getSyncOnLock,settings}=await import(blobUrl); URL.revokeObjectURL(blobUrl);
    settings.webdavSyncOnLock={};
    const host=document.createElement('div');host.style='width:500px;max-width:100%;padding:20px';document.body.append(host);
    const app=createApp(Settings);app.mount(host);
    const settle=async()=>{await nextTick();await new Promise(resolve=>setTimeout(resolve,80))};await settle();
    const checkbox=()=>host.querySelector('[data-lock-sync-settings] input');
    const initialOff=!!checkbox()&&!checkbox().checked&&!checkbox().disabled;
    checkbox().click();await settle();
    const enabled=checkbox().checked&&getSyncOnLock(vault.vaultPath.value);
    const noInterval=!host.querySelector('#auto-sync-interval')&&!host.querySelector('[role="combobox"]');
    const clearLabel=host.querySelector('[data-lock-sync-settings]').textContent.includes('锁定时自动同步');
    checkbox().click();await settle();
    const disabledOff=!checkbox().checked&&!getSyncOnLock(vault.vaultPath.value);
    app.unmount();
    globalThis.__autoSyncUiInvoke=async()=>({configured:false,url:'',username:'',hasPassword:false,lastSyncedAt:null});
    const other=createApp(Settings);other.mount(host);await settle();
    const unconfiguredDisabled=checkbox().disabled;
    other.unmount();host.remove();
    return {initialOff,enabled,noInterval,clearLabel,disabledOff,unconfiguredDisabled};
  })()`);
  console.log(JSON.stringify(checks, null, 2));
  for (const [key, value] of Object.entries(checks)) assert.equal(value, true, key);
} finally {
  if (socket) socket.close();
  if (browser) { try { execFileSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} }
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
