<script setup lang="ts">
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { roundTripDemo } from "./kdbx/demo";

const greetMsg = ref("");
const name = ref("");

async function greet() {
  greetMsg.value = await invoke("greet", { name: name.value });
}

const kdbxMsg = ref("");
const kdbxBusy = ref(false);

async function testKdbx() {
  kdbxBusy.value = true;
  kdbxMsg.value = "运行中…（Argon2 64MB 内存哈希，约需 1-2 秒）";
  try {
    kdbxMsg.value = await roundTripDemo();
  } catch (e) {
    kdbxMsg.value = `失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    kdbxBusy.value = false;
  }
}
</script>

<template>
  <main class="page">
    <div class="card">
      <svg class="logo" width="56" height="56" viewBox="0 0 64 64">
        <path d="M32 8 C 20 8, 12 20, 12 32 C 12 44, 22 52, 32 52 C 42 52, 52 44, 52 32 C 52 20, 44 8, 32 8" fill="#8b9d77" opacity="0.3"/>
        <path d="M32 12 L32 48" stroke="#5c4033" stroke-width="2" stroke-linecap="round"/>
        <path d="M32 20 Q 24 18, 20 24 M32 28 Q 40 26, 44 32 M32 36 Q 24 34, 20 40" fill="none" stroke="#8b9d77" stroke-width="2" stroke-linecap="round"/>
        <circle cx="32" cy="52" r="3" fill="#d4a373"/>
      </svg>
      <h1 class="title">KeyLite</h1>
      <p class="subtitle">M0 骨架 · Tauri 2 + Vue 3 + TypeScript</p>

      <div class="ipc-test">
        <input v-model="name" placeholder="输入名字测试 Rust IPC" class="input" @keyup.enter="greet" />
        <button class="btn" @click="greet">测试 IPC</button>
      </div>
      <p v-if="greetMsg" class="result">{{ greetMsg }}</p>

      <div class="kdbx-test">
        <button class="btn btn-accent" :disabled="kdbxBusy" @click="testKdbx">
          {{ kdbxBusy ? "运行中…" : "KDBX 往返测试" }}
        </button>
        <pre v-if="kdbxMsg" class="kdbx-result">{{ kdbxMsg }}</pre>
      </div>
    </div>
  </main>
</template>

<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body, #app { height: 100%; }
.page {
  height: 100%;
  background: #faf6f1;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: "Segoe UI", -apple-system, sans-serif;
  color: #292524;
}
.card {
  background: #faf6f1;
  border: 1px solid #d6d3d1;
  border-radius: 2rem;
  padding: 3rem;
  text-align: center;
  max-width: 460px;
  width: 90%;
}
.logo { margin-bottom: 1rem; }
.title {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 2rem;
  color: #292524;
  font-weight: 600;
  margin-bottom: 0.25rem;
}
.subtitle {
  font-size: 0.875rem;
  color: #78716c;
  margin-bottom: 2rem;
}
.ipc-test {
  display: flex;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.input {
  flex: 1;
  padding: 0.75rem 1.25rem;
  background: #ffffff;
  border: 1px solid #d6d3d1;
  border-radius: 9999px;
  font-size: 0.875rem;
  color: #292524;
  outline: none;
  transition: border-color 0.3s;
}
.input:focus { border-color: #a8a29e; }
.btn {
  padding: 0.75rem 1.5rem;
  background: #292524;
  color: #fafaf9;
  border: none;
  border-radius: 9999px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 0.3s;
}
.btn:hover { background: #44403c; }
.btn:disabled { opacity: 0.6; cursor: wait; }
.btn-accent { background: #8b9d77; }
.btn-accent:hover { background: #7a8c66; }
.result {
  margin-top: 1rem;
  font-size: 0.875rem;
  color: #8b9d77;
  font-weight: 600;
}
.kdbx-test { margin-top: 1.5rem; }
.kdbx-result {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  background: #ffffff;
  border: 1px solid #d6d3d1;
  border-radius: 1rem;
  font-size: 0.75rem;
  color: #57534e;
  text-align: left;
  white-space: pre-wrap;
  word-break: break-all;
}
</style>
