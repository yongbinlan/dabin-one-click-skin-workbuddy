#!/usr/bin/env node
/**
 * check-publish.mjs — 公开仓库「发布前」自检
 *
 * 检查对象是 **HEAD 里已提交的字节**，不是工作区 —— 因为发布出去的是前者。
 * 所以用法是：先 commit，再跑本脚本，绿了才 push。
 *
 * 为什么需要它：这个仓库有几个特点让「人肉检查」必然漏 ——
 *
 *   1. 编码与行尾是**产物正确性**的一部分，不是风格问题，而它们只在字节层可见。
 *      中文看着完全正常，`.cmd` 缺 0x0D 也看不出来。
 *   2. 文档里写着一堆**数字**（N 项自检、N 个文件），数字会随代码漂移，
 *      而没有任何东西会因此报错。实测漂过一次：文档写 14 项、实际 12 项，
 *      漂了很久没人发现 —— 直到把这类判断交给脚本。
 *   3. 私有信息（本机目录结构、凭据）混进来以后页面渲染完全正常，肉眼绝对看不出。
 *
 * **未经验证的断言等于没有断言** —— 这个脚本本身就是这句话的产物。
 *
 * 用法（仓库根目录）：
 *   node scripts/check-publish.mjs
 *   node scripts/check-publish.mjs --worktree    改查工作区（提交前自检用）
 *
 * 退出码：0 = 通过（可能带警告），1 = 有失败项
 * 除 `git` 外无外部依赖，可在 CI 里跑。
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USE_WORKTREE = process.argv.includes("--worktree");
const SOURCE = USE_WORKTREE ? "工作区" : "HEAD";

const pass = [], fail = [], warn = [];
const ok = (m) => { console.log("✅ " + m); pass.push(m); };
const no = (m) => { console.log("❌ " + m); fail.push(m); };
const hm = (m) => { console.log("⚠️  " + m); warn.push(m); };

function git(...args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${(r.stderr || "").trim()}`);
  return r.stdout;
}

let HEAD_BLOBS = new Map();   // rel -> blob sha
try {
  for (const line of git("ls-tree", "-r", "-z", "HEAD").split("\0").filter(Boolean)) {
    const m = line.match(/^[0-9]+ blob ([0-9a-f]+)\t([\s\S]+)$/);
    if (m) HEAD_BLOBS.set(m[2], m[1]);
  }
} catch { /* 还没有 HEAD（首次提交前） */ }

/** 取「要发布的字节」：默认来自 HEAD，--worktree 时取磁盘 */
function readBytes(rel) {
  if (USE_WORKTREE || !HEAD_BLOBS.has(rel)) return fs.readFileSync(path.join(ROOT, rel));
  const r = spawnSync("git", ["cat-file", "blob", HEAD_BLOBS.get(rel)],
    { cwd: ROOT, maxBuffer: 1 << 28 });
  if (r.status !== 0) return fs.readFileSync(path.join(ROOT, rel));
  return r.stdout;
}

const isBinary = (rel) => /\.(jpe?g|png|webp|ico|lnk)$/i.test(rel);
function readText(rel) {
  const bytes = readBytes(rel);
  for (const enc of ["utf8", "gbk"]) {
    try {
      // 必须用 TextDecoder：Buffer.toString 只认 node 内置的几个编码，不认 gbk
      const text = new TextDecoder(enc, { fatal: true }).decode(bytes);
      return { text, bytes };
    } catch { /* 换下一个编码 */ }
  }
  return { text: null, bytes };
}

const tracked = git("ls-files", "-z").split("\0").filter(Boolean);

console.log(`仓库：${ROOT}`);
console.log(`检查对象：${SOURCE} 里的 ${tracked.length} 个已跟踪文件\n`);

// ---------- 0) 先报「工作区有哪些还没提交」 ----------
// 不是为了拦截，而是为了提醒：本脚本查的是 HEAD，未提交的改动它看不见。
if (!USE_WORKTREE) {
  const dirty = git("status", "--porcelain", "-z").split("\0").filter(Boolean);
  if (dirty.length) hm(`工作区有 ${dirty.length} 项未提交，本次不参与检查：${dirty.map((d) => d.slice(3)).join(" / ")}`);
  const notInHead = tracked.filter((f) => !HEAD_BLOBS.has(f));
  if (notInHead.length) hm(`尚未进入 HEAD 的已跟踪文件：${notInHead.join(" / ")}`);
}

