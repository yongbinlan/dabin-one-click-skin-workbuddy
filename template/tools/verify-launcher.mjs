#!/usr/bin/env node
/**
 * verify-launcher.mjs — 启动器回归验证（改主题/改启动器/升级应用后跑这个）
 *
 * 覆盖 11 项，每项都是"做了/没做"的可核判定，不看主观感受：
 *   1) .vbs 纯 ASCII 且无 BOM      —— wscript 按 GBK 解析，非 ASCII 会炸成阻塞对话框
 *   2) launcher.mjs 语法            —— node --check
 *   3) 三处启动入口指向 wscript.exe —— 换入口类改动必须复核
 *   4) 端到端（wscript → vbs → node） —— 退出码 0 + 日志出现注入/自检证据
 *   5) 未双开                       —— 调用前后 WorkBuddy 进程数必须一致
 *   6) 主题缺失降级                  —— 退出码须为 2，且应用启动不受影响
 *   7) launcher/*.cmd 编码 + 行尾    —— 必须 GBK 无 BOM 且 CRLF；
 *                                      UTF-8 会满屏乱码，裸 LF 会把注释当命令跑
 *   8) tools/*.mjs 语法             —— 改动任一脚本后都要全量复核
 *   9) 壁纸选择器产物                —— 重建后须无变化（治"改了模板忘重新生成"）
 *  10) 界面自检                     —— 真的把界面拉起来，验 DOM 画出来了、命令跑得通
 *  11) .cmd 可执行性                —— 真的把 cmd 拉起来跑一遍，验能跑通并正常退出
 *
 * 用法：node tools/verify-launcher.mjs
 * 退出码：0 = 全通过，1 = 有失败项
 *
 * 注意第 6 项会临时把主题包改名几百毫秒再还原（try/finally 保证还原）。
 * 如不想承担这点风险，注释掉第 6 项即可。
 * 第 9 项会重建壁纸选择器产物，第 10 项会短暂拉起一次界面自检（不可见、自动收尸），
 * 第 11 项会真的跑一遍 launcher 下的 .cmd（用重定向输入喂一个回车）。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
// 可移植化：这些值全部运行时推导，不写死任何一台机器的路径或用户名
const NODE = process.execPath;
const VBS = path.join(ROOT, "launcher", "workbuddy-skin-launcher.vbs");
const LAUNCHER = path.join(ROOT, "tools", "launcher.mjs");
const LOG = path.join(ROOT, "logs", "launcher.log");
const HOME = os.homedir();

/** 主题包：不写死名字，build/ 下的 *.codedrobe-theme 存在哪个就用哪个 */
function findTheme() {
  const bd = path.join(ROOT, "build");
  try {
    const hit = fs.readdirSync(bd).filter((f) => f.endsWith(".codedrobe-theme")).sort();
    if (hit.length) return path.join(bd, hit[hit.length - 1]);
  } catch { /* 没有 build 目录 */ }
  return path.join(bd, "theme.codedrobe-theme");
}
const THEME = findTheme();

const pass = [], fail = [];
const logLines = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8").split("\n").filter(Boolean) : []);
const ok = (m) => { console.log("✅ " + m); pass.push(m); };
const no = (m) => { console.log("❌ " + m); fail.push(m); };

function procCount() {
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "(Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue | Measure-Object).Count"],
    { encoding: "utf8", windowsHide: true, timeout: 30000 });
  const n = parseInt((r.stdout || "").trim(), 10);
  return Number.isFinite(n) ? n : null;
}

// ---------- 1) vbs 编码 ----------
{
  const b = fs.readFileSync(VBS);
  let nonAscii = 0;
  for (const x of b) if (x > 127) nonAscii++;
  const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  console.log(`1) vbs ${b.length}B ｜ 非 ASCII ${nonAscii} ｜ BOM ${bom ? "有" : "无"}`);
  (nonAscii === 0 && !bom) ? ok("vbs 纯 ASCII 无 BOM") : no(`vbs 编码异常（非ASCII=${nonAscii}, BOM=${bom}）`);
}

