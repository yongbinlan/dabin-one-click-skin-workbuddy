#!/usr/bin/env node
/**
 * build-theme.mjs — 由 legacy CSS 生成 CodeDrobe 规范作用域的主题 CSS
 *
 * 输入：themes/<主题>/assets/legacy-skin-workbuddy.css
 *       （legacy 皮肤：全局作用域 + 内联 hero data URL）
 * 输出：themes/<主题>/workbuddy.css
 *       （每条规则收敛到 html.codedrobe-host-workbuddy，
 *         hero data URL → var(--codedrobe-image-hero)，
 *         去掉 :root[data-heige-readability="on"] 属性门槛，
 *         追加 --theme-* 适配层 + color-scheme: dark）
 *
 * 为什么这么做：不重写视觉（1:1 保留原设计的配色），但把注入管道的
 * 作用域规范化，使其可被 CodeDrobe 的 probe/verify/restore 闭环管理。
 *
 * 主题显示名从 <主题>/theme.json 的 displayName 读（那是 CodeDrobe 的主题
 * 清单，本来就有这个字段），读不到就退回目录名 —— 所以换主题不用改代码。
 *
 * 用法：
 *   node tools/build-theme.mjs                 # themes/ 下只有一个主题时自动选中
 *   node tools/build-theme.mjs themes/<名字>   # 显式指定
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, "..");

/*
 * 主题目录不再写死在源码里。
 *   1. 命令行第 1 个参数：node tools/build-theme.mjs themes/<名字>
 *   2. themes/ 下只有一个主题时自动选中它
 *   3. 有多个候选就报错并要求显式指定 —— 绝不猜
 * 每个主题目录的形状：
 *   <主题>/assets/legacy-skin-workbuddy.css  →  <主题>/workbuddy.css
 */
function resolveThemeDir() {
  const arg = process.argv[2];
  if (arg) {
    const d = path.isAbsolute(arg) ? arg : path.join(ROOT, arg);
    if (!fs.existsSync(d)) { console.error(`✗ 指定的主题目录不存在：${d}`); process.exit(1); }
    return d;
  }
  const base = path.join(ROOT, "themes");
  let subs = [];
  try {
    subs = fs.readdirSync(base).filter((n) => fs.statSync(path.join(base, n)).isDirectory());
  } catch { /* themes 目录本身都不存在 */ }
  if (subs.length === 1) return path.join(base, subs[0]);
  console.error("✗ 无法确定要构建哪个主题，请显式指定：");
  console.error("    node tools/build-theme.mjs themes/<主题名>");
  if (subs.length > 1) console.error("  现有主题：" + subs.join(" / "));
  else console.error("  themes/ 下没有主题目录；每个主题一个目录，内含 assets/legacy-skin-workbuddy.css");
  process.exit(1);
}

const THEME_DIR = resolveThemeDir();
const THEME_NAME = path.basename(THEME_DIR);
const SRC = path.join(THEME_DIR, "assets", "legacy-skin-workbuddy.css");
const OUT = path.join(THEME_DIR, "workbuddy.css");

const HOST = "html.codedrobe-host-workbuddy";
const READABILITY = ':root[data-heige-readability="on"]';

if (!fs.existsSync(SRC)) {
  console.error(`✗ 找不到源 CSS：${SRC}`);
  process.exit(1);
}
const raw = fs.readFileSync(SRC, "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

/** 顶层逗号分割（括号感知，避免拆坏 :is(a, b)） */
function splitTop(sel) {
  const out = []; let depth = 0, cur = "";
  for (const ch of sel) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => stripComments(s).trim()).filter(Boolean);
}

/** 单条选择器 → 收敛到宿主作用域 */
function scopeOne(sel) {
  sel = sel.trim().replace(/\s+/g, " ");
  if (sel.startsWith(READABILITY)) {
    const rest = sel.slice(READABILITY.length).trim();
    return rest ? `${HOST} ${rest}` : HOST;
  }
  if (sel === ":root" || sel.startsWith(":root[") || sel.startsWith(":root:")) {
    return sel === ":root" ? HOST : HOST + sel.slice(":root".length);
  }
  if (sel === "html" || sel === "html:root") return HOST;
  if (sel === "body") return HOST + " body";
  if (sel.startsWith("html")) return HOST + sel.slice(4);
  return HOST + " " + sel;
}

