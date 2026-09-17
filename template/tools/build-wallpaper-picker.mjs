#!/usr/bin/env node
/**
 * build-wallpaper-picker.mjs — 生成「壁纸选择器」图形界面（HTA）
 *
 * 为什么要有图形界面：
 *   陛下要的是「点一下就换」，不是黑底白字的命令行。HTA 是 Windows 原生能力
 *   （mshta.exe，每台 Windows 都有），双击即开，不需要 node、不需要常驻服务、
 *   不占端口，还能显示壁纸缩略图。
 *
 * 架构（这一版改过，很重要）：
 *   模板是磁盘上的独立文件 tools/picker.template.hta，不是内嵌在这个脚本里的
 *   字符串。原因：早先把模板塞进 JS 模板字符串，于是输出里每个反斜杠都要写两遍
 *   （\s 要写 \\s、\r\n 要写 \\r\\n、\" 要写 \\"），漏一个就产出语法错误的
 *   .hta，而且完全静默 —— 实际就踩了，产物里 /^\s+/ 变成了 /^s+/、
 *   字符串被真换行切断、/RC=(\d+)/ 变成了 /RC=(d+)/。
 *   改成独立模板文件后，模板里按「最终产物」的样子原文书写，这层双写陷阱消失。
 *
 * 产物为什么是纯 ASCII：
 *   HTA 跑在 MSHTML(IE 内核) 上，对文件编码的猜测很不确定（ANSI？UTF-8？BOM？）。
 *   猜错就是满屏乱码，而且在 GUI 里极难排查。所以这里把模板里所有非 ASCII 字符
 *   转成 JScript 的 \uXXXX 转义，产出的 .hta 是纯 ASCII：
 *   无论按哪种编码解析，结果都一致。
 *
 * 用法：
 *   node tools/build-wallpaper-picker.mjs              只生成
 *   node tools/build-wallpaper-picker.mjs --selftest   生成 + 真的拉起 HTA 自检 + 读回结果
 *
 * 产物：launcher\壁纸选择器.hta
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const TPL = path.join(__dir, "picker.template.hta");
const OUT = path.join(ROOT, "launcher", "壁纸选择器.hta");
const LOG_DIR = path.join(ROOT, "logs");
const SELFTEST_LOG = path.join(LOG_DIR, "picker-selftest.txt");
const SELFTEST_FLAG = path.join(LOG_DIR, "picker-selftest.flag");

// 仅用于报告「本次构建用的是哪个 node」——不再是注入到产物里的东西
const NODE_EXE = process.execPath;

// 说明：这里不再有「注入到产物里的路径表」（原来的 VALUES）。
// 产物需要的路径全部由模板在运行时自己推导，见文件顶部第 1 步的注释。

const fail = (title, lines = []) => {
  console.error("✗ " + title);
  lines.forEach((l) => console.error("   · " + l));
  process.exit(1);
};

// ---------------------------------------------------------------------------
// 1. 读模板
//
// 早先这一步还要把 __ROOT__ / __NODE__ 之类的占位符替换成绝对路径 —— 那会让
// 产物被绑死在生成它的那台机器上，换个目录就得重新生成。现在路径全部由模板
// 自己在运行时推导（见 picker.template.hta 里的 htaSelfPath / readEnvCmd），
// 所以这里只剩「读进来」。产物天然可移植：整个 launcher\ 目录拷到哪都能用。
// ---------------------------------------------------------------------------
if (!fs.existsSync(TPL)) fail(`模板不存在：${TPL}`);

let src = fs.readFileSync(TPL, "utf8");

// 反向保险：模板里不该再出现旧式占位符。出现了说明有人把注入式改回来了，
// 那种产物是绑机器上的，必须在构建时就拦住。
const left = src.match(/__[A-Z_]+__/g);
if (left) fail("模板里残留了旧式占位符（路径已改为运行时推导，不该再注入绝对路径）", [...new Set(left)]);

// ---------------------------------------------------------------------------
// 2. 非 ASCII 全部转义 —— 产物必须纯 ASCII
// ---------------------------------------------------------------------------
/** 把非 ASCII 字符转成 JScript 的 \uXXXX 转义（含代理对） */
function toAsciiEscape(s) {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { out += ch; continue; }
    if (cp > 0xffff) {
      const v = cp - 0x10000;
      out += "\\u" + (0xd800 + (v >> 10)).toString(16).toUpperCase().padStart(4, "0");
      out += "\\u" + (0xdc00 + (v & 0x3ff)).toString(16).toUpperCase().padStart(4, "0");
    } else {
      out += "\\u" + cp.toString(16).toUpperCase().padStart(4, "0");
    }
  }
  return out;
}