// ---------- 2) 语法 ----------
{
  const r = spawnSync(NODE, ["--check", LAUNCHER], { encoding: "utf8", windowsHide: true });
  r.status === 0 ? ok("launcher.mjs 语法通过") : no("launcher.mjs 语法错误：" + (r.stderr || "").slice(0, 200));
}

// ---------- 3) 入口指向 ----------
{
  const entries = [
    ["desktop", `${HOME}/Desktop/WorkBuddy.lnk`],
    ["startmenu", `${HOME}/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/WorkBuddy.lnk`],
    ["taskbar", `${HOME}/AppData/Roaming/Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar/WorkBuddy.lnk`],
  ];
  for (const [tag, p] of entries) {
    if (!fs.existsSync(p)) { no(`${tag} 入口不存在：${p}`); continue; }
    const b = fs.readFileSync(p);
    let ascii = "";
    for (const x of b) ascii += x >= 32 && x < 127 ? String.fromCharCode(x) : "\n";
    ascii.includes("wscript.exe")
      ? ok(`${tag} 入口指向 wscript.exe（${b.length}B）`)
      : no(`${tag} 入口未指向 wscript.exe`);
  }
}

// ---------- 4) + 5) 端到端 & 未双开 ----------
const before = procCount();
const mark = logLines().length;
{
  const t0 = Date.now();
  const r = spawnSync("wscript.exe", ["//nologo", VBS], { encoding: "utf8", timeout: 220000, windowsHide: true });
  const ms = Date.now() - t0;
  const added = logLines().slice(mark).join("\n");
  console.log(`4) wscript 端到端 退出码 ${r.status} ｜ 耗时 ${ms}ms`);
  added.split("\n").filter(Boolean).forEach((l) => console.log("   " + l));

  (r.status === 0 && /(已注入|自检通过|SKIN SKIPPED|already running)/.test(added))
    ? ok(`端到端通过（${ms}ms）`)
    : no(`端到端未达预期（退出码 ${r.status}）`);
}
{
  const after = procCount();
  if (before === null || after === null) no("进程数取不到，双开检测跳过（unsupported）");
  else if (after === before) ok(`未双开（进程数稳定 ${after}）`);
  else no(`进程数变化 ${before} → ${after}（疑似双开）`);
}

// ---------- 6) 主题缺失降级 ----------
{
  const bak = THEME + ".bak-verify";
  if (!fs.existsSync(THEME)) {
    no("主题包不存在，无法测降级（先跑 build-theme.mjs 并打包）");
  } else {
    fs.renameSync(THEME, bak);
    try {
      const r = spawnSync(NODE, [LAUNCHER, "--no-launch"], { encoding: "utf8", windowsHide: true, timeout: 200000 });
      const out = (r.stdout || "") + (r.stderr || "");
      console.log(`6) 主题缺失时 --no-launch 退出码 ${r.status}（期望 2）`);
      out.trim().split("\n").slice(-4).forEach((l) => console.log("   " + l));
      (r.status === 2 && /跳过注入/.test(out))
        ? ok("主题缺失降级正确（退出码 2，不阻塞应用）")
        : no(`主题缺失降级不符预期（退出码 ${r.status}）`);
    } finally {
      fs.renameSync(bak, THEME);
      console.log("   主题包已还原：" + fs.existsSync(THEME));
    }
  }
}

