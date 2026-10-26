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
  if (process.env.KEYTREE_TEST_UI_ONLY === '1') {
    const uiResult = await evaluate(`(async () => {
      const {createApp, h, nextTick} = await import('/node_modules/.vite/deps/vue.js');
      const {default:Preview} = await import('/src/components/ClipboardRecognition.vue');
      const recognition = {
        records: [0, 1].map(() => ({ title: '', username: '', password: '', url: '', notes: '', evidence: [], warnings: [], candidates: {
          username: [
            { value: 'UI_USER_ALPHA', evidence: ['第 1 行账号字段'], requiresConfirmation: true },
            { value: 'UI_USER_BETA', evidence: ['第 2 行账号字段'], requiresConfirmation: true },
          ],
          password: [
            { value: 'UI_SECRET_ALPHA', evidence: ['第 1 行密码字段'], requiresConfirmation: true },
            { value: 'UI_SECRET_BETA', evidence: ['第 2 行密码字段'], requiresConfirmation: true },
          ],
        }})),
        source: { url: '', app: '' }, truncated: false,
      };
      const fixture = document.createElement('div'); document.body.appendChild(fixture);
      const emitted = [];
      const app = createApp({ render: () => h(Preview, { recognition, onAccept: (index, choices) => emitted.push({index, choices}) }) });
      app.mount(fixture); await nextTick();
      const button = fixture.querySelector('footer button:last-child');
      const radio = (field, value) => fixture.querySelector('input[name="clipboard-choice-' + field + '"][value="' + value + '"]');
      const secrets = ['UI_SECRET_ALPHA', 'UI_SECRET_BETA'];
      const attributesSafe = () => [...fixture.querySelectorAll('*')].every(element => [...element.attributes].every(attribute => !secrets.some(secret => attribute.value.includes(secret))));
      const initialDisabled = button.disabled && button.textContent.includes('还需选择 2 项');
      const genericCluePrompt = fixture.textContent.includes('检测到字段线索，请确认或补充');
      const multipleAccountsWarning = fixture.textContent.includes('系统不会自动配对');
      const noDefaultCandidate = !fixture.querySelector('input[name="clipboard-choice-username"]:checked')
        && !fixture.querySelector('input[name="clipboard-choice-password"]:checked');
      const maskedInitially = secrets.every(secret => !fixture.textContent.includes(secret)) && attributesSafe();
      radio('username', 0).click(); await nextTick();
      radio('password', 0).click(); await nextTick();
      const indexZeroEnabled = !button.disabled;
      button.click(); await nextTick();
      const indexZeroEmitted = JSON.stringify(emitted[0]) === JSON.stringify({index: 0, choices: {username: 0, password: 0}});
      [...fixture.querySelectorAll('button')].find(item => item.textContent.trim() === '显示密码').click(); await nextTick();
      const revealed = fixture.textContent.includes('UI_SECRET_ALPHA') && attributesSafe();
      [...fixture.querySelectorAll('button')].find(item => item.textContent.trim() === '隐藏密码').click(); await nextTick();
      const hidden = secrets.every(secret => !fixture.textContent.includes(secret));
      radio('password', 1).click(); await nextTick();
      const switchCandidateMasks = secrets.every(secret => !fixture.textContent.includes(secret));
      const indexOnePasswordEnabled = !button.disabled;
      button.click(); await nextTick();
      const indexOnePasswordEmitted = JSON.stringify(emitted[1]) === JSON.stringify({index: 0, choices: {username: 0, password: 1}});
      [...fixture.querySelectorAll('button')].find(item => item.textContent.trim() === '显示密码').click(); await nextTick();
      const revealSelectedOne = fixture.textContent.includes('UI_SECRET_BETA');
      [...fixture.querySelectorAll('button')].find(item => item.textContent.trim() === '隐藏密码').click(); await nextTick();
      const hiddenAgain = secrets.every(secret => !fixture.textContent.includes(secret));
      [...fixture.querySelectorAll('button')].find(item => item.textContent.trim() === '显示密码').click(); await nextTick();
      radio('password', -1).click(); await nextTick();
      const ignoreMasks = secrets.every(secret => !fixture.textContent.includes(secret));
      radio('username', 1).click(); await nextTick();
      radio('password', 0).click(); await nextTick();
      [...fixture.querySelectorAll('button')].find(item => item.textContent.trim() === '显示密码').click(); await nextTick();
      fixture.querySelector('input[name="clipboard-record"][value="1"]').click(); await nextTick();
      const recordSwitchResets = button.disabled
        && !fixture.querySelector('input[name="clipboard-choice-username"]:checked')
        && !fixture.querySelector('input[name="clipboard-choice-password"]:checked')
        && secrets.every(secret => !fixture.textContent.includes(secret));
      radio('username', 1).click(); await nextTick();
      const secondIndexStillNeedsChoice = button.disabled;
      radio('password', -1).click(); await nextTick();
      const explicitEmptyEnables = !button.disabled;
      button.click(); await nextTick();
      const indexOneAndEmptyEmitted = JSON.stringify(emitted[2]) === JSON.stringify({index: 1, choices: {username: 1, password: -1}});
      const dialogAccessible = fixture.querySelector('[role="dialog"][aria-modal="true"]') !== null;
      app.unmount(); fixture.remove();
      return {initialDisabled, genericCluePrompt, multipleAccountsWarning, noDefaultCandidate, maskedInitially, indexZeroEnabled, indexZeroEmitted, revealed, hidden, switchCandidateMasks, indexOnePasswordEnabled, indexOnePasswordEmitted, revealSelectedOne, hiddenAgain, ignoreMasks, recordSwitchResets, secondIndexStillNeedsChoice, explicitEmptyEnables, indexOneAndEmptyEmitted, dialogAccessible};
    })()`);
    for (const [name, passed] of Object.entries(uiResult)) assert.equal(passed, true, name);
    console.log(`PASS ${Object.keys(uiResult).length} isolated UI checks (synthetic data; no parser assertions or clipboard access)`);
    await send('Browser.close');
  } else {
  const result = await evaluate(`(async () => {
    const {recognizeClipboard,resolveClipboardRecord} = await import('/src/lib/clipboard-capture.ts');
    const snap = html => ({sequence:1,text:'',html,sourceUrl:'https://sheet.example.test/doc?token=hidden',sourceApp:'chrome.exe'});
    const horizontal = recognizeClipboard(snap('<table><tr><th>账号</th><th>密码</th></tr><tr><td>demo</td><td> SYNTHETIC &amp; test </td></tr></table>'));
    const vertical = recognizeClipboard(snap('<table><tr><td>账号</td><td>demo</td></tr><tr><td>密码</td><td>SYNTHETIC</td></tr></table>'));
    const fragment = recognizeClipboard(snap('<tr><th>账号</th><th>密码</th></tr><tr><td>demo</td><td>SYNTHETIC</td></tr>'));
    const multiline = recognizeClipboard(snap('<table><tr><td>账号</td><td>demo</td></tr><tr><td>密码</td><td> SYNTHETIC<br>next </td></tr></table>'));
    const merged = recognizeClipboard(snap('<table><tr><th>账号</th><th>密码</th></tr><tr><td colspan="2">ambiguous</td></tr></table>'));
    const browserDetail = recognizeClipboard({ ...snap('<credential-field id="username"><cr-input><input type="text" value="demo"></cr-input></credential-field><cr-input id="passwordInput"><input type="text" value=" SYNTHETIC &amp; : test "></cr-input>'), text: 'demo\\nSYNTHETIC', sourceUrl: 'chrome://password-manager/passwords/123' });
    const detail = html => recognizeClipboard({ ...snap(html), sourceUrl: 'chrome://password-manager/passwords/123' });
    const emptyDetail = detail('<credential-field id="usernameValue"><div slot="label">用户名</div><cr-input><input type="text"></cr-input><button>复制用户名</button></credential-field><cr-input id="passwordValue"><div slot="label">密码</div><input type="text"></cr-input><credential-note id="noteValue"><div slot="label">备注</div><button>添加备注</button></credential-note>');
    const maskedDetail = detail('<credential-field id="username" value="demo"></credential-field><cr-input id="passwordInput"><input value="••••••••"></cr-input>');
    const duplicateDetail = detail('<credential-field id="username" value="first"></credential-field><credential-field id="username" value="second"></credential-field><cr-input id="passwordInput" value="SYNTHETIC"></cr-input>');
    const conflictingDetail = detail('<credential-field id="username" value="demo"><input value="different"></credential-field><cr-input id="passwordInput"><input value="SYNTHETIC"></cr-input>');
    const ordinaryForm = recognizeClipboard(snap('<credential-field id="username" value="demo"></credential-field><cr-input id="passwordInput" value="SYNTHETIC"></cr-input>'));
    const detailWithWebsite = detail('<credential-field id="username" value="demo"></credential-field><cr-input id="passwordInput" value=" SYNTHETIC "></cr-input><div id="websites"><a href="https://login.example.test/account">login.example.test</a></div><credential-note id="note"><textarea>测试备注</textarea></credential-note>');
    const valueIdDetail = detail('<credential-field id="usernameValue"><input value="demo"></credential-field><cr-input id="passwordValue"><input value=" SYNTHETIC "></cr-input><credential-note id="noteValue"><textarea>保留备注</textarea></credential-note>');
    const mixedSources = recognizeClipboard({ ...snap('<input autocomplete="username" value="html-user"><input type="password" value="HTML_SYNTHETIC">'), text: '账号:text-user\\n密码:TEXT_SYNTHETIC' });
    const deduplicated = recognizeClipboard({ ...snap('<input name="username" value="demo"><input type="password" value="SYNTHETIC">'), text: '用户名\\ndemo\\n密码\\nSYNTHETIC' });
    const genericLabels = recognizeClipboard(snap('<label for="u">用户名</label><input id="u" value="demo"><label for="p">密码</label><input id="p" value="SYNTHETIC">'));
    const genericNeighbours = recognizeClipboard(snap('<dl><dt>账号</dt><dd>demo</dd><dt>密码</dt><dd>SYNTHETIC</dd></dl>'));
    const splitPlainText = recognizeClipboard({ ...snap('<credential-field id="usernameValue"><input></credential-field><cr-input id="passwordValue"><input></cr-input>'), sourceUrl:null, text:'用户名\\ndemo\\n网站\\nhttps://login.example.test\\n密码\\n SYNTHETIC:a,b \\n备注' });
    const crossSourcePair = recognizeClipboard({ ...snap('<input autocomplete="current-password" value="SYNTHETIC">'), text:'账号:demo' });
    const conflictingSemantic = recognizeClipboard(snap('<div name="username"><input autocomplete="username" name="password" value="MUST_NOT_IMPORT"></div><input type="password" value="SYNTHETIC">'));
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
    const incompleteFixture = document.createElement('div'); document.body.appendChild(incompleteFixture);
    const incompleteEvents = [];
    const incompleteApp = createApp({render:()=>h(Preview,{recognition:emptyDetail,onAccept:index=>incompleteEvents.push(index)})});
    incompleteApp.mount(incompleteFixture); await nextTick();
    const incompletePromptVisible = incompleteFixture.textContent.includes('检测到字段线索，请确认或补充')
      && incompleteFixture.textContent.includes('未包含可确定的账号值')
      && incompleteFixture.textContent.includes('未包含可确定的密码值');
    const completeManually = [...incompleteFixture.querySelectorAll('button')].find(button=>button.textContent.trim()==='打开新增页补充');
    completeManually?.click();
    const incompleteOpensDraftOnly = incompleteEvents.join(',')==='0';
    incompleteApp.unmount(); incompleteFixture.remove();
    return {
      horizontal: horizontal?.records[0].username==='demo' && horizontal?.records[0].password===' SYNTHETIC & test ',
      vertical: vertical?.records[0].username==='demo' && vertical?.records[0].password==='SYNTHETIC',
      fragment: fragment?.records[0].username==='demo', mergedRejected: merged===null,
      multilinePreserved: multiline?.records[0].password===' SYNTHETIC\\nnext ',
      browserDetailControls: browserDetail?.records[0].username==='demo' && browserDetail?.records[0].password===' SYNTHETIC & : test ' && browserDetail?.records[0].url==='',
      missingDetailValuesPrompt: emptyDetail?.records[0].username==='' && emptyDetail?.records[0].password==='' && emptyDetail?.records[0].warnings.some(w=>w.includes('未包含')),
      detailLabelsNotValues: emptyDetail?.records[0].title==='' && emptyDetail?.records[0].notes==='',
      detailValueIdVariants: valueIdDetail?.records[0].username==='demo' && valueIdDetail?.records[0].password===' SYNTHETIC ' && valueIdDetail?.records[0].notes==='保留备注',
      detailMaskedPasswordNotImported: maskedDetail?.records[0].username==='demo' && maskedDetail?.records[0].password==='',
      duplicateDetailCandidates: duplicateDetail?.records[0].username==='' && duplicateDetail?.records[0].candidates.username.length===2 && resolveClipboardRecord(duplicateDetail.records[0])===null,
      conflictingDetailFieldOmitted: conflictingDetail?.records[0].username==='' && conflictingDetail?.records[0].password==='SYNTHETIC' && conflictingDetail?.records[0].candidates.username.length===2,
      ordinaryCustomFormRecognizedBySemantics: ordinaryForm?.records[0].username==='demo' && ordinaryForm?.records[0].password==='SYNTHETIC',
      detailExplicitWebsiteAndNotes: detailWithWebsite?.records[0].url==='https://login.example.test/account' && detailWithWebsite?.records[0].notes==='测试备注',
      internalSourceOnly: emptyDetail?.source.url==='chrome://password-manager' && emptyDetail?.records[0].url==='',
      splitPlainTextComplementsEmptyHtml: splitPlainText?.records[0].username==='demo' && splitPlainText?.records[0].password===' SYNTHETIC:a,b ' && splitPlainText?.records[0].url==='https://login.example.test',
      textHtmlConflictRequiresChoice: mixedSources?.records[0].candidates.username.length===2 && mixedSources?.records[0].candidates.password.length===2 && resolveClipboardRecord(mixedSources.records[0])===null,
      sameValuesDeduplicate: deduplicated?.records[0].candidates.username.length===1 && deduplicated?.records[0].candidates.password.length===1,
      labelsAndInputsRecognized: genericLabels?.records[0].username==='demo' && genericLabels?.records[0].password==='SYNTHETIC',
      labelledNeighboursRecognized: genericNeighbours?.records[0].username==='demo' && genericNeighbours?.records[0].password==='SYNTHETIC',
      crossSourcePairNeedsExplicitConfirmation: !!crossSourcePair && crossSourcePair.records[0].username==='' && crossSourcePair.records[0].password==='' && resolveClipboardRecord(crossSourcePair.records[0])===null && resolveClipboardRecord(crossSourcePair.records[0],{username:0,password:0})?.username==='demo',
      conflictingOwnMarkerNotInherited: conflictingSemantic?.records[0].username==='' && !conflictingSemantic?.records[0].candidates.username?.some(candidate=>candidate.value==='MUST_NOT_IMPORT'),
      incompletePromptVisible, incompleteOpensDraftOnly,
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
  if (process.env.KEYTREE_TEST_UI_ONLY !== '1' && process.env.KEYTREE_TEST_SCREENSHOT) {
    await send("Emulation.setDeviceMetricsOverride", { width: 1080, height: 940, deviceScaleFactor: 1, mobile: false });
    const capture = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(process.env.KEYTREE_TEST_SCREENSHOT, Buffer.from(capture.data, "base64"));
    console.log("Synthetic preview screenshot saved");
  }
  await send("Browser.close");
  }
} finally {
  socket?.close();
  if (processHandle.exitCode === null && processHandle.pid) {
    try { execFileSync("taskkill", ["/PID", String(processHandle.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  }
  for (let n = 0; n < 20; n++) {
    try { await rm(directory, { recursive: true, force: true }); break; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
}
