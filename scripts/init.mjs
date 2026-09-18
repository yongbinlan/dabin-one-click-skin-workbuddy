#!/usr/bin/env node
/**
 * init.mjs — WorkBuddy 一键换肤：一键初始化
 *
 * 把 skill 里的 template/ 展开成一个可以直接用的换肤工程，探测本机环境，
 * 生成 launcher\env.cmd，并把壁纸选择器构建出来。之后双击 launcher\ 里的
 * 入口就能换壁纸、换强度、重启自动恢复皮肤。
 *
 * 用法：
 *   node scripts/init.mjs                      展开到 ./workbuddy-skin
 *   node scripts/init.mjs --dest D:\my\skin    指定目录
 *   node scripts/init.mjs --app "C:\...\WorkBuddy.exe"
 *                                              手工指定主程序（探测不到时用）
 *   node scripts/init.mjs --shortcut           顺手建桌面快捷方式
 *                                              （含带图标的壁纸选择器入口；
 *                                               launcher 里那份是默认就建的）
 *   node scripts/init.mjs --force              目标已存在时也继续（只补缺，不覆盖）
 *   node scripts/init.mjs --upgrade            把已有工程的 tools/ 与 launcher/
 *                                              刷成这个 skill 的新版（主题、壁纸、
 *                                              备份、env.cmd、文档都保留不动）
 *   node scripts/init.mjs --print              只看探测结果，不落盘
 *
 * 设计原则：
 *   · 幂等：重复跑只补齐缺失的东西，绝不覆盖用户已经改过的文件
 *   · 单点实现：主程序/node 的探测只有 write-env.mjs 一份，本脚本不重复造
 *   · 不静默：每一步都打印做了什么、跳过了什么、为什么
 *   · 不越权：绝不动用户的桌面，除非显式给 --shortcut。建在工程自己目录里的
 *     入口（launcher\壁纸选择器.lnk）不在此列 —— 那是本工程的产物，不是用户的。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const SKILL_ROOT = path.resolve(__dir, "..");
const TEMPLATE = path.join(SKILL_ROOT, "template");

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? String(argv[i + 1] || "") : ""; };

const DEST = path.resolve(valueOf("--dest") || path.join(process.cwd(), "workbuddy-skin"));
const PRINT_ONLY = has("--print");
const WANT_SHORTCUT = has("--shortcut");
const UPGRADE = has("--upgrade");
const FORCE = has("--force") || UPGRADE;   // 升级必然要往已有目录里写
const APP_ARG = valueOf("--app");

// 展开时跳过的目录（生成物 / 本机私有 / 与运行无关）
const SKIP_DIRS = new Set(["node_modules", ".git", "logs", "build", "wallpapers", "backup", ".tmp-add-test", ".generated"]);
const SKIP_FILES = new Set(["env.cmd"]);   // env.cmd 必须按本机重新生成

/*
 * 升级要覆盖什么，是这份脚本里最需要想清楚的一件事。
 *
 * 分界线只有一条：**代码**刷成新版，**用户的东西**一律不动。
 *   · tools/ 与 launcher/ 是代码 → 覆盖。不然 skill 更新后老工程永远吃不到修复。
 *   · themes/ 是主题源：用户可能改过配色、displayName，覆盖一次就白改了 → 保留。
 *   · wallpapers/ backup/ logs/ 是用户数据 → 保留。
 *   · env.cmd 记着本机路径；README 与使用说明用户可能自己批注过 → 保留。
 *
 * 这条线是踩出来的：_make-shortcuts.ps1 的 param 位置 bug 修好之后，
 * 老工程里那份坏的还在 —— --force 只补缺不覆盖，于是「修了等于没修」。
 * 验证时又踩了一次：临时目录里的旧 ps1 照样报错，白查一轮。
 */
const KEEP_ON_UPGRADE = [
  /^themes[\\/]/i,           // 主题源：配色、清单、图片，都可能是用户改过的
  /^(wallpapers|backup|logs|build|docs)[\\/]/i,
];
const KEEP_FILES_ON_UPGRADE = new Set(["env.cmd", "README.md", "使用说明.txt", "workbuddy.local.json", "current.json"]);