const escapedCount = (src.match(/[^\x00-\x7F]/g) || []).length;
const out = toAsciiEscape(src);

const badByte = [...out].findIndex((c) => c.charCodeAt(0) > 127);
if (badByte >= 0) {
  fail("产物含非 ASCII 字符，转义不完整", [`首个位置 ${badByte}`, "检查模板里是否有中文落在字符串字面量/注释之外，或落在 HTML 标签里"]);
}

// ---------------------------------------------------------------------------
// 3. 语法校验 —— 用真正的解析器，不靠肉眼，也不靠引号计数那类启发式
// ---------------------------------------------------------------------------
const m = /<script language="JScript">([\s\S]*?)<\/script>/.exec(out);
if (!m) fail("产物里找不到 <script language=\"JScript\"> 代码块");
const js = m[1];

const jsLines = js.split("\n").length;

/**
 * 剥掉 JScript 里的注释，只留可执行代码。
 * 为什么不用正则一把梭：字符串里也有 // （比如 "file:///"），正则会把
 * 字符串后半截当注释切掉。所以这里按字符扫，遇到引号就进字符串态。
 * 代价是不认正则字面量 —— 好在本文的正则里没有引号，不构成问题。
 */
function stripComments(s) {
  let out = "";
  let i = 0;
  let mode = null; // null | "'" | '"' | "//" | "/*"
  while (i < s.length) {
    const c = s[i];
    const d = s[i + 1];
    if (mode === null) {
      if (c === '"' || c === "'") { mode = c; out += c; i++; continue; }
      if (c === "/" && d === "/") { mode = "//"; i += 2; continue; }
      if (c === "/" && d === "*") { mode = "/*"; i += 2; continue; }
      out += c; i++; continue;
    }
    if (mode === "//") { if (c === "\n") { mode = null; out += c; } i++; continue; }
    if (mode === "/*") { if (c === "*" && d === "/") { mode = null; i += 2; } else i++; continue; }
    if (c === "\\") { out += c + (d === undefined ? "" : d); i += 2; continue; }
    out += c; i++;
    if (c === mode) mode = null;
  }
  return out;
}

// 3a. 真的能解析吗。JScript 是 ES3/ES5 方言，node 按函数体解析足以抓出
//     字符串没闭合、括号不配对、转义串味这类问题 —— 就是先前踩的那类。
try {
  // eslint-disable-next-line no-new-func
  new Function(js);
} catch (e) {
  const near = js.split("\n");
  const hit = near.findIndex((l) => /unterminated|Invalid|Unexpected/i.test(l));
  fail("JScript 代码块语法错误（解析器拒绝）：" + e.message, hit >= 0 ? [`第 ${hit + 1} 行附近`] : []);
}

// 3b. 只能用 ES5。HTA 的引擎版本取决于本机装的 IE，新语法一律不认，
//     而 node 的解析器是认的 —— 所以必须单独拦一道。
//
//     查之前必须先把注释剥掉：注释里写个省略号（...）或 `let` 二字，
//     按源码直接匹配就会误判。实际就误判过一次。
const jsCode = stripComments(js);

