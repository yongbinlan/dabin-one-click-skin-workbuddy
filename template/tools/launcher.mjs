#!/usr/bin/env node
/**
 * launcher.mjs — WorkBuddy 带皮肤启动器（常驻层核心）
 *
 * 解决 CodeDrobe 未覆盖的最后一环：WorkBuddy 重启后皮肤消失，需要自动重注入。
 *
 * 设计原则（吸取本机历史教训）：
 *   · 无窗口：由 WScript 以 windowStyle=0 拉起本脚本，不弹终端、不打断键鼠
 *   · 无守护：干完活立即退出，不留常驻进程、不轮询占用
 *   · 单实例：WorkBuddy 已在运行时不重复拉起，避免双实例
 *   · 失败即退：任何环节失败都写日志并退出，不静默重试
 *   · 可回滚：只用 CodeDrobe 官方 apply/restore，不碰 app.asar、不改安装目录
 *
 * 前提：用户级环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT=9342 已设置，
 *       因此无论从哪个入口启动 WorkBuddy，都会自带 CDP 通道。
 *
 * 用法：
 *   node launcher.mjs              # 启动（或复用）+ 等就绪 + 注入 + 自检
 *   node launcher.mjs --no-launch  # 不启动应用，只做注入（应用已在运行）
 *   node launcher.mjs --restore    # 还原原生界面
 *   node launcher.mjs --status     # 只读：报告当前主题状态
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runCli } from "./run-codedrobe.mjs";
import { readSkinState, applySkinFromState, PRESET_CN } from "./skin-state.mjs";
import { removeWallpaperLayer } from "./lib-cdp.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");

/* ---------------------------------------------------------------------------
 * 可移植化：这些值不再写死在一台机器上
 *
 * exe 解析优先级：
 *   1. 环境变量 WORKBUDDY_EXE
 *   2. <ROOT>/workbuddy.local.json 的 exe 字段（本机记录，init 探测后写入）
 *   3. 常见安装位置探测
 * theme 解析优先级：
 *   1. 环境变量 WORKBUDDY_THEME
 *   2. workbuddy.local.json 的 theme 字段
 *   3. build/ 下的 *.codedrobe-theme（有多个就取最新的，并告警）
 * port：WORKBUDDY_REMOTE_DEBUGGING_PORT，缺省 9342
 * ------------------------------------------------------------------------- */
function readLocalCfg() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "workbuddy.local.json"), "utf8"));
  } catch { return {}; }
}

function detectExe(local) {
  const cands = [
    process.env.WORKBUDDY_EXE,
    local.exe,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "WorkBuddy", "WorkBuddy.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "WorkBuddy", "WorkBuddy.exe"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "WorkBuddy", "WorkBuddy.exe"),
  ].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* 探不到就试下一个 */ }
  }
  return "";
}

function detectTheme(local) {
  const cands = [process.env.WORKBUDDY_THEME, local.theme].filter(Boolean);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch { /* 探不到就试下一个 */ }
  }
  try {
    const bd = path.join(ROOT, "build");
    const hit = fs.readdirSync(bd).filter((f) => f.endsWith(".codedrobe-theme")).sort();
    if (hit.length) {
      if (hit.length > 1) {
        console.log(`[warn] build/ 下有多个主题包，本次用最新的：${hit[hit.length - 1]}`);
        console.log("       想固定用哪个：设 WORKBUDDY_THEME，或写进 workbuddy.local.json 的 theme 字段");
      }
      return path.join(bd, hit[hit.length - 1]);
    }
  } catch { /* ignore */ }
  /*
   * 找不到主题包时给一个「本该在哪」的示意路径，而不是返回空串。
   * 返回空串会让日志变成「主题包不存在：」—— 后面什么都没有，
   * 排查的人根本不知道去看哪里。
   */
  console.log(`[warn] 在 ${path.join(ROOT, "build")} 下没找到 *.codedrobe-theme`);
  console.log("       生成主题包：node tools/build-theme.mjs，再用 CodeDrobe 打包");
  return path.join(ROOT, "build", "theme.codedrobe-theme");
}

const LOCAL_CFG = readLocalCfg();

const CFG = {
  appId: "workbuddy",
  port: Number(process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT) || 9342,
  exe: detectExe(LOCAL_CFG),
  theme: detectTheme(LOCAL_CFG),
  logDir: path.join(ROOT, "logs"),
  // 空闲端口就绪后，最多再等 renderer landmark 这么多毫秒
  rendererReadyMs: 90000,
  cdpReadyMs: 90000,
};

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

// ---------------- 日志 ----------------
fs.mkdirSync(CFG.logDir, { recursive: true });
const logFile = path.join(CFG.logDir, "launcher.log");
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    // 单文件超过 1MB 就轮转，避免无限增长
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) {
      fs.renameSync(logFile, logFile + ".1");
    }
    fs.appendFileSync(logFile, line + "\n", "utf8");
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 探测工具 ----------------
function portOpen(port, timeout = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const t = setTimeout(() => { s.destroy(); resolve(false); }, timeout);
    s.on("connect", () => { clearTimeout(t); s.destroy(); resolve(true); });
    s.on("error", () => { clearTimeout(t); resolve(false); });
  });
}

