// 验证：强制 argon2-browser 走「浏览器分支」（内联 base64 wasm），
// 与 @noble/hashes 逐字节比对。这条分支就是 WebView2 里实际会走的路径。
// Resolve the browser prebundle relative to this script, regardless of the working directory.
import { argon2d, argon2i, argon2id } from "@noble/hashes/argon2.js";

const depUrl = new URL(
  "../node_modules/.vite/deps/argon2-browser_dist_argon2-bundled__min__js.js", import.meta.url
).href;

const realProcess = globalThis.process;
globalThis.self = globalThis;
globalThis.window = globalThis;
// 关键：argon2-browser 用 `process.versions.node` 判断 Node 环境并改走外部 wasm，
// 抹掉它就能强制走浏览器分支（内联 base64 → atob → WebAssembly）。
globalThis.process = undefined;

const ns = await import(depUrl);
const interop = (m) => (m && m.__esModule ? m : { ...(m || {}), default: m });
const resolved = interop(ns.default);

function unwrap(mod) {
  let cur = mod;
  for (let d = 0; d < 6; d++) {
    if (!cur || typeof cur !== "object") return null;
    if (typeof cur.hash === "function") return cur;
    cur = cur.default;
  }
  return null;
}
const argon2 = unwrap(resolved);
if (!argon2) throw new Error("argon2 剥壳失败");

const hex = (a) =>
  Array.from(a)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

const pass = new TextEncoder().encode("master-pw");
const salt = new Uint8Array(16).fill(7);
const params = { time: 2, mem: 8192, hashLen: 32, parallelism: 1 };

const cases = [
  { name: "Argon2d (0)", type: 0, ref: argon2d },
  { name: "Argon2i (1)", type: 1, ref: argon2i },
  { name: "Argon2id (2)", type: 2, ref: argon2id },
];

let allOk = true;
for (const c of cases) {
  const t0 = Date.now();
  const res = await argon2.hash({ pass, salt, ...params, type: c.type, version: 0x13 });
  const ms = Date.now() - t0;
  const wasmOut = new Uint8Array(res.hash);
  const ref = c.ref(pass, salt, {
    t: params.time,
    m: params.mem,
    p: params.parallelism,
    dkLen: params.hashLen,
  });
  const ok = hex(wasmOut) === hex(ref);
  allOk = allOk && ok;
  console.log(`${ok ? "✅" : "❌"} ${c.name}  ${ms}ms  ${hex(wasmOut).slice(0, 32)}…`);
}

globalThis.process = realProcess;
console.log(allOk ? "\n全部一致：内联 wasm 分支可用" : "\n存在不一致，需排查");
process.exit(allOk ? 0 : 1);
