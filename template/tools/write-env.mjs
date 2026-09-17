#!/usr/bin/env node
/**
 * write-env.mjs — 探测本机路径，生成 launcher\env.cmd
 *
 * 为什么需要它：
 *   launcher 下的 .cmd / .vbs 都用运行时推导解决「工程在哪里」，
 *   但有两样东西无法推导 —— node 解释器和 WorkBuddy 主程序的位置，
 *   那是每台机器自己的事。本脚本负责探测它们并写进 launcher\env.cmd；
 *   其余脚本只读那个文件。于是整个工程可以搬到任意目录、任意机器，
 *   换机器时只要重跑一次本脚本。
 *
 * 用法：
 *   node tools/write-env.mjs                 探测并写入
 *   node tools/write-env.mjs --print         只打印探测结果，不写文件
 *   node tools/write-env.mjs --app <路径>    手工指定主程序位置（会被记住）
 *   node tools/write-env.mjs --node <路径>   手工指定 node 位置
 *
 * 主程序位置是「推导不出来」的典型：它跟工程无关，是每台机器自己的事。
 * 所以这里按可靠性依次试多条线索（参数 → 环境变量 → 上次结果 → 备份的原始
 * 快捷方式 → 桌面快捷方式 → 附近其他工程 → 默认安装位置），
 * 谁能命中就用谁，并把「来源」打出来 —— 万一全不命中，用户才知道往哪查。
 *
 * env.cmd 是**本机生成物**：不要提交版本库，也不要手工编辑。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const ENV_CMD = path.join(ROOT, "launcher", "env.cmd");
const BACKUP = path.join(ROOT, "backup");

const argv = process.argv.slice(2);
const valueOf = (f) => { const i = argv.indexOf(f); return i >= 0 ? String(argv[i + 1] || "") : ""; };

/** 读某个 env.cmd 文件里的某个键 */
function readEnvFile(file, key) {
  try {
    const txt = fs.readFileSync(file, "ascii");
    for (const line of txt.split(/\r?\n/)) {
      if (line.toLowerCase().indexOf(key.toLowerCase()) < 0) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      return line.slice(eq + 1).replace(/"/g, "").trim();
    }
  } catch { /* 没有就是没有 */ }
  return "";
}

/** 读本工程已有 env.cmd 里的某个键（重跑时不丢上次的结果） */
const readEnvCmd = (key) => readEnvFile(ENV_CMD, key);

/** 从 .lnk 二进制里抠出可打印字符串（不依赖任何 COM） */
function lnkStrings(file) {
  const b = fs.readFileSync(file);
  const out = [];
  let cur = "";
  for (const x of b) {
    if (x >= 32 && x < 127) cur += String.fromCharCode(x);
    else { if (cur.length >= 4) out.push(cur); cur = ""; }
  }
  for (let i = 0; i + 1 < b.length; i += 2) {
    if (b[i + 1] !== 0) continue;
    let s = "", j = i;
    while (j + 1 < b.length && b[j + 1] === 0 && b[j] >= 32 && b[j] < 127) { s += String.fromCharCode(b[j]); j += 2; }
    if (s.length >= 4) { out.push(s); i = j - 2; }
  }
  return out;
}

/** 备份目录里那些「原始快捷方式」仍指向真正的主程序，是很好的线索 */
function appFromBackup() {
  try {
    for (const f of fs.readdirSync(BACKUP)) {
      if (!/\.(original|archived)$/i.test(f)) continue;
      for (const s of lnkStrings(path.join(BACKUP, f))) {
        if (/WorkBuddy\.exe$/i.test(s) && fs.existsSync(s)) return s;
      }
    }
  } catch { /* 没有备份目录 */ }
  return "";
}

/** 桌面 / 开始菜单 / 任务栏上还没被改过的快捷方式，直接指着主程序 */
function shortcutDirs() {
  const home = os.homedir();
  const ad = process.env.APPDATA || "";
  const pd = process.env.ProgramData || "";
  return [
    path.join(home, "Desktop"),
    ad && path.join(ad, "Microsoft", "Windows", "Start Menu", "Programs"),
    pd && path.join(pd, "Microsoft", "Windows", "Start Menu", "Programs"),
    ad && path.join(ad, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar"),
  ].filter(Boolean);
}

function appFromShortcuts() {
  for (const d of shortcutDirs()) {
    let files = [];
    try { files = fs.readdirSync(d).filter((f) => /\.lnk$/i.test(f)); } catch { continue; }
    for (const f of files) {
      for (const s of lnkStrings(path.join(d, f))) {
        if (/\\WorkBuddy\.exe$/i.test(s) && fs.existsSync(s)) return s;
      }
    }
  }
  return "";
}

/**
 * 注册表探测**故意不做**。
 * 查 App Paths 需要起 reg.exe，而企业安全软件（本机就是）会把它整个拉黑，
 * 探测脚本一跑就被拦，用户还得处理一个权限提示 —— 收益远小于代价。
 * 快捷方式那一条已经把「非标准安装位置」覆盖得差不多了。
 */

/**
 * 别的换肤工程里也记着主程序位置 —— 另开一份工程、或把它挪了地方时，老位置的记录还能救一次。
 *
 * 只扫「盘根」和「盘根下一层」。下一层里那些系统目录一律跳过：
 * 一是没有必要，二是碰到用户目录下的受保护子目录（.ssh 之类）会弹权限框，
 * 甚至被安全策略拦下 —— 探测脚本不该有这种副作用。
 */
const BORING = /^(Users|Windows|Program Files|Program Files \(x86\)|ProgramData|\$Recycle\.Bin|System Volume Information|Recovery|PerfLogs|MSOCache|Documents and Settings|Config\.Msi|Intel|AMD|NVIDIA|\.)/i;

function appFromOtherProjects() {
  const names = ["workbuddy-skin", "WorkBuddy-skin", "workbuddy_skin"];
  const bases = [];
  for (const d of ["C", "D", "E", "F", "G"]) bases.push(d + ":\\");
  if (process.env.USERPROFILE) bases.push(process.env.USERPROFILE);

  const spots = [];
  for (const b of bases) {
    spots.push(b);
    try {
      for (const sub of fs.readdirSync(b)) {
        if (BORING.test(sub)) continue;
        const p = path.join(b, sub);
        try { if (fs.statSync(p).isDirectory()) spots.push(p); } catch { /* 权限不足 */ }
      }
    } catch { /* 盘不可读 */ }
  }

  for (const s of spots) {
    for (const n of names) {
      const at = path.join(s, n);
      if (path.resolve(at) === ROOT) continue;   // 就是自己，跳过
      const app = readEnvFile(path.join(at, "launcher", "env.cmd"), "SKIN_APP");
      if (app && fs.existsSync(app)) return app;
    }
  }
  return "";
}

/**
 * 按可靠性依次尝试。返回 { path, from } —— from 是命中线索的名字，
 * 探测失败时把这条过程打出来，用户才知道该往哪查。
 */
function appCandidates() {
  const la = process.env.LOCALAPPDATA || "";
  const pf = process.env.ProgramFiles || "";
  const pf86 = process.env["ProgramFiles(x86)"] || "";
  return [
    ["参数 --app", valueOf("--app")],
    ["环境变量 WORKBUDDY_EXE", process.env.WORKBUDDY_EXE],
    ["已有的 env.cmd", readEnvCmd("SKIN_APP")],
    ["备份的原始快捷方式", appFromBackup()],
    ["桌面/开始菜单快捷方式", appFromShortcuts()],
    ["附近的其他换肤工程", appFromOtherProjects()],
    ["默认安装位置", la && path.join(la, "Programs", "WorkBuddy", "WorkBuddy.exe")],
    ["默认安装位置", la && path.join(la, "Programs", "workbuddy", "WorkBuddy.exe")],
    ["默认安装位置", pf && path.join(pf, "WorkBuddy", "WorkBuddy.exe")],
    ["默认安装位置", pf86 && path.join(pf86, "WorkBuddy", "WorkBuddy.exe")],
  ].filter(([, v]) => v);
}

const nodeExe = valueOf("--node") || readEnvCmd("SKIN_NODE") || process.execPath;
let appExe = "";
let appFrom = "";
for (const [from, c] of appCandidates()) {
  try { if (fs.existsSync(c) && /\.exe$/i.test(c)) { appExe = c; appFrom = from; break; } } catch { /* 换下一条 */ }
}

console.log("=== 探测结果 ===");
console.log("  node      : " + nodeExe + (fs.existsSync(nodeExe) ? "  ✅" : "  ⚠️ 文件不存在"));
console.log("  WorkBuddy : " + (appExe || "（未找到）"));
if (appExe) console.log("              来源：" + appFrom + " ✅");
else {
  console.log("              试过这些线索，都没命中：");
  for (const [from] of appCandidates()) console.log("                · " + from);
  console.log("              用参数指定一次，之后会被记住：");
  console.log('              node tools/write-env.mjs --app "C:\\...\\WorkBuddy.exe"');
  console.log("              不知道装在哪？在开始菜单里找到 WorkBuddy，右键 → 打开文件位置");
}

if (argv.includes("--print")) process.exit(0);

/** 统一成反斜杠：Windows 两种都认，但 .cmd 里混着写容易看错 */
const norm = (s) => String(s).replace(/\//g, "\\");

const lines = [
  "@echo off",
  "rem Generated by tools/write-env.mjs -- machine-specific paths. Do not edit by hand.",
  "rem Regenerate after moving the project or switching machines:",
  "rem     node tools/write-env.mjs",
  'set "SKIN_NODE=' + norm(nodeExe) + '"',
  'set "SKIN_APP=' + norm(appExe) + '"',
  "",
];
fs.mkdirSync(path.dirname(ENV_CMD), { recursive: true });
fs.writeFileSync(ENV_CMD, lines.join("\r\n"), "ascii");

const b = fs.readFileSync(ENV_CMD);
console.log();
console.log("已写入 " + ENV_CMD);
console.log("  大小=" + b.length + "B  非ASCII=" + [...b].filter((x) => x > 127).length +
            "  CRLF=" + (b.toString("latin1").match(/\r\n/g) || []).length);
