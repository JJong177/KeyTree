// Real updater UI/service in an isolated browser; native and storage boundaries are synthetic.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser } from "./lib/browser-fixture.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(project, "package.json"));
const { build } = require("esbuild");
const { parse, compileScript } = require("@vue/compiler-sfc");
const source = `
import { createApp, nextTick, reactive, ref } from 'vue';
import { createUpdateService } from 'updates-real';
import AboutUpdates from './src/components/AboutUpdates.vue';
import SettingsModal from './src/components/SettingsModal.vue';
import App from './src/App.vue';
export { createApp, AboutUpdates, SettingsModal, App };
export const state = globalThis.__keytreeUpdatesBrowser ??= {
  service: null, version: '1.2.0', versionError: false, mode: 'release', release: null,
  versionReads: 0, fetchCalls: [], nativeCalls: [], openCalls: [], resolvePending: null,
  vaultUnlocked: ref(false),
};
function response(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}
export function makeRelease({tag='v1.4.0', body='Synthetic release notes', htmlUrl, asset=true, assetUrl}={}) {
  return {
    draft: false, prerelease: false, tag_name: tag, name: 'Synthetic release', body,
    html_url: htmlUrl ?? 'https://github.com/JJong177/KeyTree/releases/tag/' + encodeURIComponent(tag),
    assets: asset ? [{ name: 'KeyTree-Setup.exe', browser_download_url: assetUrl ?? 'https://github.com/JJong177/KeyTree/releases/download/' + encodeURIComponent(tag) + '/KeyTree-Setup.exe' }] : [],
  };
}
export function reset({version='1.2.0', versionError=false, mode='release', release}={}) {
  Object.assign(state, {
    service: null, version, versionError, mode, release: release ?? makeRelease(),
    versionReads: 0, fetchCalls: [], nativeCalls: [], openCalls: [], resolvePending: null,
    vaultUnlocked: ref(false),
  });
  const stored = new Map();
  state.service = createUpdateService({
    getVersion: async () => {
      state.versionReads += 1;
      state.nativeCalls.push({ name: 'get_version' });
      if (state.versionError) throw new Error('SYNTHETIC_VERSION_FAILURE');
      return state.version;
    },
    fetch: async (url, init) => {
      state.fetchCalls.push({ url, method: init?.method, credentials: init?.credentials });
      if (url !== 'https://api.github.com/repos/JJong177/KeyTree/releases/latest') throw new Error('Unexpected synthetic URL');
      if (state.mode === 'error') throw new Error('SYNTHETIC_NETWORK_FAILURE');
      if (state.mode === 'pending') return await new Promise(resolve => { state.resolvePending = payload => resolve(response(payload)); });
      return response(state.release);
    },
    storage: { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    now: () => 1700000000000,
    openUrl: async url => {
      state.nativeCalls.push({ name: 'open_url', url });
      state.openCalls.push(url);
    },
  });
  return state.service;
}
export async function settle() {
  await nextTick();
  await new Promise(resolve => setTimeout(resolve, 40));
  await nextTick();
}
`;
const serviceFile = resolve(project, "src/lib/updates.ts");
const normalized = (path) => resolve(path).replaceAll("\\", "/").replace(/\.(?:ts|js|vue)$/, "");
const stubs = new Map([
  [normalized(resolve(project, "src/composables/useVault.ts")), "vault"],
  [normalized(resolve(project, "src/composables/useDialogFocus.ts")), "focus"],
  [normalized(resolve(project, "src/composables/useAutoLock.ts")), "lifecycle"],
  [normalized(resolve(project, "src/composables/useSystemGuard.ts")), "lifecycle"],
  [normalized(resolve(project, "src/composables/useVaultSync.ts")), "lifecycle"],
  [normalized(resolve(project, "src/composables/usePanelHost.ts")), "lifecycle"],
  [normalized(resolve(project, "src/lib/clipboard.ts")), "lifecycle"],
  [normalized(resolve(project, "src/lib/settings.ts")), "settings"],
  [normalized(resolve(project, "src/lib/toast.ts")), "toast"],
  [normalized(resolve(project, "src/lib/quick-unlock.ts")), "quick-unlock"],
]);
const buildResult = await build({
  stdin: { resolveDir: project, loader: "ts", contents: source },
  bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent",
  plugins: [{ name: "synthetic-update-browser", setup(build) {
    build.onResolve({ filter: /.*/ }, args => {
      if (args.path === "updates-real") return { path: serviceFile, namespace: "updates-real" };
      if (args.path.startsWith("@tauri-apps/")) return { path: args.path, namespace: "synthetic-native" };
      if (!args.path.startsWith(".") && !args.path.startsWith("/")) return;
      const target = normalized(resolve(args.resolveDir, args.path));
      if (target === normalized(resolve(project, "src/lib/updates.ts"))) return { path: "updates-adapter", namespace: "synthetic-updates" };
      const stub = stubs.get(target);
      if (stub) return { path: stub, namespace: "synthetic-stub" };
    });
    build.onLoad({ filter: /.*/, namespace: "updates-real" }, async ({ path }) => ({
      contents: await readFile(path, "utf8"), loader: "ts", resolveDir: dirname(path),
    }));
    build.onLoad({ filter: /.*/, namespace: "synthetic-updates" }, () => ({
      loader: "js", contents: `import { createUpdateService } from 'updates-real';
export { createUpdateService };
export const useUpdates = () => globalThis.__keytreeUpdatesBrowser.service;
`,
    }));
    build.onLoad({ filter: /.*/, namespace: "synthetic-native" }, ({ path }) => ({
      loader: "js", contents: path === "@tauri-apps/api/app"
        ? "export const getVersion=async()=>{throw new Error('Unexpected default version boundary')};"
        : path === "@tauri-apps/api/core"
          ? "export const invoke=async(name,args)=>{const s=globalThis.__keytreeUpdatesBrowser;s.nativeCalls.push({name,args});if(name==='hello_status')return 'unavailable';};"
          : path === "@tauri-apps/plugin-http"
            ? "export const fetch=async()=>{throw new Error('Unexpected default network boundary')};"
            : path === "@tauri-apps/plugin-dialog"
              ? "export const open=async()=>null;export const save=async()=>null;"
              : path === "@tauri-apps/plugin-autostart"
                ? "export const enable=async()=>{};export const disable=async()=>{};export const isEnabled=async()=>false;"
                : "export {};",
    }));
    build.onLoad({ filter: /.*/, namespace: "synthetic-stub" }, ({ path }) => {
      if (path === "vault") return { loader: "js", resolveDir: project, contents: `
import { reactive, ref } from 'vue';
export function useVault() {
  const state = globalThis.__keytreeUpdatesBrowser;
  return {
    unlocked: state.vaultUnlocked, flushSave: async()=>{}, syncExternalChanges: async()=>{},
    vaultPath: ref(''), vaultInfo: ref({kdf:'synthetic',version:'1'}), drawer: reactive({open:false}),
    hasKeyFile: ref(false), changeMasterPassword: async()=>false, applyKeyFile: async()=>false,
    createKeyFile: async()=>false, exportKdbx: async()=>false, exportCsv: async()=>false,
    previewCsv: async()=>false, importPreview: ref([]), cancelImport: ()=>{}, backupInfoOf: async()=>({exists:false,mtimeMs:0,size:0}),
    error: ref(''), busy: ref(false),
  };
}` };
      if (path === "focus") return { loader: "js", contents: "export function useDialogFocus(){}" };
      if (path === "lifecycle") return { loader: "js", contents: "export function useAutoLock(){};export function useSystemGuard(){};export function useVaultSync(){};export function usePanelHost(){};export function useClipboardStatus(){}" };
      if (path === "settings") return { loader: "js", resolveDir: project, contents: "import {reactive} from 'vue';export const settings=reactive({launchAtLogin:false,highSecurityMode:false,screenshotProtection:false,quickUnlock:false,autoHelloUnlock:false,clipboardRecognition:false,autoLockMinutes:10,clipboardSeconds:30});" };
      if (path === "toast") return { loader: "js", contents: "export function toast(){}" };
      if (path === "quick-unlock") return { loader: "js", contents: "export function installQuickUnlockPolicy(){};export async function clearQuickUnlockCache(){}" };
      throw new Error(`Unexpected stub module ${path}`);
    });
    build.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
      if (!["AboutUpdates.vue", "SettingsModal.vue", "App.vue"].includes(basename(path))) {
        return { loader: "js", resolveDir: dirname(path), contents: `import {h} from 'vue';export default {render(){return h('div',{'data-test-child':'${basename(path, ".vue")}'});}};` };
      }
      const { descriptor } = parse(await readFile(path, "utf8"), { filename: path });
      return { contents: compileScript(descriptor, { id: path, inlineTemplate: true }).content, loader: "ts", resolveDir: dirname(path) };
    });
  }}],
});

