<script setup lang="ts">
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import kdbxweb from "kdbxweb";
import { installArgon2 } from "./kdbx/argon2";

installArgon2();

interface EntryView {
  title: string;
  username: string;
  password: string;
}

const vaultPath = ref("");
const password = ref("");
const status = ref("");
const error = ref("");
const entries = ref<EntryView[]>([]);
const busy = ref(false);

let db: kdbxweb.Kdbx | null = null;
let rawBytes: Uint8Array | null = null;

function resetVault() {
  db = null;
  rawBytes = null;
  entries.value = [];
  error.value = "";
}

async function pickFile() {
  resetVault();
  try {
    const path = await open({
      multiple: false,
      filters: [{ name: "KeePass 数据库", extensions: ["kdbx"] }],
    });
    if (typeof path !== "string") return;
    vaultPath.value = path;
    const bytes = await invoke<number[]>("read_vault", { path });
    rawBytes = new Uint8Array(bytes);
    status.value = `已选择 ${path} · ${rawBytes.byteLength} bytes · 输入主密码解锁`;
  } catch (e) {
    error.value = `选择文件失败：${e instanceof Error ? e.message : String(e)}`;
  }
}

async function unlock() {
  error.value = "";
  if (!rawBytes) {
    error.value = "先选择一个 .kdbx 文件";
    return;
  }
  busy.value = true;
  try {
    const credentials = new kdbxweb.Credentials(
      kdbxweb.ProtectedValue.fromString(password.value)
    );
    const buf = rawBytes.buffer.slice(
      rawBytes.byteOffset,
      rawBytes.byteOffset + rawBytes.byteLength
    ) as ArrayBuffer;
    const t0 = performance.now();
    db = await kdbxweb.Kdbx.load(buf, credentials);
    const ms = Math.round(performance.now() - t0);
    entries.value = Array.from(db.getDefaultGroup().allEntries()).map((e) => ({
      title: String(e.fields.get("Title") ?? ""),
      username: String(e.fields.get("UserName") ?? ""),
      password:
        e.fields.get("Password") instanceof kdbxweb.ProtectedValue
          ? (e.fields.get("Password") as kdbxweb.ProtectedValue).getText()
          : String(e.fields.get("Password") ?? ""),
    }));
    status.value = `解锁成功 · ${entries.value.length} 条 · ${ms}ms`;
  } catch (e) {
    error.value = `解锁失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    busy.value = false;
  }
}

async function save() {
  if (!db || !vaultPath.value) return;
  busy.value = true;
  try {
    const t0 = performance.now();
    const saved = await db.save();
    const ms = Math.round(performance.now() - t0);
    await invoke("write_vault", {
      path: vaultPath.value,
      bytes: Array.from(new Uint8Array(saved)),
    });
    status.value = `已原子写回 ${vaultPath.value} · ${saved.byteLength} bytes · ${ms}ms`;
  } catch (e) {
    error.value = `保存失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    busy.value = false;
  }
}

function touchFirst() {
  if (!db) return;
  const all = Array.from(db.getDefaultGroup().allEntries());
  const first = all[0];
  if (!first) return;
  const oldTitle = String(first.fields.get("Title") ?? "");
  first.fields.set("Title", oldTitle.endsWith(" ✓") ? oldTitle.slice(0, -2) : `${oldTitle} ✓`);
  first.times.update();
  entries.value = entries.value.map((e, i) =>
    i === 0 ? { ...e, title: String(first.fields.get("Title")) } : e
  );
  status.value = "已修改第一条标题（未写盘，点「保存回文件」验证写回）";
}
</script>

