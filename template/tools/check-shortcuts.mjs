#!/usr/bin/env node
/**
 * check-shortcuts.mjs — 核对启动入口快捷方式的真实指向
 *
 * 为什么不用 COM：某些机器的安全策略会拦 `New-Object -ComObject WScript.Shell`。
 * 因此这里直接扫 .lnk 二进制里的 ASCII / UTF-16LE 字符串，不依赖任何 COM。
 *
 * PORTABLE：
 *   · 用户目录来自 os.homedir()，项目根来自本脚本位置
 *   · 桌面上还有哪些快捷方式**不再写死名字**，而是整体扫出来按指向分类
 *     （写死名字的版本只对原来那台机器有意义，换台机器会全报 MISSING）
 *
 * 用法：node tools/check-shortcuts.mjs
 *
 * 期望结果：
 *   desktop / startmenu / taskbar 三处 → wscript.exe + workbuddy-skin-launcher.vbs
 *   backup-orig                       → 原生 WorkBuddy.exe（备份里的原始指向）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOME = os.homedir();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ENTRIES = [
  ["desktop   ", path.join(HOME, "Desktop", "WorkBuddy.lnk")],
  ["startmenu ", path.join(HOME, "AppData", "Roaming", "Microsoft", "Windows", "Start Menu", "Programs", "WorkBuddy.lnk")],
  ["taskbar   ", path.join(HOME, "AppData", "Roaming", "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned", "TaskBar", "WorkBuddy.lnk")],
  ["backup-orig", path.join(ROOT, "backup", "WorkBuddy.lnk.desktop.original")],
];

const WANT_KEY = ["wscript", "workbuddy-skin", ".vbs", "WorkBuddy.exe"];

function strings(p) {
  const b = fs.readFileSync(p);
  const out = [];
  let cur = "";
  for (const x of b) {
    if (x >= 32 && x < 127) cur += String.fromCharCode(x);
    else { if (cur.length >= 4) out.push(cur); cur = ""; }
  }
  if (cur.length >= 4) out.push(cur);
  for (let i = 0; i + 1 < b.length; i += 2) {
    if (b[i + 1] !== 0) continue;
    let s = "", j = i;
    while (j + 1 < b.length && b[j + 1] === 0 && b[j] >= 32 && b[j] < 127) {
      s += String.fromCharCode(b[j]); j += 2;
    }
    if (s.length >= 4) { out.push(s); i = j - 2; }
  }
  return out;
}

function report(list, { full = false } = {}) {
  for (const [tag, p] of list) {
    if (!fs.existsSync(p)) { console.log(`${tag} | MISSING | ${p}`); continue; }
    const size = fs.statSync(p).size;
    const uniq = [...new Set(strings(p))];
    const hit = uniq.filter((x) => WANT_KEY.some((k) => x.includes(k)));
    console.log(`${tag} | ${size}B | ${JSON.stringify(hit)}`);
    if (full) {
      const paths = uniq.filter((x) => /\.(exe|vbs|cmd|bat|ps1|mjs|js)\b/i.test(x));
      for (const x of paths) console.log(`      ${x}`);
    }
  }
}

/** 桌面上的全部快捷方式（不预设名字） */
function desktopShortcuts() {
  const d = path.join(HOME, "Desktop");
  try {
    return fs.readdirSync(d)
      .filter((f) => f.toLowerCase().endsWith(".lnk"))
      .map((f) => [f.length > 34 ? f.slice(0, 31) + "..." : f.padEnd(34), path.join(d, f)]);
  } catch {
    return [];
  }
}

console.log("=== 启动入口（应全部指向 wscript.exe + workbuddy-skin-launcher.vbs）===");
report(ENTRIES, { full: true });

console.log("\n=== 桌面上其他快捷方式（按指向核对，避免误伤别的应用的入口）===");
const others = desktopShortcuts();
if (others.length) report(others);
else console.log("  （桌面没有快捷方式，或读不到桌面目录）");

console.log("\n=== backup 目录（原始入口的备份）===");
const bd = path.join(ROOT, "backup");
if (fs.existsSync(bd)) {
  for (const f of fs.readdirSync(bd)) console.log(`  ${f}  (${fs.statSync(path.join(bd, f)).size}B)`);
} else {
  console.log("  (无)");
}
