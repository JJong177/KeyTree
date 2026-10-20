import type { Kdbxweb } from "./kdbxweb";

type Argon2Browser = {
  hash(opts: {
    pass: Uint8Array;
    salt: Uint8Array;
    time: number;
    mem: number;
    hashLen: number;
    parallelism: number;
    type: number;
    version: number;
  }): Promise<{ hash: Uint8Array | ArrayBuffer }>;
};

/** 同样按能力探测剥壳：argon2-browser 也是 UMD，同样没有 default。 */
function unwrapArgon2(mod: unknown): Argon2Browser | null {
  let cur: unknown = mod;
  for (let depth = 0; depth < 6; depth++) {
    if (!cur || typeof cur !== "object") return null;
    const candidate = cur as Record<string, unknown>;
    if (typeof candidate.hash === "function") return cur as Argon2Browser;
    cur = candidate.default;
  }
  return null;
}

let installed = false;

/**
 * 把 argon2-browser（wasm，KeeWeb 同款实现）接进 kdbxweb。
 * kdbxweb 不内置 Argon2（KDBX4 的默认 KDF），必须经 setArgon2Impl 注入。
 *
 * 为什么不用 hash-wasm：它只实现 Argon2i/Argon2id，而 KDBX 生态三种变体都在用
 * （KeePassXC 默认 id，kdbxweb/pykeepass 默认 d）——只支持 id 会打不开一部分合法库。
 *
 * 为什么用动态 import：argon2-browser 的 UMD 在模块加载时会做 Emscripten/wasm 初始化，
 * 静态 import 一旦在 webview 里失败会把整个 App 拖挂（白屏）。懒加载让首屏不依赖它，
 * 且失败时错误只出现在解锁路径上，可提示。
 */
export async function installArgon2(kdbxweb: Kdbxweb): Promise<void> {
  if (installed) return;

  const mod: unknown = await import(
    "argon2-browser/dist/argon2-bundled.min.js"
  );
  const argon2 = unwrapArgon2(mod);
  if (!argon2) throw new Error("argon2 引擎加载异常");

  kdbxweb.CryptoEngine.setArgon2Impl(
    (password, salt, memory, iterations, length, parallelism, type) =>
      argon2
        .hash({
          pass: new Uint8Array(password),
          salt: new Uint8Array(salt),
          time: iterations,
          mem: memory,
          hashLen: length,
          parallelism,
          type,
          version: 0x13,
        })
        .then((res) => {
          const out =
            res.hash instanceof Uint8Array
              ? res.hash
              : new Uint8Array(res.hash);
          return out.buffer.slice(
            out.byteOffset,
            out.byteOffset + out.byteLength
          ) as ArrayBuffer;
        })
  );
  installed = true;
}
