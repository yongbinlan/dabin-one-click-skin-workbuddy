#!/usr/bin/env node
/**
 * shot.mjs — 给 WorkBuddy 渲染进程截图（用于换肤效果的证据留档）
 *
 * 为什么单独做成工具：换肤这件事"看起来对不对"只能靠眼睛。每次改完主题
 * 或壁纸，都需要一张可复核的截图，而不是靠"注入返回 applied:true"当作完成。
 *
 * 用法：
 *   node tools/shot.mjs                          → docs/shot-<时间戳>.png
 *   node tools/shot.mjs docs/after.png           → 指定输出路径
 *   node tools/shot.mjs docs/after.png 1200      → 指定宽度（默认取窗口实际尺寸）
 *
 * 退出码：0 成功 ｜ 3 CDP 不可达（WorkBuddy 未以调试端口启动）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cdp, findRenderer } from "./lib-cdp.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");
const PORT = Number(process.env.SKIN_PORT || 9342);

const rel = process.argv[2];
const widthArg = Number(process.argv[3] || 0);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = rel
  ? path.resolve(process.cwd(), rel)
  : path.join(ROOT, "docs", `shot-${stamp}.png`);

let target;
try {
  target = await findRenderer(PORT);
} catch (e) {
  console.error(`✗ CDP 不可达：${e.message}`);
  console.error("  先确认 WorkBuddy 已启动，且带 WORKBUDDY_REMOTE_DEBUGGING_PORT=9342");
  process.exit(3);
}

// 取视口尺寸；必要时先按指定宽度调整，再截整页可视区
const metrics = await cdp(target.webSocketDebuggerUrl, "Page.getLayoutMetrics", {});
const vp = metrics.result?.cssVisualViewport || metrics.result?.visualViewport || {};
const realW = Math.round(vp.clientWidth || 1440);
const realH = Math.round(vp.clientHeight || 900);

if (widthArg && widthArg !== realW) {
  await cdp(target.webSocketDebuggerUrl, "Emulation.setDeviceMetricsOverride", {
    width: widthArg,
    height: Math.round((realH * widthArg) / realW),
    deviceScaleFactor: 1,
    mobile: false,
  });
}

const shot = await cdp(target.webSocketDebuggerUrl, "Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: false,
});

if (widthArg && widthArg !== realW) {
  await cdp(target.webSocketDebuggerUrl, "Emulation.clearDeviceMetricsOverride", {});
}

const b64 = shot.result?.data;
if (!b64) {
  console.error("✗ 截图失败：" + JSON.stringify(shot).slice(0, 300));
  process.exit(1);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, Buffer.from(b64, "base64"));
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`✅ 截图已保存：${out}  (${realW}×${realH} → ${kb}KB)`);
