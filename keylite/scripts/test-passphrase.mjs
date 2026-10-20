// 口令（passphrase）生成器验证：先 esbuild 把 TS 编译成 tmp/passphrase.mjs 再跑
//   node node_modules/esbuild/bin/esbuild.js src/lib/format.ts --bundle --format=esm --outfile=tmp/passphrase.mjs --external:vue
//   node scripts/test-passphrase.mjs
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const mod = await import(
  pathToFileURL(resolve("tmp/passphrase.mjs")).href + `?t=${Date.now()}`
);
const { generatePassphrase, passphraseStrength, WORDLIST_BITS } = mod;

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

// 1. 基本形态：N 个词、- 连接、全部来自词表
const one = generatePassphrase(6);
const parts = one.split("-");
check("默认 6 词", parts.length === 6, one);

// 2. 词数边界被钳制
check("词数下界 3", generatePassphrase(1).split("-").length === 3);
check("词数上界 12", generatePassphrase(99).split("-").length === 12);

// 3. 随机性：两次生成几乎不可能相同
const distinct = new Set(Array.from({ length: 200 }, () => generatePassphrase(6)));
check("200 次生成全不同", distinct.size === 200, `去重后 ${distinct.size}`);

// 4. 强度识别：生成物能被 passphraseStrength 认出来，熵 = 词数 * log2(词表)
const s = passphraseStrength(generatePassphrase(6));
check("识别为口令", s !== null);
check(
  "熵按词数计算",
  s && s.label === `${6 * WORDLIST_BITS} 位熵`,
  `实际 ${s && s.label}，词表 ${WORDLIST_BITS} 位/词`
);

// 5. 非口令回落：普通密码和胡乱拼的词都认不出
check("普通字符串返回 null", passphraseStrength("Tr0ub4dor&3") === null);
check("词表外的词返回 null", passphraseStrength("alpha-beta-gamma-delta") === null);
check("少于 3 词返回 null", passphraseStrength("oak-pine") === null);

// 6. 无偏性粗测：每个位置上词表首个词的命中频率不应系统性偏高
//    （模偏差会让低位词出现更频繁；这里只做卡方级别的粗检）
const counts = new Map();
const N = 3000;
for (let i = 0; i < N; i++) {
  const [w] = generatePassphrase(3).split("-");
  counts.set(w, (counts.get(w) ?? 0) + 1);
}
const words = Object.keys(mod.WORDS ?? {});
check("取样集合够大", counts.size > 100, `实际 ${counts.size} 个不同词`);
const avg = N / counts.size;
const tooHot = [...counts.values()].filter((c) => c > avg * 3).length;
check("无明显热点（无偏性粗检）", tooHot === 0, `超出均值3倍的词 ${tooHot} 个`);

console.log(`\n${fail === 0 ? "全部通过" : "有失败"}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