const mainSource = await readFile(resolve(project, "src/main.ts"), "utf8");
assert.match(mainSource, /get\(["']panel["']\)\s*===\s*["']1["']/, "main.ts routes panel windows through the panel query parameter");
assert.match(mainSource, /createApp\(PanelApp\)\.mount/, "panel route mounts PanelApp");

await withBrowser(async ({ evaluate }) => {
  const checks = await evaluate(`(async()=>{
    document.querySelector('#app')?.__vue_app__?.unmount(); document.body.replaceChildren();
    const blob=URL.createObjectURL(new Blob([${JSON.stringify(buildResult.outputFiles[0].text)}],{type:'text/javascript'}));
    const ui=await import(blob); URL.revokeObjectURL(blob);
    const checks={};
    const mount=(component,props={})=>{const host=document.createElement('div');document.body.append(host);const app=ui.createApp(component,props);app.mount(host);return {host,app};};
    const button=(root,selector)=>root.querySelector(selector);
    const tab=(root,label)=>[...root.querySelectorAll('button')].find(el=>el.textContent.trim().startsWith(label));
    const unmount=f=>{f.app.unmount();f.host.remove();};

    // The shared service is inert until UI lifecycle calls initialize/check.
    ui.reset({release:ui.makeRelease({tag:'v1.2.0'})});
    checks.noImportNetworkOrVersionRead=ui.state.fetchCalls.length===0&&ui.state.versionReads===0;
    let f=mount(ui.AboutUpdates); await ui.settle();
    checks.uncheckedState=button(f.host,'[data-update-state]')?.dataset.status==='unchecked'&&f.host.textContent.includes('尚未检查更新')&&ui.state.fetchCalls.length===0;
    await ui.state.service.check({force:true}); await ui.settle();
    checks.currentVersionRead=ui.state.versionReads===1&&ui.state.nativeCalls.some(call=>call.name==='get_version');
    checks.currentState=button(f.host,'[data-update-state]')?.dataset.status==='current'&&f.host.querySelector('[data-current-version]')?.textContent.trim()==='v1.2.0'&&f.host.querySelector('[data-available-version]')===null;
    unmount(f);

    const malicious='Release <img src=x onerror=alert(1)> [safe label](https://evil.invalid) <script>window.__notesExecuted=true</script>';
    ui.reset({release:ui.makeRelease({tag:'v1.4.0',body:malicious})});
    f=mount(ui.AboutUpdates); await ui.settle(); await ui.state.service.check({force:true}); await ui.settle();
    checks.availableState=button(f.host,'[data-update-state]')?.dataset.status==='available'&&f.host.querySelector('[data-available-version]')?.textContent.includes('1.4.0');
    f.host.querySelector('details summary')?.click(); await ui.settle();
    const notes=f.host.querySelector('[data-update-notes]');
    checks.notesAreText=!!notes&&notes.textContent.includes('safe label')&&!notes.textContent.includes('https://evil.invalid')&&!f.host.querySelector('img,script')&&!window.__notesExecuted;
    button(f.host,'[data-update-download]')?.click(); await ui.settle();
    button(f.host,'[data-update-release]')?.click(); await ui.settle();
    checks.opensOnlyProjectUrls=ui.state.openCalls.length===2&&ui.state.openCalls.every(url=>url.startsWith('https://github.com/JJong177/KeyTree/releases/'))&&ui.state.nativeCalls.filter(call=>call.name==='open_url').length===2;
    unmount(f);

    ui.reset({release:ui.makeRelease({tag:'v1.5.0',asset:false})});
    f=mount(ui.AboutUpdates); await ui.settle(); await ui.state.service.check({force:true}); await ui.settle();
    checks.noAttachmentFallback=!f.host.querySelector('[data-update-download]')&&!!f.host.querySelector('[data-update-release]')&&f.host.querySelector('[data-update-release]').textContent.includes('发布页');
    f.host.querySelector('[data-update-release]')?.click(); await ui.settle();
    checks.fallbackOpensProjectPage=ui.state.openCalls.length===1&&ui.state.openCalls[0]==='https://github.com/JJong177/KeyTree/releases/tag/v1.5.0';
    unmount(f);

    ui.reset({release:ui.makeRelease({tag:'v1.6.0',htmlUrl:'https://evil.invalid/releases/v1.6.0'})});
    f=mount(ui.AboutUpdates); await ui.settle(); await ui.state.service.check({force:true}); await ui.settle();
    checks.malformedReleaseLinkRejected=button(f.host,'[data-update-state]')?.dataset.status==='failed'&&!f.host.querySelector('[data-update-download]')&&ui.state.openCalls.length===0;
    unmount(f);

    ui.reset({release:ui.makeRelease({tag:'v1.7.0',assetUrl:'https://evil.invalid/installer.exe'})});
    f=mount(ui.AboutUpdates); await ui.settle(); await ui.state.service.check({force:true}); await ui.settle();
    checks.malformedAttachmentRejected=!f.host.querySelector('[data-update-download]')&&!!f.host.querySelector('[data-update-release]');
    unmount(f);

    ui.reset({mode:'error'});
    f=mount(ui.AboutUpdates); await ui.settle();
    f.host.querySelector('[data-update-check]')?.click(); await ui.settle();
    checks.failureState=button(f.host,'[data-update-state]')?.dataset.status==='failed'&&ui.state.fetchCalls.length===1;
    unmount(f);

    ui.reset({versionError:true});
    f=mount(ui.AboutUpdates); await ui.settle();
    checks.unavailableState=button(f.host,'[data-update-state]')?.dataset.status==='unavailable'&&f.host.querySelector('[data-current-version]')?.textContent.includes('不可用')&&ui.state.fetchCalls.length===0;
    unmount(f);

    ui.reset({mode:'pending'});
    f=mount(ui.AboutUpdates); await ui.settle();
    f.host.querySelector('[data-update-check]')?.click(); await ui.settle();
    checks.checkingState=!!ui.state.resolvePending&&f.host.querySelector('[data-update-state]')?.textContent.includes('正在检查更新')&&f.host.querySelector('[data-update-check]')?.disabled;
    ui.state.resolvePending(ui.makeRelease({tag:'v1.8.0'})); await ui.settle();
    unmount(f);

    // A previously discovered update and its badge survive visiting About and a later failed refresh.
    const service=ui.reset({release:ui.makeRelease({tag:'v1.9.0'})});
    await service.check({force:true});
    f=mount(ui.SettingsModal,{initialTab:'security',onClose:()=>{}}); await ui.settle();
    checks.badgeInitiallyVisible=!!f.host.querySelector('[data-update-badge]');
    tab(f.host,'关于')?.click(); await ui.settle();
    checks.badgeSurvivesViewing=!!f.host.querySelector('[data-update-badge]')&&!!f.host.querySelector('[data-available-version]');
    checks.aboutLayout=f.host.querySelectorAll('[data-update-product]').length===1&&[f.host.querySelector('[data-about-updates]'),f.host.querySelector('[data-settings-scroll]')].every(el=>el&&el.clientWidth>0&&el.scrollWidth<=el.clientWidth+1);
    ui.state.mode='error'; await service.check({force:true}); await ui.settle();
    checks.badgeSurvivesFailure=service.state.status==='failed'&&service.hasUpdate.value&&!!f.host.querySelector('[data-update-badge]')&&!!f.host.querySelector('[data-available-version]');
    unmount(f);

    // A pending check must not block closing Settings.
    ui.reset({mode:'pending'});
    let closed=false;
    f=mount(ui.SettingsModal,{initialTab:'about',onClose:()=>{closed=true;}}); await ui.settle();
    f.host.querySelector('[data-update-check]')?.click(); await ui.settle();
    const pendingBeforeClose=!!ui.state.resolvePending&&ui.state.service.state.checking;
    [...f.host.querySelectorAll('button')].find(el=>el.textContent.trim()==='✕')?.click(); await ui.settle();
    checks.settingsClosesWhileChecking=pendingBeforeClose&&closed;
    ui.state.resolvePending(ui.makeRelease({tag:'v1.3.0'})); await ui.settle();
    unmount(f);

    // App checks in the background on mount while locked; importing it above did not check.
    ui.reset({mode:'pending'});
    const fetchesBeforeMount=ui.state.fetchCalls.length;
    f=mount(ui.App); await ui.settle();
    checks.appBackgroundCheckWhileLocked=fetchesBeforeMount===0&&ui.state.fetchCalls.length===1&&!!ui.state.resolvePending&&!!f.host.querySelector('[data-test-child="UnlockView"]');
    ui.state.resolvePending(ui.makeRelease({tag:'v1.2.0'})); await ui.settle();
    unmount(f);
    return checks;
  })()`);
  console.log(JSON.stringify(checks, null, 2));
  for (const [name, passed] of Object.entries(checks)) assert.equal(passed, true, name);
});
