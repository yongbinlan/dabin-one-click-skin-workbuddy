#!/usr/bin/env node
/**
 * set-wallpaper.mjs — 自定义皮肤：换壁纸 + 调透出强度（秒级，不重新打包）
 *
 * 原理：主题的壁纸变量 --codedrobe-image-hero 定义在
 * `html.codedrobe-host-workbuddy #root` 上，而 renderer 是 file:// 协议、
 * 能直接加载本地图片。所以往页面注入一条规则即可换壁纸，无需 base64、
 * 无需重打包、无需重启。
 *
 * 注入的是三层（配方见 tools/lib-cdp.mjs 的 buildSkinCss）：
 *   ① 壁纸层  换图
 *   ② 薄纱层  重写 #root 的方向性遮罩，决定壁纸透出多少
 *   ③ 玻璃层  把挡住壁纸的结构容器改成半透明 + 毛玻璃
 * 三层共用一个"档位"，所以换壁纸和调观感都是一条命令。
 *
 * 用法：
 *   node tools/set-wallpaper.mjs                              列出壁纸库 + 当前档位
 *   node tools/set-wallpaper.mjs use <编号|文件路径> [档位]     换壁纸
 *   node tools/set-wallpaper.mjs add <图片路径> [档位]          收图进库并启用（库里已有的图一张不动）
 *   node tools/set-wallpaper.mjs prune                         可选：清库用，只留当前那张，其余移到归档目录
 *   node tools/set-wallpaper.mjs intensity <淡|中|浓>           只调透出强度
 *   node tools/set-wallpaper.mjs css                           打印将注入的 CSS
 *   node tools/set-wallpaper.mjs none                          撤掉皮肤层，回到主题原样
 *
 * 档位：淡（壁纸优先，最透）/ 中（默认，平衡）/ 浓（可读优先，最实）
 * 退出码：0 成功 ｜ 2 参数错 ｜ 3 CDP 不可达（已记录，下次启动自动生效）｜ 4 自检异常
 */
import fs from "node:fs";
import path from "node:path";
import {
  ROOT, LIB, CURRENT, IMG_RE, PRESET_CN, PRESET_DESC,
  listWallpapers, normalizePreset, readSkinState, writeSkinState, disableSkin,
  skinCssFromState,
} from "./skin-state.mjs";
import { applyWallpaperCss, removeWallpaperLayer, readWallpaperState, SKIN_PRESETS } from "./lib-cdp.mjs";

const PORT = Number(process.env.SKIN_PORT || 9342);
const [, , cmd, ...rest] = process.argv;
const args = rest.filter((a) => a && !a.startsWith("--"));

const hr = () => console.log("-".repeat(64));

/** 尽力注入；拿不到 CDP 不算失败（下次启动会自动注入） */
async function tryInject(cssText) {
  try {
    const r = await applyWallpaperCss(PORT, cssText);
    const state = await readWallpaperState(PORT);
    return { injected: true, result: r, state };
  } catch (e) {
    return { injected: false, why: e.message };
  }
}

/**
 * 统一出口：换图与调档位都走这里重算整条皮肤层。
 * 保证"文件记录"和"页面实际"永远一致，不会只改一半。
 */
async function applyState({ path: imagePath, preset, position }, { quiet = false } = {}) {
  const css = skinCssFromState({ path: imagePath, preset, position });
  writeSkinState({ path: imagePath, preset, position });

  if (!quiet) {
    console.log(imagePath ? `壁纸：${imagePath}` : "壁纸：（主题自带）");
    console.log(`档位：${PRESET_CN[preset]}(${preset})（${PRESET_DESC[preset] || ""}）`);
  }

  const r = await tryInject(css);
  if (!r.injected) {
    console.log("⚠️ 本次未能即时生效（CDP 不可达）：" + r.why);
    console.log("   已记录到 current.json，下次启动 WorkBuddy 时会自动应用。");
    process.exit(3);
  }

  console.log("已注入并生效 ✅");
  const s = r.state;
  console.log("  生效变量：" + s.heroVarHead.slice(0, 80));
  console.log(`  玻璃层：glass=${s.preset.glass}  rootX=${s.preset.rootX}  blur=${s.preset.blur}`);
  console.log(`  对话区实测：bg=${s.agentBodyBg}  blur=${s.agentBodyBlur}`);

  // 自检三条断言：任一不过就报异常 —— 不允许把"注入成功"当"观感正确"
  const problems = [];
  if (imagePath && !s.heroVarIsFile) problems.push("壁纸变量不是 file:// 路径");
  if (s.preset.glass === "(unset)") problems.push("档位变量未生效（--wb-skin-glass 为空）");
  if (/\s\/\s*1\)$/.test(s.agentBodyBg)) problems.push("对话区仍完全不透明（玻璃层没压过去）");
  const strays = s.strayStyles.filter((x) => x !== "workbuddy-skin-wallpaper");
  if (strays.length) problems.push(`发现重复注入层：${strays.join(", ")}`);

  if (problems.length) {
    console.log("⚠️ 自检异常：");
    problems.forEach((p) => console.log("   · " + p));
    console.log("   排查：node tools/diag-occluders.mjs 30000 0.5");
    process.exit(4);
  }
  console.log("  自检：3/3 通过");
  return s;
}