function shouldOverwrite(rel) {
  if (!UPGRADE) return false;
  if (KEEP_FILES_ON_UPGRADE.has(path.basename(rel))) return false;
  return !KEEP_ON_UPGRADE.some((re) => re.test(rel));
}

const NODE = process.execPath;

// ---------------------------------------------------------------- 探测
function findCodedrobe() {
  const root = process.env.CODEDROBE_HOME || path.join(os.homedir(), ".workbuddy", "tools", "codedrobe");
  const entry = path.join(root, "node_modules", "@codedrobe", "core", "bin", "codedrobe.mjs");
  return { root, entry, ok: fs.existsSync(entry) };
}

const CD = findCodedrobe();
const HAVE_TEMPLATE = fs.existsSync(TEMPLATE);

console.log("======== WorkBuddy 一键换肤 · 初始化 ========");
console.log();
console.log("【环境探测】");
console.log("  node          : " + NODE);
console.log("  CodeDrobe CLI : " + (CD.ok ? CD.entry : "⚠️ 没找到"));
if (!CD.ok) console.log("                  （找的是 " + CD.entry + "）");
console.log("  工程模板      : " + (HAVE_TEMPLATE ? TEMPLATE : "⚠️ 缺失"));
console.log("  目标目录      : " + DEST);
if (APP_ARG) console.log("  主程序（指定）: " + APP_ARG + (fs.existsSync(APP_ARG) ? "  ✅" : "  ⚠️ 文件不存在"));
else console.log("  主程序        : 交给 write-env.mjs 自动探测（展开之后）");
console.log();

// ---------------------------------------------------------------- 前置检查
// 只检查「此刻就能确定、且展开前就该告诉用户」的两件事。
// 主程序位置不在这里判 —— 探测结果只可能在展开之后拿到，而且展开本身无害。
const problems = [];
if (!HAVE_TEMPLATE) problems.push("template/ 目录不存在，skill 安装不完整：" + TEMPLATE);
if (!CD.ok) {
  problems.push("没装 CodeDrobe CLI（皮肤最终靠它注入）。修法：\n" +
                 '     npm install --prefix "' + CD.root + '" @codedrobe/core');
}
if (APP_ARG && !fs.existsSync(APP_ARG)) {
  problems.push("--app 指定的文件不存在：" + APP_ARG);
}

if (problems.length) {
  console.log("【需要先处理】");
  problems.forEach((p, i) => console.log("  " + (i + 1) + ". " + p));
  console.log();
}
if (!HAVE_TEMPLATE) process.exit(1);

if (PRINT_ONLY) {
  console.log("（--print：只探测，未落盘）");
  process.exit(problems.length ? 1 : 0);
}

// ---------------------------------------------------------------- 展开 template
function copyTree(src, dst, stats) {
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const rel = path.relative(TEMPLATE, s);
    if (fs.statSync(s).isDirectory()) {
      if (SKIP_DIRS.has(name)) { stats.skipped.push(rel + "/"); continue; }
      copyTree(s, d, stats);
    } else {
      if (SKIP_FILES.has(name)) { stats.skipped.push(rel + "（按本机重新生成）"); continue; }
      if (fs.existsSync(d)) {
        if (!shouldOverwrite(rel)) { stats.kept.push(rel); continue; }
        fs.copyFileSync(s, d);
        stats.updated.push(rel);
        continue;
      }
      fs.copyFileSync(s, d);
      stats.copied++;
    }
  }
}

if (fs.existsSync(DEST) && !FORCE) {
  let n = 0;
  try { n = fs.readdirSync(DEST).length; } catch { /* 读不了就当空 */ }
  if (n > 0) {
    console.log("【目标目录已存在且有内容】" + DEST);
    console.log("  默认不覆盖任何东西。确认要往里补齐缺失文件，加 --force 重跑：");
    console.log("      node scripts/init.mjs --dest \"" + DEST + "\" --force");
    console.log("  想让 tools/ 与 launcher/ 刷成这个 skill 的新版（保留主题与壁纸）：");
    console.log("      node scripts/init.mjs --dest \"" + DEST + "\" --upgrade");
    console.log("  想换个位置：node scripts/init.mjs --dest <目录>");
    process.exit(2);
  }
}

const stats = { copied: 0, kept: [], skipped: [], updated: [] };
copyTree(TEMPLATE, DEST, stats);

