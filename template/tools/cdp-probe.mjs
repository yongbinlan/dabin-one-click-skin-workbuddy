#!/usr/bin/env node
/**
 * cdp-probe.mjs — 只读探测 WorkBuddy 的 CDP 通道（不注入任何东西）
 *
 * 用途：换肤失效、令牌对不上、怀疑版本升级改了 DOM 时的第一诊断工具。
 * 零依赖（Node 22+ 内置 fetch / WebSocket），不改任何状态。
 *
 * 用法：
 *   node tools/cdp-probe.mjs            # 默认端口 9342
 *   node tools/cdp-probe.mjs 9336       # 指定端口
 *
 * 看什么：
 *   · targets 里必须有 file:///...renderer/index.html 且 ws=yes
 *   · protocol 必须是 file:（CodeDrobe 的注入前提）
 *   · hasCodedrobeStyle=true 表示 CodeDrobe 的主题样式元素在场
 *   · vars 是四层令牌的实测取值（与 references/local-facts.md 的第 5 节对照）
 */

// ---------------- 最小 CDP 客户端 ----------------
async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

function cdp(wsUrl, method, params = {}, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = Math.floor(Math.random() * 1e6);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error(`timeout:${method}`));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id === id) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve(m);
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`ws-error:${method}`)); };
  });
}

const isInjectable = (t) =>
  !!t.webSocketDebuggerUrl &&
  !String(t.url || "").startsWith("devtools://") &&
  (t.type === "page" || t.type === "iframe" || t.type === "webview");

// ---------------- 采样 ----------------
const PORT = Number(process.argv[2] || 9342);

const VARS = [
  // 语义层
  "--cb-text-primary", "--cb-bg-card", "--cb-sidebar-background",
  // VS Code 桥接层
  "--cb-vscode-editor-background", "--cb-vscode-button-background",
  // 结构层
  "--wb-sidebar-bg", "--wb-bg-modal", "--wb-bg-base", "--wb-text-primary",
  // 5.5 对话区
  "--cr-bg-primary",
  // legacy（heige 注入的残留标记，应为空）
  "--heige-solid",
];

const expr = `(() => {
  const cs = getComputedStyle(document.documentElement);
  const bs = getComputedStyle(document.body);
  const vars = {};
  ${JSON.stringify(VARS)}.forEach((n) => {
    const r = cs.getPropertyValue(n).trim();
    const b = bs.getPropertyValue(n).trim();
    vars[n] = r || b || null;
  });
  const html = document.documentElement;
  return {
    href: location.href.slice(0, 110),
    protocol: location.protocol,
    // CodeDrobe 在场证据
    hasCodedrobeHostClass: html.classList.contains('codedrobe-host-workbuddy'),
    hasCodedrobeStyle: !!document.getElementById('codedrobe-theme-style-workbuddy'),
    // legacy 残留证据（应为 false / null）
    hasLegacyStyle: !!document.getElementById('heige-codex-skin-style'),
    legacySkinAttr: html.getAttribute('data-heige-workbuddy-skin'),
    legacyReadability: html.getAttribute('data-heige-readability'),
    themeAttr: document.body.getAttribute('data-vscode-theme-name'),
    cssRuleCount: [...document.styleSheets].reduce((a, s) => {
      try { return a + s.cssRules.length } catch { return a }
    }, 0),
    vars,
  };
})()`;

let targets;
try {
  targets = await listTargets(PORT);
} catch (e) {
  console.error(`✗ 连不上 CDP :${PORT} —— ${e.message}`);
  console.error(`  请确认用户级环境变量 WORKBUDDY_REMOTE_DEBUGGING_PORT=${PORT} 已设，且 WorkBuddy 已重启。`);
  process.exit(5);
}

console.log(`CDP :${PORT}  targets = ${targets.length}\n`);
for (const t of targets) {
  console.log(`- type=${t.type}  injectable=${isInjectable(t)}  title="${String(t.title || "").slice(0, 40)}"`);
  console.log(`  url=${String(t.url || "").slice(0, 130)}`);
  console.log(`  ws=${t.webSocketDebuggerUrl ? "yes" : "no"}`);
}

console.log("\n===== 令牌采样与环境证据 =====");
for (const t of targets) {
  if (!isInjectable(t)) continue;
  try {
    const m = await cdp(t.webSocketDebuggerUrl, "Runtime.evaluate", {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    const v = m.result?.result?.value;
    console.log(`\n[${t.type}] ${String(t.url || "").slice(0, 80)}`);
    console.log(JSON.stringify(v, null, 2));
  } catch (e) {
    console.log(`\n[${t.type}] 采样失败: ${e.message}`);
  }
}
