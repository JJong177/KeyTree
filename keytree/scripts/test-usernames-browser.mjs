// Requires the local Vite server. Uses synthetic entries and an isolated temporary Edge profile.
import assert from "node:assert/strict";
import { withBrowser } from "./lib/browser-fixture.mjs";

await withBrowser(async ({ evaluate, send }) => {
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const result = await evaluate(`(async () => {
    const main = await (await fetch('/src/main.ts')).text();
    const vueUrl = main.split('from "')[1].split('"')[0];
    const { createApp, nextTick } = await import(vueUrl);
    const componentCode = await (await fetch('/src/components/UsernameList.vue')).text();
    const vaultUrl = componentCode.split(String.fromCharCode(10)).find(line => line.includes('composables/useVault')).split('"')[1];
    const { useVault } = await import(vaultUrl);
    const { default: UsernameList } = await import('/src/components/UsernameList.vue');
    const { default: GroupTree } = await import('/src/components/GroupTree.vue');
    const vault = useVault();
    document.querySelector('#app')?.__vue_app__?.unmount();
    const makeEntry = (uuid, username, url, { favorite = false, inTrash = false } = {}) => ({
      uuid, groupUuid: 'group-one', ancestors: ['group-one'], title: uuid, username, url, notes: '', tags: [],
      hasTotp: false, inTrash, expires: false, expiryTime: null, updatedAt: null, createdAt: null,
      usageCount: 0, lastUsedAt: null, totpPeriod: null, icon: null, favorite,
    });
    const longName = 'LongUnbrokenUsername'.repeat(5);
    vault.entries.value = [
      makeEntry('a1', 'Alpha', 'https://sample.test/login'),
      makeEntry('a2', 'Alpha', 'http://sample.test/other?x=1'),
      makeEntry('a3', 'alpha', 'https://sample.test:8443/'),
      makeEntry('blank', '', 'not a web address'),
      makeEntry('long', longName, ''),
      makeEntry('archived', 'Archived', 'https://trash.test/', { inTrash: true }),
    ];
    vault.groups.value = [
      { uuid: 'root', name: 'Synthetic root', depth: 0, count: 6 },
      { uuid: 'group-one', name: 'Synthetic group', depth: 1, count: 6 },
    ];
    vault.query.value = 'no matching entry';
    vault.favoritesOnly.value = true;
    vault.selectedGroupUuid.value = 'all';
    vault.setSidebarView('usernames');
    const fixture = document.createElement('div');
    fixture.style = 'position:fixed;inset:0 auto 0 0;width:200px;height:100vh;background:white;z-index:99999;display:flex';
    document.body.append(fixture);
    const app = createApp(UsernameList, { class: 'min-h-0 w-full overflow-hidden' });
    app.mount(fixture);
    await nextTick();
    const settle = async () => { await nextTick(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); };
    const row = username => [...fixture.querySelectorAll('[data-username]')].find(item => item.dataset.username === username)?.querySelector('button') ?? null;
    const rows = [...fixture.querySelectorAll('[data-username]')];
    const byName = username => rows.find(item => item.dataset.username === username);
    const countOf = element => element?.querySelector('[data-account-count]')?.textContent.trim();
    const initialCounts = {
      alphaUpper: countOf(byName('Alpha')) === '2',
      alphaLower: countOf(byName('alpha')) === '1',
      blank: byName('')?.innerText.includes('未填写账号') && countOf(byName('')) === '1',
      longName: byName(longName)?.innerText.includes(longName) ?? false,
      trashExcluded: !byName('Archived'),
      globalDespiteFilters: rows.reduce((sum, item) => sum + Number(countOf(item) ?? 0), 0) === 5,
      noStatisticsLine: rows.every(item => !/条|站点/.test(item.innerText)),
    };
    const input = fixture.querySelector('input[aria-label="搜索账号"]');
    input.value = 'ALPHA'; input.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    const localSearch = fixture.querySelectorAll('[data-username]').length === 2
      && countOf(row('Alpha')) === '2' && countOf(row('alpha')) === '1';
    const searchInputDoesNotBubbleEscape = (() => {
      let bubbled = false;
      const listen = () => { bubbled = true; };
      window.addEventListener('keydown', listen, { once: true });
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      window.removeEventListener('keydown', listen);
      return !bubbled;
    })();
    await settle();
    const escapeClearsLocalSearch = input.value === '' && fixture.querySelectorAll('[data-username]').length === 4;
    row('Alpha').click(); await settle();
    const selected = vault.selectedUsername.value === 'Alpha' && row('Alpha').getAttribute('aria-pressed') === 'true';
    row('Alpha').click(); await settle();
    const toggledOff = vault.selectedUsername.value === null && vault.sidebarView.value === 'usernames';
    row('').click(); await settle();
    const blankSelected = vault.selectedUsername.value === '' && row('').getAttribute('aria-pressed') === 'true';
    row('').click(); await settle();
    const allCleared = vault.selectedUsername.value === null;
    const noRedundantHeader = !fixture.querySelector('#username-list-heading')
      && !fixture.querySelector('button[aria-label="查看全部账号条目"]')
      && !!fixture.querySelector('section[aria-label="账号筛选"]');
    const longLabel = [...fixture.querySelectorAll('[data-username] button > span:first-child')].find(el => el.textContent === longName);
    const labelStyle = longLabel ? getComputedStyle(longLabel) : null;
    const longNameSingleLine = !!longLabel && labelStyle.whiteSpace === 'nowrap' && labelStyle.textOverflow === 'ellipsis'
      && longLabel.scrollWidth > longLabel.clientWidth && longLabel.clientHeight <= parseFloat(labelStyle.lineHeight) + 1;
    const rowHeightsMatch = Math.abs(row(longName).getBoundingClientRect().height - row('Alpha').getBoundingClientRect().height) <= 1;
    const singleBadge = row('Alpha')?.querySelector('[data-account-count]');
    const counterStyle = element => {
      if (!element) return null;
      const css = getComputedStyle(element);
      return ['fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom', 'borderRadius'].map(key => css[key]).join('|');
    };
    const groupFixture = document.createElement('div');
    groupFixture.style = 'position:fixed;inset:0 auto 0 220px;width:200px;height:100vh;background:white;display:flex';
    document.body.append(groupFixture);
    const groupApp = createApp(GroupTree, { class: 'min-h-0 w-full overflow-hidden' });
    groupApp.mount(groupFixture);await settle();
    const groupButton = groupFixture.querySelector('[data-group-uuid="group-one"] button');
    const groupCounter = groupButton?.lastElementChild;
    const unselectedCountMatchesGroups = !!singleBadge && !!groupCounter && counterStyle(singleBadge) === counterStyle(groupCounter);
    const badgeRect = singleBadge?.getBoundingClientRect();
    const accountRect = row('Alpha')?.getBoundingClientRect();
    const groupCounterRect = groupCounter?.getBoundingClientRect();
    const groupRect = groupButton?.getBoundingClientRect();
    const countRightAligned = !!badgeRect && !!accountRect && !!groupCounterRect && !!groupRect
      && Math.abs((accountRect.right - badgeRect.right) - (groupRect.right - groupCounterRect.right)) <= 1;
    row('Alpha').click();await settle();
    const selectedAccountStyle = counterStyle(singleBadge);
    groupButton?.click();await settle();
    const selectedCountMatchesGroups = !!groupCounter && selectedAccountStyle === counterStyle(groupCounter);
    vault.entries.value = [...vault.entries.value, ...Array.from({length: 11}, (_, index) => makeEntry('long-extra-' + index, longName, ''))];
    await settle();
    const multiBadge = row(longName)?.querySelector('[data-account-count]');
    const multiDigitFits = multiBadge?.textContent.trim() === '12' && multiBadge.scrollWidth <= multiBadge.clientWidth + 1
      && row(longName).scrollWidth <= row(longName).clientWidth + 1;
    const hover = async button => {
      const rect = button.getBoundingClientRect();
      const pointer = {pointerType: 'mouse', clientX: rect.left + 5, clientY: rect.top + 5};
      button.dispatchEvent(new PointerEvent('pointerenter', pointer));await nextTick();
      button.dispatchEvent(new PointerEvent('pointermove', {...pointer, bubbles: true}));
      await new Promise(resolve => setTimeout(resolve,450));await settle();
    };
    await hover(row(longName));
    const tooltip = document.querySelector('[data-account-tooltip]');
    const hoverShowsFullName = !!tooltip && tooltip.textContent.includes(longName) && !row(longName).hasAttribute('title');
    const tooltipCss = tooltip ? getComputedStyle(tooltip) : null;
    const themedTooltip = !!tooltipCss && tooltipCss.backgroundColor === 'rgb(255, 253, 249)'
      && tooltipCss.borderTopColor === 'rgb(222, 217, 209)' && tooltipCss.color === 'rgb(87, 83, 78)'
      && parseFloat(tooltipCss.borderRadius) >= 12 && tooltipCss.boxShadow !== 'none';
    const tooltipRect = tooltip?.getBoundingClientRect();
    const tooltipOutsideSidebar = !!tooltip && !fixture.contains(tooltip) && tooltipRect.right > fixture.getBoundingClientRect().right
      && tooltipRect.left >= 11 && tooltipRect.right <= innerWidth - 11;
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await settle();
    const escapeClosesTooltip = !document.querySelector('[data-account-tooltip]');
    await hover(row('Alpha'));
    const shortNameHasNoTooltip = !document.querySelector('[data-account-tooltip]');
    row(longName).focus();await settle();
    const focusShowsFullName = !!document.querySelector('[data-account-tooltip]')?.textContent.includes(longName);
    row(longName).blur();await settle();
    const blurClosesTooltip = !document.querySelector('[data-account-tooltip]');
    groupApp.unmount();groupFixture.remove();
    app.unmount(); fixture.remove();
    return { initialCounts, localSearch, searchInputDoesNotBubbleEscape, escapeClearsLocalSearch, selected, toggledOff, blankSelected, allCleared, noRedundantHeader, longNameSingleLine, rowHeightsMatch, countRightAligned, unselectedCountMatchesGroups, selectedCountMatchesGroups, multiDigitFits, hoverShowsFullName, themedTooltip, tooltipOutsideSidebar, escapeClosesTooltip, shortNameHasNoTooltip, focusShowsFullName, blurClosesTooltip };
  })()`);
  console.log(JSON.stringify(result, null, 2));
  for (const [key, value] of Object.entries(result.initialCounts)) assert.equal(value, true, key);
  for (const key of ['localSearch', 'searchInputDoesNotBubbleEscape', 'escapeClearsLocalSearch', 'selected', 'toggledOff', 'blankSelected', 'allCleared', 'noRedundantHeader', 'longNameSingleLine', 'rowHeightsMatch', 'countRightAligned', 'unselectedCountMatchesGroups', 'selectedCountMatchesGroups', 'multiDigitFits', 'hoverShowsFullName', 'themedTooltip', 'tooltipOutsideSidebar', 'escapeClosesTooltip', 'shortNameHasNoTooltip', 'focusShowsFullName', 'blurClosesTooltip']) assert.equal(result[key], true, key);
  const integration = await evaluate(`(async () => {
    const mainSource = await (await fetch('/src/components/MainView.vue')).text();
    const vaultUrl = mainSource.split(String.fromCharCode(10)).find(line => line.includes('composables/useVault')).split('"')[1];
    const { useVault } = await import(vaultUrl);
    const { createApp, nextTick } = await import((await (await fetch('/src/main.ts')).text()).split('from "')[1].split('"')[0]);
    const { default: MainView } = await import('/src/components/MainView.vue');
    const vault = useVault();
    document.querySelector('#app')?.__vue_app__?.unmount();
    const makeEntry = (uuid, username, url, { favorite = false, inTrash = false, groupUuid = 'group-one' } = {}) => ({
      uuid, groupUuid, ancestors: [groupUuid], title: uuid, username, url, notes: '', tags: [], hasTotp: false,
      inTrash, expires: false, expiryTime: null, updatedAt: null, createdAt: null, usageCount: 0, lastUsedAt: null,
      totpPeriod: null, icon: null, favorite,
    });
    vault.entries.value = [
      makeEntry('alpha-one', 'Alpha', 'https://sample.test/login'),
      makeEntry('alpha-two', 'Alpha', 'http://sample.test/other', { favorite: true }),
      makeEntry('blank', '', 'not a web address'),
      makeEntry('other', 'Other', 'https://other.test/path', { groupUuid: 'group-two' }),
      makeEntry('archived', 'Archived', 'https://trash.test/', { inTrash: true }),
    ];
    vault.groups.value = [
      { uuid: 'root', name: 'HiddenRootFixture', depth: 0, count: 5 },
      { uuid: 'group-one', name: 'Synthetic first group', depth: 1, count: 3 },
      { uuid: 'group-two', name: 'Synthetic second group', depth: 1, count: 1 },
    ];
    vault.query.value = '';
    vault.favoritesOnly.value = false;
    vault.selectedUuid.value = '';
    vault.selectGroup('all');
    vault.vaultPath.value = 'C:/Synthetic/Usernames.kdbx';
    const fixture = document.createElement('div');
    fixture.style = 'position:fixed;inset:0;width:100vw;height:100vh;background:white;z-index:99999';
    document.body.append(fixture);
    const app = createApp(MainView);
    app.mount(fixture);
    const settle = async () => { await nextTick(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); };
    await settle();
    const groupTab = fixture.querySelector('#sidebar-tab-groups');
    const usernamesTab = fixture.querySelector('#sidebar-tab-usernames');
    const initialTabs = !!groupTab && !!usernamesTab && groupTab.getAttribute('aria-selected') === 'true'
      && usernamesTab.getAttribute('aria-selected') === 'false' && !!fixture.querySelector('[role="tablist"]');
    const rootHidden = !fixture.querySelector('[data-group-uuid="root"]') && !fixture.textContent.includes('HiddenRootFixture');
    fixture.querySelector('[data-group-uuid="group-one"] button')?.click(); await settle();
    const groupFilterApplied = vault.selectedGroupUuid.value === 'group-one' && vault.visibleEntries.value.length === 3;
    const globalSearch = fixture.querySelector('input[placeholder^="搜索条目"]');
    const favoritesButton = [...fixture.querySelectorAll('button')].find(button => button.textContent.includes('收藏'));
    globalSearch.value = 'no matching entry'; globalSearch.dispatchEvent(new Event('input', { bubbles: true }));
    favoritesButton.click(); await settle();
    usernamesTab.click(); await settle();
    const groupClearedOnTabChange = vault.sidebarView.value === 'usernames' && vault.selectedGroupUuid.value === 'all'
      && vault.selectedUsername.value === null && vault.selectedUuid.value === '';
    const searchFavoritePreserved = vault.query.value === 'no matching entry' && vault.favoritesOnly.value;
    const globalCountsIgnoreFilters = fixture.querySelector('#sidebar-panel-usernames [data-username="Alpha"] [data-account-count]')?.textContent.trim() === '2'
      && fixture.querySelector('#sidebar-panel-usernames [data-username=""] [data-account-count]')?.textContent.trim() === '1'
      && vault.visibleEntries.value.length === 0;
    globalSearch.value = ''; globalSearch.dispatchEvent(new Event('input', { bubbles: true }));
    favoritesButton.click(); await settle();
    const filtersRemainVisibleAndClear = vault.query.value === '' && !vault.favoritesOnly.value && vault.visibleEntries.value.length === 4;
    const usernameRow = username => [...fixture.querySelectorAll('#sidebar-panel-usernames [data-username]')].find(item => item.dataset.username === username)?.querySelector('button') ?? null;
    usernameRow('Alpha').click(); await settle();
    const selectedUsernameFilter = vault.selectedUsername.value === 'Alpha' && vault.selectedGroupUuid.value === 'all'
      && vault.visibleEntries.value.length === 2 && fixture.textContent.includes('账号 · Alpha · 2 条');
    usernameRow('Alpha').click(); await settle();
    const toggledOff = vault.selectedUsername.value === null && vault.visibleEntries.value.length === 4
      && fixture.textContent.includes('全部账号 · 4 条');
    usernameRow('').click(); await settle();
    const blankUsernameFilter = vault.selectedUsername.value === '' && vault.visibleEntries.value.length === 1
      && fixture.textContent.includes('账号 · 未填写账号 · 1 条');
    globalSearch.value = 'not found'; globalSearch.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    const usernameSearchEmptyState = fixture.textContent.includes('当前账号下暂无匹配条目')
      && fixture.textContent.includes('账号 · 未填写账号 · 0 条');
    globalSearch.value = ''; globalSearch.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    const listSearch = fixture.querySelector('#sidebar-panel-usernames input[aria-label="搜索账号"]');
    listSearch.value = 'Alpha'; listSearch.dispatchEvent(new Event('input', { bubbles: true })); await settle();
    const localSearchIsSeparate = vault.query.value === '' && fixture.querySelectorAll('#sidebar-panel-usernames [data-username]').length === 1;
    groupTab.click(); await settle();
    const groupSwitchClearsUsername = vault.sidebarView.value === 'groups' && vault.selectedUsername.value === null
      && vault.selectedGroupUuid.value === 'all';
    usernamesTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })); await settle();
    const endTabKey = vault.sidebarView.value === 'usernames' && document.activeElement === usernamesTab
      && usernamesTab.getAttribute('aria-selected') === 'true';
    const arrowLeft = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
    usernamesTab.dispatchEvent(arrowLeft); await settle();
    const arrowLeftTabKey = arrowLeft.defaultPrevented && vault.sidebarView.value === 'groups' && document.activeElement === groupTab;
    const arrowRight = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    groupTab.dispatchEvent(arrowRight); await settle();
    const arrowRightTabKey = arrowRight.defaultPrevented && vault.sidebarView.value === 'usernames' && document.activeElement === usernamesTab;
    const home = new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true });
    usernamesTab.dispatchEvent(home); await settle();
    const homeTabKey = home.defaultPrevented && vault.sidebarView.value === 'groups' && document.activeElement === groupTab;
    usernamesTab.click(); await settle();
    const localSearchResetOnUnmount = fixture.querySelector('#sidebar-panel-usernames input[aria-label="搜索账号"]')?.value === '';
    vault.entries.value = vault.entries.value.map(entry => entry.uuid === 'alpha-two' ? { ...entry, username: 'ALPHA' } : entry);
    await settle();
    const usernameEditUpdatesCounts = vault.usernameGroups.value.find(group => group.username === 'Alpha')?.entryCount === 1
      && vault.usernameGroups.value.find(group => group.username === 'ALPHA')?.entryCount === 1;
    vault.entries.value = vault.entries.value.map(entry => entry.uuid === 'other' ? { ...entry, inTrash: true } : entry);
    await settle();
    const trashUpdate = !vault.usernameGroups.value.some(group => group.username === 'Other');
    vault.entries.value = vault.entries.value.map(entry => entry.uuid === 'other' ? { ...entry, inTrash: false } : entry);
    await settle();
    const recoveryUpdate = vault.usernameGroups.value.find(group => group.username === 'Other')?.entryCount === 1;
    const footer = fixture.querySelector('footer');
    const quickbar = fixture.querySelector('[data-sync-quickbar]');
    const syncOnlyInFooter = !!quickbar && quickbar.closest('footer') === footer
      && fixture.querySelectorAll('[data-sync-quickbar]').length === 1;
    const priorAvailability = vault.webdavAvailability.value, priorSyncState = vault.webdavState.value;
    vault.webdavAvailability.value = {configured:true,loading:false,lastSyncedAt:1000,error:''};
    vault.webdavState.value = {phase:'unchecked',message:'尚未检查远端；本地保存不代表已同步。',lastSyncedAt:null};await settle();
    const syncButton = text => [...quickbar.querySelectorAll('button')].find(el => el.textContent.trim() === text);
    const syncActionsAvailable = !!syncButton('立即同步') && !!syncButton('同步设置');
    const footerRect = footer.getBoundingClientRect(), syncRect = quickbar.getBoundingClientRect();
    const footerCompact = footerRect.height <= 44 && syncRect.height <= 26
      && footer.scrollWidth <= footer.clientWidth + 1 && syncRect.right <= footerRect.right;
    const summary = quickbar.querySelector('[data-sync-summary]');
    summary?.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',bubbles:true}));
    await new Promise(resolve => setTimeout(resolve,450));await settle();
    const details = document.querySelector('[data-sync-status-detail]');
    const syncDetailsPreserved = !!details && details.textContent.includes('本地保存不代表已同步')
      && details.textContent.includes('上次上传确认') && details.textContent.includes('不代表远端当前一致');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await settle();
    vault.webdavState.value = {phase:'synced',message:'上传已确认，远端之后仍可能变化。',lastSyncedAt:1000};await settle();
    const syncConfirmedLabel = !!summary?.textContent.includes('上传已确认') && !summary?.textContent.includes('已同步');
    vault.webdavState.value = {phase:'conflict',message:'远端有变化，未覆盖。',lastSyncedAt:1000};await settle();
    const syncConflictVisible = !!summary?.textContent.includes('同步冲突') && !!syncButton('重试同步');
    vault.busy.value = true;await settle();
    const syncBlockedWhileBusy = !!syncButton('重试同步')?.disabled && !!syncButton('同步设置')?.disabled;
    vault.busy.value = false;await settle();syncButton('同步设置')?.click();await settle();
    const syncSettingsOpensSyncTab = !!fixture.querySelector('[data-webdav-settings]');
    document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));await settle();
    vault.webdavAvailability.value = priorAvailability;vault.webdavState.value = priorSyncState;
    app.unmount(); fixture.remove();
    return { initialTabs, rootHidden, groupFilterApplied, groupClearedOnTabChange, searchFavoritePreserved, globalCountsIgnoreFilters,
      filtersRemainVisibleAndClear, selectedUsernameFilter, toggledOff, blankUsernameFilter, usernameSearchEmptyState, localSearchIsSeparate,
      groupSwitchClearsUsername, endTabKey, arrowLeftTabKey, arrowRightTabKey, homeTabKey, localSearchResetOnUnmount,
      usernameEditUpdatesCounts, trashUpdate, recoveryUpdate, syncOnlyInFooter, syncActionsAvailable, footerCompact,
      syncDetailsPreserved, syncConfirmedLabel, syncConflictVisible, syncBlockedWhileBusy, syncSettingsOpensSyncTab };
  })()`);
  console.log(JSON.stringify(integration, null, 2));
  for (const key of ['initialTabs', 'rootHidden', 'groupFilterApplied', 'groupClearedOnTabChange', 'searchFavoritePreserved',
    'globalCountsIgnoreFilters', 'filtersRemainVisibleAndClear', 'selectedUsernameFilter', 'toggledOff', 'blankUsernameFilter',
    'usernameSearchEmptyState', 'localSearchIsSeparate', 'groupSwitchClearsUsername', 'endTabKey', 'arrowLeftTabKey',
    'arrowRightTabKey', 'homeTabKey', 'localSearchResetOnUnmount', 'usernameEditUpdatesCounts', 'trashUpdate', 'recoveryUpdate',
    'syncOnlyInFooter', 'syncActionsAvailable', 'footerCompact', 'syncDetailsPreserved', 'syncConfirmedLabel', 'syncConflictVisible',
    'syncBlockedWhileBusy', 'syncSettingsOpensSyncTab']) assert.equal(integration[key], true, key);
});
