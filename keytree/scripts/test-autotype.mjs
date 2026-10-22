// Auto-Type 序列解析验证（先用 esbuild 把 TS 编到 tmp/autotype.mjs）
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const { parseSequence, DEFAULT_AUTO_TYPE } = await import(
  pathToFileURL(resolve("tmp/autotype.mjs")).href + `?t=${Date.now()}`
);

const values = { username: "jong@example.com", password: "p@ss中文" };
let failed = 0;

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failed++;
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) console.log(`   实际 ${a}\n   期望 ${e}`);
}

check("默认序列", parseSequence("", values), [
  { kind: "text", value: "jong@example.com" },
  { kind: "tab" },
  { kind: "text", value: "p@ss中文" },
  { kind: "enter" },
]);

check("自定义顺序", parseSequence("{PASSWORD}{TAB}{USERNAME}", values), [
  { kind: "text", value: "p@ss中文" },
  { kind: "tab" },
  { kind: "text", value: "jong@example.com" },
]);

check("延迟", parseSequence("{USERNAME}{TAB}{DELAY 800}{PASSWORD}", values), [
  { kind: "text", value: "jong@example.com" },
  { kind: "tab" },
  { kind: "delay", ms: 800 },
  { kind: "text", value: "p@ss中文" },
]);

check("未知占位符按文本", parseSequence("a{X}b", values), [
  { kind: "text", value: "a{X}b" },
]);

check("空用户名不产生空文本", parseSequence("{USERNAME}{TAB}{PASSWORD}", { username: "", password: "x" }), [
  { kind: "tab" },
  { kind: "text", value: "x" },
]);

check("默认常量", DEFAULT_AUTO_TYPE, "{USERNAME}{TAB}{PASSWORD}{ENTER}");

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
