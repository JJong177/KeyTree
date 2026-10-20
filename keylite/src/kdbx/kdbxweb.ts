import type * as KdbxwebTypes from "kdbxweb";

export type Kdbxweb = typeof KdbxwebTypes;

/**
 * 鸭子类型逐层剥壳：拿到真正带 Kdbx 的导出对象。
 *
 * 为什么不能直接 `import kdbxweb from "kdbxweb"`：
 * kdbxweb 是 webpack 打的 UMD，它的导出对象自己定义了 `__esModule: true`，
 * 但**没有 default 导出**。Vite 的 CJS 互操作看到 `__esModule` 为真就去取 `.default`，
 * 结果拿到 undefined（典型报错：Cannot read properties of undefined (reading 'CryptoEngine')）。
 * 反过来的命名空间导入又多包了一层 `{ default: { default: 真对象 } }`。
 *
 * 与其依赖某个具体打包形态（Vite 版本、是否预打包、生产/开发模式都会变），
 * 不如按能力探测：谁身上有 Kdbx + CryptoEngine，谁就是它。
 */
function unwrapKdbxweb(mod: unknown): Kdbxweb | null {
  let cur: unknown = mod;
  for (let depth = 0; depth < 6; depth++) {
    if (!cur || typeof cur !== "object") return null;
    const candidate = cur as Record<string, unknown>;
    if (
      typeof candidate.Kdbx === "function" &&
      typeof candidate.CryptoEngine === "object" &&
      candidate.CryptoEngine !== null
    ) {
      return cur as Kdbxweb;
    }
    cur = candidate.default;
  }
  return null;
}

let cached: Kdbxweb | null = null;

/** 加载 kdbxweb 引擎（幂等，成功后缓存）。所有库操作前必须先拿到它。 */
export async function getKdbxweb(): Promise<Kdbxweb> {
  if (cached) return cached;
  const mod: unknown = await import("kdbxweb");
  const engine = unwrapKdbxweb(mod);
  if (!engine) {
    const keys =
      mod && typeof mod === "object" ? Object.keys(mod).join(",") : typeof mod;
    throw new Error(`kdbxweb 模块加载异常（导出形状：${keys}）`);
  }
  cached = engine;
  return engine;
}