const ES6_TRAPS = [
  [/=>/, "箭头函数"],
  [/`/, "模板字符串"],
  [/\blet\s+[A-Za-z_$]/, "let"],
  [/\bconst\s+[A-Za-z_$]/, "const"],
  [/\bclass\s+[A-Za-z_$]/, "class"],
  [/\.\.\./, "展开/剩余运算符"],
  [/\.includes\(/, "String/Array.prototype.includes"],
  [/Array\.from/, "Array.from"],
  [/Object\.assign/, "Object.assign"],
];
const traps = ES6_TRAPS.filter(([re]) => re.test(jsCode)).map(([, n]) => n);
if (traps.length) fail("代码块用了 ES5 之外的语法，HTA 的引擎不认", traps);

// 3c. 关键内容在不在（防止模板被改到结构性失效）
const must = [
  ['HTA:APPLICATION', out.includes("HTA:APPLICATION")],
  ['ID="oWp"', out.includes('ID="oWp"')],
  ["function runCmd", js.includes("function runCmd")],
  ["function render", js.includes("function render")],
  ["function selfTest", js.includes("function selfTest")],
  ["退出码解析 RC=", js.includes("RC=")],
  ["壁纸变量注入点 set-wallpaper.mjs", js.includes("set-wallpaper.mjs")],
];
const lost = must.filter(([, ok]) => !ok).map(([n]) => n);
if (lost.length) fail("产物缺少关键内容", lost);

// 3d. 引用一致性：脚本里每一处 WIN.xxx，WIN 对象里都必须真的有这个键。
//     这条是拿血换来的。先前加了个 WIN.flag 的用法，却忘了在 WIN 对象里定义它，
//     于是 ntv(undefined) 变成字符串 "undefined"，FileExists 恒为 false，
//     自检永远不触发 —— 而表面上「什么都没发生」，根本看不出错在哪，
//     查了好几轮才定位。变量名写错这类事必须由机器拦住，不能靠人仔细。
const winBlock = /var WIN = \{([\s\S]*?)\n\};/.exec(out);
if (!winBlock) fail("产物里找不到 WIN 常量对象");
const definedKeys = new Set([...winBlock[1].matchAll(/^\s*(\w+)\s*:/gm)].map((mm) => mm[1]));
const usedKeys = new Set([...jsCode.matchAll(/\bWIN\.(\w+)/g)].map((mm) => mm[1]));
const undefKeys = [...usedKeys].filter((k) => !definedKeys.has(k));
if (undefKeys.length) {
  fail("脚本引用了 WIN 里没有定义的字段（这类错会静默失效，必须挡在构建期）",
    undefKeys.map((k) => `WIN.${k} —— WIN 对象里没有这个键，运行时会变成 undefined`));
}

// 3d. 关键路径真存在吗 —— 界面点了却换不了壁纸比打不开更糟
const paths = [
  ["壁纸库目录", path.join(ROOT, "wallpapers")],
  ["换壁纸脚本", path.join(ROOT, "tools", "set-wallpaper.mjs")],
  ["node 运行时", NODE_EXE.replace(/\//g, path.sep)],
];
const missing = paths.filter(([, p]) => !fs.existsSync(p)).map(([n, p]) => `${n}：${p}`);
if (missing.length) fail("以下路径不存在，生成的界面点了也换不了壁纸", missing);

// ---------------------------------------------------------------------------
// 4. 落盘
// ---------------------------------------------------------------------------
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(OUT, out, "ascii");

console.log(`✅ 已生成 ${OUT}`);
console.log(`   体积 ${out.length}B ｜ 纯 ASCII ✅（非 ASCII 字符 0 个）`);
console.log(`   转义的中文字符：${escapedCount} 个 ｜ JScript 代码块 ${jsLines} 行`);
console.log(`   语法校验：解析通过 ✅ ｜ ES5 合规 ✅ ｜ 关键内容 ${must.length}/${must.length} ✅`);
console.log(`   壁纸库：${path.join(ROOT, "wallpapers")}`);

// ---------------------------------------------------------------------------
// 5. --selftest：真的把界面拉起来，再读回它自己写的证据
//    本机教训：自检通过 != 界面画出来了，所以自检本身要校验 DOM。
//
//    触发方式用「标志文件」而不是命令行参数：命令行要依赖 HTA 的
//    oWp.commandLine，实测它没进去，窗口就一直开着挂在那儿（现在还留在屏幕上）。
//    标志文件是确定性的。
//
//    另外绝不阻塞等待 GUI 进程：起来之后轮询它写下的日志，
//    拿到就走，拿不到就如实报失败 —— 不能让构建进程去赌一个窗口会不会自己关。
// ---------------------------------------------------------------------------
if (process.argv.includes("--kill")) {
  // 清掉可能挂着的旧窗口。默认不做，避免误杀陛下自己开着的其他 HTA。
  try {
    spawnSync("taskkill", ["/IM", "mshta.exe", "/F"], { stdio: "ignore" });
    console.log("· 已尝试清理残留的 mshta 进程");
  } catch (e) {
    console.log("· 清理残留进程失败（不影响后续）：" + e.message);
  }
}

if (process.argv.includes("--selftest")) {
  console.log("");
  console.log("--- 拉起 HTA 自检 ---");
  for (const p of [SELFTEST_LOG, SELFTEST_FLAG]) { try { fs.unlinkSync(p); } catch { /* 首次没有 */ } }

  fs.writeFileSync(SELFTEST_FLAG, "selftest\n", "ascii");

  const mshtaPath = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "mshta.exe");
  const exe = fs.existsSync(mshtaPath) ? mshtaPath : "mshta.exe";

  let child = null;
  try {
    child = spawn(exe, [OUT], { stdio: "ignore" });
    child.on("error", (e) => console.error("   宿主进程启动报错：" + e.message));
  } catch (e) {
    console.error("✗ 宿主进程启动失败：" + e.message);
  }
  if (!child) {
    try { fs.unlinkSync(SELFTEST_FLAG); } catch { /* ignore */ }
    process.exit(1);
  }

  // 同步小睡
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

  let txt = "";
  for (let i = 0; i < 60; i++) {
    try { txt = fs.readFileSync(SELFTEST_LOG, "utf8"); } catch { txt = ""; }
    if (txt.includes("ALL=DONE")) break;
    sleep(500);
  }

  // 关键：必须自己收尸。实测 HTA 里的 window.close() 关不掉宿主进程，
  // 不自杀就会在屏幕上留一个关不掉的窗口 —— 已经发生过一次。
  const stillAlive = child.exitCode === null;
  try { child.kill(); } catch { /* ignore */ }
  sleep(300);
  try { child.kill("SIGKILL"); } catch { /* ignore */ }

  try { fs.unlinkSync(SELFTEST_FLAG); } catch { /* ignore */ }

  if (!txt) {
    fail("HTA 没留下任何日志 —— 脚本一行都没执行（连启动留痕都没有）。", [
      `预期日志：${SELFTEST_LOG}`,
      "启动留痕没有，说明 HTA 的脚本根本没跑，而不是某一步失败。",
      "此时要查的是宿主/策略层，不是界面代码。",
    ]);
  }

  console.log(txt.trim().split(/\r?\n/).map((l) => "   " + l).join("\n"));
  if (stillAlive) console.log("   （宿主进程不自行退出，已由构建脚本收尸）");

  // ---- 断言 ----
  const get = (k) => {
    const mm = new RegExp("^" + k + "=(.*)$", "m").exec(txt);
    return mm ? mm[1].trim() : null;
  };
  const problems = [];
  const need = {
    FSO: "OK",
    SHELL: "OK",
    LIB_EXISTS: "1",
    NODE_EXISTS: "1",
    SCRIPT_EXISTS: "1",
    NODE_VERSION_RC: "0",
    LIST_CMD_RC: "0",
    DOM_TITLE_MATCH: "1",
    // 下面三条针对「中文壁纸名被按 ASCII 读成乱码」那类问题。
    // 光打一行 STATE_PATH 在纯 ASCII 日志里只会显示成问号，看不出对错，
    // 所以必须用数值断言。
    STATE_MISSING: "0",
    STATE_IN_LIST: "1",
    DOM_ON_COUNT: "1",
    ALL: "DONE",
  };
  for (const [k, want] of Object.entries(need)) {
    const got = get(k);
    if (got !== want) problems.push(`${k}=${got === null ? "(缺失)" : got}，应为 ${want}`);
  }
  const nWp = Number(get("WALLPAPER_COUNT"));
  const nCard = Number(get("DOM_CARD_COUNT"));
  if (!(nWp >= 1)) problems.push(`WALLPAPER_COUNT=${get("WALLPAPER_COUNT")}，壁纸库里一张图都没有`);
  if (nCard !== nWp) problems.push(`DOM_CARD_COUNT=${nCard} 与 WALLPAPER_COUNT=${nWp} 不一致 —— 界面没把每张壁纸都画出来`);
  if (!(Number(get("DOM_GRID_LEN")) >= 50)) problems.push(`DOM_GRID_LEN=${get("DOM_GRID_LEN")}，卡片区域几乎是空的`);
  if (!(Number(get("LIST_CMD_OUT_BYTES")) >= 50)) problems.push(`LIST_CMD_OUT_BYTES=${get("LIST_CMD_OUT_BYTES")}，命令没有真实输出`);

  console.log("");
  if (problems.length) fail("自检未通过", problems);
  console.log(`✅ 自检通过：${Object.keys(need).length} 项断言 + 4 项数值一致性校验`);
}