// ---------- 1) 字节级回环：HEAD 里存的字节 == 磁盘上的字节 ----------
// 治的是 `.gitattributes` 失效：一旦被行尾转换盯上，`.cmd` 会以 LF 存进仓库，
// CLONE 下来双击就是满屏「不是内部或外部命令」，而中文看着完全正常。
{
  const bad = [], drift = [];
  for (const rel of tracked) {
    if (!HEAD_BLOBS.has(rel)) continue;
    const a = readBytes(rel), b = fs.readFileSync(path.join(ROOT, rel));
    if (a.equals(b)) continue;
    // 区分「只是改过没提交」和「字节被规范化过」：
    // 归一化会成片地改行尾，所以看两边行尾画像是否不同。
    const prof = (x) => {
      let crlf = 0, lf = 0;
      for (let i = 0; i < x.length; i++) if (x[i] === 10) { if (i && x[i - 1] === 13) crlf++; else lf++; }
      return `${crlf}/${lf}`;
    };
    const [pa, pb] = [prof(a), prof(b)];
    (/\.(cmd|ps1|vbs)$/i.test(rel) && pa !== pb ? bad : drift)
      .push(`${rel}（HEAD ${pa} vs 磁盘 ${pb}）`);
  }
  if (bad.length) no(`行尾被规范化过 —— clone 下来会坏：${bad.join(" / ")}`);
  else ok(`行尾与字节回环正常（${HEAD_BLOBS.size} 个文件）`);
  if (drift.length) hm(`与 HEAD 内容不同（若刚改过就是正常的）：${drift.join(" / ")}`);
}

// ---------- 2) 编码：按宿主解析规则逐类判 ----------
{
  const bad = [];
  let cmdN = 0, scriptN = 0;

  for (const rel of tracked) {
    const b = readBytes(rel);
    const bom = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
    // BOM 自身三个字节都 > 127，必须先判出 BOM 再跳过它计数。
    // 否则「纯 ASCII 却带 BOM」会被算成「有非 ASCII」，两个分支都不命中、静默放过。
    let nonAscii = 0;
    for (let i = bom ? 3 : 0; i < b.length; i++) if (b[i] > 127) nonAscii++;

    if (/\.cmd$/i.test(rel)) {
      cmdN++;
      let bare = 0;
      for (let i = 0; i < b.length; i++) if (b[i] === 10 && (i === 0 || b[i - 1] !== 13)) bare++;
      if (bare) bad.push(`${rel}（裸 LF ${bare} 处 → 双击报「不是内部或外部命令」）`);
      if (bom) bad.push(`${rel}（有 BOM）`);
      if (nonAscii) {
        // cmd.exe 按 OEM 码页读，UTF-8 的中文会满屏乱码 —— 含非 ASCII 就必须是 GBK
        let utf8Ok = true;
        try { new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(3)); } catch { utf8Ok = false; }
        if (utf8Ok) bad.push(`${rel}（是 UTF-8，应为 GBK）`);
      }
    } else if (/\.(vbs|ps1)$/i.test(rel)) {
      scriptN++;
      // 两个宿主对 BOM 的判定方向相反：
      //   .vbs —— wscript 对无 BOM 文件按 ANSI 读，含非 ASCII 会炸或弹阻塞框 → 必须纯 ASCII 且无 BOM
      //   .ps1 —— 有 BOM 按 UTF-8、无 BOM 按 ANSI → 真正会出事的是「含非 ASCII 却没 BOM」
      if (/\.vbs$/i.test(rel)) {
        if (nonAscii) bad.push(`${rel}（非 ASCII ${nonAscii} 处 → wscript 会炸/弹阻塞框）`);
        if (bom) bad.push(`${rel}（有 BOM）`);
      } else {
        if (nonAscii && !bom) bad.push(`${rel}（非 ASCII ${nonAscii} 处却没 BOM → 按 GBK 解会乱码）`);
        if (!nonAscii && bom) bad.push(`${rel}（纯 ASCII 却带 BOM → 被工具重新编码过，去掉）`);
      }
    }
  }
  bad.length === 0
    ? ok(`编码与行尾正确（${cmdN} 个 .cmd + ${scriptN} 个 .vbs/.ps1）`)
    : no(`编码/行尾 ${bad.length} 处问题：\n     ` + bad.join("\n     "));
}