console.log("【展开工程】" + DEST);
console.log("  复制文件      : " + stats.copied + " 个");
if (stats.updated.length) {
  console.log("  升级覆盖      : " + stats.updated.length + " 个（tools/ 与 launcher/ 的代码）");
  stats.updated.slice(0, 8).forEach((f) => console.log("      ↑ " + f));
  if (stats.updated.length > 8) console.log("      …… 另有 " + (stats.updated.length - 8) + " 个");
}
if (stats.kept.length) console.log("  保留已存在    : " + stats.kept.length + " 个（未覆盖）");
if (stats.skipped.length) console.log("  跳过          : " + stats.skipped.join("、"));
console.log();

// 运行期必须存在的空目录（logs 存日志、wallpapers 存壁纸、build 放主题包）
for (const d of ["logs", "wallpapers", "build"]) {
  fs.mkdirSync(path.join(DEST, d), { recursive: true });
}

// ---------------------------------------------------------------- 生成 env.cmd
const runNode = (script, args) =>
  spawnSync(NODE, [script, ...args], { encoding: "utf8", cwd: DEST, windowsHide: true });

const ENV_CMD = path.join(DEST, "launcher", "env.cmd");
const writeEnv = path.join(DEST, "tools", "write-env.mjs");
let APP = "";

if (fs.existsSync(writeEnv)) {
  console.log("【探测本机路径 → launcher\\env.cmd】");
  const r = runNode(writeEnv, APP_ARG ? ["--app", APP_ARG] : []);
  process.stdout.write(((r.stdout || "") + (r.stderr || "")).replace(/^/gm, "  "));
  if (r.status !== 0) console.log("  ⚠️ write-env 退出码 " + r.status);
  console.log();

  // 从生成的文件里回读 —— 之后建快捷方式要拿它当图标来源
  try {
    const txt = fs.readFileSync(ENV_CMD, "ascii");
    const m = txt.match(/set "SKIN_APP=([^"]*)"/);
    if (m) APP = m[1].trim();
  } catch { /* 没生成出来 */ }
} else {
  console.log("⚠️ 没找到 tools\\write-env.mjs，跳过 env.cmd 生成");
  console.log();
}

// ---------------------------------------------------------------- 生成壁纸选择器
const buildPicker = path.join(DEST, "tools", "build-wallpaper-picker.mjs");
if (fs.existsSync(buildPicker)) {
  console.log("【生成壁纸选择器.hta】");
  const r = runNode(buildPicker, []);
  process.stdout.write(((r.stdout || "") + (r.stderr || "")).replace(/^/gm, "  "));
  if (r.status !== 0) console.log("  ⚠️ 构建退出码 " + r.status);
  console.log();
}

// ---------------------------------------------------------------- 构建主题包
// 不做这一步，用户双击「注入皮肤.cmd」会直接失败 —— 一键初始化必须把它做完。
/** themes/ 下只有一个主题就用它；多个就报错不猜（与 build-theme.mjs 同一规则） */
function resolveThemeDir() {
  const base = path.join(DEST, "themes");
  let subs = [];
  try { subs = fs.readdirSync(base).filter((n) => fs.statSync(path.join(base, n)).isDirectory()); } catch { /* 没主题 */ }
  return subs.length === 1 ? path.join(base, subs[0]) : "";
}

