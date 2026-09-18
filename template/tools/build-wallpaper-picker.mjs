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

// 图标：模板里的 ICON="picker.ico" 是**相对**路径，mshta 以 .hta 所在目录为基准
// 解析它，所以图标必须和产物同目录。源文件放在 tools/（跟着代码走），
// 生成时拷一份到 launcher/（跟着产物走）。
const ICON_SRC = path.join(__dir, "picker.ico");
const ICON_OUT = path.join(ROOT, "launcher", "picker.ico");
const ICON_REF = "picker.ico";


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
/* 报出**行号 + 那一行的内容**，不要只报语法名。
   一开始只报"箭头函数 / 模板字符串"这种名字，真去改的时候还得全文找是哪一处 ——
   本轮就为了注释里一个反引号多跑了一轮构建（门禁拦住了，但没说拦在哪）。
   注意 stripComments() 会把注释整段抽掉，所以行号是"代码块内第 N 行"，
   与模板源码的行号不一一对应 —— 这一点在消息里写明，免得照着行号找错地方。 */
const traps = [];
for (const [re, n] of ES6_TRAPS) {
  const hit = re.exec(jsCode);
  if (!hit) continue;
  const idx = jsCode.slice(0, hit.index).split("\n").length;
  const snippet = jsCode.split("\n")[idx - 1].trim().slice(0, 60);
  traps.push(`${n} —— 代码块内第 ${idx} 行：${snippet}`);
}
if (traps.length) fail("代码块用了 ES5 之外的语法，HTA 的引擎不认", traps);

// 3b-2. ICON 属性 —— 只在 <HTA:APPLICATION ... /> 元素内部取属性，不全文 grep。
//
// 为什么必须限定范围：这一项的第一版写成 out.includes('ICON="picker.ico"')，
// 而模板里恰好有一段解释 ICON 用法的注释也写着这串字 —— 于是把 ICON 属性
// 整行删掉，检查照样报「关键内容 8/8」。**注释把门禁骗过去了。**
// 这正是那句「扫描类门禁的失效方式不是判错，而是根本没扫到」的又一次实例；
// ES6 那项早就用 stripComments() 防住了，这里改成按元素取属性，从根上避免。
const htaBlock = /<HTA:APPLICATION([\s\S]*?)\/>/.exec(out);
if (!htaBlock) fail("产物里找不到 <HTA:APPLICATION ... /> 元素");

const iconAttr = /ICON\s*=\s*"([^"]*)"/.exec(htaBlock[1]);
if (!iconAttr) {
  fail("HTA:APPLICATION 里没有 ICON 属性", [
    `该属性是照文档保留的（本机 mshta 实测不生效，见 SKILL.md 7.10.1），应为 ICON="${ICON_REF}"`,
    "它不见了说明模板被改过 —— 若是有意删掉，就连这条检查一起去掉，别留个假要求",
  ]);
}
// 绝对路径会把产物钉死在生成它的那台机器上。（本机这条属性不生效，
// 所以这里拦的是"将来哪天生效了、或者被别的宿主读到"的情况。）
if (/^[A-Za-z]:[\\/]|^\\\\|^[\\/]/.test(iconAttr[1])) {
  fail("ICON 是绝对路径，产物不可移植", [
    `当前值：${iconAttr[1]}`,
    "改成相对文件名（mshta 以 .hta 所在目录为基准解析），由本脚本把图标拷到产物旁边",
  ]);
}
if (iconAttr[1] !== ICON_REF) {
  fail(`ICON 指向的不是 ${ICON_REF}`, [`当前值：${iconAttr[1]}`]);
}

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

// 3c-2. 图标文件本身：必须存在，且真的是 .ico
// 只判"文件在不在"不够 —— 一个 0 字节或被 Git 当文本处理坏掉的文件同样"存在"，
// 拿去做快捷方式的 IconLocation 会静默退回默认图标。
if (!fs.existsSync(ICON_SRC)) {
  fail("图标源文件不存在，外壳（快捷方式）就没法带上项目图标", [`预期位置：${ICON_SRC}`]);
}
{
  const ib = fs.readFileSync(ICON_SRC);
  const magicOk = ib.length >= 6 && ib[0] === 0 && ib[1] === 0 && ib[2] === 1 && ib[3] === 0;
  if (!magicOk) {
    fail("图标文件不是有效的 .ico（缺 00 00 01 00 文件头）", [`${ICON_SRC} 前 8 字节：${[...ib.subarray(0, 8)].join(" ")}`]);
  }
  const n = ib.readUInt16LE(4);
  if (!(n >= 1)) fail("图标文件里一个图像尺寸都没有", [`声明尺寸数：${n}`]);
}


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

