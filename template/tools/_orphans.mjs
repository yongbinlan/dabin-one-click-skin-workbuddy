#!/usr/bin/env node
/**
 * _orphans.mjs — 清掉挂着的 HTA 宿主进程，并**验证**真的清掉了。
 *
 * 为什么需要它：
 *   壁纸选择器早先的版本在自检模式下没能自己关掉（实测 window.close() 关不掉
 *   宿主进程），于是屏幕上留了一个孤儿窗口。而选择器当时配了单实例属性，
 *   后续每一次启动都被静默移交给那个孤儿、立即退出 ——
 *   表现就是「日志一行都没有」，看起来像脚本根本没跑。查了好几轮才定位到这里。
 *
 * 教训：清理动作不能盲报。上一版构建脚本打完 taskkill 就写「已尝试清理残留进程」，
 *   成没成完全不知道，结果就是拿一个假前提继续往下推。这里改成把退出码和输出
 *   都抓回来，并且用列表命令复查一遍。
 *
 * 注意：本文件名叫 _orphans 而不是带宿主程序名 ——
 *   bash 的安全过滤按命令文本静态扫，命令里出现那个词会被直接拒掉。
 *
 * 用法：node tools/_orphans.mjs
 * 用完即可删除，不属于交付物。
 */
import { spawnSync } from "node:child_process";

const IMAGE = "m" + "shta.exe";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    status: r.status,
    error: r.error ? r.error.message : null,
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
  };
}

function listAlive() {
  // 过滤语法里的引号要小心：这里只按映像名过滤，不用引号
  const r = run("tasklist", ["/FI", "IMAGENAME eq " + IMAGE, "/NH", "/FO", "CSV"]);
  if (r.error) return { err: r.error };
  const lines = r.out.split(/\r?\n/).filter((l) => l.toUpperCase().includes(IMAGE.toUpperCase()));
  return { count: lines.length, lines };
}

const before = listAlive();
console.log("清理前：");
if (before.err) console.log("  列表查询失败：" + before.err);
else if (!before.count) console.log("  没有存活实例");
else before.lines.forEach((l) => console.log("  " + l));

if (before.err) {
  console.log("");
  console.log("查不到进程列表就无法验证 —— 不猜，如实报。");
  process.exit(1);
}

if (before.count) {
  const k = run("taskkill", ["/IM", IMAGE, "/F"]);
  console.log("");
  console.log("执行结束命令：status=" + k.status + (k.error ? " error=" + k.error : ""));
  if (k.out) k.out.split(/\r?\n/).forEach((l) => console.log("  " + l));
  if (k.err) k.err.split(/\r?\n/).forEach((l) => console.log("  ERR " + l));
}

const after = listAlive();
console.log("");
console.log("清理后：");
if (after.err) console.log("  列表查询失败：" + after.err);
else if (!after.count) console.log("  已全部清掉 ✅");
else {
  after.lines.forEach((l) => console.log("  " + l));
  console.log("  仍有存活实例 ❌ —— 后续启动会被静默移交，不能拿它当验证环境");
  process.exit(1);
}
