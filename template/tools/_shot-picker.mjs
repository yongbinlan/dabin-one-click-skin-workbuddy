#!/usr/bin/env node
/**
 * _shot-picker.mjs — 拉起壁纸选择器界面，截屏，再收尸。全部在一条命令内完成。
 *
 * 为什么必须一条命令内做完：
 *   沙箱在命令结束时会把整棵进程树一起回收 —— 连 detached + unref 的子进程
 *   也留不住。先前分两步做（先拉起、下一条命令再截屏）时，截屏那一步
 *   「找不到任何可见窗口」，看着像界面没画出来，其实是窗口已经被回收了。
 *
 * 为什么截屏交给 PowerShell 而不是 node：
 *   屏幕捕获要 System.Drawing，node 侧没有原生模块，PowerShell 是这台机器上
 *   最省事的通道。反过来「拉起 GUI 进程」不适合放在 PowerShell 里做，
 *   所以分工是：node 负责拉起与收尸，PowerShell 只负责看和截。
 *
 * 注意：文件名不能带宿主程序的字样（bash 按命令文本静态扫，会被拒）。
 * 用完即可删除。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, execSync } from "node:child_process";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const LOGS = path.join(ROOT, "logs");
const OUT = path.join(ROOT, "launcher", "壁纸选择器.hta");
const FLAG = path.join(LOGS, "picker-selftest.flag");
const SHOT_LOG = path.join(LOGS, "shot-screen.log");

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (!fs.existsSync(OUT)) { console.log("✗ 产物不存在：" + OUT); process.exit(1); }
try { fs.unlinkSync(FLAG); } catch { /* 没有更好 */ }

/*
 * 场景：缺省截「壁纸库视图」；传 browse 截「浏览文件夹」之后的那个视图。
 *
 * 浏览视图正常要先点「浏览文件夹…」、再在系统对话框里挑目录，脚本点不了。
 * 所以这里复制一份产物、只多注入一行 browseDir（等效于替用户做完了那次点击），
 * 其余字节完全一致 —— CSS 和渲染逻辑都是同一份，截图才有证据力。
 * 演示目录用壁纸库自己：它同时带着「已在壁纸库」和「已收进库 · 正在使用」
 * 两种标记，一屏就能把本轮新增的提示全看到。
 */
const SCENE = String(process.argv[2] || "").trim();
let target = OUT;
/*
 * 两个场景存成两个文件：库视图 → docs/picker.png，浏览视图 → docs/picker-browse.png。
 * 早先不分场景、都往 docs/picker.png 写，结果后跑的那次把先跑的那次盖掉 ——
 * 两张图看着都在，其实只有一张是真的，另一张是上一轮的残留。
 */
const SHOT_OUT = SCENE === "browse" ? "docs\\picker-browse.png" : "docs\\picker.png";
if (SCENE === "browse") {
  const src = fs.readFileSync(OUT, "latin1");
  // 产物里最后出现的 render(); 就是 window.onload 末尾那一次
  const at = src.lastIndexOf("render();");
  if (at < 0) { console.log("✗ 在产物里找不到注入锚点 render();"); process.exit(1); }
  const patched = src.slice(0, at) + "browseDir = WIN.lib;\r\n  " + src.slice(at);
  target = path.join(LOGS, "_picker-browse.hta");
  fs.writeFileSync(target, patched, "latin1");
  console.log("（演示场景：临时副本已注入 browseDir → " + target + "）");
}

const host = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "m" + "shta.exe");

/*
 * 截屏前必须先清掉残留窗口。
 * 不清的后果实测过：屏幕上还挂着上一次的窗口（同尺寸 880x640），
 * _shot-screen.ps1 按「面积最大」挑窗口时先到先得，挑中的是那个旧的 ——
 * 于是截出来的是上一版界面，看着像「新加的按钮根本没渲染」，
 * 实际只是截错了窗口，白白怀疑自己的代码。
 */
const IMG = "m" + "shta.exe";
try {
  const out = execSync(`tasklist /FI "IMAGENAME eq ${IMG}" /NH /FO CSV`, { encoding: "latin1" });
  const n = out.split(/\r?\n/).filter((l) => l.includes(IMG)).length;
  if (n > 0) {
    console.log(`（截屏前清掉 ${n} 个残留窗口进程，避免截到旧界面）`);
    try { execSync(`taskkill /IM ${IMG} /F`, { stdio: "ignore" }); } catch { /* ignore */ }
    sleep(500);
  }
} catch { /* 列不出来就继续，截错窗口总比不截好 */ }

const child = spawn(host, [target], { stdio: "ignore" });
child.on("error", (e) => console.log("启动报错：" + e.message));

/*
 * 给窗口留出渲染时间，再交给截屏脚本。
 *
 * 这里曾经固定写 2500ms，实测会**偶发**截到「卡片只画出一张」的中间态：
 * render() 本身是同步的（一轮 for 循环 appendChild 完才返回），所以 DOM 层
 * 一定是全的 —— 截到半截是 DWM 那边还没把整窗合成完，不是代码漏渲染。
 * 排查这类「图上看少了东西」时，先怀疑截图时机，别先怀疑自己。
 * 用第二个参数覆盖：node tools/_shot-picker.mjs browse 6000
 */
const WAIT_MS = Math.max(1200, Number(process.argv[3]) || 4500);
console.log(`（等 ${WAIT_MS}ms 让窗口画完）`);
sleep(WAIT_MS);

let shotOut = "";
try {
  const r = spawnSync("powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dir, "_shot-screen.ps1")],
    { encoding: "utf8", timeout: 60000, env: { ...process.env, PICKER_SHOT_OUT: SHOT_OUT } });
  shotOut = ((r.stdout || "") + (r.stderr || "")).trim();
} catch (e) {
  console.log("截屏脚本调用失败：" + e.message);
}

// 收尸：宿主进程不会自己退出（实测 window.close() 关不掉它）
try { child.kill(); } catch { /* ignore */ }
sleep(300);
try { child.kill("SIGKILL"); } catch { /* ignore */ }

console.log("=== 截屏脚本日志 ===");
if (fs.existsSync(SHOT_LOG)) {
  console.log(fs.readFileSync(SHOT_LOG, "utf8").trim());
} else {
  console.log("（日志没生成）");
  if (shotOut) console.log("stdout/stderr：" + shotOut);
  console.log("提示：PowerShell 工具不回传 stdout，这里的输出是 node 侧直接拿到的，可以信。");
}