function transform(src) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) { out += src.slice(i); break; }
    const head = src.slice(i, open);
    const headClean = stripComments(head).trim();

    let depth = 1, j = open + 1;
    while (j < src.length && depth > 0) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") depth--;
      j++;
    }
    const body = src.slice(open + 1, j - 1);

    if (/^@(media|supports|layer)/.test(headClean)) {
      out += headClean + " {" + transform(body) + "}\n";
    } else {
      const comments = [...head.matchAll(/\/\*[\s\S]*?\*\//g)].map((m) => m[0].trim());
      const scoped = splitTop(headClean).map(scopeOne).join(", ");
      if (comments.length) out += "\n" + comments.join("\n") + "\n";
      out += scoped + " {" + body + "}\n";
    }
    i = j;
  }
  return out;
}

let css = transform(raw);
css = css.replace(/url\(\s*["']?data:image\/webp;base64,[^)"']*["']?\s*\)/g, "var(--codedrobe-image-hero)");

// 提取 --heige-* 取值（仅用于日志确认四色未被改动）
const heige = {};
for (const m of raw.matchAll(/(--heige-[a-z-]+)\s*:\s*([^;]+);/g)) heige[m[1]] = m[2].trim();

const ADAPTER = `
/* ===== CodeDrobe 适配层（--theme-* 别名 + 深色声明） ===== */
${HOST} {
  color-scheme: dark !important;
  --theme-bg: var(--heige-surface);
  --theme-surface: color-mix(in srgb, var(--heige-surface) 92%, transparent);
  --theme-surface-strong: var(--heige-solid);
  --theme-sidebar: color-mix(in srgb, var(--heige-surface) 90%, transparent);
  --theme-text: var(--heige-text);
  --theme-muted: color-mix(in srgb, var(--heige-text) 66%, transparent);
  --theme-accent: var(--heige-accent);
  --theme-accent-soft: color-mix(in srgb, var(--heige-accent) 15%, transparent);
  --theme-border: var(--heige-line);
  --theme-shadow: color-mix(in srgb, #000 40%, transparent);
}

/* ===== 阅读增强（默认常开，取代 legacy 的 data-heige-readability 门槛） ===== */
${HOST} .cb-assistant-message > :not(:empty),
${HOST} .cr-agent__body:has(> .cr-agent__content:not(:empty)) {
  background: color-mix(in srgb, var(--heige-surface) 90%, transparent) !important;
}
`;

/*
 * 主题显示名：优先读 <主题目录>/theme.json 的 displayName，缺省用目录名。
 * 这样换主题不用改代码，也不会把某个主题的名字烧进源码。
 */
function themeDisplayName() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(THEME_DIR, "theme.json"), "utf8"));
    if (j && j.displayName) return String(j.displayName);
  } catch { /* 没写 theme.json 就用目录名 */ }
  return THEME_NAME;
}
const DISPLAY_NAME = themeDisplayName();

const HEADER = `/* ============================================================
   ${DISPLAY_NAME} — WorkBuddy 主题（CodeDrobe 规范化版）
   本文件由 tools/build-theme.mjs 自动生成，请勿手工编辑。
   源：themes/${THEME_NAME}/assets/legacy-skin-workbuddy.css
   重新生成：node tools/build-theme.mjs themes/${THEME_NAME}
   ============================================================ */
`;

fs.writeFileSync(OUT, HEADER + css.trim() + "\n" + ADAPTER, "utf8");

const check = fs.readFileSync(OUT, "utf8");
const heads = [...check.matchAll(/(^|\})\s*([^{}@]+?)\s*\{/g)]
  .map((m) => stripComments(m[2]).trim())
  .filter(Boolean);
const bad = heads.filter((h) => splitTop(h).some((x) => !x.startsWith(HOST)));

console.log("四色（--heige-*）：");
for (const k of ["--heige-accent", "--heige-secondary", "--heige-surface", "--heige-text"]) {
  console.log(`  ${k}: ${heige[k]}`);
}
console.log(`\n✅ 已生成 ${OUT}`);
console.log(`   体积 ${check.length}B ｜ 规则块 ${heads.length} ｜ 令牌 ${new Set([...check.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1])).size} 个`);
console.log(`   残留 data URL: ${(check.match(/data:image/g) || []).length}`);
console.log(`   未收敛选择器: ${bad.length ? "⚠️ " + bad.length : "✅ 无"}`);
if (bad.length) bad.slice(0, 5).forEach((s) => console.log("     " + s.slice(0, 120)));
