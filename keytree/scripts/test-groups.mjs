// Exercise the actual GroupTree setup with a mocked vault; no real vault is touched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(project, "package.json"));
const { parse, compileScript } = require("@vue/compiler-sfc");
const { build } = require("esbuild");
const directory = await mkdtemp(join(process.env.PI_SCRATCH_DIR || tmpdir(), "keytree-groups-"));
const output = join(directory, "groups.mjs");
try {
  const filename = join(project, "src/components/GroupTree.vue");
  await test("Windows main window enables frontend HTML drag and drop", async () => {
    const config = JSON.parse(await readFile(join(project, "src-tauri/tauri.conf.json"), "utf8"));
    assert.equal(config.app.windows.find(window => window.label === "main").dragDropEnabled, false);
  });
  const { descriptor } = parse(await readFile(filename, "utf8"), { filename });
  const script = compileScript(descriptor, { id: "group-regression" });
  await build({
    stdin: { contents: script.content, resolveDir: dirname(filename), loader: "ts" },
    outfile: output, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    plugins: [{ name: "vault-fixture", setup(build) {
      build.onResolve({ filter: /composables\/useVault$/ }, () => ({ path: "vault", namespace: "fixture" }));
      build.onResolve({ filter: /lib\/toast$/ }, () => ({ path: "toast", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: path === "vault" ? "export const useVault = () => globalThis.__groupTestVault;" : "export const toast = () => {};",
        loader: "js",
      }));
    } }],
  });
  const { default: GroupTree } = await import(pathToFileURL(output).href);
  function fixture(selected = "existing-group") {
    const calls = [];
    const moves = [];
    const deletions = [];
    globalThis.__groupTestVault = {
      groups: { value: [] }, entries: { value: [] },
      selectedGroupUuid: { value: selected }, trash: { value: { uuid: "trash" } },
      vaultPath: { value: "test.kdbx" }, recycleBinEnabled: { value: true },
      busy: { value: false },
      error: { value: "" },
      selectGroup: uuid => { globalThis.__groupTestVault.selectedGroupUuid.value = uuid; },
      addGroup: async (...args) => calls.push(args),
      moveGroup: async (...args) => { moves.push(args); return true; },
      deleteGroup: async uuid => {
        deletions.push(uuid);
        const vault = globalThis.__groupTestVault;
        if (vault.deleteGate) await vault.deleteGate;
        return vault.deleteResult ?? true;
      },
    };
    const state = GroupTree.setup({}, { expose() {} });
    return { state, calls, moves, deletions, vault: globalThis.__groupTestVault };
  }
  await test("sidebar hides roots without changing the underlying group tree", () => {
    const { state, vault } = fixture("all");
    vault.groups.value = [
      { uuid: "root", depth: 0 }, { uuid: "first", depth: 1 },
      { uuid: "child", depth: 2 }, { uuid: "second-root", depth: 0 },
    ];
    assert.deepEqual(state.visibleGroups.value.map(g => g.uuid), ["first", "child"]);
    assert.equal(vault.groups.value.length, 4);
    assert.equal(state.visibleGroups.value[0].depth, 1, "only presentation indentation changes");
  });
  await test("clicking a group toggles its selection; switching groups does not toggle off", () => {
    const { state, vault } = fixture("all");
    state.toggleGroup("a");
    assert.equal(vault.selectedGroupUuid.value, "a");
    state.toggleGroup("b");
    assert.equal(vault.selectedGroupUuid.value, "b");
    state.toggleGroup("b");
    assert.equal(vault.selectedGroupUuid.value, "all");
  });
  await test("header add creates a top-level group even when a group is selected", async () => {
    const { state, calls } = fixture();
    await state.startAdd();
    state.draftName.value = "  一级分组  ";
    await state.confirmAdd();
    assert.deepEqual(calls, [["一级分组", ""]]);
  });
  await test("explicit child add retains its parent when selection changes", async () => {
    const { state, calls, vault } = fixture();
    await state.startAdd("parent-group");
    vault.selectedGroupUuid.value = "another-group";
    state.draftName.value = "子分组";
    await state.confirmAdd();
    assert.deepEqual(calls, [["子分组", "parent-group"]]);
  });
  await test("root creation works from all entries and the recycle bin", async () => {
    for (const selected of ["all", "trash"]) {
      const { state, calls } = fixture(selected);
      await state.startAdd();
      state.draftName.value = "一级";
      await state.confirmAdd();
      assert.deepEqual(calls, [["一级", ""]]);
    }
  });
  await test("blank names and repeated blur after confirmation do not create groups", async () => {
    const { state, calls } = fixture();
    await state.startAdd();
    state.draftName.value = "   ";
    await state.confirmAdd();
    assert.equal(calls.length, 0);
    await state.startAdd();
    state.draftName.value = "一级";
    await state.confirmAdd();
    await state.confirmAdd();
    assert.deepEqual(calls, [["一级", ""]]);
  });
  function dragFixture() {
    const f = fixture();
    f.vault.groups.value = [
      { uuid: "root", depth: 0 }, { uuid: "a", depth: 1 },
      { uuid: "child", depth: 2 }, { uuid: "b", depth: 1 },
    ];
    const data = new Map();
    const event = {
      clientY: 50, prevented: false,
      preventDefault() { this.prevented = true; },
      currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 100 }) },
      dataTransfer: { setData: (key, value) => data.set(key, value), getData: key => data.get(key) ?? "" },
    };
    return { ...f, event };
  }
  await test("drag drop uses upper/middle/lower zones for before/inside/after", async () => {
    for (const [y, position] of [[10, "before"], [50, "inside"], [90, "after"]]) {
      const { state, moves, event, vault } = dragFixture();
      state.startDrag(event, vault.groups.value[1]);
      event.clientY = y;
      state.dragOver(event, "b");
      assert.equal(event.prevented, true);
      assert.equal(state.dropTarget.value, "b");
      assert.equal(state.dropPosition.value, position);
      await state.dropGroup(event, "b");
      assert.deepEqual(moves, [["a", "b", position]]);
      assert.equal(state.draggingUuid.value, "");
      assert.equal(state.moving.value, false);
    }
  });
  await test("drag blocks roots, own descendants and external data; supports moving back to first level", async () => {
    const { state, moves, event, vault } = dragFixture();
    state.startDrag(event, vault.groups.value[0]);
    assert.equal(state.draggingUuid.value, "");
    state.startDrag(event, vault.groups.value[1]);
    for (const target of ["a", "child", "missing"]) assert.equal(state.canDrop(target, "inside"), false);
    assert.equal(state.canDrop("root", "before"), false);
    event.dataTransfer.setData("application/x-keytree-group", "external");
    await state.dropGroup(event, "b");
    assert.equal(moves.length, 0);
    state.startDrag(event, vault.groups.value[1]);
    await state.dropGroup(event, "");
    assert.deepEqual(moves, [["a", "", "inside"]]);
    state.startDrag(event, vault.groups.value[1]);
    state.endDrag();
    assert.equal(state.draggingUuid.value, "");
    assert.equal(state.dropTarget.value, "");
  });
  await test("both recycle and permanent group deletion require explicit confirmation; cancel never deletes", async () => {
    for (const recycle of [true, false]) {
      const { state, deletions, vault } = fixture();
      const group = { uuid: "to-delete", name: "Group", depth: 1, count: 2 };
      vault.groups.value = [group]; vault.recycleBinEnabled.value = recycle;
      state.onMenuDelete(group);
      assert.deepEqual(deletions, []);
      assert.equal(state.pendingDelete.value.uuid, group.uuid);
      assert.equal(state.deleteToTrash.value, recycle);
      state.cancelDelete();
      await state.confirmDelete();
      assert.deepEqual(deletions, []);
      state.onMenuDelete(group);
      await state.confirmDelete();
      assert.deepEqual(deletions, [group.uuid]);
      assert.equal(state.pendingDelete.value, null);
      await state.confirmDelete();
      assert.equal(deletions.length, 1);
    }
  });
  await test("group deletion blocks double submit and dismissal while saving and retains failures", async () => {
    const { state, deletions, vault } = fixture();
    const group = { uuid: "to-delete", name: "Group", depth: 1, count: 0 };
    vault.groups.value = [group];
    let release;
    vault.deleteGate = new Promise(resolve => { release = resolve; });
    state.onMenuDelete(group);
    const pending = state.confirmDelete();
    await state.confirmDelete();
    state.cancelDelete();
    assert.equal(state.pendingDelete.value.uuid, group.uuid);
    assert.equal(state.deleting.value, true);
    assert.equal(deletions.length, 1);
    release(); await pending;
    assert.equal(state.deleting.value, false);
    assert.equal(state.pendingDelete.value, null);
    vault.deleteResult = false; vault.error.value = "SYNTHETIC_DELETE_FAILURE";
    state.onMenuDelete(group);
    await state.confirmDelete();
    assert.equal(state.pendingDelete.value.uuid, group.uuid);
    assert.equal(state.deleteError.value, "SYNTHETIC_DELETE_FAILURE");
    assert.equal(state.deleting.value, false);
  });
  await test("changed recycle policy requires renewed confirmation and roots/busy states cannot open deletion", async () => {
    const { state, deletions, vault } = fixture();
    const group = { uuid: "to-delete", name: "Group", depth: 1, count: 0 };
    vault.groups.value = [group];
    state.onMenuDelete({ ...group, depth: 0 });
    assert.equal(state.pendingDelete.value, null);
    vault.busy.value = true;
    state.onMenuDelete(group);
    assert.equal(state.pendingDelete.value, null);
    vault.busy.value = false;
    state.onMenuDelete(group);
    vault.recycleBinEnabled.value = false;
    await state.confirmDelete();
    assert.equal(state.deleteToTrash.value, false);
    assert.notEqual(state.deleteError.value, "");
    assert.deepEqual(deletions, []);
    await state.confirmDelete();
    assert.deepEqual(deletions, [group.uuid]);
  });
  await test("closing the menu does not steal focus from add or rename inputs", () => {
    const { state } = fixture();
    const idle = new Event("close", { cancelable: true });
    state.onMenuCloseAutoFocus(idle);
    assert.equal(idle.defaultPrevented, false);
    state.adding.value = true;
    const adding = new Event("close", { cancelable: true });
    state.onMenuCloseAutoFocus(adding);
    assert.equal(adding.defaultPrevented, true);
    state.adding.value = false;
    state.renamingUuid.value = "renaming";
    const renaming = new Event("close", { cancelable: true });
    state.onMenuCloseAutoFocus(renaming);
    assert.equal(renaming.defaultPrevented, true);
  });
} finally {
  delete globalThis.__groupTestVault;
  await rm(directory, { recursive: true, force: true });
}