// ---------- 7) launcher/*.cmd 编码 + 行尾 ----------
{
  const dir = path.join(ROOT, "launcher");
  const cmds = fs.readdirSync(dir).filter((f) => f.endsWith(".cmd"));
  const bad = [];
  let lfTotal = 0;

  for (const f of cmds) {
    const b = fs.readFileSync(path.join(dir, f));

    // 裸 LF（0x0A 前面没有 0x0D）：cmd 不能可靠地按行切分，会把注释和 echo
    // 的残片当成命令去执行，报一串「不是内部或外部命令」。
    // 这个坑极其隐蔽 —— 中文看着完全正常，只有在字节层才看得见缺了 0x0D。
    let bareLf = 0;
    for (let i = 0; i < b.length; i++) if (b[i] === 10 && (i === 0 || b[i - 1] !== 13)) bareLf++;
    lfTotal += bareLf;
    if (bareLf) bad.push(`${f}（裸 LF ${bareLf} 处）`);

    // 编码：只判含非 ASCII 的文件 —— 纯 ASCII 的文件既是合法 UTF-8
    // 也是合法 GBK，判不出来也没必要判。含中文的就必须是 GBK，否则双击必乱码。
    if (b.some((x) => x > 127)) {
      let isUtf8 = true;
      try { new TextDecoder("utf-8", { fatal: true }).decode(b); } catch { isUtf8 = false; }
      const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
      if (isUtf8) bad.push(`${f}（UTF-8）`);
      if (bom) bad.push(`${f}（有 BOM）`);
    }
  }

  console.log(`7) launcher/*.cmd 共 ${cmds.length} 个 ｜ 查编码 + 行尾 ｜ 裸 LF 合计 ${lfTotal}`);
  bad.length === 0
    ? ok(`${cmds.length} 个 cmd 均为 GBK 无 BOM、CRLF 行尾`)
    : no(`cmd 编码/行尾不对，双击会乱码或把注释当命令跑：${bad.join(" / ")} → 跑 tools/_fix-cmd.ps1`);
}

// ---------- 8) tools/*.mjs 语法 ----------
{
  const dir = path.join(ROOT, "tools");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".mjs"));
  const bad = [];
  for (const f of files) {
    const r = spawnSync(NODE, ["--check", path.join(dir, f)], { encoding: "utf8", windowsHide: true });
    if (r.status !== 0) bad.push(f);
  }
  console.log(`8) tools/*.mjs 共 ${files.length} 个`);
  bad.length === 0 ? ok(`${files.length} 个脚本语法全通过`) : no(`语法错误：${bad.join(", ")}`);
}

// ---------- 9) 壁纸选择器产物 ----------
{
  const HTA = path.join(ROOT, "launcher", "壁纸选择器.hta");
  const GEN = path.join(ROOT, "tools", "build-wallpaper-picker.mjs");
  const beforeBuf = fs.existsSync(HTA) ? fs.readFileSync(HTA) : null;

  // 先重建再比对：这一步专治「改了模板忘了重新生成」。
  // 这个坑真实发生过 —— 模板改了单实例属性，产物还是旧的，
  // 后面所有基于产物的结论都建立在旧文件上，白查半天。
  const r = spawnSync(NODE, [GEN], { encoding: "utf8", windowsHide: true, timeout: 90000 });
  if (r.status !== 0) {
    console.log("9) 壁纸选择器产物重建失败");
    no("壁纸选择器生成失败：" + ((r.stdout || "") + (r.stderr || "")).trim().split("\n").pop());
  } else {
    const after = fs.readFileSync(HTA);
    let nonAscii = 0;
    for (const x of after) if (x > 127) nonAscii++;
    const txt = after.toString("latin1");
    const need = ['HTA:APPLICATION', 'ID="oWp"', "picker-selftest.flag", "function selfTest", "function runCmd"];
    const missing = need.filter((k) => !txt.includes(k));
    const stale = beforeBuf !== null && !beforeBuf.equals(after);
    console.log(`9) 壁纸选择器 ${after.length}B ｜ 非 ASCII ${nonAscii} ｜ 关键内容缺 ${missing.length} ｜ 重建后变化 ${stale}`);
    if (nonAscii) no(`壁纸选择器含非 ASCII 字节 ${nonAscii} 个 —— 纯 ASCII 的编码假设不成立`);
    else if (missing.length) no("壁纸选择器缺少关键内容：" + missing.join(", "));
    else if (stale) no("壁纸选择器产物是过期的（重建后内容有变）—— 模板改了但没重新生成");
    else ok(`壁纸选择器产物新鲜且纯 ASCII（${after.length}B）`);
  }
}

