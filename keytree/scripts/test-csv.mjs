// CSV 解析/生成验证：先 esbuild 编译再跑
//   node_modules/@esbuild/win32-x64/esbuild.exe src/lib/csv.ts --bundle --format=esm --outfile=tmp/csv.mjs
//   node scripts/test-csv.mjs
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = await import(
  pathToFileURL(resolve("tmp/csv.mjs")).href + `?t=${Date.now()}`
);
const { parseCsv, detectColumns, buildChromeCsv } = mod;

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name} ${detail}`);
  }
}

// 1. Chrome/Edge 导出样例：带引号转义 + CRLF
const chrome = `name,url,username,password\r\nGitHub,https://github.com,octocat,"pass,with""quotes"\r\nGoogle,https://google.com,a@b.c,"multi\r\nline"`;
const rows1 = parseCsv(chrome);
check("Chrome 行数", rows1.length === 3, JSON.stringify(rows1.length));
check("Chrome 表头", rows1[0].join("|") === "name|url|username|password");
check("引号内逗号+双引号转义", rows1[1][3] === `pass,with"quotes`, JSON.stringify(rows1[1][3]));
check("引号内换行", rows1[2][3] === "multi\nline", rows1[2][3]);

// 2. KeePassXC 样例：Group 分层 + BOM
const kpx = `\uFEFF"Group","Title","Username","Password","URL","Notes"\n"Web/开发","GitHub","octo","pw","https://github.com","代码"\n"银行","招行","me","pw2","",""`;
const rows2 = parseCsv(kpx);
check("KeePassXC 去 BOM + 行数", rows2.length === 3);
const cols2 = detectColumns(rows2[0]);
check(
  "KeePassXC 列识别",
  cols2 &&
    cols2.title === 1 &&
    cols2.username === 2 &&
    cols2.password === 3 &&
    cols2.url === 4 &&
    cols2.notes === 5 &&
    cols2.group === 0,
  JSON.stringify(cols2)
);

// 3. Chrome 表头识别 + Bitwarden 表头识别 + 垃圾表头拒绝
const cols1 = detectColumns(parseCsv(chrome)[0]);
check("Chrome 列识别", cols1 && cols1.title === 0 && cols1.url === 1 && cols1.username === 2 && cols1.password === 3);
const bw = detectColumns(
  parseCsv("folder,favorite,type,name,notes,fields,login_uri,login_username,login_password")[0]
);
check(
  "Bitwarden 列识别",
  bw && bw.title === 3 && bw.url === 6 && bw.username === 7 && bw.password === 8 && bw.group === 0,
  JSON.stringify(bw)
);
check("垃圾表头返回 null", detectColumns(["a,b,c"]) === null);

// 4. 尾行无换行符 + 末尾空字段
const rows3 = parseCsv("a,b\nc,d,\n");
check("末尾空字段保留", rows3[1].length === 3 && rows3[1][2] === "", JSON.stringify(rows3[1]));
const rows4 = parseCsv("x,y\nz,w");
check("尾行无换行", rows4.length === 2 && rows4[1][1] === "w");

// 5. 生成：含逗号/引号/换行的字段正确转义
const out = buildChromeCsv([
  { title: "plain", url: "https://x.y", username: "u", password: "p" },
  { title: 'we"ird, title', url: "https://x.y", username: "u2", password: "multi\nline" },
]);
check(
  "生成转义",
  out.includes('"we""ird, title"') && out.includes('"multi\nline"') && out.startsWith("name,url,username,password,note\r\n"),
  JSON.stringify(out)
);

// 6. 往返：生成的东西能原样解析回来
const round = parseCsv(out);
check(
  "生成→解析往返",
  round[1][0] === "plain" && round[2][0] === 'we"ird, title' && round[2][3] === "multi\nline",
  JSON.stringify(round)
);

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
