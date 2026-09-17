/**
 * lib-cdp.mjs — 共享 CDP 客户端 + 壁纸层注入
 *
 * 为什么需要它：CodeDrobe 的 apply 只能注入整个主题包，而"换壁纸"要求秒级、
 * 不重新打包。实测发现主题的壁纸变量定义在 `html.codedrobe-host-workbuddy #root`
 * 上（不是 :root），所以只要往页面注入一条 targeting #root 的规则，就能换掉壁纸，
 * 且立即生效、无需打包、无需重启。
 *
 * 实测证据（2026-09-17）：
 *   · file:// 本地图片在 renderer 中可正常加载（1920×1078，CSP 为 null）
 *   · 注入 `html.codedrobe-host-workbuddy #root { --codedrobe-image-hero: url("file:///...") !important; }`
 *     → 变量被改写 ✅、#root 背景引用到新图 ✅、移除后完全复原 ✅、无残留 ✅
 *
 * 零依赖：Node 22+ 内置 fetch / WebSocket。
 */
import path from "node:path";
import { pathToFileURL } from "node:url";

/** 壁纸层 style 元素的 id（与 CodeDrobe 自己的主题 style 元素互不干扰） */
export const WALLPAPER_STYLE_ID = "workbuddy-skin-wallpaper";

// ---------------- CDP 基础 ----------------

export async function listTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

