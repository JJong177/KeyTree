import kdbxweb from "kdbxweb";
import argon2 from "argon2-browser/dist/argon2-bundled.min.js";

/**
 * 把 argon2-browser（wasm，KeeWeb 同款实现）接进 kdbxweb。
 * kdbxweb 不内置 Argon2（KDBX4 的默认 KDF），必须经 setArgon2Impl 注入。
 *
 * 为什么不用 hash-wasm：它只实现 Argon2i/Argon2id，而 KDBX 生态三种变体都在用
 * （KeePassXC 默认 id，kdbxweb/pykeepass 默认 d）——只支持 id 会打不开一部分合法库。
 * argon2-browser 覆盖 0=Argon2d / 1=Argon2i / 2=Argon2id，与 kdbxweb 的 Argon2Type 数值一致。
 *
 * 类型契约（见 vendor/kdbxweb/dist/types/crypto/crypto-engine.d.ts 的 Argon2Fn）：
 * - password / salt: ArrayBuffer；memory: KiB；返回 Promise<ArrayBuffer>
 */
export function installArgon2(): void {
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
          const out = new Uint8Array(res.hash);
          return out.buffer.slice(
            out.byteOffset,
            out.byteOffset + out.byteLength
          ) as ArrayBuffer;
        })
  );
}