// 3c-2. 反向检查之一：产物里不许再**调用** BrowseForFolder
//   这一条的检查方向和其他都相反 —— 它盯的是"不许出现什么"。
//   上一版只禁了 pickFolder() 函数体内；本轮把范围扩到全产物，因为那个入口
//   已经从"备用"变成"彻底删掉"了：它是 XP 时代的控件，没有缩略图，
//   用户看得见文件名、看不见图。留着它就是留着一条"点了看不见图"的路，
//   而所有正向断言都不会响。
//
//   判据为什么是 `BrowseForFolder(` 而不是光看名字：说明文字里难免会提到它
//   （本产物里就有好几处注释在讲"为什么不用它"），把**提到**也判违规，
//   门禁就会变成"一句解释都不能写" —— 那是我第一次写这条时的错，
//   构建当场就报了（注释里提到它也算命中）。真正要拦的是**调用**。
//   注意别把它和"系统自带对话框"混为一谈：现在的主入口走的是 Vista+ 的通用
//   对话框（IFileOpenDialog），有缩略图 —— 那才是要留的。
const fnPick = /function pickFolder\(\) \{([\s\S]*?)\n\}/.exec(out);
if (!fnPick) fail("产物里找不到 pickFolder，原生不可用时就没有兜底入口了");
if (/BrowseForFolder\s*\(/.test(out)) {
  fail("产物里又出现了 BrowseForFolder 的调用（没有缩略图的老控件）", [
    "它让用户只能看见文件名、看不见图，而挑壁纸恰恰是「看图」的活。",
    "要「原生交互」请走 pickByNative（PowerShell + Vista+ 通用对话框），",
    "那条路才有缩略图 / 左侧导航 / 搜索。",
  ]);
}
// 3c-2b. 结构门禁：主按钮必须真的接在原生那条路上
//   这一轮的全部意义就是"点「选一张图…」出原生框"。只验证 pickByNative 存在
//   是不够的 —— 它可能写了却没接线，那用户点了还是老路。所以直接盯接线语句。
if (!/bPick\.onclick\s*=\s*pickByNative;/.test(out)) {
  fail("主按钮没有接在原生对话框上（bPick.onclick = pickByNative 不见了）", [
    "pickByNative 可能是写了但没接线，也可能是被换回了其它入口。",
    "结果都是：用户点主按钮时，看到的不是资源管理器那个框。",
  ]);
}
// 3c-2c. 反向检查之三：主按钮的**名字**也得说原生，还得挂上悬停说明
//   为什么"接线对了"还不够：陛下这轮的原话是「直接调用 WINDOWS 自带的文件管理器，
//   原生交互会好一点」。按钮接在原生框上、名字却还写着旧的「选一张图…」，
//   用户根本看不出这轮改了什么 —— 而"入口名字与实际行为对不上"正是这个项目
//   前两轮反复踩的坑（叫「浏览文件夹…」时，用户以为要交出一个文件夹）。
//   这条还顺带挡住一类**运行时空白**：文案键被删/改名、引用却没跟着改，
//   createTextNode(undefined) 渲染出来是个没有字的按钮 —— 接线在、函数在、
//   语法也过，所有正向断言都不响，只有这条能拦。本轮就正好是这种改动形态。
if (!/bPick\.appendChild\(document\.createTextNode\(T\.nativeBtn\)\)/.test(out)) {
  fail("主按钮的文案不是 T.nativeBtn（按钮上写的名字与实际打开的框对不上）", [
    "主入口走的是资源管理器的选图框，按钮就必须写着「用资源管理器选…」。",
    "另一种触发方式：文案键被删/改名后忘了改这一处引用 —— 那会渲染出一个空白按钮。",
  ]);
}
if (!/bPick\.title\s*=\s*T\.nativeTitle;/.test(out)) {
  fail("主按钮没挂悬停说明（bPick.title = T.nativeTitle 不见了）", [
    "按钮名字要短（它和「在界面里翻…」并排），细节靠 title 补：挑一张、选完自动换上。",
  ]);
}
// 3c-2d. 废弃的文案键不许再被引用
//   删键不删引用是**静默**故障：运行时报 undefined，按钮空白、状态行空白，
//   而构建期三道检查（语法 / ES5 / 关键内容）全绿，谁都看不出来。
//   判据走 jsCode（**已剥注释**的代码）而不是 out：
//   注释里当然还要讲这段历史，把"提到"也判违规，就等于"一句解释都不许写" ——
//   这个项目在这上面已经栽过一次（反向门禁把注释里的 BrowseForFolder 也算命中）。
if (/T\.pickFolder(Title)?\b/.test(jsCode)) {
  fail("代码里还在用已删除的文案键 T.pickFolder / T.pickFolderTitle", [
    "pickFolder 与函数同名（迟早有人改错那一个），pickFolderTitle 从未接到任何控件上。",
    "主按钮应取 T.nativeBtn，兜底按钮取 T.inUiBtn。",
  ]);
}
// 3c-3. 反向检查之二：原生对话框的核心开关不许被拿掉
//   为什么单独拦一条：AutoUpgradeEnabled 一变成 false，WinForms 会**静默**退回
//   Vista 之前的老式对话框 —— 路径照样拿得到、代码照样跑得通，只有"看得见图"
//   这件事没了。症状与当初的 BrowseForFolder 一模一样，而正向断言全绿，
//   所以只能靠这里拦。
if (!/AutoUpgradeEnabled\s*=\s*\$true/.test(out)) {
  fail("生成的原生对话框脚本里 AutoUpgradeEnabled 不是 $true", [
    "它一变成 false，WinForms 会静默退回老式对话框：没有缩略图、没有左侧导航，",
    "用户又回到「只看得见文件名」。这正是本轮要解决的问题，不许退化回去。",
  ]);
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

// 图标也要落到产物旁边，且每次构建都刷一遍。
// 不能靠 init.mjs 从 template/ 拷过来就算完 —— 换目录、单跑本脚本、
// 或者手动删过 launcher/ 里的图标，那条路径都覆盖不到。
fs.copyFileSync(ICON_SRC, ICON_OUT);
if (!fs.existsSync(ICON_OUT) || fs.statSync(ICON_OUT).size !== fs.statSync(ICON_SRC).size) {
  fail("图标拷贝后校验不一致", [`源 ${ICON_SRC}`, `目标 ${ICON_OUT}`]);
}
const iconKB = (fs.statSync(ICON_OUT).size / 1024).toFixed(1);

console.log(`✅ 已生成 ${OUT}`);
console.log(`   体积 ${out.length}B ｜ 纯 ASCII ✅（非 ASCII 字符 0 个）`);
console.log(`   转义的中文字符：${escapedCount} 个 ｜ JScript 代码块 ${jsLines} 行`);
console.log(`   语法校验：解析通过 ✅ ｜ ES5 合规 ✅ ｜ 关键内容 ${must.length}/${must.length} ✅`);
console.log(`   图标资产：${ICON_REF}（${iconKB}KB，与产物同目录）`);
console.log(`             ⚠️ 仅供外壳使用：实测本机 mshta 不应用 ICON 属性（SKILL.md 7.10.1）`);
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
    // 主按钮的闸门。这条断的是**按钮上真实显示的文字**（自检从 DOM 里读出来），
    // 不是"文案表里某个键等于什么" —— 后者只是表象，按钮渲染成别的它也不知道。
    // 另外四条断判定分支的四种输入。
    PICK_BTN_LABEL: "1",
    PICK_KIND_FILE: "1",
    PICK_KIND_DIR: "1",
    PICK_KIND_BAD: "1",
    PICK_KIND_NONE: "1",
    // 结算文案的两个收尾：有来源目录时「其他图一张没动」那句必须在；
    // 没有来源目录时，也不能留个悬空的分号。
    // （SETTLE_OK 原先只写在日志里、从没进过断言表 —— 等于没门禁，一并补上。）
    SETTLE_OK: "1",
    SETTLE_NODIR_TAIL_OK: "1",
    PARENT_DIR: "1",
    /* ---- 「在界面里翻…」= 界面自带的图片浏览器（现在是**兜底**，不再是主路径）----
       它的来历：当年系统对话框只有 SHBrowseForFolder（XP 控件，没有缩略图），
       用户看得见文件名、看不见图，于是自绘了一个图片浏览器顶上。
       本轮主入口换成了 Vista+ 的通用对话框（IFileOpenDialog，有缩略图），
       这条路退成兜底 —— 但**绝不能删**：原生那条路被安全策略拦住时，
       它是用户手上唯一还选得成图的入口。
       它成立的前提是四件事：列得出目录、列得出盘符、上得去、起点记得住。每件一条断言。 */
    DIRS_HAS_TOOLS: "1",
    DIRS_NO_JUNK: "1",
    DRIVES_OK: "1",
    PLACES_OK: "1",
    PLACES_SENTINEL: "1",
    PLACES_CARDS_EQ: "1",
    PLACES_PATH_OK: "1",
    PLACES_NO_UP: "1",
    /* 原生选图这条路（本轮换的主入口）。系统对话框不是"都不能用"，
       而是"老的那个不能用" —— BrowseForFolder 背后是 XP 的 SHBrowseForFolder，
       没有缩略图；资源管理器那一套（Vista+ 的 IFileOpenDialog）有。
       这四条盯住：产物纯 ASCII、开关在位、启动参数在位、真跑得起来。 */
    PLACES_HAS_NATIVE: "1",
    NATIVE_PS_ASCII: "1",
    NATIVE_PS_KEY: "1",
    NATIVE_BAT_OK: "1",
    NATIVE_PS_RUN: "1",
    /* 管道实测：启动 → 传参 → 结果文件 → 读回。这一条盖住的是"安静失败"：
       路径里的空格 / 中文、少一个引号、参数个数不对 —— 全都不报错，
       只会拿不到结果，界面上表现为"点了没反应"。 */
    NATIVE_PIPE: "1",
    /* 两条选图入口都得在按钮行里：原生（主）+ 界面自带（兜底）。 */
    DOM_INUI_BTN: "1",
    UP_MIDDLE: "1",
    UP_TO_DRIVE: "1",
    UP_AT_ROOT: "1",
    UP_PLACES: "1",
    LAST_DIR_ROUNDTRIP: "1",
    LAST_DIR_GHOST: "1",
    /* 起点记忆的另外三条。它们盯的不是"能不能记住"，而是"记的东西对不对" ——
       LAST_DIR_ROUNDTRIP 原先拿 WIN.lib 做往返、还把"能记住壁纸库"写成必须通过，
       等于用门禁保证了 bug 的存在：跳进壁纸库目录看到的图和壁纸库视图一模一样，
       用户点完主按钮只会觉得按钮坏了。现在四条各归各位。 */
    LAST_DIR_SKIPS_LIB: "1",
    LAST_DIR_CJK: "1",
    LAST_DIR_SELFHEAL: "1",
    /* 兜底入口（「在界面里翻…」）点下去必须真的换视图。两条：浏览态点 → 回位置列表；
       起点被写脏时点 → 也不能跳回壁纸库目录。 */
    PICK_IN_BROWSE_TO_LIST: "1",
    PICK_FROM_LIB_SKIPS_LIB: "1",
    /* 浏览一个目录时状态行必须给出三个出路：上一级 / 换个位置 / 返回壁纸库。
       自绘浏览器没有系统对话框那种侧边栏，"走到某一层出不去"是它最大的风险，
       所以把导航口的条数本身写成门禁。改导航时记得同步这个数。 */
    BROWSE_NAV_BTNS: "3",
    /* 首屏最常见的那一屏：只有子文件夹、一张图都没有的目录。
       它同时盖住两件事 —— "目录卡片真的画出来了"（数量与标签数对得上）
       和"没被错标成位置"（dthumb drive 那个蓝色变体不能串到这里）。 */
    ROOTVIEW_DIROLBL: "1",
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
  // 浏览器那条路的数值门槛。用区间而不是定值：子目录数、位置数会随机器变，
  // 写成定值会让门禁在换台机器时误报 —— 门禁误报比没有门禁更快被无视。
  if (!(Number(get("DIRS_IN_ROOT")) >= 1)) problems.push(`DIRS_IN_ROOT=${get("DIRS_IN_ROOT")}，一个子目录都列不出来（工程根下明明有一堆）`);
  if (!(Number(get("ROOTVIEW_DIRS")) >= 1)) problems.push(`ROOTVIEW_DIRS=${get("ROOTVIEW_DIRS")}，只有子目录的那种目录里一个文件夹卡片都没画出来`);
  if (!(Number(get("DRIVES_COUNT")) >= 1)) problems.push(`DRIVES_COUNT=${get("DRIVES_COUNT")}，一个盘符都没列出来 —— 位置列表会缺一整排入口`);
  const nPlCard = Number(get("PLACES_CARDS"));
  const nPlTh = Number(get("PLACES_DTHUMB"));
  if (!(nPlCard >= 1)) problems.push(`PLACES_CARDS=${get("PLACES_CARDS")}，位置列表一张卡片都没画出来（第一屏会是空的）`);
  if (nPlCard !== nPlTh) problems.push(`位置卡片 ${nPlCard} 张，但文件夹图形只有 ${nPlTh} 个 —— 有卡片没画出中间那块缩略图位`);
  /* 点兜底入口（「在界面里翻…」）之后那一屏的卡片数，必须与直接渲染位置列表时一致 ——
     不一致说明按钮走的不是同一条渲染路径，用户会看到一屏对不上的东西。 */
  const nPickCard = Number(get("PICK_CARDS_IN_LIST"));
  if (!(nPickCard >= 1)) problems.push(`PICK_CARDS_IN_LIST=${get("PICK_CARDS_IN_LIST")}，点兜底入口之后一张卡片都没画出来`);
  if (nPickCard !== nPlCard) problems.push(`点兜底入口后是 ${nPickCard} 张卡片，直接渲染位置列表是 ${nPlCard} 张 —— 两条路渲染结果不一致`);

  console.log("");
  if (problems.length) fail("自检未通过", problems);
  console.log(`✅ 自检通过：${Object.keys(need).length} 项断言 + 10 项数值一致性校验`);
}