// ---------- 3) 私有信息 ----------
{
  // 只匹配真实的用户目录与已知私有根。
  // 文档里的 `D:\my\workbuddy-skin` 这类是**示例路径**，无害，不能误报。
  const pats = [
    [/[A-Za-z]:\\Users\\[^\\\s"'`]+/g, "本机用户目录路径"],
    [/[A-Za-z]:\\WorkBuddy\\[^\\\s"'`]+/g, "私有工作目录路径"],
    [/sk-[A-Za-z0-9]{16,}/g, "疑似 OpenAI key"],
    [/gh[pous]_[A-Za-z0-9]{20,}/g, "疑似 GitHub token"],
    [/\b(?:api[_-]?key|secret|passwd|password)\b\s*[:=]\s*["'][^"']{12,}["']/gi, "疑似硬编码凭据"],
  ];
  const hits = [];
  for (const rel of tracked) {
    if (isBinary(rel)) continue;
    const { text } = readText(rel);
    if (text === null) { no(`${rel} 既不是 UTF-8 也不是 GBK，编码未知`); continue; }
    const lines = text.split(/\r?\n/);
    for (const [re, name] of pats) {
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        const m = lines[i].match(re);
        if (m) hits.push(`${rel}:${i + 1} ${name} → ${m[0].slice(0, 60)}`);
      }
    }
  }
  hits.length === 0
    ? ok("未发现私有路径 / 凭据")
    : no(`发现 ${hits.length} 处私有信息（仓库是 PUBLIC）：\n     ` + hits.join("\n     "));
}

// ---------- 4) 文档里的数字必须与代码事实一致 ----------
// 这类错误最阴：页面渲染完全正常，只有真去数一遍才会发现。
{
  const vmPath = "template/tools/verify-launcher.mjs";
  let expected = null;

  if (tracked.includes(vmPath)) {
    const vm = readText(vmPath).text || "";
    // 以文件头部那段 ` *   N) ...` 清单为「项数」的唯一权威来源
    const listed = [...vm.matchAll(/^ \* +(\d+)\)/gm)].map((m) => m[1]);
    expected = listed.length;
    const guarded = new Set([...vm.matchAll(/want\((\d+)\)/g)].map((m) => m[1]));
    const missing = listed.filter((n) => !guarded.has(n));
    missing.length
      ? no(`自检第 ${missing.join(", ")} 项缺 want() 守卫 → --only 时会静默漏跑`)
      : ok(`自检 ${expected} 项，且都有 --only 守卫`);
  }

  const md = tracked.filter((f) => /\.(md|txt|mjs|js|json|css|ya?ml)$/i.test(f) && !isBinary(f));
  const nums = [];
  for (const rel of md) {
    // 代码文件里跳过注释行：真实声明只会写在**字符串字面量**里
    // （例如 init.mjs 那句 console.log("……（N 项自检）")）。
    // 注释里出现的数字是**在描述这件事**，不是声明 ——
    // 不加这条，这个检查器会把自己的解释性注释判成违规。
    const isCode = /\.(mjs|js|json|css|ya?ml)$/i.test(rel);
    const lines = (readText(rel).text || "").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (isCode && /^\s*(\/\/|\/\*|\*|#|<!--)/.test(line)) return;
      // 措辞要枚举全 —— 这个检查器第一版只认「项自检」，于是漏掉了
      // 安装说明文件里的「项断言」写法和 init.mjs 里的那句提示：
      // 前者是措辞没覆盖，后者是**文件类型没覆盖**（原来只扫 *.md）。
      // 教训：扫描类门禁的失效方式不是"判错"，而是"根本没扫到"。
      for (const m of line.matchAll(/(\d+)\s*项(?:自检|全绿|断言)|覆盖\s*(\d+)\s*项/g))
        nums.push({ rel, line: i + 1, n: +(m[1] || m[2]) });
    });
  }
  if (expected === null) hm("找不到 verify-launcher.mjs，跳过项数核对");
  else {
    const wrong = nums.filter((d) => d.n !== expected);
    wrong.length === 0
      ? ok(`文档「N 项自检」与事实一致（${expected} 项，${nums.length} 处引用）`)
      : no(`文档项数不符（实际 ${expected} 项）：` +
           wrong.map((d) => `${d.rel}:${d.line} 写着 ${d.n} 项`).join(" / "));
    if (nums.length === 0) hm("文档里没有「N 项自检」表述 —— 若是有意省略，忽略");
  }

  // template/ 展开的文件数（README 承诺过「35 个文件」）
  const tplCount = tracked.filter((f) => f.startsWith("template/")).length;
  const claimed = [];
  for (const rel of md) {
    const lines = (readText(rel).text || "").split(/\r?\n/);
    lines.forEach((line, i) => {
      // 只认「展开工程 —— ... N 个文件」「已剔除本机专属项」这类 template 语境，
      // 免得把别处的「3 个文件」也拖进来误报
      if (!/\u5c55\u5f00|\u5de5\u7a0b\u6a21\u677f|\u5df2\u5254\u9664/.test(line)) return;
      for (const m of line.matchAll(/(\d+)\s*个文件/g)) claimed.push({ rel, line: i + 1, n: +m[1] });
    });
  }
  const badCount = claimed.filter((c) => c.n !== tplCount);
  if (claimed.length === 0) hm("文档里没有「展开 N 个文件」表述");
  else if (badCount.length)
    no(`template/ 实际 ${tplCount} 个文件，文档写着：` +
       badCount.map((c) => `${c.rel}:${c.line} 写着 ${c.n}`).join(" / "));
  else ok(`template/ 文件数与文档一致（${tplCount} 个，${claimed.length} 处引用）`);
}

// ---------- 5) 展示图 ----------
{
  const imgs = tracked.filter((f) => /^docs\/.+\.(jpe?g|png)$/i.test(f));
  if (imgs.length === 0) no("docs/ 下没有展示图 —— README 引用的图会 404");
  else {
    const tiny = imgs.filter((f) => readBytes(f).length < 4096);
    tiny.length
      ? no(`展示图过小，可能是空图：${tiny.join(" / ")}`)
      : ok(`${imgs.length} 张展示图均在位（脱敏质量需人工复核，脚本只判存在与非空）`);
  }
}

// ---------- 6) 根目录必备文件 ----------
{
  const need = ["README.md", "LICENSE", ".gitattributes", ".gitignore"];
  const miss = need.filter((f) => !tracked.includes(f));
  miss.length === 0
    ? ok(`根目录必备文件齐全（${need.join(" / ")}）`)
    : hm(`根目录缺：${miss.join(" / ")}` +
         (miss.includes("LICENSE") ? " —— PUBLIC 仓库没许可证等于「保留所有权利」" : ""));
  if (tracked.includes("LICENSE") && !tracked.includes("NOTICE"))
    hm("有 LICENSE 但没有 NOTICE —— 若上游要求保留署名声明，需要补");
}

// ---------- 7) 文档里引用的 GitHub 仓库 / 账号是否真的存在 ----------
// 治一次真实事故：文档里把上游地址写成 `https://github.com/codedrobe`。
// 这类错字**页面渲染完全正常**，只有真去点才会发现；
// 更糟的是它会被复制到别处（那次就扩散到了 skill 索引与另一份参考表）。
//
// **必须同时管两种写法**：`github.com/<org>/<repo>`（两段）和
// `github.com/<org>`（一段，裸组织名）。第一版只写了前者，
// 于是正好漏掉本次那个真实故障 —— 一段式恰恰更阴险，
// 因为它连"到底指到哪个仓库"都没写清楚。
//
// 关于那次事故，有一条**我一开始判断错了、后来实测纠正**的细节，记在这里
// 免得后人重蹈：`codedrobe` 这个组织**是真实存在的**（`users/codedrobe`
// 返回 200），所以它**不是 404**，而是"可达但没指到该指的东西" ——
// 上游仓库是 `CodeDrobe/core`，不是 `codedrobe`。顺带记两条 GitHub 行为：
//   - 大小写不敏感：`repos/codedrobe/core` 与 `repos/CodeDrobe/core` 都是 200，
//     只是后者才是人类可读的规范写法；
//   - 因此"404 才是错"这个判据太窄 —— 一段式裸组织名要单独判，见下方 bare。
//
// 要联网，所以拿不到网络时**跳过而非判失败** —— 别把离线环境变成假红灯。
{
  const LINK = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)(?:\/([A-Za-z0-9_.-]+))?/g;
  // GitHub 自己的功能路径，不是用户/组织
  const NOT_USER = new Set(["orgs", "features", "about", "settings", "sponsors",
                            "marketplace", "topics", "collections", "apps", "contact",
                            "login", "join", "pricing", "explore", "trending", "new",
                            "codespaces", "enterprise", "security", "site", "readme"]);
  const found = new Map();   // "users/x" 或 "repos/x/y" -> ["文件:行", ...]
  const why = new Map();
  const bare = new Set();    // 一段式（裸组织名）—— 单独判，见下方
  for (const rel of tracked) {
    if (isBinary(rel)) continue;
    const text = readText(rel).text;
    if (text === null) continue;
    // 代码文件里跳过注释行 —— 与第 4 项同一条规矩，理由也相同：
    // 本文件开头那段注释**正是在举例说明这个坏链接**，不跳过的话
    // 它会变成一条永久噪音（`codedrobe（只有组织名…）`），而噪音会掩盖真正的红灯。
    const isCode = /\.(mjs|js|ts|json|css|ya?ml)$/i.test(rel);
    text.split(/\r?\n/).forEach((line, i) => {
      if (isCode && /^\s*(\/\/|\/\*|\*|#|<!--)/.test(line)) return;
      for (const m of line.matchAll(LINK)) {
        if (NOT_USER.has(m[1].toLowerCase())) continue;
        const api = m[2] ? `repos/${m[1]}/${m[2]}` : `users/${m[1]}`;
        const shown = m[2] ? `${m[1]}/${m[2]}` : `${m[1]}（只有组织名，没指到具体仓库）`;
        if (!found.has(api)) { found.set(api, []); why.set(api, shown); }
        found.get(api).push(`${rel}:${i + 1}`);
        if (!m[2]) bare.add(why.get(api));
      }
    });
  }

  const dead = [], unknown = [];
  for (const [api, wheres] of found) {
    try {
      const res = await fetch(`https://api.github.com/${api}`, {
        headers: { "User-Agent": "check-publish", Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(15000),
      });
      if (res.status === 200) continue;
      if (res.status === 404) { dead.push(`${why.get(api)}（${wheres[0]}）`); continue; }
      unknown.push(why.get(api));   // 403 限流 / 5xx —— 判不了，不冤枉它
    } catch { unknown.push(why.get(api)); }
  }

  if (found.size === 0) hm("文档里没有 GitHub 链接");
  else if (dead.length) no(`文档引用的 GitHub 目标不存在（点进去 404）：${dead.join(" / ")}`);
  else if (bare.size) hm(`文档里有只写到组织名的链接（能打开，但落到组织首页，读者找不到具体仓库）：${[...bare].join(" / ")}`);
  else if (unknown.length) hm(`外链可达性未完全确认（限流或离线）：${unknown.join(" / ")}`);
  else ok(`文档引用的 ${found.size} 个 GitHub 目标均可达且指到了具体仓库（${[...why.values()].join(" / ")}）`);
}

console.log("\n================ 结果 ================");
console.log(`通过 ${pass.length} ｜ 警告 ${warn.length} ｜ 失败 ${fail.length}`);
if (fail.length) {
  fail.forEach((f) => console.log("  ❌ " + f.split("\n")[0]));
  process.exit(1);
}
console.log(warn.length ? "通过（有警告，见上）" : "全部通过");
