#!/usr/bin/env node
/**
 * skin-state.mjs — 皮肤层「记录态」的单一出处
 *
 * 为什么单独抽出来：换壁纸（命令行）和开机恢复（启动器）都要做同一件事——
 * 读 wallpapers/current.json → 算出三层 CSS → 注入页面。两处各写一份必然走样，
 * 所以记录格式、容错规则、注入顺序只在这里定义一次。
 *
 * 注入顺序约束（重要）：皮肤层必须在 CodeDrobe 的主题 style **之后**注入。
 * 两边的选择器同特异性，靠"谁在后谁生效"取胜；顺序反了玻璃层会被主题的
 * 90% 不透明底色压掉，表现为"壁纸看不见"。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSkinCss, applyWallpaperCss, SKIN_PRESETS, PRESET_ALIAS } from "./lib-cdp.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dir, "..");
export const LIB = path.join(ROOT, "wallpapers");
export const CURRENT = path.join(LIB, "current.json");
export const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
export const DEFAULT_PRESET = "medium";

export const PRESET_CN = { light: "淡", medium: "中", strong: "浓" };
export const PRESET_DESC = {
  light: "壁纸优先 · 最透",
  medium: "平衡 · 默认",
  strong: "可读优先 · 最实",
};

/** 壁纸库里的图片文件名（排序稳定，编号才不会漂） */
export function listWallpapers() {
  fs.mkdirSync(LIB, { recursive: true });
  return fs.readdirSync(LIB).filter((f) => IMG_RE.test(f)).sort();
}

/** 中文 / 英文档位名 → 内部键；非法返回 null */
export function normalizePreset(s) {
  if (!s) return null;
  const t = String(s).trim();
  return PRESET_ALIAS[t] || PRESET_ALIAS[t.toLowerCase()] || null;
}

/**
 * 读取记录态。
 * 容错原则：任何一项坏了都回落到默认值，绝不抛错——
 * 启动器读到一份坏 json 也必须能把 WorkBuddy 打开，不能因为皮肤而卡住启动。
 */
export function readSkinState() {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(CURRENT, "utf8")); } catch { raw = null; }

  const p = raw?.path && fs.existsSync(raw.path) ? raw.path : null;
  const preset = raw?.preset && SKIN_PRESETS[raw.preset] ? raw.preset : DEFAULT_PRESET;
  return {
    raw,
    path: p,
    preset,
    position: raw?.position || "center center",
    /** 用户主动关掉了皮肤（none 命令），启动器不要自作主张装回来 */
    enabled: !raw?.disabled,
    /** 记录里写了壁纸但文件没了 —— 需要在界面上提示，但不能当失败 */
    missingFile: !!(raw?.path && !p),
    /** 是否已有记录（无论启用与否） */
    configured: !!raw,
  };
}

/**
 * JSON 序列化，但把所有非 ASCII 字符转成 \uXXXX 转义，产出纯 ASCII 文件。
 *
 * 为什么非要多这一步：current.json 不只给 node 读，壁纸选择器界面（HTA）也要读它。
 * HTA 里只能靠 FSO 读文件，而 FSO 的 OpenTextFile 只认 ASCII 和 UTF-16，没有
 * UTF-8 选项 —— 壁纸文件名一带中文就读成乱码。实测后果不是"显示难看"这么轻：
 *   表头「当前壁纸」变成乱码 → FileExists(乱码路径) 失败 → 误报「文件已不存在」
 *   → 而且文件名比对不上，当前那张卡片也不再高亮。
 * 写成纯 ASCII 之后，无论谁用什么方式读都不会错，JSON.parse 照常认。
 */
function asciiJson(obj) {
  return JSON.stringify(obj, null, 2).replace(/[\u0080-\uffff]/g, (ch) =>
    "\\u" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")
  );
}

export function writeSkinState({ path: p, preset, position }) {
  fs.mkdirSync(LIB, { recursive: true });
  fs.writeFileSync(
    CURRENT,
    asciiJson({ path: p || null, preset, position, setAt: new Date().toISOString() }),
    "ascii"
  );
}

/**
 * 关闭皮肤。
 * 注意这里写的是"禁用标记"而不是删文件 —— 删了的话启动器下次就当成
 * "从未配置"并默认装回玻璃层，用户会看到"关了又自己回来"。
 */
export function disableSkin() {
  fs.mkdirSync(LIB, { recursive: true });
  fs.writeFileSync(
    CURRENT,
    asciiJson({ disabled: true, setAt: new Date().toISOString() }),
    "ascii"
  );
}

/** 由记录态算出三层 CSS（不含注入） */
export function skinCssFromState(state) {
  return buildSkinCss({
    imagePath: state.path,
    preset: state.preset,
    position: state.position,
  });
}

/**
 * 注入皮肤层。返回 { ok, css, ... }，**不抛错**。
 * 调用方（尤其是启动器）需要自己决定"注入失败算不算整体失败"——
 * 对启动器来说不算：皮肤是装饰，应用能开才是底线。
 */
export async function applySkinFromState(port, state = readSkinState()) {
  const css = skinCssFromState(state);
  try {
    await applyWallpaperCss(port, css);
    return { ok: true, css };
  } catch (e) {
    return { ok: false, css, why: e.message };
  }
}