// 判断 WorkBuddy 是否已在运行。
// 关键：本机有安全策略会拦截部分命令行工具，tasklist 一旦被拦会返回空 stdout，
// 若直接把"空输出"当成"未运行"，启动器就会盲目 spawn 出第二个实例（双开）。
// 因此空输出一律视为"取不到结论"，改用 PowerShell 复核；只有 tasklist 明确
// 输出了结果（含 "No tasks are running" 这类否定结论）才直接采信。
async function processRunning() {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq WorkBuddy.exe", "/FO", "CSV", "/NH"], {
    encoding: "utf8", windowsHide: true, timeout: 15000,
  });
  const out = (r.stdout || "").trim();
  if (/WorkBuddy\.exe/i.test(out)) return true;
  if (out !== "") return false;

  const ps = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command",
    "(Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue | Measure-Object).Count"], {
    encoding: "utf8", windowsHide: true, timeout: 25000,
  });
  const n = parseInt((ps.stdout || "").trim(), 10);
  if (Number.isFinite(n)) return n > 0;
  // 两条路都取不到结论：保守返回 true，宁可等待也不要造成双开
  log("⚠️ 无法确认 WorkBuddy 进程状态（tasklist/powershell 均无输出），保守处理为「已在运行」");
  return true;
}

async function waitForCdp(ms) {
  const deadline = Date.now() + ms;
  let tries = 0;
  while (Date.now() < deadline) {
    tries++;
    if (await portOpen(CFG.port)) return true;
    await sleep(1000);
  }
  return false;
}

function parseJson(out) {
  const i = out.indexOf("{");
  if (i < 0) return null;
  try { return JSON.parse(out.slice(i, out.lastIndexOf("}") + 1)); } catch { return null; }
}

