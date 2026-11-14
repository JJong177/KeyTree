// Production EntryDrawer controls with synthetic vault/native adapters in an isolated Edge profile.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { withBrowser } from "./lib/browser-fixture.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(project, "package.json"));
const { build } = require("esbuild");
const { parse, compileScript } = require("@vue/compiler-sfc");

const result = await build({
  stdin: {
    contents: `import { createApp, nextTick, ref } from 'vue';
import EntryDrawer from './src/components/EntryDrawer.vue';
const pair = (username,password) => ({username,password});
export const drawer = ref({open:true,mode:'new',uuid:''});
export const vault = {
  drawer, groups:ref([{uuid:'g1',name:'合成分组',depth:0}]), pendingGroup:ref(''), pendingUsername:ref(''), entries:ref([]), busy:ref(false), error:ref(''),
  usernameGroups:ref([{username:'alice@example.test',entryCount:2,siteCount:2},{username:'Bob',entryCount:1,siteCount:1},{username:'alice@example.test',entryCount:9,siteCount:9},{username:'',entryCount:1,siteCount:0}]),
  credentialCandidates:ref([
    {uuid:'source-a',title:'样例邮箱',username:'same@example.test',url:'https://mail.example.test',site:'mail.example.test',lastUsedAt:200},
    {uuid:'source-b',title:'样例论坛',username:'same@example.test',url:'https://forum.example.test',site:'forum.example.test',lastUsedAt:100},
    {uuid:'source-c',title:'其他账号',username:'different@example.test',url:'https://social.example.test',site:'social.example.test',lastUsedAt:300}
  ]),
  credentialEpoch:ref(7), sourceData:new Map([['source-a',pair('same@example.test','synthetic-secret-a')],['source-b',pair('same@example.test','synthetic-secret-b')],['source-c',pair('different@example.test','synthetic-secret-c')]]),
  invalidSources:new Set(), credentialReads:[], addCalls:[], updateCalls:[],
  credentialsOf(uuid,expectedEpoch){vault.credentialReads.push({uuid,expectedEpoch});if(expectedEpoch!==vault.credentialEpoch.value||vault.invalidSources.has(uuid))return null;const value=vault.sourceData.get(uuid);return value?{...value}:null;},
  draftOf(uuid){return uuid==='edit-1'?{title:'原标题',username:'edit-user',password:'edit-pass',url:'https://old.example.test',notes:'保留备注',tags:'tag',totp:'',groupUuid:'g1',expires:false,expiryDate:'',customFields:[],removedFields:[],autoTypeSequence:''}:null;},
  async addEntry(draft){vault.addCalls.push(JSON.parse(JSON.stringify(draft)));return 'created-id';},
  async updateEntry(uuid,draft){vault.updateCalls.push({uuid,draft:JSON.parse(JSON.stringify(draft))});return true;},
  closeDrawer(){drawer.value={...drawer.value,open:false};}
};
export const settings={genLength:20,genSymbols:true,genMode:'chars',genWords:6};
export const siteCalls=[];
export function websiteHost(input){try{const raw=String(input||'').trim();const url=new URL(raw.includes('://')?raw:'https://'+raw);return ['http:','https:'].includes(url.protocol)?url.host:'';}catch{return '';}}
export function canFetchSiteTitle(input){try{return new URL(String(input||'')).protocol==='https:';}catch{return false;}}
export function fetchSiteTitle(input,options){siteCalls.push({input,signal:options?.signal});return globalThis.__entrySiteTitleFetch(input,options);}
export async function mount(host,props={},mode='new',uuid=''){drawer.value={open:true,mode,uuid};vault.invalidSources.clear();vault.credentialReads.length=0;vault.addCalls.length=0;vault.updateCalls.length=0;const app=createApp(EntryDrawer,props);app.mount(host);await nextTick();await new Promise(resolve=>setTimeout(resolve,0));return app;}
export async function settle(){await nextTick();await new Promise(resolve=>setTimeout(resolve,25));}
`,
    resolveDir: project,
    loader: "ts",
  },
  bundle: true,
  platform: "browser",
  format: "esm",
  write: false,
  logLevel: "silent",
  plugins: [{
    name: "entry-convenience-fixture",
    setup(build) {
      build.onResolve({ filter: /composables\/useVault$/ }, () => ({ path: "use-vault-fixture", namespace: "entry-fixture" }));
      build.onResolve({ filter: /lib\/site-title$/ }, () => ({ path: "site-title-fixture", namespace: "entry-fixture" }));
      build.onLoad({ filter: /.*/, namespace: "entry-fixture" }, ({ path }) => ({
        loader: "js",
        contents: path === "use-vault-fixture"
          ? "export const useVault=()=>globalThis.__entryVault; export const settings=globalThis.__entrySettings;"
          : `export const websiteHost=input=>globalThis.__entryWebsiteHost(input);export const canFetchSiteTitle=input=>globalThis.__entryCanFetchSiteTitle(input);export const fetchSiteTitle=(input,options)=>globalThis.__entrySiteTitleFetch(input,options);`,
      }));
      build.onLoad({ filter: /\.vue$/ }, async ({ path }) => {
        const { descriptor } = parse(await (await import("node:fs/promises")).readFile(path, "utf8"), { filename: path });
        return { contents: compileScript(descriptor, { id: path, inlineTemplate: true }).content, loader: "ts", resolveDir: dirname(path) };
      });
    },
  }],
});
const moduleCode = result.outputFiles[0].text;

