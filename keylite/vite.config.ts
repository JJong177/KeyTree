import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
    watch: {
      // 密码库文件不参与前端热更新：M1 的文件 watcher 会频繁写库，
      // 不排除的话每存一次库整个页面就重载一次
      ignored: ["**/*.kdbx", "**/*.kdbx.bak", "**/*.kdbx.tmp", "**/selftest-*"],
    },
  },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  optimizeDeps: {
    include: ["kdbxweb"],
  },
  build: {
    commonjsOptions: {
      // kdbxweb 经 file:vendor 符号链接指向 node_modules 之外，需显式纳入 CJS 转换
      include: [/kdbxweb/, /node_modules/],
    },
    target: "chrome105",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
});
