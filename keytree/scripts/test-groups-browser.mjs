// Requires the Vite dev server. Uses synthetic groups and an isolated temporary Edge profile.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
const executable = process.env.KEYTREE_TEST_BROWSER || join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe");
await access(executable);
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "keytree-group-browser-"));
const profile = join(directory, "profile");
const browser = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let socket;
try {
  let port;
  for (let n = 0; n < 150; n++) {
    try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); if (port) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(port, "isolated browser did not start");
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
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text);
    return value.result.value;
  }
  await send("Page.navigate", { url: process.env.KEYTREE_TEST_URL || "http://127.0.0.1:1420" });
  for (let n = 0; n < 100; n++) {
    if (await evaluate("document.readyState === 'complete' && location.href.startsWith('http')")) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const result = await evaluate(`(async () => {
    const main = await (await fetch('/src/main.ts')).text();
    const vueUrl = main.split('from "')[1].split('"')[0];
    const {createApp, nextTick} = await import(vueUrl);
    const componentCode = await (await fetch('/src/components/GroupTree.vue')).text();
    const vaultUrl = componentCode.split(String.fromCharCode(10)).find(line => line.includes('composables/useVault')).split('"')[1];
    const {useVault} = await import(vaultUrl);
    const {default:GroupTree} = await import('/src/components/GroupTree.vue');
    const vault = useVault();
    document.querySelector('#app')?.__vue_app__?.unmount();
    vault.vaultPath.value = 'C:/Synthetic/SidebarDuplicateFile.kdbx';
    const names = ['这是一个需要完整展示的很长分组名称', 'VeryLongUnbrokenGroupNameForLayoutVerification'];
    vault.groups.value = [{uuid: 'hidden-root', name: 'HiddenVaultRoot', depth: 0, count: 24}, ...names.map((name, index) => ({uuid: 'sample-' + index, name, depth: 1 + index * 8, count: 12}))];
    const originalGroupCount = vault.groups.value.length;
    const fixture = document.createElement('div');
    fixture.style = 'position:fixed;inset:0 auto 0 0;width:200px;background:white;z-index:99999;display:flex';
    document.body.append(fixture);
    const app = createApp(GroupTree, {class: 'w-full min-h-0 overflow-hidden'}); app.mount(fixture); await nextTick();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const labels = names.map(name => [...fixture.querySelectorAll('span')].find(el => el.textContent === name && el.children.length === 0));
    if (labels.some(el => !el)) throw new Error('Missing synthetic group labels: ' + fixture.innerHTML);
    const layout = labels.map(el => ({name: el.textContent, width: el.clientWidth, scrollWidth: el.scrollWidth, height: el.clientHeight, scrollHeight: el.scrollHeight, overflow: getComputedStyle(el).textOverflow}));
    const root = fixture.querySelector('aside');
    const noClipping = layout.every(el => el.width > 50 && el.scrollWidth <= el.width + 1 && el.scrollHeight <= el.height + 1 && el.overflow !== 'ellipsis');
    const noOverflow = root.scrollWidth <= 200;
    const draggable = fixture.querySelectorAll('[draggable="true"]').length;
    const actions = fixture.querySelectorAll('button[title="新建子分组"]').length;
    const buttons = [...fixture.querySelectorAll('[draggable="true"]')];
    const rootHidden = !fixture.querySelector('[data-group-uuid="hidden-root"]') && !fixture.textContent.includes('HiddenVaultRoot');
    const firstLevelAligned = buttons[0].style.paddingLeft === '12px';
    const defaultAll = vault.selectedGroupUuid.value === 'all' && buttons.every(button => button.getAttribute('aria-pressed') === 'false');
    buttons[0].click(); await nextTick();
    const groupSelected = vault.selectedGroupUuid.value === 'sample-0' && buttons[0].getAttribute('aria-pressed') === 'true';
    buttons[1].click(); await nextTick();
    const groupSwitched = vault.selectedGroupUuid.value === 'sample-1' && buttons[0].getAttribute('aria-pressed') === 'false' && buttons[1].getAttribute('aria-pressed') === 'true';
    buttons[1].click(); await nextTick();
    const groupDeselected = vault.selectedGroupUuid.value === 'all' && buttons.every(button => button.getAttribute('aria-pressed') === 'false');
    const handles = buttons.map(button => button.querySelector('[data-group-drag-handle]'));
    const handleAlignment = handles.map((handle, index) => {
      if (!handle || handle.querySelectorAll('svg circle').length !== 6) return false;
      const icon = handle.getBoundingClientRect();
      const text = labels[index].getBoundingClientRect();
      const firstLineCenter = text.top + parseFloat(getComputedStyle(labels[index]).lineHeight) / 2;
      return Math.abs(icon.top + icon.height / 2 - firstLineCenter) <= 1 && getComputedStyle(handle).cursor === 'grab';
    });
    const data = new DataTransfer();
    handles[1].dispatchEvent(new DragEvent('dragstart', {bubbles: true, cancelable: true, dataTransfer: data}));
    const bounds = buttons[0].getBoundingClientRect();
    const markers = [];
    for (const ratio of [0.1, 0.5, 0.9]) {
      const event = new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: data, clientY: bounds.top + bounds.height * ratio});
      buttons[0].dispatchEvent(event); await nextTick();
      markers.push(event.defaultPrevented && (ratio === 0.5 ? buttons[0].style.outline.includes('2px') : buttons[0].style.boxShadow.includes(ratio < 0.5 ? '3px' : '-3px')));
    }
    const library = fixture.querySelector('[data-group-root]');
    const rootEvent = new DragEvent('dragover', {bubbles: true, cancelable: true, dataTransfer: data});
    library.dispatchEvent(rootEvent); await nextTick();
    const rootDrop = rootEvent.defaultPrevented && library.style.outline.includes('2px');
    handles[1].dispatchEvent(new DragEvent('dragend', {bubbles: true})); await nextTick();
    const cleared = !library.style.outline && !buttons[0].style.outline && !buttons[0].style.boxShadow;
    vault.selectGroup('sample-0');
    library.click(); await nextTick();
    const allSelected = vault.selectedGroupUuid.value === 'all' && library.getAttribute('aria-pressed') === 'true';
    const noDuplicateFileRow = !fixture.textContent.includes('SidebarDuplicateFile') && fixture.querySelectorAll('ul > li').length === names.length;
    const settle = async () => { await nextTick(); await new Promise(resolve => setTimeout(resolve, 50)); };
    const menu = () => document.querySelector('[role="menu"]');
    const openMenu = async button => {
      const rect = button.getBoundingClientRect();
      button.dispatchEvent(new MouseEvent('contextmenu', {bubbles: true, cancelable: true, button: 2, clientX: rect.left + 30, clientY: rect.top + 10}));
      await settle();
    };
    const item = text => [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.trim() === text);
    await openMenu(buttons[0]);
    const menuActions = [...document.querySelectorAll('[role="menuitem"]')].map(el => el.textContent.trim());
    const rect = menu()?.getBoundingClientRect();
    const menuVisible = !!rect && rect.width > 100 && rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
    item('删除分组')?.click(); await settle();
    const dialog = () => document.querySelector('[role="alertdialog"]');
    const confirmationKeptOpen = !!dialog() && !menu()
      && dialog().textContent.includes(names[0])
      && dialog().textContent.includes('所有子分组和条目')
      && dialog().textContent.includes('永久删除')
      && document.activeElement?.textContent.trim() === '取消';
    const dialogBounds = dialog()?.getBoundingClientRect();
    if (!dialogBounds || dialogBounds.width > innerWidth || dialogBounds.left < 0) throw new Error('delete confirmation must fit viewport');
    document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, pointerType: 'mouse', button: 0})); await settle();
    const outsideDoesNotDelete = !!dialog() && vault.groups.value.length === originalGroupCount;
    dialog()?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})); await settle();
    const escapeClosed = !menu() && !dialog() && vault.groups.value.length === originalGroupCount;
    await openMenu(buttons[0]);
    item('删除分组')?.click(); await settle();
    [...dialog().querySelectorAll('button')].find(button => button.textContent.trim() === '取消').click(); await settle();
    const cancelClosed = !dialog() && vault.groups.value.length === originalGroupCount && document.activeElement === buttons[0];
    await openMenu(buttons[0]);
    item('新建子分组')?.click(); await settle();
    const addInput = fixture.querySelector('input[placeholder="子分组名，回车确认"]');
    const addFocused = !!addInput && document.activeElement === addInput && !menu();
    addInput?.dispatchEvent(new KeyboardEvent('keyup', {key: 'Escape', bubbles: true})); await settle();
    await openMenu(buttons[0]);
    item('重命名')?.click(); await settle();
    const renameInput = fixture.querySelector('.rename-input');
    const renameFocused = !!renameInput && renameInput.value === names[0] && document.activeElement === renameInput && !menu();
    renameInput?.dispatchEvent(new KeyboardEvent('keyup', {key: 'Escape', bubbles: true})); await settle();
    await openMenu(buttons[1]);
    document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles: true, pointerType: 'mouse', button: 0})); await settle();
    const outsideClosed = !menu();
    const keyboardMenus = [];
    const currentTrigger = fixture.querySelector('[data-group-uuid="sample-0"] button');
    for (const [key, shiftKey] of [['F10', true], ['ContextMenu', false]]) {
      currentTrigger.focus();
      currentTrigger.dispatchEvent(new KeyboardEvent('keydown', {key, shiftKey, bubbles: true, cancelable: true})); await settle();
      keyboardMenus.push(!!menu());
      menu()?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true, cancelable: true})); await settle();
    }
    const noSidebarInstructions = !fixture.querySelector('aside > p');
    app.unmount(); fixture.remove();
    const {default:SettingsModal} = await import('/src/components/SettingsModal.vue');
    const settingsFixture = document.createElement('div'); document.body.append(settingsFixture);
    const settingsApp = createApp(SettingsModal, {initialTab: 'security'}); settingsApp.mount(settingsFixture); await settle();
    const settingsDialog = settingsFixture.querySelector('[role="dialog"]');
    const securityText = settingsDialog.innerText;
    const encryptionOptions = settingsDialog.querySelector('[data-encryption-options]');
    const settingsChecks = {
      compactSecurity: securityText.length < 1000,
      encryptionCollapsed: !!encryptionOptions && !encryptionOptions.open,
      publicHintWarning: securityText.includes('公开明文'),
      keyFileWarning: securityText.includes('密钥文件丢失将无法解锁'),
    };
    encryptionOptions.querySelector('summary').click(); await settle();
    settingsChecks.encryptionExpandable = encryptionOptions.open && encryptionOptions.querySelector('#encryption-profile').getClientRects().length > 0;
    const switchSettings = async text => {
      [...settingsDialog.querySelectorAll('button')].find(button => button.textContent.trim() === text).click(); await settle();
    };
    await switchSettings('便利');
    const convenienceText = settingsDialog.innerText;
    const privacy = [...settingsDialog.querySelectorAll('details')].find(details => details.querySelector('summary')?.textContent === '隐私说明');
    settingsChecks.compactConvenience = convenienceText.includes('开机启动') && convenienceText.includes('空闲自动锁定') && !!privacy && !privacy.open;
    await switchSettings('数据');
    settingsChecks.csvWarning = settingsDialog.innerText.includes('明文密码');
    const backupHelp = [...settingsDialog.querySelectorAll('details')].find(details => details.querySelector('summary')?.textContent === '备份与恢复说明');
    settingsChecks.backupHelpCollapsed = !!backupHelp && !backupHelp.open;
    await switchSettings('同步');
    const syncHelp = [...settingsDialog.querySelectorAll('details')].find(details => details.querySelector('summary')?.textContent === '同步须知');
    settingsChecks.syncHelpCollapsed = !!syncHelp && !syncHelp.open;
    const scrollArea = settingsDialog.querySelector('[data-settings-scroll]');
    settingsChecks.noHorizontalOverflow = scrollArea.scrollWidth <= scrollArea.clientWidth + 1;
    settingsApp.unmount(); settingsFixture.remove();
    return {noClipping, noOverflow, draggable, actions, layout, markers, rootDrop, cleared, menuActions, menuVisible, escapeClosed, addFocused, renameFocused, outsideClosed, confirmationKeptOpen, keyboardMenus, allSelected, noDuplicateFileRow, handleAlignment, outsideDoesNotDelete, cancelClosed, rootHidden, firstLevelAligned, defaultAll, groupSelected, groupSwitched, groupDeselected, noSidebarInstructions, settingsChecks};
  })()`);
  console.log(JSON.stringify(result, null, 2));
  assert.equal(result.noClipping, true, "group names must remain fully readable at 200px, including deep nesting");
  assert.equal(result.noOverflow, true, "sidebar must not overflow horizontally");
  assert.deepEqual(result.handleAlignment, [true, true], "six-dot drag handles align with the first text line and show a grab cursor");
  assert.equal(result.draggable, 2, "normal group rows must be draggable");
  assert.equal(result.actions, 0, "group rows must no longer render action button bars");
  assert.deepEqual(result.markers, [true, true, true], "DOM drag events show before/inside/after markers");
  assert.equal(result.rootDrop, true, "group heading accepts moving back to first level");
  assert.equal(result.cleared, true, "drag end clears all visual indicators");
  assert.equal(result.allSelected, true, "group heading returns to all entries");
  assert.equal(result.noDuplicateFileRow, true, "sidebar contains groups only, without a duplicate file-name row");
  for (const key of ['rootHidden', 'firstLevelAligned', 'defaultAll', 'groupSelected', 'groupSwitched', 'groupDeselected']) assert.equal(result[key], true, key);
  assert.deepEqual(result.menuActions, ['新建子分组', '重命名', '删除分组']);
  for (const key of ['menuVisible', 'escapeClosed', 'addFocused', 'renameFocused', 'outsideClosed', 'confirmationKeptOpen']) assert.equal(result[key], true, key);
  assert.equal(result.outsideDoesNotDelete, true, "outside clicks cannot confirm deletion");
  assert.equal(result.cancelClosed, true, "cancel preserves groups and restores trigger focus");
  assert.deepEqual(result.keyboardMenus, [true, true], "Shift+F10 and Menu key open group operations");
  assert.equal(result.noSidebarInstructions, true, "sidebar has no persistent instruction block");
  for (const [key, value] of Object.entries(result.settingsChecks)) assert.equal(value, true, key);
} finally {
  if (socket) socket.close();
  try { execFileSync("taskkill", ["/PID", String(browser.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