<template>
  <main class="page">
    <div class="card">
      <svg class="logo" width="48" height="48" viewBox="0 0 64 64">
        <path d="M32 8 C 20 8, 12 20, 12 32 C 12 44, 22 52, 32 52 C 42 52, 52 44, 52 32 C 52 20, 44 8, 32 8" fill="#8b9d77" opacity="0.3"/>
        <path d="M32 12 L32 48" stroke="#5c4033" stroke-width="2" stroke-linecap="round"/>
        <path d="M32 20 Q 24 18, 20 24 M32 28 Q 40 26, 44 32 M32 36 Q 24 34, 20 40" fill="none" stroke="#8b9d77" stroke-width="2" stroke-linecap="round"/>
        <circle cx="32" cy="52" r="3" fill="#d4a373"/>
      </svg>
      <h1 class="title">KeyLite</h1>
      <p class="subtitle">M0 · 打开真实 KDBX 库</p>

      <div class="row">
        <button class="btn" @click="pickFile">选择 .kdbx 文件</button>
        <span class="path">{{ vaultPath || "未选择文件" }}</span>
      </div>

      <div class="row">
        <input
          v-model="password"
          type="password"
          class="input"
          placeholder="主密码"
          @keyup.enter="unlock"
        />
        <button class="btn btn-accent" :disabled="busy" @click="unlock">解锁</button>
      </div>

      <p v-if="status" class="status">{{ status }}</p>
      <p v-if="error" class="error">{{ error }}</p>

      <div v-if="entries.length" class="list">
        <div v-for="(e, i) in entries" :key="i" class="entry">
          <span class="entry-title">{{ e.title }}</span>
          <span class="entry-user">{{ e.username }}</span>
        </div>
      </div>

      <div v-if="entries.length" class="row actions">
        <button class="btn" @click="touchFirst">改第一条标题</button>
        <button class="btn btn-accent" :disabled="busy" @click="save">保存回文件</button>
      </div>
    </div>
  </main>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app { height: 100%; }
.page {
  min-height: 100%;
  background: #faf6f1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem 1rem;
  font-family: "Segoe UI", -apple-system, sans-serif;
  color: #292524;
}
.card {
  background: #faf6f1;
  border: 1px solid #d6d3d1;
  border-radius: 2rem;
  padding: 2rem 2.5rem;
  max-width: 560px;
  width: 100%;
  text-align: center;
}
.logo { display: block; margin: 0 auto 0.5rem; }
.title {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.75rem;
  font-weight: 600;
  margin-bottom: 0.15rem;
}
.subtitle { font-size: 0.8rem; color: #78716c; margin-bottom: 1.5rem; }
.row { display: flex; gap: 0.5rem; align-items: center; margin-bottom: 0.75rem; }
.btn {
  white-space: nowrap;
  padding: 0.7rem 1.25rem;
  background: #292524;
  color: #fafaf9;
  border: none;
  border-radius: 9999px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.3s;
}
.btn:hover { background: #44403c; }
.btn:disabled { opacity: 0.6; cursor: wait; }
.btn-accent { background: #8b9d77; }
.btn-accent:hover { background: #7a8c66; }
.input {
  flex: 1;
  padding: 0.7rem 1.25rem;
  background: #ffffff;
  border: 1px solid #d6d3d1;
  border-radius: 9999px;
  font-size: 0.85rem;
  color: #292524;
  outline: none;
  transition: border-color 0.3s;
}
.input:focus { border-color: #a8a29e; }
.path {
  flex: 1;
  font-size: 0.72rem;
  color: #78716c;
  text-align: left;
  word-break: break-all;
}
.status { font-size: 0.78rem; color: #5c4033; margin: 0.5rem 0; text-align: left; }
.error { font-size: 0.78rem; color: #8b2332; margin: 0.5rem 0; text-align: left; }
.list {
  margin-top: 0.75rem;
  border: 1px solid #d6d3d1;
  border-radius: 1rem;
  max-height: 220px;
  overflow-y: auto;
  text-align: left;
}
.entry {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.6rem 1rem;
  border-bottom: 1px solid #e7e5e4;
  font-size: 0.82rem;
}
.entry:last-child { border-bottom: none; }
.entry-title { font-weight: 600; }
.entry-user { color: #78716c; }
.actions { margin-top: 0.75rem; justify-content: center; }
</style>
