// Real UI and useVault; synthetic in-memory KDBX with native/network boundaries replaced.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser } from "./lib/browser-fixture.mjs";
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(project, "package.json"));
const { build } = require("esbuild");
const { parse, compileScript } = require("@vue/compiler-sfc");
const result = await build({
  stdin: { resolveDir: project, loader: "ts", contents: `
import * as raw from './vendor/kdbxweb/dist/kdbxweb.js';
import {createApp,nextTick} from 'vue';
import MainView from './src/components/MainView.vue';
import {useVault} from './src/composables/useVault';
import {settings} from './src/lib/settings';
let k=raw;for(let depth=0;!k.Kdbx&&depth<6;depth++)k=k.default;
export const state=globalThis.__bulkBrowser={writes:0,failWrite:false,db:null,nativeCalls:[],engine:{...k,Kdbx:class extends k.Kdbx{
  static create(...args){const db=k.Kdbx.create(...args);state.db=db;db.save=async()=>new ArrayBuffer(64);return db;}
}},async invoke(name,args){
  state.nativeCalls.push(name);
  if(name==='stat_vault')return {mtimeMs:1,size:64,mtimeNs:'1'};
  if(name==='write_vault'){state.writes++;if(state.failWrite)throw new Error('SYNTHETIC_DISK_FAILURE');return {mtimeMs:1,size:64,mtimeNs:'1'};}
  if(name==='webdav_get_config')return {configured:false,url:'',username:'',hasPassword:false,lastSyncedAt:null};
  if(['watch_vault','cancel_auto_type','clear_secret_clipboard','set_screenshot_protection','quick_unlock_clear','quick_unlock_save','webdav_cancel_sync'].includes(name))return;
  if(name==='audit_status')return {enabled:false,epoch:1};
  throw new Error('Unexpected synthetic native call: '+name);
}};
export const vault=useVault();
export async function setup(host){
 settings.quickUnlock=false;settings.clipboardRecognition=false;
 if(!await vault.createVault('SYNTHETIC_BULK.kdbx','Synthetic bulk','SYNTHETIC_ONLY'))throw new Error('synthetic vault creation failed');
 await vault.addGroup('Target');
 const target=vault.groups.value.find(g=>g.name==='Target').uuid;
 const draft={title:'',username:'test@example.test',password:'SYNTHETIC_ONLY',url:'',notes:'',tags:'original',totp:'',groupUuid:vault.groups.value[0].uuid,expires:false,expiryDate:''};
 const a=await vault.addEntry({...draft,title:'Alpha'}),b=await vault.addEntry({...draft,title:'Beta'}),c=await vault.addEntry({...draft,title:'Other'});
 const app=createApp(MainView);app.mount(host);await settle();state.writes=0;
 return {app,a,b,c,target,root:draft.groupUuid};
}
export async function settle(){await nextTick();await new Promise(resolve=>setTimeout(resolve,40));}
` },
  bundle: true, platform: "browser", format: "esm", write: false, logLevel: "silent", loader: { ".png": "dataurl" },
  plugins: [{name: "synthetic-bulk-browser", setup(b) {
    b.onResolve({filter: /^@tauri-apps\/api\/core$/}, () => ({path: "core", namespace: "bulk"}));
    b.onResolve({filter: /^@tauri-apps\/api\/event$/}, () => ({path: "events", namespace: "bulk"}));
    b.onResolve({filter: /^@tauri-apps\/plugin-http$/}, () => ({path: "http", namespace: "bulk"}));
    b.onResolve({filter: /^@tauri-apps\/plugin-dialog$/}, () => ({path: "dialog", namespace: "bulk"}));
    b.onResolve({filter: /kdbx\/(kdbxweb|argon2)$/}, ({path}) => ({path: path.endsWith("argon2") ? "argon2" : "engine", namespace: "bulk"}));
    b.onResolve({filter: /^crypto$/}, () => ({path: "crypto", namespace: "bulk"}));
    b.onLoad({filter: /.*/, namespace: "bulk"}, ({path}) => ({loader: "js", contents: {
      core: "export const invoke=(...args)=>globalThis.__bulkBrowser.invoke(...args);",
      events: "export const listen=async()=>()=>{};export const emitTo=async()=>{};export const emit=async()=>{};",
      http: "export const fetch=async()=>{throw new Error('Network disabled in synthetic bulk checks')};",
      dialog: "export const save=async()=>null;export const open=async()=>null;",
      engine: "export const getKdbxweb=async()=>globalThis.__bulkBrowser.engine;",
      argon2: "export const installArgon2=async()=>{};",
      crypto: "export default {};",
    }[path]}));
    b.onLoad({filter: /\.vue$/}, async ({path}) => {
      const {descriptor} = parse(await readFile(path,"utf8"), {filename:path});
      return {contents:compileScript(descriptor,{id:path,inlineTemplate:true}).content,loader:"ts",resolveDir:dirname(path)};
    });
  }}],
});
await withBrowser(async ({evaluate,send}) => {
  await send("Emulation.setFocusEmulationEnabled", {enabled:true});
  const checks=await evaluate(`(async()=>{
    document.querySelector('#app')?.__vue_app__?.unmount();document.body.replaceChildren();
    const blob=URL.createObjectURL(new Blob([${JSON.stringify(result.outputFiles[0].text)}],{type:'text/javascript'}));
    const ui=await import(blob);URL.revokeObjectURL(blob);
    const host=document.createElement('div');document.body.append(host);
    const f=await ui.setup(host),v=ui.vault,s=ui.state,checks={};
    const button=(text,root=host)=>[...root.querySelectorAll('button')].find(el=>el.textContent.trim()===text);
    const row=id=>host.querySelector('[data-uuid="'+CSS.escape(id)+'"]');
    const check=id=>row(id)?.querySelector('input[type="checkbox"]');
    const dialog=()=>host.querySelector('[aria-labelledby="bulk-entry-dialog-title"]');
    const fill=(input,value)=>{input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
    const waitSaved=async()=>{for(let i=0;i<100;i++){await ui.settle();if(!v.bulkWorking.value)return;}throw new Error('synthetic bulk save never settled');};
    checks.minimalDefault=!!button('多选')&&!host.querySelector('input[type="checkbox"]')&&!dialog();
    button('多选').click();await ui.settle();
    checks.initiallyEmpty=v.selectionMode.value&&v.bulkSelectedUuids.value.length===0&&[f.a,f.b,f.c].every(id=>!!check(id));
    const viewed=v.selectedUuid.value;check(f.a).click();await ui.settle();
    checks.checkboxSeparate=!check(f.a).closest('button')&&v.selectedUuid.value===viewed&&v.bulkSelectedUuids.value.includes(f.a);
    const search=host.querySelector('input[placeholder^="搜索条目"]');fill(search,'Alpha');await ui.settle();
    checks.filterClearsSelection=v.bulkSelectedUuids.value.length===0;
    document.activeElement?.blur();
    button('全选').click();await ui.settle();checks.selectVisibleOnly=v.bulkSelectedUuids.value.length===1&&v.bulkSelectedUuids.value[0]===f.a;
    fill(search,'');await ui.settle();button('全选').click();await ui.settle();
    checks.selectAllThree=v.bulkSelectedUuids.value.length===3;
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Delete',bubbles:true,cancelable:true}));
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'e',ctrlKey:true,bubbles:true,cancelable:true}));await ui.settle();
    checks.singleShortcutsBlocked=!v.drawer.value.open&&v.entries.value.every(e=>!e.inTrash);
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await ui.settle();
    checks.escapeExits=!v.selectionMode.value&&v.bulkSelectedUuids.value.length===0;
    button('多选').click();await ui.settle();check(f.a).click();check(f.b).click();await ui.settle();
    button('添加标签').click();await ui.settle();
    checks.dialogCount=!!dialog()&&dialog().textContent.includes('2 条');
    checks.emptyTagsDisabled=button('确认',dialog()).disabled;
    fill(dialog().querySelector('#bulk-entry-tags'),'，');await ui.settle();checks.onlyChineseSeparatorsDisabled=button('确认',dialog()).disabled;
    const writesBeforeCancel=s.writes;button('取消',dialog()).click();await ui.settle();
    checks.cancelNoMutation=!dialog()&&s.writes===writesBeforeCancel&&v.draftOf(f.a).tags==='original';
    button('添加标签').click();await ui.settle();fill(dialog().querySelector('#bulk-entry-tags'),'first, second');await ui.settle();
    s.failWrite=true;button('确认',dialog()).click();await waitSaved();
    checks.failedAppliedOnce=v.bulkPendingSave.value&&dialog().textContent.includes('尚未保存')&&v.draftOf(f.a).tags==='original, first, second';
    checks.pendingBlocksNew=!!button('新建条目')?.disabled||!button('新建条目');
    const historyLength=v.historyOf(f.a).length;s.failWrite=false;button('重试保存',dialog()).click();await waitSaved();
    checks.retryOnlySaves=!v.bulkPendingSave.value&&!dialog()&&v.historyOf(f.a).length===historyLength&&v.draftOf(f.c).tags==='original';
    check(f.a).click();await ui.settle();button('移动').click();await ui.settle();
    checks.moveNeedsTarget=button('确认',dialog()).disabled;
    const moveSelect=dialog().querySelector('[role="combobox"]');moveSelect.focus();moveSelect.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));await ui.settle();
    const option=[...document.querySelectorAll('[role="option"]')].find(el=>el.textContent.includes('Target'));
    if(!option)throw new Error('Target option missing');option.focus();option.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await ui.settle();
    button('确认',dialog()).click();await waitSaved();
    checks.moveOnlyChecked=v.draftOf(f.a).groupUuid===f.target&&v.draftOf(f.b).groupUuid===f.root;
    s.db.meta.recycleBinEnabled=false;v.groups.value=[...v.groups.value];await ui.settle();
    check(f.b).click();await ui.settle();checks.disabledTrash=button('移到回收站').disabled&&host.textContent.includes('回收站已关闭');
    s.db.meta.recycleBinEnabled=true;v.groups.value=[...v.groups.value];await ui.settle();
    button('移到回收站').click();await ui.settle();
    checks.trashCancelFocus=!!dialog()&&document.activeElement===button('取消',dialog());
    const trashWrites=s.writes;button('取消',dialog()).click();await ui.settle();
    checks.trashCancelSafe=s.writes===trashWrites&&!v.entries.value.find(e=>e.uuid===f.b).inTrash;
    button('移到回收站').click();await ui.settle();button('确认移到回收站',dialog()).click();await waitSaved();
    checks.trashOnlyChecked=v.entries.value.find(e=>e.uuid===f.b).inTrash&&!v.entries.value.find(e=>e.uuid===f.c).inTrash;
    checks.noPermanentBulk=!host.textContent.includes('永久删除');
    v.selectGroup(v.trash.value.uuid);await ui.settle();checks.noTrashMultiselect=!button('多选')&&!v.selectionMode.value;
    await v.lock({force:true});await ui.settle();checks.lockClearsBatch=!v.selectionMode.value&&!v.bulkDialog.value&&v.bulkSelectedUuids.value.length===0;
    f.app.unmount();host.remove();return checks;
  })()`);
  console.log(JSON.stringify(checks,null,2));
  for(const [key,value] of Object.entries(checks))assert.equal(value,true,key);
});