// ---------- 10) 界面自检 ----------
{
  const GEN = path.join(ROOT, "tools", "build-wallpaper-picker.mjs");
  // --selftest 会把界面真的拉起来（自检模式会把自己缩到 1x1 并移出屏幕，看不见），
  // 校验 DOM 是否真的画出来、命令管道是否真能跑通，然后自己收尸。
  const r = spawnSync(NODE, [GEN, "--selftest"], { encoding: "utf8", windowsHide: true, timeout: 180000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const m = /✅ 自检通过：(\d+) 项断言 \+ (\d+) 项数值一致性校验/.exec(out);
  console.log(`10) 界面自检 退出码 ${r.status}`);
  if (m) {
    ok(`界面自检通过（${m[1]} 项断言 + ${m[2]} 项一致性）`);
  } else {
    no("界面自检未通过");
    out.trim().split("\n").slice(-8).forEach((l) => console.log("    " + l));
  }
}

// ---------- 11) .cmd 能真跑通 ----------
{
  // 编码对了不等于能跑。这里真的把 cmd 拉起来跑一遍：
  // 给一段「直接回车」的输入，让它走完整流程再退出。
  // 能抓住的东西：括号块里的 goto 之类的语法坑、node 路径写错、
  // 以及「某个出口忘了 pause 就结束」之外的结构性问题。
  // pause 会从被重定向的 stdin 读到回车，所以不会把测试挂住。
  const targets = ["换壁纸.cmd", "调强度.cmd"];
  const bad = [];
  for (const f of targets) {
    const p = path.join(ROOT, "launcher", f);
    if (!fs.existsSync(p)) { bad.push(f + "（不存在）"); continue; }
    // 不指定 encoding，拿 Buffer 自己按 GBK 解 —— cmd 的输出是 ANSI 码页，
    // 按 UTF-8 解会满屏替换字符，那是测试自己错，不是文件错（踩过）。
    //
    // 必须显式 chcp 936：node 派生出的 cmd 没有真实控制台，默认码页不是 936。
    // 码页不对时 cmd 会把 GBK 双字节按单字节拆开读，于是整行被切碎、
    // 注释和 echo 的残片被当成命令去执行，报出一堆「不是内部或外部命令」——
    // 而双击（有真实控制台、码页正确）根本不会这样。不加这一句测的是假象。
    // 路径不要加引号：cmd /c 的引号剥离规则会把带引号的整段当成一个命令名，
    // 报「不是内部或外部命令」。这里的路径没有空格，不加引号最稳。
    const r = spawnSync("cmd.exe", ["/c", `chcp 936 >nul & ${p}`], {
      input: "\r\n\r\n", timeout: 90000, windowsHide: true,
    });
    const buf = Buffer.concat([r.stdout || Buffer.alloc(0), r.stderr || Buffer.alloc(0)]);
    const out = new TextDecoder("gbk").decode(buf);
    const cmdErr = /不是内部或外部命令|系统找不到|语法不正确|syntax of the command/i.test(out);
    // 输出量异常大 = 菜单在死循环刷新，交互时看不出来，只会在后台狂刷
    const looped = out.length > 200000;
    console.log(`    ${f} 退出码 ${r.status} ｜ 输出 ${out.length} 字符${cmdErr ? " ｜ 含 cmd 报错" : ""}${looped ? " ｜ 疑似死循环" : ""}`);
    if (cmdErr) {
      // 把命中的原文打出来。只报"有错"而不给现场，排查就得重跑一遍，白费一轮。
      out.split(/\r?\n/)
        .filter((l) => /不是内部或外部命令|系统找不到|语法不正确|syntax of the command/i.test(l))
        .slice(0, 4)
        .forEach((l) => console.log("      > " + l.trim()));
    }
    if (r.error) bad.push(`${f}（${r.error.code || r.error.message}）`);
    else if (r.status !== 0) bad.push(`${f}（退出码 ${r.status}）`);
    else if (cmdErr) bad.push(`${f}（输出里有 cmd 报错）`);
    else if (looped) bad.push(`${f}（输出异常大，菜单大概在死循环）`);
  }
  console.log(`11) .cmd 可执行性（${targets.length} 个）`);
  bad.length === 0
    ? ok(`${targets.length} 个 cmd 能完整跑通并正常退出`)
    : no("cmd 执行异常：" + bad.join(" / "));
}

// ---------- 12) tools/*.ps1 语法 ----------
{
  // 这条门禁来自一次真实翻车：把 $ErrorActionPreference = "Stop" 写在文件第一行、
  // param(...) 放在注释之后，整个脚本就再也解析不了。
  // PowerShell 要求 param 必须是**第一条语句** —— 上面多一行赋值，它就
  // 不再把这段当 param 块，而是当成一次命令调用去解析括号，报出来的却是
  // 「赋值表达式无效（InvalidLeftHandSide）」，指向第一个默认值那一行。
  // 报错位置和真实病因差着九行，光看错误信息根本想不到。
  //
  // 后果特别难发现：脚本平时没人跑，只有真要建/改快捷方式时才炸；
  // 而那时用户已经在换肤流程里了。
  const dir = path.join(ROOT, "tools");
  const files = fs.readdirSync(dir).filter((f) => /\.ps1$/i.test(f));
  const bad = [];

  // 先做纯静态判断（不依赖任何外部程序，永远可用）
  const suspect = [];
  for (const f of files) {
    const txt = fs.readFileSync(path.join(dir, f)).toString("utf8").replace(/^\uFEFF/, "");
    let paramLine = -1, stmtBefore = -1;
    txt.split(/\r?\n/).forEach((L, i) => {
      const t = L.trim();
      if (!t || t.startsWith("#")) return;
      if (/^param\s*\(/i.test(t)) { if (paramLine < 0) paramLine = i + 1; return; }
      if (paramLine < 0 && stmtBefore < 0) stmtBefore = i + 1;
    });
    if (paramLine > 0 && stmtBefore > 0) suspect.push(`${f}（param 在第 ${paramLine} 行，第 ${stmtBefore} 行已有可执行语句）`);
  }
  bad.push(...suspect);

  // 再做真实解析校验（调 PowerShell 的 Parser，只解析不执行 —— 没有副作用）
  let parsed = "跳过";
  if (suspect.length === 0 && files.length) {
    let unavailable = "";
    for (const f of files) {
      const p = path.join(dir, f).replace(/'/g, "''");
      const cmd = "$e=$null; $null=[System.Management.Automation.Language.Parser]::ParseFile('" +
                  p + "',[ref]$null,[ref]$e); if($e.Count -eq 0){'PARSE-OK'}else{$e|%{'L'+$_.Extent.StartLineNumber+': '+$_.Message}}";
      const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd],
        { encoding: "utf8", windowsHide: true, timeout: 60000 });
      const out = ((r.stdout || "") + (r.stderr || "")).trim();
      if (r.error || (!out.includes("PARSE-OK") && /无法将|not recognized|拒绝访问|Access is denied/i.test(out))) {
        unavailable = (r.error && (r.error.code || r.error.message)) || out.split(/\r?\n/)[0] || "未知原因";
        break;
      }
      if (!out.includes("PARSE-OK")) {
        bad.push(`${f}（解析失败：${out.split(/\r?\n/)[0]}）`);
      }
    }
    parsed = unavailable ? "跳过（调不到 PowerShell：" + unavailable + "）" : "已校验";
  }

  console.log(`12) tools/*.ps1 共 ${files.length} 个 ｜ 解析校验 ${parsed}`);
  bad.length === 0
    ? ok(`${files.length} 个 ps1 语法通过（param 均位于首条语句）`)
    : no("ps1 会被 PowerShell 拒绝解析，建/改快捷方式时会炸：" + bad.join(" / "));
}

console.log("\n================ 结果 ================");
console.log(`通过 ${pass.length} / 失败 ${fail.length}`);
if (fail.length) { fail.forEach((f) => console.log("  ❌ " + f)); process.exit(1); }
console.log("全部通过");
