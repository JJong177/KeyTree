/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

declare module "argon2-browser/dist/argon2-bundled.min.js" {
  interface Argon2Options {
    pass: string | Uint8Array;
    salt: string | Uint8Array;
    time: number;
    mem: number;
    hashLen: number;
    parallelism: number;
    type: number;
    version?: number;
  }
  export function hash(options: Argon2Options): Promise<{ hash: Uint8Array }>;
  const argon2: { hash: typeof hash };
  export default argon2;
}