export function cdp(wsUrl, method, params = {}, timeoutMs = 25000) {
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

/** 找到可注入的 renderer target（排除 devtools 等） */
export async function findRenderer(port) {
  const list = await listTargets(port);
  const t = list.find(
    (x) => x.webSocketDebuggerUrl && !String(x.url || "").startsWith("devtools://"),
  );
  if (!t) throw new Error(`端口 ${port} 上找不到可注入的 renderer（WorkBuddy 未以 CDP 方式启动？）`);
  return t;
}

export async function evaluate(port, expression, { awaitPromise = false, timeoutMs = 25000 } = {}) {
  const t = await findRenderer(port);
  const r = await cdp(t.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression, returnByValue: true, awaitPromise,
  }, timeoutMs);
  if (r.result?.exceptionDetails) {
    throw new Error("页面执行异常：" + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  }
  return r.result?.result?.value;
}

// ---------------- 皮肤层（壁纸 / 薄纱 / 玻璃 三层合一） ----------------

/**
 * 强度档位。数值含义：
 *   rootX / rootY  重写 #root 方向性遮罩的混色比例（越小越透）
 *   glass          结构容器（对话区 / 侧栏 / 输入框）不透明度
 *   content        内容块（代码 / diff / 工具卡片）不透明度 —— 保可读，不跟着一起透
 *   blur           结构容器毛玻璃半径
 *
 * 为什么不把 content 也调很透：壁纸透得越狠，代码和 diff 越看不清。
 * 结构面可以糊，内容面不能糊 —— 这是换肤唯一不能破的底线。
 */
export const SKIN_PRESETS = {
  light: { rootX: 56, rootY: 42, glass: 46, content: 80, blur: 22 },
  medium: { rootX: 74, rootY: 60, glass: 62, content: 88, blur: 18 },
  strong: { rootX: 90, rootY: 78, glass: 80, content: 92, blur: 12 },
};

/** 中文档位别名 → 内部键 */
export const PRESET_ALIAS = {
  "淡": "light", light: "light",
  "中": "medium", medium: "medium",
  "浓": "strong", strong: "strong",
  "更淡": "light",
};

/**
 * 结构容器清单（会被玻璃化）。
 * 全部来自 tools/diag-occluders.mjs 的**实测**遮挡清单，不是猜的类名：
 *   .cr-agent__body      41.1% —— 最大元凶，ADAPTER 给了它 90% 不透明底色
 *   .conversation-sidebar 13.4%
 *   .cr-input-container   6.5%
 *   .sidebar-next         右侧详情面板（会话切换时出现）
 *   .cr-widget-card       卡片式回复（出现时才有）
 */
const GLASS_SELECTORS = [
  // 第一、二条镜像 build-theme.mjs ADAPTER 的选择器（同为 (0,4,1)），靠"注入在后"取胜；
  // 第二条是同元素的降级兜底 —— 两条都留着，ADAPTER 改版也不至于整体失效。
  ".cr-agent__body:has(> .cr-agent__content:not(:empty))",
  ".cr-agent__body",
  ".conversation-sidebar",
  ".cr-input-container",
  ".sidebar-next",
  ".cr-widget-card",
];

/** 内容块清单（只轻调，保持高不透明以保可读） */
const CONTENT_SELECTORS = [
  ".cr-tool-exp__content",
  ".cr-tool-write__body",
  ".cr-tool-diff",
  ".sc-block-content",
  ".cr-code-like-box",
];

/**
 * 生成完整的皮肤层 CSS。
 *
 * @param {object} o
 * @param {string|null} o.imagePath  壁纸绝对路径；null = 用主题自带壁纸（仍会重写遮罩与玻璃层）
 * @param {string} o.preset          档位：light | medium | strong（或中文 淡/中/浓）
 * @param {string} [o.position]      壁纸定位，默认 center center
 * @param {object} [o.overrides]     逐项覆盖，如 { glass: 55 }（数字，单位 %）
 */
export function buildSkinCss({ imagePath = null, preset = "medium", position = "center center", overrides = {} } = {}) {
  const key = PRESET_ALIAS[preset] || "medium";
  const p = { ...(SKIN_PRESETS[key] || SKIN_PRESETS.medium), ...overrides };
  const pct = (v) => `${Number(v)}%`;
  const H = "html.codedrobe-host-workbuddy";

  const wpVar = imagePath
    ? `  /* 自选壁纸（file:// 直连，renderer 实测可加载，无需 base64） */\n` +
      `  --codedrobe-image-hero: url("${pathToFileURL(path.resolve(imagePath)).href}") !important;\n`
    : `  /* 未选自选壁纸 —— 沿用主题自带图，只重写遮罩与玻璃层 */\n`;

  return `/* ============================================================
   WorkBuddy 皮肤层 v2 —— 由 workbuddy-skin 注入，请勿手改
   三层结构：
     ① 壁纸层  覆盖 --codedrobe-image-hero（#root background 的第三层）
     ② 薄纱层  重写 #root 的方向性遮罩，决定壁纸"透出多少"
     ③ 玻璃层  把挡在壁纸前面的结构容器改成半透明 + 毛玻璃
   强度档位：${key}（rootX=${p.rootX}% rootY=${p.rootY}% glass=${p.glass}% content=${p.content}% blur=${p.blur}px）
   改档位：node tools/set-wallpaper.mjs intensity 淡|中|浓
   移除本层：node tools/set-wallpaper.mjs none
   ============================================================ */
${H} {
  --wb-skin-root-x: ${pct(p.rootX)};
  --wb-skin-root-y: ${pct(p.rootY)};
  --wb-skin-glass: ${pct(p.glass)};
  --wb-skin-content: ${pct(p.content)};
  --wb-skin-blur: ${p.blur}px;
  --wb-skin-wp-pos: ${position};
}

/* ① + ② 壁纸与薄纱：与主题同特异性 (1,1,1)，注入在后 → 后者胜 */
${H} #root {
${wpVar}  background:
    linear-gradient(90deg, color-mix(in srgb, var(--heige-surface) var(--wb-skin-root-x), transparent) 0 20%, transparent 46%),
    linear-gradient(180deg, transparent 0 42%, color-mix(in srgb, var(--heige-surface) var(--wb-skin-root-y), transparent) 82% 100%),
    var(--codedrobe-image-hero) var(--wb-skin-wp-pos) / cover no-repeat !important;
}

/* ③ 玻璃层：结构容器半透明 + 毛玻璃（壁纸从这里透出来） */
${GLASS_SELECTORS.map((s) => `${H} ${s}`).join(",\n")} {
  background: color-mix(in srgb, var(--heige-surface) var(--wb-skin-glass), transparent) !important;
  backdrop-filter: blur(var(--wb-skin-blur)) saturate(1.12) !important;
  -webkit-backdrop-filter: blur(var(--wb-skin-blur)) saturate(1.12) !important;
}

/* 嵌套容器去重：.conversation-list 在 .conversation-sidebar 内，
   两层都半透明会叠加成更实的一块，所以内层必须放空。 */
${H} .conversation-sidebar .conversation-list {
  background: transparent !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
}

/* 内容块：保可读，只做轻微压暗，不参与毛玻璃 */
${CONTENT_SELECTORS.map((s) => `${H} ${s}`).join(",\n")} {
  background-color: color-mix(in srgb, var(--heige-surface) var(--wb-skin-content), transparent) !important;
}
`;
}

/** 兼容旧调用：只给图片路径 → 完整皮肤层（medium 档） */
export function wallpaperCss(imagePath, opts = {}) {
  return buildSkinCss({ imagePath, ...opts });
}

/** 注入或替换壁纸层 style 元素（幂等：同 id 的旧元素会被替换） */
export async function applyWallpaperCss(port, cssText) {
  return await evaluate(port, `(() => {
    const ID = ${JSON.stringify(WALLPAPER_STYLE_ID)};
    document.getElementById(ID)?.remove();
    if (!${JSON.stringify(cssText)}.trim()) return { applied: false, reason: 'empty-css' };
    const s = document.createElement('style');
    s.id = ID;
    s.textContent = ${JSON.stringify(cssText)};
    document.head.appendChild(s);
    return { applied: true, id: ID };
  })()`);
}

/** 移除壁纸层（回到主题自带壁纸） */
export async function removeWallpaperLayer(port) {
  return await evaluate(port, `(() => {
    const ID = ${JSON.stringify(WALLPAPER_STYLE_ID)};
    const el = document.getElementById(ID);
    el?.remove();
    return { removed: !!el };
  })()`);
}

/** 读回当前实际生效的皮肤层状态（用于自检，而不是靠"注入返回 true"当证据） */
export async function readWallpaperState(port) {
  return await evaluate(port, `(async () => {
    // 必须等两帧：同一同步任务里连续读写 DOM，浏览器来不及重算样式，
    // 之前就是因此得到过"变量为空"的假警报。
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const root = document.getElementById('root');
    const rs = root ? getComputedStyle(root) : null;
    const varVal = rs ? rs.getPropertyValue('--codedrobe-image-hero').trim() : '';
    const body = document.querySelector('.cr-agent__body');
    const glassVar = rs ? rs.getPropertyValue('--wb-skin-glass').trim() : '';
    const bg = rs ? rs.backgroundImage : '';
    return {
      wallpaperStylePresent: !!document.getElementById(${JSON.stringify(WALLPAPER_STYLE_ID)}),
      heroVarHead: varVal.slice(0, 120),
      heroVarIsFile: varVal.includes('file:///'),
      heroVarIsBlob: varVal.includes('blob:'),
      bgLen: bg.length,
      bgTail: bg.slice(-160),
      // 三层是否真的落地
      preset: {
        glass: glassVar || '(unset)',
        rootX: rs ? rs.getPropertyValue('--wb-skin-root-x').trim() || '(unset)' : '(unset)',
        blur: rs ? rs.getPropertyValue('--wb-skin-blur').trim() || '(unset)' : '(unset)',
      },
      agentBodyBg: body ? getComputedStyle(body).backgroundColor : '(no .cr-agent__body)',
      agentBodyBlur: body ? (getComputedStyle(body).backdropFilter || '(none)') : '',
      strayStyles: [...document.querySelectorAll('style')]
        .filter(s => String(s.textContent || '').includes('wb-skin-glass'))
        .map(s => s.id || '(anonymous)'),
    };
  })()`, { awaitPromise: true });
}