const THEME_DIR = resolveThemeDir();
if (!THEME_DIR) {
  console.log("⚠️ themes/ 下没有唯一主题目录，跳过主题包构建");
  console.log();
} else if (!CD.ok) {
  console.log("⚠️ 没有 CodeDrobe CLI，跳过主题包构建（装上之后重跑本脚本）");
  console.log();
} else {
  console.log("【构建主题包】");
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(THEME_DIR, "theme.json"), "utf8")); } catch { /* 用目录名 */ }
  const id = meta.id || path.basename(THEME_DIR);
  const ver = meta.version || "0.0.0";
  const outName = id + "-" + ver + ".codedrobe-theme";
  const outFile = path.join(DEST, "build", outName);

  const r = spawnSync(NODE, [CD.entry, "theme", "pack",
    path.join(THEME_DIR, "theme.json"), "--output", outFile],
    { encoding: "utf8", cwd: DEST, windowsHide: true });
  const raw = (r.stdout || "") + (r.stderr || "");

  // 幂等：已经打过了就报「跳过」，不要假装又打了一遍。
  // （CodeDrobe 的 pack 遇到同名产物只打印 Output already exists 就退出，
  //   光看「文件在不在」会把这种情况误报成成功。）
  if (/Output already exists/i.test(raw)) {
    console.log("  · " + outName + " 已存在，跳过（要重打就先删掉它）");
  } else if (fs.existsSync(outFile)) {
    let warn = -1;
    try { warn = (JSON.parse(raw).warnings || []).length; } catch { /* 输出不是纯 JSON */ }
    console.log("  ✅ " + outName + "  " + (fs.statSync(outFile).size / 1024).toFixed(0) + "KB");
    if (warn > 0) console.log("     " + warn + " 条 lint 警告（long-selector / deep-child-chain，已知技术债，不阻塞）");
    if (warn < 0) process.stdout.write(raw.replace(/^/gm, "     "));
  } else {
    console.log("  ❌ 没能生成主题包，退出码 " + r.status);
    process.stdout.write(raw.replace(/^/gm, "     "));
  }
  console.log();
}

// ---------------------------------------------------------------- 默认壁纸
// 新工程壁纸库是空的。空库不算坏，但选择器打开是一片空白，用户会以为坏了。
// 主题自带的 hero 图正好可以当第一张 —— 开箱即有图，且不必多带一份文件。
const LIB = path.join(DEST, "wallpapers");
const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const libImages = (() => { try { return fs.readdirSync(LIB).filter((f) => IMG_RE.test(f)); } catch { return []; } })();

if (libImages.length === 0 && THEME_DIR) {
  const assets = path.join(THEME_DIR, "assets");
  let hero = "";
  try { hero = fs.readdirSync(assets).filter((f) => IMG_RE.test(f)).sort()[0] || ""; } catch { /* 没图片 */ }
  if (hero && fs.existsSync(path.join(DEST, "tools", "set-wallpaper.mjs"))) {
    console.log("【装一张默认壁纸】壁纸库是空的，先用主题自带的图打底");
    /*
     * 端口隔离：这一步的语义只是「给这个新展开的工程记一个默认壁纸」，
     * 绝不能去动用户机器上正在运行的真实应用。
     *
     * 但 CDP 端口是全局的（SKIN_PORT 缺省 9342），不隔离的后果是：
     * 在临时目录里跑初始化，会把这份副本的皮肤层注入到用户正在用的
     * WorkBuddy 上 —— 2026-09-18 实测踩到过（临时目录的 hero.webp 盖掉了
     * 用户自己选的壁纸，而两个 current.json 各说各话，极难排查）。
     *
     * 指向一个必然连不上的端口，让它走「已记录，下次启动生效」这条正常分支：
     * 状态照样落盘，但不碰任何正在运行的应用。
     */
    const r = spawnSync(NODE,
      [path.join(DEST, "tools", "set-wallpaper.mjs"), "add", path.join(assets, hero), "中"],
      { encoding: "utf8", cwd: DEST, windowsHide: true, env: { ...process.env, SKIN_PORT: "1" } });
    const out = ((r.stdout || "") + (r.stderr || "")).trim();
    // 退出码 3 = 端口不通，但状态已记录，下次启动自动生效 —— 对初始化来说算成功
    if (r.status === 0) console.log("  ✅ 已设为当前壁纸（中档）");
    else if (r.status === 3) console.log("  ✅ 已记录为默认壁纸（不打扰当前运行中的应用，下次启动自动生效）");
    else { console.log("  ⚠️ 退出码 " + r.status); process.stdout.write(out.replace(/^/gm, "     ")); }
    console.log();
  }
}

