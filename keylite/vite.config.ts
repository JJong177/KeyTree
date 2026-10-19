import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [vue(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
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