// ---------------- 列出 ----------------
function doList() {
  const files = listWallpapers();
  const st = readSkinState();
  const curBase = st.path ? path.basename(st.path) : null;

  console.log("壁纸库：" + LIB);
  hr();
  if (!files.length) {
    console.log("  (空) —— 把图片放进上面的目录，或用 `add` 命令收图进来");
  } else {
    files.forEach((f, i) => {
      const s = fs.statSync(path.join(LIB, f));
      const mark = f === curBase ? "  ← 当前" : "";
      console.log(`  [${i + 1}] ${f}   ${(s.size / 1024).toFixed(0)}KB${mark}`);
    });
  }
  hr();
  if (!st.enabled) {
    console.log("当前状态：已关闭 —— 皮肤层未启用，界面为主题原样");
    console.log("  恢复：node tools/set-wallpaper.mjs intensity 中");
  } else if (st.missingFile) {
    console.log(`⚠️ 记录的壁纸文件已不存在：${st.raw.path}`);
    console.log("   （启动器会跳过换图，界面回落到主题自带壁纸；玻璃层照常生效）");
  } else if (st.path) {
    console.log(`当前壁纸：${path.basename(st.path)}`);
  } else {
    console.log("当前壁纸：（未设置，使用主题自带的夜街壁纸）");
  }
  if (st.enabled) {
    console.log(`当前档位：${PRESET_CN[st.preset]}(${st.preset})（${PRESET_DESC[st.preset]}）`);
  }
  if (st.raw?.setAt) console.log(`设置时间：${st.raw.setAt}`);
  hr();
  console.log("档位对照（数字越小壁纸越透）：");
  for (const k of ["light", "medium", "strong"]) {
    const p = SKIN_PRESETS[k];
    console.log(`  ${PRESET_CN[k]}(${k.padEnd(6)})  遮罩 ${p.rootX}%/${p.rootY}%  结构面 ${p.glass}%  内容面 ${p.content}%  毛玻璃 ${p.blur}px`);
  }
  console.log("");
  console.log("用法：");
  console.log("  node tools/set-wallpaper.mjs use 2             # 按编号换壁纸");
  console.log("  node tools/set-wallpaper.mjs use 2 浓          # 换壁纸 + 用「浓」档");
  console.log("  node tools/set-wallpaper.mjs intensity 淡      # 只调透出强度");
  console.log("  node tools/set-wallpaper.mjs add D:\\图\\壁纸.jpg  # 收图进库并启用");
  console.log("  node tools/set-wallpaper.mjs prune             # 只留当前这张，清掉库里其他图");
  console.log("  node tools/set-wallpaper.mjs none              # 撤掉皮肤层，回到主题原样");
}

// ---------------- 换壁纸 ----------------
async function doUse(target, presetArg) {
  if (!target) { console.error("✗ 缺少参数：use <编号|文件路径> [档位]"); process.exit(2); }

  let filePath;
  if (/^\d+$/.test(target)) {
    const files = listWallpapers();
    const i = Number(target) - 1;
    if (!files[i]) { console.error(`✗ 编号 ${target} 越界（库里有 ${files.length} 张）`); process.exit(2); }
    filePath = path.join(LIB, files[i]);
  } else {
    filePath = path.isAbsolute(target) ? target : path.resolve(LIB, target);
  }

  if (!fs.existsSync(filePath)) { console.error(`✗ 文件不存在：${filePath}`); process.exit(2); }
  if (!IMG_RE.test(filePath)) { console.error(`✗ 不是支持的图片格式（jpg/png/webp/gif/bmp/avif）：${path.basename(filePath)}`); process.exit(2); }

  const st = readSkinState();
  let preset = st.preset;
  if (presetArg) {
    const p = normalizePreset(presetArg);
    if (!p) { console.error(`✗ 未知档位：${presetArg}（可用：淡 / 中 / 浓）`); process.exit(2); }
    preset = p;
  }
  await applyState({ path: filePath, preset, position: st.position });
}