// ------------------------------------------------- 壁纸选择器入口（带图标）
// 为什么需要这一步：.hta 在资源管理器里显示什么图标，由 Windows 的**扩展名关联**
// （HKCR\htafile\DefaultIcon = mshta.exe）决定，跟文件里写什么完全无关 ——
// <HTA:APPLICATION ICON="..."> 只管运行时的窗口/任务栏，Win10 的 mshta 连那个都不理
// （见 SKILL.md 7.10.1 的 WM_GETICON 实测）。Windows 没有「单文件图标」机制，
// 所以能带上项目图标的只有外壳这一条路：一个设了 IconLocation 的快捷方式。
//
// 这一份建在 launcher 目录里（工程的目录，不是用户的桌面），所以不必征询；
// 桌面那一份仍然只在显式给 --shortcut 时才建，不越权。
{
  const launcherDir = path.join(DEST, "launcher");
  const ps1 = path.join(DEST, "tools", "_make-picker-entry.ps1");
  let hta = "";
  try { hta = fs.readdirSync(launcherDir).filter((f) => /\.hta$/i.test(f))[0] || ""; } catch { /* 没目录 */ }

  if (!fs.existsSync(ps1)) {
    console.log("【壁纸选择器入口】跳过：找不到 tools/_make-picker-entry.ps1");
    console.log();
  } else if (!hta) {
    console.log("【壁纸选择器入口】跳过：launcher 里没有 .hta 产物");
    console.log();
  } else {
    console.log("【壁纸选择器入口】给 launcher 里的 " + hta + " 配一个带图标的快捷方式");
    const r = spawnSync("powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, "-Into", launcherDir],
      { encoding: "utf8", windowsHide: true });
    process.stdout.write(((r.stdout || "") + (r.stderr || "")).replace(/^/gm, "  "));
    // 失败不算致命：没有快捷方式时双击 .hta 一切照旧，只是图标是系统默认的。
    if (r.status !== 0) console.log("  ⚠️ 退出码 " + r.status + "（不影响功能，双击 .hta 仍可用）");
    console.log();
  }
}

// ---------------------------------------------------------------- 快捷方式（可选）
if (WANT_SHORTCUT) {
  const ps1 = path.join(DEST, "tools", "_make-shortcuts.ps1");
  if (fs.existsSync(ps1)) {
    console.log("【创建快捷方式】");
    const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1];
    if (APP) args.push("-Exe", APP);
    const r = spawnSync("powershell.exe", args, { encoding: "utf8", windowsHide: true });
    process.stdout.write(((r.stdout || "") + (r.stderr || "")).replace(/^/gm, "  "));
    console.log();
  }

  // 桌面也来一份「壁纸选择器」入口 —— 用户换壁纸是从桌面点，不是翻进工程目录点。
  // 这会动用户的桌面，所以只跟在显式 --shortcut 后面，不默认执行。
  const pickerPs1 = path.join(DEST, "tools", "_make-picker-entry.ps1");
  if (fs.existsSync(pickerPs1)) {
    console.log("【壁纸选择器入口（桌面）】");
    const r = spawnSync("powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", pickerPs1],
      { encoding: "utf8", windowsHide: true });
    process.stdout.write(((r.stdout || "") + (r.stderr || "")).replace(/^/gm, "  "));
    console.log();
  }
}

// ---------------------------------------------------------------- 后续步骤
console.log("======== 完成 ========");
console.log();
console.log("工程位置：" + DEST);
console.log();
console.log("接下来：");
if (problems.length) {
  console.log("  0. 先处理上面【需要先处理】里列出的问题，然后重跑本脚本");
}
console.log("  1. 注入皮肤（WorkBuddy 需要在运行）：");
console.log("       双击 launcher\\注入皮肤.cmd");
console.log("       或   node \"" + path.join(DEST, "tools", "launcher.mjs") + "\"");
console.log("  2. 换壁纸：双击 launcher\\壁纸选择器.hta（有缩略图，最直观）");
console.log("        或双击 launcher\\换壁纸.cmd（命令行列表）");
console.log("  3. 调壁纸透出强度：双击 launcher\\调强度.cmd");
console.log("  4. 重启后自动恢复皮肤：");
console.log("        把桌面/开始菜单的 WorkBuddy 快捷方式指向 launcher\\workbuddy-skin-launcher.vbs");
console.log("        （原来的快捷方式会自动备份到 backup\\，随时可还原）");
console.log();
if (fs.existsSync(path.join(DEST, "README.md"))) {
  console.log("详细说明：README.md ｜ 简短版：launcher\\使用说明.txt");
}
console.log("排障：node \"" + path.join(DEST, "tools", "verify-launcher.mjs") + "\"   （12 项自检）");