await withBrowser(async ({ evaluate, send }) => {
  const checks = await evaluate(`(async()=>{
    document.querySelector('#app')?.__vue_app__?.unmount();
    document.body.replaceChildren();
    globalThis.__entryVault=undefined;globalThis.__entrySettings=undefined;
    const url=URL.createObjectURL(new Blob([${JSON.stringify(moduleCode)}],{type:'text/javascript'}));
    const ui=await import(url);URL.revokeObjectURL(url);
    globalThis.__entryVault=ui.vault;globalThis.__entrySettings=ui.settings;globalThis.__entryUi=ui;
    globalThis.__entryWebsiteHost=ui.websiteHost;globalThis.__entryCanFetchSiteTitle=ui.canFetchSiteTitle;
    globalThis.__entrySiteTitleFetch=(input,options)=>{ui.siteCalls.push({input,signal:options?.signal});return globalThis.__entryTitleBehavior(input,options);};
    globalThis.__entryTitleBehavior=async()=>null;
    const host=document.createElement('div');host.style='position:fixed;inset:0 auto 0 0;width:min(720px,100vw);height:100vh';document.body.append(host);
    const input=(id)=>host.querySelector('#'+id);
    const fill=(el,value)=>{el.value=value;el.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));};
    const clickText=(root,text)=>[...root.querySelectorAll('button')].find(button=>button.textContent.trim()===text);
    ui.vault.pendingUsername.value='category-user';
    let app=await ui.mount(host);await ui.settle();
    const prefilledAccount=input('entry-username').value==='category-user'&&input('entry-password').value==='';
    ui.vault.pendingUsername.value='changed-after-open';
    const prefillContextSnapshot=input('entry-username').value==='category-user';
    const prefillNoSave=ui.vault.addCalls.length===0;
    clickText(host,'取消')?.click();await ui.settle();
    const prefillCancelNoWarning=!host.querySelector('[data-dialog-confirmation]')&&!ui.vault.drawer.value.open;
    app.unmount();host.replaceChildren();ui.vault.pendingUsername.value='';
    app=await ui.mount(host);await ui.settle();
    const fields=[...host.querySelectorAll('#entry-url,#entry-title,#entry-username,#entry-password')].map(el=>el.id);
    const firstNewFocus=document.activeElement===input('entry-url');
    fill(input('entry-url'),'https://first.example.test/login');await ui.settle();
    const autoTitle=input('entry-title').value==='first.example.test';fill(input('entry-url'),'https://updated.example.test/path');await ui.settle();const autoTitleUpdates=input('entry-title').value==='updated.example.test';fill(input('entry-url'),'https://first.example.test/login');await ui.settle();
    fill(input('entry-password'),'untouched-pass');fill(input('entry-username'),'ali');await ui.settle();
    const usernameInput=input('entry-username');
    const duplicatesDeduped=[...host.querySelectorAll('[role="option"]')].filter(option=>option.textContent.includes('alice@example.test')).length===1;
    usernameInput.focus();await ui.settle();usernameInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await ui.settle();const autocompleteEscapeClosed=!host.querySelector('[role="listbox"]')&&ui.vault.drawer.value.open;
    usernameInput.blur();usernameInput.focus();await ui.settle();usernameInput.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));usernameInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));await ui.settle();
    const usernameCompletion=usernameInput.value==='alice@example.test'&&input('entry-password').value==='untouched-pass';const suggestionsClosed=!host.querySelector('[role="listbox"]');
    fill(input('entry-username'),'');fill(input('entry-password'),'');const credentialButton=clickText(host,'复用已有账号密码');credentialButton?.click();await ui.settle();
    const picker=()=>document.querySelector('[data-testid="credential-picker"]');
    const pickerPublic=!!picker()&&picker().textContent.includes('样例邮箱')&&picker().textContent.includes('same@example.test')&&picker().textContent.includes('mail.example.test')&&picker().textContent.includes('其他账号')&&!picker().textContent.includes('synthetic-secret-a')&&!picker().textContent.includes('synthetic-secret-b')&&!picker().textContent.includes('synthetic-secret-c')&&!picker().outerHTML.includes('lastUsedAt');
    const candidateIds=()=>[...(picker()?.querySelectorAll('[data-testid="credential-candidate"]')||[])].map(candidate=>candidate.getAttribute('data-source'));
    const pickerRecentOrder=JSON.stringify(candidateIds())===JSON.stringify(['source-c','source-a','source-b']);
    const searchInput=picker()?.querySelector('#credential-picker-search');fill(searchInput,'different@example.test');await ui.settle();
    const pickerSearchUnhidesOtherAccount=picker()?.querySelectorAll('[data-testid="credential-candidate"][data-source="source-c"]').length===1;
    fill(searchInput,'');await ui.settle();clickText(picker(),'取消')?.click();await ui.settle();
    fill(input('entry-username'),'same@example.test');
    clickText(host,'复用已有账号密码')?.click();await ui.settle();
    const pickerAccountPriority=JSON.stringify(candidateIds())===JSON.stringify(['source-a','source-b','source-c']);
    const sameUserSources=picker()?.querySelectorAll('[data-testid="credential-candidate"]').length===3;
    const selected=picker()?.querySelector('[data-testid="credential-candidate"][data-source="source-a"]');selected?.click();await ui.settle();
    const reusedOnlyPair=input('entry-username').value==='same@example.test'&&input('entry-password').value==='synthetic-secret-a'&&input('entry-password').type==='password'&&input('entry-url').value==='https://first.example.test/login'&&input('entry-title').value==='first.example.test'&&ui.vault.addCalls.length===0;
    const pairWasReadOnDemand=ui.vault.credentialReads.length===1&&ui.vault.credentialReads[0].uuid==='source-a'&&ui.vault.credentialReads[0].expectedEpoch===7;

    fill(input('entry-username'),'manual-user');fill(input('entry-password'),'manual-pass');
    clickText(host,'复用已有账号密码')?.click();await ui.settle();
    picker()?.querySelector('[data-testid="credential-candidate"][data-source="source-b"]')?.click();await ui.settle();
    const replacement=()=>host.querySelector('[data-testid="credential-replacement-confirm"]');
    const conflictShown=!!replacement()&&input('entry-username').value==='manual-user'&&input('entry-password').value==='manual-pass';
    clickText(replacement(),'取消')?.click();await ui.settle();
    const cancelKeepsDraft=input('entry-username').value==='manual-user'&&input('entry-password').value==='manual-pass';
    clickText(host,'复用已有账号密码')?.click();await ui.settle();
    picker()?.querySelector('[data-testid="credential-candidate"][data-source="source-b"]')?.click();await ui.settle();
    ui.vault.invalidSources.add('source-b');
    clickText(replacement(),'替换账号和密码')?.click();await ui.settle();
    const invalidSourceRejected=input('entry-username').value==='manual-user'&&input('entry-password').value==='manual-pass';
    const confirmedPairReread=ui.vault.credentialReads.filter(read=>read.uuid==='source-b').length===3;
    ui.vault.invalidSources.delete('source-b');
    clickText(host,'复用已有账号密码')?.click();await ui.settle();
    picker()?.querySelector('[data-testid="credential-candidate"][data-source="source-b"]')?.click();await ui.settle();
    clickText(replacement(),'替换账号和密码')?.click();await ui.settle();
    const confirmedReplacement=input('entry-username').value==='same@example.test'&&input('entry-password').value==='synthetic-secret-b'&&input('entry-password').type==='password'&&input('entry-url').value==='https://first.example.test/login'&&ui.vault.addCalls.length===0;
    const noSecretAttributes=!host.outerHTML.includes('synthetic-secret-a')&&!host.outerHTML.includes('synthetic-secret-b');
    app.unmount();host.replaceChildren();
    const similarSource={uuid:'similar-1',title:'Existing similar title',username:'similar-user',url:'https://similar.example.test/old',groupUuid:'g1',inTrash:false,password:'never-show-similar-secret',totp:'never-show-similar-totp',notes:'private-note'};
    ui.vault.entries.value=[similarSource,{uuid:'trashed-similar',title:'Trash only',username:'similar-user',url:'https://similar.example.test/trash',groupUuid:'g1',inTrash:true}];
    ui.vault.pendingUsername.value='';
    app=await ui.mount(host);await ui.settle();
    fill(input('entry-url'),'http://similar.example.test/new');await ui.settle();
    fill(input('entry-title'),'Unsaved similar draft');
    fill(input('entry-username'),'similar-user');
    fill(input('entry-password'),'draft-secret');await ui.settle();
    const similarToggle=()=>host.querySelector('[data-testid="similar-entry-toggle"]');
    const similarVisible=similarToggle()?.textContent.trim()==='已有相似条目 · 查看';
    similarToggle()?.click();await ui.settle();
    const preview=()=>host.querySelector('[data-testid="similar-entry-preview"]');
    const similarPreviewPublic=!!preview()&&preview().textContent.includes('Existing similar title')&&preview().textContent.includes('similar-user')&&preview().textContent.includes('similar.example.test')&&preview().textContent.includes('合成分组')&&!preview().outerHTML.includes('never-show-similar-secret')&&!preview().outerHTML.includes('never-show-similar-totp')&&!preview().outerHTML.includes('private-note');
    const draftSnapshot=()=>[input('entry-url').value,input('entry-title').value,input('entry-username').value,input('entry-password').value];
    const unchangedAfterPreview=JSON.stringify(draftSnapshot())===JSON.stringify(['http://similar.example.test/new','Unsaved similar draft','similar-user','draft-secret'])&&ui.vault.drawer.value.mode==='new'&&ui.vault.updateCalls.length===0;
    fill(input('entry-username'),'different-user');await ui.settle();
    const similarCollapsedOnUsernameChange=!similarToggle();
    fill(input('entry-username'),'similar-user');await ui.settle();
    const similarCollapsedAfterUsernameRestore=similarToggle()?.getAttribute('aria-expanded')==='false';
    similarToggle()?.click();await ui.settle();
    fill(input('entry-url'),'http://unmatched.example.test/new');await ui.settle();
    const similarCollapsedOnUrlChange=!similarToggle();
    fill(input('entry-url'),'http://similar.example.test/new');await ui.settle();
    const similarCollapsedAfterUrlRestore=similarToggle()?.getAttribute('aria-expanded')==='false';
    similarToggle()?.click();await ui.settle();
    ui.vault.entries.value=[];await ui.settle();
    const similarUpdateClearsStalePreview=!similarToggle()&&!preview();
    ui.vault.entries.value=[similarSource];await ui.settle();
    const similarUpdateRecomputed=!!preview()&&preview().textContent.includes('Existing similar title');
    const unchangedAfterUpdates=JSON.stringify(draftSnapshot())===JSON.stringify(['http://similar.example.test/new','Unsaved similar draft','similar-user','draft-secret']);
    clickText(host,'保存')?.click();await ui.settle();
    const savedSimilarDraft=ui.vault.addCalls.at(-1);
    const similarDoesNotBlockSave=ui.vault.addCalls.length===1&&savedSimilarDraft?.username==='similar-user'&&savedSimilarDraft?.password==='draft-secret'&&savedSimilarDraft?.title==='Unsaved similar draft'&&savedSimilarDraft?.url==='http://similar.example.test/new'&&!ui.vault.drawer.value.open;
    app.unmount();host.replaceChildren();ui.vault.entries.value=[];



    const waitForTitle=async()=>{await new Promise(resolve=>setTimeout(resolve,600));await ui.settle();};
    ui.siteCalls.length=0;
    app=await ui.mount(host,{},'edit','edit-1');await ui.settle();
    const editOrder=[...host.querySelectorAll('#entry-url,#entry-title,#entry-username,#entry-password')].map(el=>el.id);
    const editPreserved=input('entry-title').value==='原标题'&&input('entry-url').value==='https://old.example.test'&&input('entry-username').value==='edit-user'&&input('entry-password').value==='edit-pass'&&input('entry-password').type==='password'&&!host.querySelector('#entry-username[role="combobox"]');
    fill(input('entry-url'),'https://new-edit.example.test');await waitForTitle();
    const editTitleNotAutofilled=input('entry-title').value==='原标题';
    const editTitleNoFetch=ui.siteCalls.length===0&&!host.querySelector('[data-testid="fetch-site-title"]');
    app.unmount();host.replaceChildren();

    app=await ui.mount(host,{clipboardDraft:{title:'剪贴板标题',username:'clip-user',password:'clip-pass',url:'https://clip.example.test',notes:''}});await ui.settle();
    fill(input('entry-url'),'https://changed-clip.example.test');await waitForTitle();
    const clipboardTitlePreserved=input('entry-title').value==='剪贴板标题'&&ui.siteCalls.length===0;
    clickText(host,'取消')?.click();await ui.settle();const clipboardDiscardConfirmation=!!host.querySelector('[data-continue-editing]');
    app.unmount();host.replaceChildren();

    let resolveFetch;
    globalThis.__entryTitleBehavior=()=>new Promise(resolve=>{resolveFetch=resolve;});
    ui.vault.pendingUsername.value='clipboard-fallback';
    app=await ui.mount(host,{clipboardDraft:{title:'',username:'',password:'',url:'https://empty-clip.example.test',notes:''}});await ui.settle();
    const emptyClipboardGetsFallback=input('entry-title').value==='empty-clip.example.test';
    const clipboardEmptyOverrides=input('entry-username').value===''&&input('entry-password').value==='';
    const noTitleButton=!host.querySelector('[data-testid="fetch-site-title"]');
    await waitForTitle();
    const autoFetchStarted=ui.siteCalls.length===1&&ui.siteCalls[0].input==='https://empty-clip.example.test';
    resolveFetch?.('服务端标题');await ui.settle();
    const directTitle=input('entry-title').value==='服务端标题'&&ui.vault.addCalls.length===0;
    app.unmount();host.replaceChildren();ui.vault.pendingUsername.value='';

    ui.siteCalls.length=0;app=await ui.mount(host);await ui.settle();
    globalThis.__entryTitleBehavior=async()=> '防抖后标题';
    fill(input('entry-url'),'https://typing-one.example.test');await ui.settle();
    fill(input('entry-url'),'https://typing-two.example.test');await ui.settle();
    fill(input('entry-url'),'https://typing-final.example.test');await waitForTitle();
    const debouncedSingleRequest=ui.siteCalls.length===1&&ui.siteCalls[0].input==='https://typing-final.example.test'&&input('entry-title').value==='防抖后标题';
    app.unmount();host.replaceChildren();

    ui.siteCalls.length=0;app=await ui.mount(host);await ui.settle();
    fill(input('entry-url'),'https://manual.example.test');fill(input('entry-title'),'用户自定义');await waitForTitle();
    const manualBeforeRequest=ui.siteCalls.length===0&&input('entry-title').value==='用户自定义';
    app.unmount();host.replaceChildren();

    ui.siteCalls.length=0;app=await ui.mount(host);await ui.settle();
    let resolveManual;
    globalThis.__entryTitleBehavior=()=>new Promise(resolve=>{resolveManual=resolve;});
    fill(input('entry-url'),'https://manual-pending.example.test');await waitForTitle();
    const manualRequest=ui.siteCalls.at(-1);
    fill(input('entry-title'),'等待中的自定义标题');await ui.settle();
    resolveManual?.('迟到的网站建议');await ui.settle();
    const manualDuringRequest=manualRequest?.signal?.aborted===true&&input('entry-title').value==='等待中的自定义标题'&&!host.textContent.includes('迟到的网站建议');
    fill(input('entry-url'),'https://manual-new.example.test');await waitForTitle();
    const manualStopsFuture=ui.siteCalls.length===1&&input('entry-title').value==='等待中的自定义标题';
    app.unmount();host.replaceChildren();

    app=await ui.mount(host);await ui.settle();
    let resolveLate;
    globalThis.__entryTitleBehavior=()=>new Promise(resolve=>{resolveLate=resolve;});
    fill(input('entry-url'),'https://pending.example.test');await waitForTitle();
    const lateRequest=ui.siteCalls.at(-1);const resolveOldUrl=resolveLate;
    fill(input('entry-url'),'https://replacement.example.test');await ui.settle();
    const urlAborted=lateRequest?.signal?.aborted===true;
    resolveOldUrl?.('迟到标题');await ui.settle();
    const urlLateRejected=input('entry-title').value==='replacement.example.test'&&!host.textContent.includes('迟到标题');
    await waitForTitle();
    const epochRequest=ui.siteCalls.at(-1);
    ui.vault.credentialEpoch.value++;await ui.settle();
    const epochAborted=epochRequest?.signal?.aborted===true;
    resolveLate?.('跨会话迟到标题');await ui.settle();
    const epochLateRejected=!host.textContent.includes('跨会话迟到标题');
    app.unmount();host.replaceChildren();

    ui.vault.credentialEpoch.value=7;app=await ui.mount(host);await ui.settle();
    fill(input('entry-url'),'https://unmount.example.test');await waitForTitle();
    const unmountRequest=ui.siteCalls.at(-1);app.unmount();await ui.settle();
    const unmountAborted=unmountRequest?.signal?.aborted===true;
    resolveLate?.('卸载后迟到标题');await ui.settle();host.replaceChildren();

    ui.siteCalls.length=0;app=await ui.mount(host);await ui.settle();
    fill(input('entry-url'),'https://cancel-debounce.example.test');await ui.settle();
    app.unmount();await waitForTitle();
    const pendingDebounceCancelled=ui.siteCalls.length===0;host.replaceChildren();

    app=await ui.mount(host);await ui.settle();
    fill(input('entry-url'),'http://offline.example.test');await waitForTitle();
    const nonHttpsNoFetch=ui.siteCalls.length===0&&input('entry-title').value==='offline.example.test';
    globalThis.__entryTitleBehavior=async()=> null;
    fill(input('entry-url'),'https://offline.example.test');await waitForTitle();
    const offlineFallback=ui.siteCalls.length===1&&input('entry-title').value==='offline.example.test'&&!clickText(host,'保存').disabled;
    app.unmount();host.remove();
    return {fields,firstNewFocus,prefilledAccount,prefillContextSnapshot,prefillNoSave,prefillCancelNoWarning,autoTitle,autoTitleUpdates,usernameCompletion,suggestionsClosed,autocompleteEscapeClosed,duplicatesDeduped,pickerPublic,pickerRecentOrder,pickerSearchUnhidesOtherAccount,pickerAccountPriority,sameUserSources,reusedOnlyPair,pairWasReadOnDemand,conflictShown,cancelKeepsDraft,invalidSourceRejected,confirmedPairReread,confirmedReplacement,noSecretAttributes,similarVisible,similarPreviewPublic,unchangedAfterPreview,similarCollapsedOnUsernameChange,similarCollapsedAfterUsernameRestore,similarCollapsedOnUrlChange,similarCollapsedAfterUrlRestore,similarUpdateClearsStalePreview,similarUpdateRecomputed,unchangedAfterUpdates,similarDoesNotBlockSave,editOrder,editPreserved,editTitleNotAutofilled,editTitleNoFetch,clipboardTitlePreserved,clipboardDiscardConfirmation,emptyClipboardGetsFallback,clipboardEmptyOverrides,noTitleButton,autoFetchStarted,directTitle,debouncedSingleRequest,manualBeforeRequest,manualDuringRequest,manualStopsFuture,urlAborted,urlLateRejected,epochAborted,epochLateRejected,unmountAborted,pendingDebounceCancelled,nonHttpsNoFetch,offlineFallback};
  })()`);
  console.log(JSON.stringify(checks, null, 2));
  assert.deepEqual(checks.fields, ["entry-url", "entry-title", "entry-username", "entry-password"], "primary fields are ordered URL, title, username, password");
  assert.deepEqual(checks.editOrder, checks.fields, "edit uses the same primary field order");
  for (const key of ["firstNewFocus", "prefilledAccount", "prefillContextSnapshot", "prefillNoSave", "prefillCancelNoWarning", "autoTitle", "autoTitleUpdates", "usernameCompletion", "suggestionsClosed", "autocompleteEscapeClosed", "duplicatesDeduped", "pickerPublic", "pickerRecentOrder", "pickerSearchUnhidesOtherAccount", "pickerAccountPriority", "sameUserSources", "reusedOnlyPair", "pairWasReadOnDemand", "conflictShown", "cancelKeepsDraft", "invalidSourceRejected", "confirmedPairReread", "confirmedReplacement", "noSecretAttributes", "similarVisible", "similarPreviewPublic", "unchangedAfterPreview", "similarCollapsedOnUsernameChange", "similarCollapsedAfterUsernameRestore", "similarCollapsedOnUrlChange", "similarCollapsedAfterUrlRestore", "similarUpdateClearsStalePreview", "similarUpdateRecomputed", "unchangedAfterUpdates", "similarDoesNotBlockSave", "editPreserved", "editTitleNotAutofilled", "editTitleNoFetch", "clipboardTitlePreserved", "clipboardDiscardConfirmation", "emptyClipboardGetsFallback", "clipboardEmptyOverrides", "noTitleButton", "autoFetchStarted", "directTitle", "debouncedSingleRequest", "manualBeforeRequest", "manualDuringRequest", "manualStopsFuture", "urlAborted", "urlLateRejected", "epochAborted", "epochLateRejected", "unmountAborted", "pendingDebounceCancelled", "nonHttpsNoFetch", "offlineFallback"]) assert.equal(checks[key], true, key);
  const suggestionsOpen = await evaluate(`(async()=>{
    const ui=globalThis.__entryUi;
    const host=document.createElement('div');document.body.append(host);
    globalThis.__entryTabHost=host;globalThis.__entryTabApp=await ui.mount(host);
    const input=host.querySelector('#entry-username');input.value='ali';input.dispatchEvent(new Event('input',{bubbles:true}));
    await ui.settle();input.focus();await ui.settle();return !!host.querySelector('[role="listbox"]');
  })()`);
  assert.equal(suggestionsOpen, true, 'Tab regression starts with visible username candidates');
  await send('Input.dispatchKeyEvent', {type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9});
  await send('Input.dispatchKeyEvent', {type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9,nativeVirtualKeyCode:9});
  const tabState = await evaluate(`(async()=>{await globalThis.__entryUi.settle();return {focus:document.activeElement?.id,listClosed:!globalThis.__entryTabHost.querySelector('[role="listbox"]')}})()`);
  console.log(JSON.stringify({usernameTab:tabState}));
  assert.equal(tabState.focus, 'entry-password', 'Tab proceeds from username to password without losing focus');
  assert.equal(tabState.listClosed, true, 'Tab closes username suggestions');
  await evaluate(`globalThis.__entryTabApp.unmount();globalThis.__entryTabHost.remove();delete globalThis.__entryUi;`);
});
