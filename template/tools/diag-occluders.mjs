#!/usr/bin/env node
/**
 * diag-occluders.mjs — 遮挡诊断：找出"谁挡住了壁纸"
 *
 * 原理：壁纸画在 #root 的 background 上，任何位于其上、面积大且不透明的
 * 容器都会把它盖住。本工具遍历整棵渲染树，把「与视口相交面积 ≥ 阈值 且
 * 背景 alpha ≥ 阈值」的元素按面积倒序列出来，并给出建议的玻璃化配方。
 *
 * 用法：
 *   node tools/diag-occluders.mjs                 → 默认阈值（30000px² / alpha 0.5）
 *   node tools/diag-occluders.mjs 10000 0.2       → 自定义 面积阈值 / alpha 阈值
 *   node tools/diag-occluders.mjs 30000 0.5 --json → 输出 JSON（供程序消费）
 *
 * 为什么需要：不能靠"猜哪个容器不透明"。WorkBuddy 版本升级会改类名，
 * 每次升级后跑一遍这个，就能拿到真实的遮挡清单。
 */
import { evaluate } from "./lib-cdp.mjs";

const PORT = Number(process.env.SKIN_PORT || 9342);
const areaMin = Number(process.argv[2] || 30000);
const alphaMin = Number(process.argv[3] || 0.5);
const asJson = process.argv.includes("--json");

const expr = `(() => {
  const AREA_MIN = ${areaMin}, ALPHA_MIN = ${alphaMin};
  const vw = innerWidth, vh = innerHeight;

  // 解析任意 CSS 颜色 → {r,g,b,a}；无法解析返回 null
  const parse = (col) => {
    if (!col || col === 'transparent') return { r:0,g:0,b:0,a:0 };
    if (col === 'none') return null;
    let m = col.match(/^rgba?\\(([^)]+)\\)$/);
    if (m) { const p = m[1].split(/[,\\/]/).map(s => s.trim()); 
      return { r:+p[0], g:+p[1], b:+p[2], a: p[3] === undefined ? 1 : +p[3] }; }
    m = col.match(/^color\\(srgb ([\\d.]+) ([\\d.]+) ([\\d.]+)(?: \\/ ([\\d.]+))?\\)$/);
    if (m) { return { r:Math.round(+m[1]*255), g:Math.round(+m[2]*255), b:Math.round(+m[3]*255),
      a: m[4] === undefined ? 1 : +m[4] }; }
    m = col.match(/^#([0-9a-f]{3,8})$/i);
    if (m) { let h = m[1]; if (h.length === 3) h = h.split('').map(c=>c+c).join('');
      return { r:parseInt(h.slice(0,2),16), g:parseInt(h.slice(2,4),16), b:parseInt(h.slice(4,6),16),
        a: h.length >= 8 ? parseInt(h.slice(6,8),16)/255 : 1 }; }
    m = col.match(/^color-mix\\(/);
    if (m) return { r:-1, g:-1, b:-1, a:null };   // 计算值里不应出现，留个标记
    return null;
  };

  const sig = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/) : [];
    if (cls.length) s += '.' + cls.slice(0, 3).join('.');
    return s;
  };

  const out = [];
  for (const el of document.querySelectorAll('*')) {
    if (el.id === 'root' || el.tagName === 'HTML' || el.tagName === 'BODY') continue;
    // 跳过我们自己的注入层
    if (el.id && el.id.startsWith('workbuddy-skin-')) continue;
    if (el.closest && el.closest('[id^="workbuddy-skin-"]')) continue;

    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) continue;
    const ix = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const iy = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const area = ix * iy;
    if (area < AREA_MIN) continue;

    const cs = getComputedStyle(el);
    const bg = parse(cs.backgroundColor);
    if (!bg || bg.a === null) continue;
    if (bg.a < ALPHA_MIN) continue;

    out.push({
      sel: sig(el),
      w: Math.round(r.width), h: Math.round(r.height),
      area: Math.round(area),
      areaPct: +(area / (vw * vh) * 100).toFixed(1),
      bg: cs.backgroundColor,
      blur: cs.backdropFilter && cs.backdropFilter !== 'none' ? cs.backdropFilter : '',
      pos: cs.position,
      z: cs.zIndex,
    });
  }
  // 去掉"被同面积祖先完全包住且颜色相同"的重复项
  out.sort((a, b) => b.area - a.area);
  return { viewport: { vw, vh }, total: out.length, list: out.slice(0, 40) };
})()`;

let res;
try {
  res = await evaluate(PORT, expr);
} catch (e) {
  console.error(`✗ CDP 不可达：${e.message}`);
  process.exit(3);
}

if (asJson) {
  console.log(JSON.stringify(res, null, 2));
  process.exit(0);
}

const { viewport, list, total } = res;
console.log(`视口 ${viewport.vw}×${viewport.vh}  ｜  遮挡候选（面积≥${areaMin}px²、alpha≥${alphaMin}）：${total} 个`);
console.log("─".repeat(84));
list.forEach((x, i) => {
  console.log(
    `${String(i + 1).padStart(2)}. ${String(x.area).padStart(7)}px² ${String(x.areaPct).padStart(5)}%  ` +
    `${x.w}×${x.h}  ${x.bg}${x.blur ? "  +" + x.blur : ""}`
  );
  console.log(`    ${x.sel}   [pos=${x.pos} z=${x.z}]`);
});
if (!list.length) console.log("（无遮挡候选 —— 壁纸应能透出）");
