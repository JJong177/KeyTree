import kdbxweb from "kdbxweb";
import { argon2id } from "hash-wasm";

/**
 * 把 hash-wasm 的 Argon2 实现接进 kdbxweb。
 * kdbxweb 不内置 Argon2（KDBX4 的默认 KDF），必须经 setArgon2Impl 注入。
 *
 * 类型契约（见 vendor/kdbxweb/dist/types/crypto/crypto-engine.d.ts 的 Argon2Fn）：
 * - password / salt: ArrayBuffer
 * - memory: KiB（KDBX 格式原生单位，与 hash-wasm 的 memorySize 一致，无需换算）
 * - type: Argon2Type = 0(Argon2d) | 2(Argon2id)；KDBX4 实际只用 id
 * - 返回 Promise<ArrayBuffer>
 */
export function installArgon2(): void {
  kdbxweb.CryptoEngine.setArgon2Impl(
    (password, salt, memory, iterations, length, parallelism, type) => {
      if (type === 0) {
        // hash-wasm 没有 Argon2d 实现；KDBX4 实际不会生成这种库，明确报错好过静默算错哈希
        return Promise.reject(
          new Error("该库使用 Argon2d，KeyLite 仅支持 Argon2id（KDBX4 标准）")
        );
      }
      return argon2id({
        password: new Uint8Array(password),
        salt: new Uint8Array(salt),
        iterations,
        memorySize: memory,
        parallelism,
        hashLength: length,
        outputType: "binary",
      }).then((hash) => {
        const out = new Uint8Array(hash);
        return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
      });
    }
  );
}
