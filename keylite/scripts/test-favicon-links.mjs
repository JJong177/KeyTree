// 图标链接提取验证：先 esbuild 编译再跑
//   node_modules/@esbuild/win32-x64/esbuild.exe src/lib/favicon.ts --bundle --format=esm --outfile=tmp/favicon.mjs --external:@tauri-apps/plugin-http
//   node scripts/test-favicon-links.mjs
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = await import(
  pathToFileURL(resolve("tmp/favicon.mjs")).href + `?t=${Date.now()}`
);
const { extractIconHrefs } = mod;

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} ${JSON.stringify(detail)}`);
  }
}

const BASE = "https://example.com/";

// 1. 典型页面：apple-touch-icon（180px）应排在 shortcut icon 前面
const html1 = `
<html><head>
<link rel="shortcut icon" href="/favicon.ico">
<link rel="apple-touch-icon" sizes="180x180" href="/static/apple-touch-icon.png">
<link rel="icon" type="image/png" sizes="32x32" href="/static/favicon-32.png">
</head></html>`;
const r1 = extractIconHrefs(html1, BASE);
check(
  "apple-touch-icon 优先",
  r1[0] === "https://example.com/static/apple-touch-icon.png",
  r1
);
check("候选数截到 4 以内", r1.length <= 4, r1.length);
check("32px icon 在 ico 之前", r1.indexOf("https://example.com/static/favicon-32.png") < r1.indexOf("https://example.com/favicon.ico"), r1);

// 2. SVG 矢量最高优先
const html2 = `<link rel="icon" href="/logo.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/a.png">`;
const r2 = extractIconHrefs(html2, BASE);
check("SVG 优先于 apple-touch-icon", r2[0] === "https://example.com/logo.svg", r2);

// 3. 相对路径解析（./ 和无斜杠）
const html3 = `<link rel="icon" href="./icons/x.png"><link rel="icon" href="y.ico">`;
const r3 = extractIconHrefs(html3, BASE);
check("相对路径 ./ 解析", r3.includes("https://example.com/icons/x.png"), r3);
check("相对路径解析", r3.includes("https://example.com/y.ico"), r3);

// 4. mask-icon（Safari 固定图标，单色不适合做 favicon）跳过；非 icon link 跳过
const html4 = `<link rel="mask-icon" href="/safari.svg" color="#333"><link rel="stylesheet" href="/s.css"><link rel="canonical" href="https://example.com/">`;
const r4 = extractIconHrefs(html4, BASE);
check("mask-icon 与非 icon link 全跳过", r4.length === 0, r4);

// 5. 大 sizes 加分（96 以上接近满分）
const html5 = `<link rel="icon" sizes="192x192" href="/big.png"><link rel="icon" sizes="16x16" href="/tiny.ico">`;
const r5 = extractIconHrefs(html5, BASE);
check("大尺寸优先", r5[0] === "https://example.com/big.png", r5);

// 6. 单引号 / 无引号属性
const html6 = `<link rel='icon' href='/a.ico'><link rel=icon href=/b.ico>`;
const r6 = extractIconHrefs(html6, BASE);
check("单引号/无引号属性", r6.length === 2 && r6.includes("https://example.com/a.ico") && r6.includes("https://example.com/b.ico"), r6);

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