// ---------------- 只调档位 ----------------
async function doIntensity(presetArg) {
  if (!presetArg) { console.error("✗ 缺少参数：intensity <淡|中|浓>"); process.exit(2); }
  const p = normalizePreset(presetArg);
  if (!p) { console.error(`✗ 未知档位：${presetArg}（可用：淡 / 中 / 浓）`); process.exit(2); }
  const st = readSkinState();
  await applyState({ path: st.path, preset: p, position: st.position });
}

// ---------------- 收图进库 ----------------
/**
 * 两个文件内容是否相同。先比大小再比字节 —— 壁纸都是小文件，全量比最快也最准。
 *
 * 为什么要这一步：界面上的「选图 / 拖图」会对同一张外部图片反复调用 add。
 * 原来的实现只看「目标名是否已存在」，于是每次选同一张图都会生成
 * `名字-2.jpg`、`名字-3.jpg`…… 壁纸库无上限地膨胀，而且用户完全没做错什么。
 * 内容一致就直接复用已有文件，选一百次也只留一份。
 */
function sameBytes(a, b) {
  try {
    if (fs.statSync(a).size !== fs.statSync(b).size) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch { return false; }
}

async function doAdd(src, presetArg) {
  if (!src) { console.error("✗ 缺少参数：add <图片路径> [档位]"); process.exit(2); }
  const srcPath = path.isAbsolute(src) ? src : path.resolve(process.cwd(), src);
  if (!fs.existsSync(srcPath)) { console.error(`✗ 文件不存在：${srcPath}`); process.exit(2); }
  if (!IMG_RE.test(srcPath)) { console.error(`✗ 不是支持的图片格式：${path.basename(srcPath)}`); process.exit(2); }

  const name = path.basename(srcPath);
  let dst = path.join(LIB, name);
  if (path.resolve(dst) === path.resolve(srcPath)) {
    console.log("（源文件已在壁纸库中，直接启用）");
  } else if (fs.existsSync(dst) && sameBytes(srcPath, dst)) {
    console.log(`（壁纸库里已有内容相同的图，直接启用：${name}）`);
  } else {
    let n = 1;
    while (fs.existsSync(dst)) {
      const ext = path.extname(name);
      dst = path.join(LIB, `${path.basename(name, ext)}-${++n}${ext}`);
    }
    fs.copyFileSync(srcPath, dst);
    console.log(`已收入壁纸库：${dst}`);
  }
  await doUse(dst, presetArg);

  /*
   * 【这里千万不要加「自动清理库里其他图」】
   *
   * 曾经加过（一度默认只留当前这张），但那是把用户的诉求理解错了：
   * 用户说的「其他的不用保留」，指的是**浏览文件夹里列出来的那些图**
   * （那些只是预览，不该被收进来），而不是壁纸库里已经有的图。
   * 用户随后纠正：「之前选择的壁纸也要保留在壁纸库里」。
   *
   * 壁纸库是用户一张张攒下来的收藏。收新图时，旧图**一张都不能动**。
   * 确实要清理时，只能由用户显式跑 prune —— 绝不默认执行。
   */
}

// ---------------- 只留当前那张 ----------------
/**
 * 归档目录：移走的图放这里，而不是删掉。
 * 用户的诉求是「库变干净」，不是「销毁数据」—— 留一份可恢复的，
 * 之后想换回去、或者想攒几张轮换，都还有救。删除不可逆，这里不用。
 *
 * 位置就挨着壁纸库本身（<根>\wallpapers-archive）。
 * 早先放在 docs\legacy-assets\ 下面 —— 那是放文档素材的地方，
 * 把运行期归档塞进去，看目录的人会以为它是个历史遗留物，不敢碰。
 */
const ARCHIVE = path.join(ROOT, "wallpapers-archive");

/**
 * 把壁纸库里除 keepBase 之外的图都移到归档目录，返回被移走的文件名。
 * 「移走」而不是「删除」：这个动作的诉求是「库变干净」，不是「销毁数据」。
 * 放进归档目录后，想换回去、或者以后想攒几张轮换，都还有救。
 */
function pruneOld(keepBase) {
  const move = listWallpapers().filter((f) => f !== keepBase);
  if (!move.length) return [];
  fs.mkdirSync(ARCHIVE, { recursive: true });
  for (const f of move) {
    let dst = path.join(ARCHIVE, f);
    // 归档目录里撞名就加时间戳，绝不覆盖已有的归档
    if (fs.existsSync(dst)) {
      const ext = path.extname(f);
      dst = path.join(ARCHIVE, `${path.basename(f, ext)}-${Date.now()}${ext}`);
    }
    fs.renameSync(path.join(LIB, f), dst);
  }
  return move;
}

/**
 * 只保留当前在用的那一张，其余移走。
 * 原话：「我只需要保留我选的那张就可以了，其他的不用保留」。
 */
function doPrune() {
  const files = listWallpapers();
  if (!files.length) { console.log("壁纸库是空的，没什么可清理的。"); return; }

  const st = readSkinState();
  const curBase = st.path ? path.basename(st.path) : null;

  /*
   * 当前壁纸认不出来时一律不动手。
   * 那种情况下「该保留哪一个」根本没有答案，硬跑会把整个库搬空 ——
   * 这类误伤比「没清理干净」严重得多，所以宁可报错退出。
   */
  if (!curBase || files.indexOf(curBase) < 0) {
    console.log("⚠️ 没找到当前在用的那张壁纸，未做任何改动。");
    if (curBase) console.log(`   记录里是「${curBase}」，但它已经不在壁纸库里了。`);
    else console.log("   当前没有设置壁纸（用的是主题自带的那张）。");
    console.log("   想清空壁纸库：先用 use <编号> 指定一张要留的，再跑 prune。");
    process.exit(2);
  }

  const moved = pruneOld(curBase);
  console.log("壁纸库清理 —— 只保留当前在用的那一张");
  hr();
  console.log("  保留：" + curBase);
  if (!moved.length) {
    console.log("  没有别的图需要清理，库已经是干净的。");
    hr();
    return;
  }
  moved.forEach((f) => console.log("  移走：" + f));
  hr();
  const left = listWallpapers();
  console.log(`壁纸库现在（${left.length} 张）：${left.join(" | ") || "(空)"}`);
  console.log("移走的图在：" + ARCHIVE);
  console.log("（是「移走」不是「删除」—— 想换回去，把文件拷回壁纸库目录即可）");
}

// ---------------- 打印 CSS（排查用） ----------------
function doCss() {
  console.log(skinCssFromState(readSkinState()));
}

// ---------------- 撤掉皮肤层 ----------------
async function doNone() {
  const had = fs.existsSync(CURRENT);
  disableSkin();
  try {
    const r = await removeWallpaperLayer(PORT);
    const state = await readWallpaperState(PORT);
    const leftovers = state.strayStyles.filter((x) => x !== "workbuddy-skin-wallpaper");
    console.log(`已撤掉皮肤层（removed=${r.removed}），回到主题原样`);
    console.log(`  残留注入层：${leftovers.length} 个${leftovers.length ? "（" + leftovers.join(", ") + "）" : " ✅"}`);
    console.log("  对话区实测：bg=" + state.agentBodyBg);
    console.log("  提示：下次启动不会自动装回来；想恢复用 `use <编号>` 或 `intensity 中`。");
  } catch (e) {
    console.log("⚠️ 未能即时撤掉（CDP 不可达）：" + e.message);
    console.log(`   已写入禁用标记（${had ? "原有记录已被覆盖" : "原本就没有记录"}），下次启动会回落到主题原样。`);
  }
}

// ---------------- 分发 ----------------
switch (cmd) {
  case undefined:
  case "list":
    doList();
    break;
  case "use":
    await doUse(args[0], args[1]);
    break;
  case "add":
    await doAdd(args[0], args[1]);
    break;
  case "intensity":
    await doIntensity(args[0]);
    break;
  case "prune":
    doPrune();
    break;
  case "css":
    doCss();
    break;
  case "none":
    await doNone();
    break;
  default:
    console.error(`✗ 未知命令：${cmd}`);
    console.error("可用：list | use <编号|路径> [档位] | add <路径> [档位] | prune | intensity <淡|中|浓> | css | none");
    process.exit(2);
}
