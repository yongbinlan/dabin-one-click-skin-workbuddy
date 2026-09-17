#!/usr/bin/env node
/**
 * run-codedrobe.mjs — CodeDrobe CLI 统一调用器
 *
 * 为什么需要它：CodeDrobe 的 core 是隔离安装在
 *   ~/.workbuddy/tools/codedrobe
 * （刻意不用 npm -g，避免污染全局 prefix），所以不在 PATH 里。
 * 本机 shell 的 shim 又不可靠，因此统一用「绝对路径 node + 绝对路径入口」调用。
 *
 * 用法：node run-codedrobe.mjs <codedrobe 子命令...>
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";

/*
 * PORTABLE: nothing here is pinned to one machine any more.
 *   · NODE_EXE  = whichever node is running this file (process.execPath),
 *                 instead of an absolute path into one user's managed runtimes
 *   · CLI_ROOT  = $CODEDROBE_HOME if set, else <home>\.workbuddy\tools\codedrobe
 *   · CLI_ENTRY = derived from CLI_ROOT
 * On the original dev machine these resolve to exactly the same paths the old
 * literals did, so behaviour there is unchanged.
 */
export const NODE_EXE = process.execPath;
export const CLI_ROOT = process.env.CODEDROBE_HOME
  || path.join(os.homedir(), ".workbuddy", "tools", "codedrobe");
export const CLI_ENTRY = path.join(CLI_ROOT, "node_modules", "@codedrobe", "core", "bin", "codedrobe.mjs");

export function runCli(args, { timeout = 240000 } = {}) {
  if (!fs.existsSync(CLI_ENTRY)) {
    return { status: 127, stdout: "", stderr: `CodeDrobe CLI 不存在：${CLI_ENTRY}\n请重新安装：npm install --prefix "${CLI_ROOT}" @codedrobe/core` };
  }
  const r = spawnSync(NODE_EXE, [CLI_ENTRY, ...args], {
    encoding: "utf8",
    timeout,
    windowsHide: true,
    cwd: CLI_ROOT,
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "", error: r.error };
}

// 直接执行时透传参数。
//
// 必须用 pathToFileURL 来做这个比较。手写 `file:///${process.argv[1]}` 不会给
// 空格和中文做百分号编码，而 import.meta.url 是编码过的形式 —— 两者对不上，
// 后果是「直接执行时静默不干活」（既不报错也不做事）。
// 本机工程路径恰好既无空格也无中文，所以这个坑一直没暴露；一换机器就会踩到。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const r = runCli(args);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status ?? 1);
}