// ---------------- 主流程 ----------------
async function main() {
  log(`=== launcher 启动 (${argv.join(" ") || "默认"}) ===`);

  // 主题包是否齐备只决定"要不要注入"，绝不决定"能不能启动 WorkBuddy"。
  // 早先的实现在这里直接 return 2，一旦主题包被移动/删除，双击带皮肤入口
  // 就会连应用都打不开——这是不可接受的单向门，故改为降级标记。
  const themeOk = fs.existsSync(CFG.theme);
  if (!themeOk && !has("--restore")) {
    log(`⚠️ 主题包不存在：${CFG.theme} → 本次只启动应用，跳过注入`);
  }

  // --- 状态模式 ---
  if (has("--status")) {
    const open = await portOpen(CFG.port);
    log(`CDP :${CFG.port} = ${open ? "可达" : "不可达"}；WorkBuddy 进程 = ${(await processRunning()) ? "在运行" : "未运行"}`);
    const skin = readSkinState();
    log(`皮肤层：${skin.enabled ? "启用" : "已关闭"} ｜ 壁纸 = ${skin.path ? path.basename(skin.path) : "(主题自带)"} ｜ 档位 = ${PRESET_CN[skin.preset]}(${skin.preset})`);
    if (skin.missingFile) log(`  ⚠️ 记录的壁纸文件已不存在：${skin.raw.path}`);
    if (open && themeOk) {
      const r = runCli(["verify", "--app", CFG.appId, "--port", String(CFG.port), "--theme", CFG.theme]);
      const j = parseJson(r.stdout);
      const t = j?.targets?.[0]?.result;
      log(`主题状态：installed=${t?.installed} themeId=${t?.themeId} version=${t?.version} pass=${t?.pass}`);
    } else if (open) {
      log("主题包缺失，跳过 verify");
    }
    return 0;
  }

  // --- 还原模式 ---
  if (has("--restore")) {
    // 先撤皮肤层再撤主题：否则 restore 之后会剩下一层"玻璃 + 壁纸"盖在原生界面上。
    // 只移除页面上的注入，不动 current.json —— 记录留着，下次启动仍会自动恢复。
    if (await portOpen(CFG.port)) {
      try {
        const r = await removeWallpaperLayer(CFG.port);
        log(`皮肤层已移除（removed=${r.removed}）`);
      } catch (e) {
        log(`⚠️ 皮肤层移除失败（不影响还原主流程）：${e.message}`);
      }
    }
    const r = runCli(["restore", "--app", CFG.appId, "--port", String(CFG.port)]);
    log(`还原完成 status=${r.status}`);
    if (r.stderr) log("  stderr: " + r.stderr.trim().slice(0, 300));
    return r.status === 0 ? 0 : 3;
  }

  // --- 1) 确保 WorkBuddy 在跑 ---
  let cdpReady = await portOpen(CFG.port);
  if (!cdpReady && !has("--no-launch")) {
    const running = await processRunning();
    if (running) {
      log("WorkBuddy 已在运行但 CDP 未就绪 → 等待（可能仍在启动）");
    } else {
      // spawn 对不存在的可执行文件不会同步抛错（错误是异步事件），
      // 所以必须先用 existsSync 同步确认，否则 try/catch 形同虚设。
      if (!fs.existsSync(CFG.exe)) {
        log(`✗ 找不到 WorkBuddy 可执行文件：${CFG.exe || "(未探测到)"}`);
        log("  修法（任选其一）：");
        log("    · 设环境变量 WORKBUDDY_EXE=<完整路径>");
        log('    · 在工程根写 workbuddy.local.json：{ "exe": "C:\\\\...\\\\WorkBuddy.exe" }');
        log("    · 重跑一键初始化：node scripts/init.mjs");
        return 4;
      }
      log(`启动 WorkBuddy：${CFG.exe}`);
      const child = spawn(CFG.exe, [], { detached: true, stdio: "ignore", windowsHide: false });
      child.on("error", (e) => log(`✗ 启动进程出错：${e.message}`));
      child.unref();
    }
  }
  // 注意：这一步必须在 if 之外。--no-launch 的语义是"不负责启动应用"，
  // 而不是"不等待应用"——应用可能正由外部启动中，CDP 尚未监听。
  if (!cdpReady) cdpReady = await waitForCdp(CFG.cdpReadyMs);
  if (!cdpReady) {
    log(`✗ CDP :${CFG.port} 在超时内未就绪。请确认环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT=${CFG.port}`);
    return 5;
  }
  log(`CDP :${CFG.port} 已就绪`);

  if (!themeOk) {
    log("✗ 主题包缺失，跳过注入（应用已正常启动）");
    return 2;
  }

  // --- 2) 等 renderer landmark 就绪（loading 页会全部 landmark 缺失，需重试）---
  log("等待 renderer landmark 就绪…");
  let compatible = false;
  const deadline = Date.now() + CFG.rendererReadyMs;
  while (Date.now() < deadline) {
    const r = runCli(["probe", "--app", CFG.appId, "--port", String(CFG.port), "--theme", CFG.theme]);
    const j = parseJson(r.stdout);
    const res = j?.targets?.[0]?.result;
    if (res?.compatible && !(res.missing || []).length) { compatible = true; break; }
    await sleep(2000);
  }
  if (!compatible) {
    log("✗ renderer landmark 未在超时内就绪，放弃注入（界面可能是加载中或版本不兼容）");
    return 6;
  }
  log("renderer landmark 就绪");

  // --- 3) 注入 ---
  const ap = runCli(["apply", "--app", CFG.appId, "--port", String(CFG.port), "--theme", CFG.theme, "--no-launch"]);
  const aj = parseJson(ap.stdout);
  const at = aj?.targets?.[0]?.result;
  if (!at?.pass) {
    log(`✗ 注入失败：${(ap.stderr || ap.stdout).trim().slice(0, 400)}`);
    return 7;
  }
  log(`✅ 已注入「${aj.theme?.displayName}」v${aj.theme?.version}（themeId=${at.themeId}）`);

  // --- 4) 自检 ---
  const vf = runCli(["verify", "--app", CFG.appId, "--port", String(CFG.port), "--theme", CFG.theme]);
  const vj = parseJson(vf.stdout);
  const vt = vj?.targets?.[0]?.result;
  if (vt?.pass) {
    log(`✅ 自检通过：stylePresent=${vt.stylePresent} images=${JSON.stringify(vt.images)} 横向溢出=${vt.horizontalOverflow}`);
  } else {
    log(`⚠️ 自检未通过：${JSON.stringify(vt).slice(0, 300)}`);
  }

  // --- 5) 应用皮肤层（壁纸 + 玻璃）---
  // 位置敏感：必须在 apply 主题**之后**。皮肤层与 CodeDrobe 注入的 style 选择器
  // 同特异性，靠"谁在后谁生效"取胜；先装后主题的话，玻璃层会被主题给
  // .cr-agent__body 的 90% 不透明底色压掉，表现为"壁纸怎么都透不出来"。
  //
  // 皮肤是装饰而不是功能：这一步失败只写日志，绝不影响退出码、
  // 更不影响 WorkBuddy 本身（应用此时已经打开且已上好主题）。
  const skin = readSkinState();
  if (!skin.enabled) {
    log("皮肤层：已关闭（current.json 是禁用标记），保持主题原样");
    try {
      const r = await removeWallpaperLayer(CFG.port);
      if (r?.removed) log("  已顺手清掉上一次残留的皮肤层");
    } catch {}
  } else {
    const r = await applySkinFromState(CFG.port, skin);
    if (!r.ok) {
      log(`⚠️ 皮肤层注入失败（不影响主题与应用）：${r.why}`);
    } else {
      const w = skin.path ? path.basename(skin.path) : "主题自带";
      log(`✅ 皮肤层已应用：壁纸=${w} 档位=${PRESET_CN[skin.preset]}(${skin.preset})`);
      if (skin.missingFile) log(`  ⚠️ 记录的壁纸文件不存在，已回落到主题自带图：${skin.raw.path}`);
    }
  }

  return vt?.pass ? 0 : 8;
}

main()
  .then((code) => { log(`=== 退出码 ${code} ===`); process.exit(code); })
  .catch((e) => { log(`✗ 异常：${e.stack || e.message}`); process.exit(9); });
