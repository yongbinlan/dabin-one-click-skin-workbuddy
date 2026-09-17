---
name: workbuddy-one-click-skin
description: 一键给 WorkBuddy（腾讯 CodeBuddy 桌面端）装皮肤并让它每次开机自动回来。带完整工程包与一键初始化脚本：展开即用，可换壁纸、调壁纸透出强度（淡/中/浓）、重启后皮肤自动恢复、随时还原原生。当涉及 WorkBuddy 换肤/皮肤/主题、让皮肤在重启后自动回来、更换壁纸、调毛玻璃透出强度、壁纸看不见或被遮挡、皮肤失效或没生效、还原原生外观、打包 .codedrobe-theme 主题包、改快捷方式启动入口、给别人的机器装同款皮肤时使用。触发词：WorkBuddy换肤、一键换肤、workbuddy 皮肤、WorkBuddy 主题、换壁纸、壁纸、自定义皮肤、毛玻璃、透出强度、皮肤失效、皮肤没了、还原原生、常驻注入、自动注入、codedrobe。
agent_created: true
---

# WorkBuddy 一键换肤

把一整套 **「给 WorkBuddy 装上皮肤 + 让它开机自动回来」** 的能力打包分发。

产物是一个**自包含的工程目录**：初始化一次，之后全部操作都是**双击**——
换壁纸、调强度、看状态、还原原生。不需要懂命令行，不需要装依赖。

上游主题引擎是成熟开源项目 **CodeDrobe Theme**（Apache-2.0），
本 skill 负责的是**工程化与常驻层**：把「注入一次、重启就没了」变成「装一次、以后一直在」。

---

## 0. 这个 skill 负责什么、不负责什么

| | 说明 |
|---|---|
| ✅ 负责 | 把整套工程展开到用户机器上、探测本机路径、生成壁纸选择器、构建并打包主题、建快捷方式、排障 |
| ✅ 负责 | 「夜街 · 白吊带」这一套主题（暖金 + 蓝灰 + 深墨底）的**分发与运行** |
| ❌ 不负责 | 从参考图**创作新主题** —— 那走 `codedrobe-theme` skill 的 reference-image 流程 |
| ❌ 不负责 | 其他应用的换肤（本工程只针对 WorkBuddy 这个 target） |

> 换句话说：别人用这个 skill 能拿到**和原设计逐字节相同的那套皮肤**，
> 但换主题配色／做一套全新视觉，是另一件事。

---

## 1. 前置条件

| 项 | 要求 | 说明 |
|---|---|---|
| 系统 | **Windows** | 依赖 `.cmd` / `.vbs` / `.hta` / `.lnk`，不做跨平台 |
| WorkBuddy | 已安装 | 桌面端（Electron）。装在非标准路径也支持，见 §6 |
| Node.js | ≥ 18 | 工程里的脚本用 `node:` 前缀导入与 ESM |
| CodeDrobe CLI | `@codedrobe/core` | 皮肤最终靠它注入。装在 `<用户目录>\.workbuddy\tools\codedrobe`，或用 `CODEDROBE_HOME` 指定 |

装 CodeDrobe CLI：

```bat
npm install --prefix "%USERPROFILE%\.workbuddy\tools\codedrobe" @codedrobe/core
```

> 刻意**不用** `npm -g`：避免污染全局 prefix，也避免和别的工具抢版本。

---

## 2. 一键初始化（主路径）

```bat
node <本skill目录>\scripts\init.mjs --dest D:\my\workbuddy-skin
```

它会依次做完这些事，每一步都打印做了什么：

1. **探测本机环境** —— node、WorkBuddy 主程序、CodeDrobe CLI
2. **展开工程** —— 把 `template/` 铺到目标目录（35 个文件，已剔除本机专属项）
3. **生成 `launcher\env.cmd`** —— 本机路径落在这一份文件里
4. **构建壁纸选择器** —— 生成 `launcher\壁纸选择器.hta`（纯 ASCII 产物）
5. **构建主题包** —— `build\<主题id>-<版本>.codedrobe-theme`
6. **装一张默认壁纸** —— 壁纸库空时用主题自带的 hero 图打底，避免开箱是一片空白

参数：

| 参数 | 用途 |
|---|---|
| `--dest <目录>` | 指定展开位置（默认 `./workbuddy-skin`） |
| `--app "C:\...\WorkBuddy.exe"` | 主程序探测不到时手工指定一次，之后会被记住 |
| `--shortcut` | 顺手在桌面 + 开始菜单建一个皮肤启动快捷方式 |
| `--force` | 目标已存在时也继续：**只补缺口，不覆盖任何已有文件** |
| `--upgrade` | 把已有工程的 `tools/` 与 `launcher/` 刷成这个 skill 的新版（见 §5） |
| `--print` | 只看探测结果，不落盘 |

初始化完成后：

```bat
node <工程>\tools\verify-launcher.mjs
```

**14 项自检**，全绿才算装好了。这一步别省 —— 它能在用户发现问题之前，
把「产物过期」「编码不对」「脚本语法错」这些静默故障先揪出来。

---

## 3. 日常使用（全部双击）

| 想做什么 | 双击什么 |
|---|---|
| **注入皮肤**（第一次装完必做，WorkBuddy 要在运行） | `launcher\注入皮肤.cmd` |
| **换壁纸**（有缩略图，最直观） | `launcher\壁纸选择器.hta` |
| 换壁纸（命令行列表） | `launcher\换壁纸.cmd`（也支持把图片**拖到它上面**） |
| 调壁纸透出强度 | `launcher\调强度.cmd`（淡 / 中 / 浓） |
| 看当前状态 | `launcher\查看状态.cmd` |
| 还原成原生外观 | `launcher\还原原生.cmd` |

**让皮肤在重启后自动回来**：把桌面／开始菜单的 WorkBuddy 快捷方式指向
`launcher\workbuddy-skin-launcher.vbs`。原来的快捷方式会**自动备份到 `backup\`**，
随时可以还原。

> 这是**替换启动入口**，不是守护进程。理由见 §7.6。

---

## 4. 换壁纸为什么不用重打包

主题的壁纸变量定义在 `html.codedrobe-host-workbuddy #root` 上，
而 WorkBuddy 的 renderer 是 `file://` 协议、**能直接加载本地图片**。

所以换壁纸 = 往页面注入一条 CSS 规则，**秒级生效，不重打包、不重启、不用 base64**。

壁纸层实际是三层叠加：

| 层 | 作用 |
|---|---|
| ① 壁纸层 | 换图 |
| ② 薄纱层 | 重写 `#root` 的方向性遮罩 —— 决定壁纸**透出多少** |
| ③ 玻璃层 | 把挡住壁纸的结构容器改成半透明 + 毛玻璃 |

三层共用**同一个档位**，所以「换壁纸」和「调观感」本质是同一条命令。

> 壁纸库里的图**一直保留**：每收一张就多一张，旧的一张不动。
> 想清理用 `node tools\set-wallpaper.mjs prune`（它只留当前那张，其余移进归档目录）。

---

## 5. 升级已有工程：`--upgrade`

skill 更新之后，老工程怎么吃到修复？

```bat
node <本skill目录>\scripts\init.mjs --dest <已有工程> --upgrade
```

**分界线只有一条：代码刷成新版，用户的东西一律不动。**

| 覆盖 | 保留 |
|---|---|
| `tools\**`（脚本） | `themes\**` ← 主题源！用户可能改过配色、displayName |
| `launcher\**`（入口与启动器） | `wallpapers\` `backup\` `logs\`（用户数据） |
| | `env.cmd`（记着本机路径）、`README.md`、`使用说明.txt`（用户可能批注过） |

这条线是踩出来的：修好 `_make-shortcuts.ps1` 的 bug 之后，
老工程里那份坏的还在 —— `--force` 只补缺不覆盖，于是**「修了等于没修」**。
所以 `--force` 与 `--upgrade` 是两件事：前者补缺口，后者换实现。

---

## 6. 主程序装在非标准路径

工程里**没有任何一处**写死 WorkBuddy 的安装位置。
`tools\write-env.mjs` 按可靠性依次试这些线索，谁能命中就用谁，并把**来源**打出来：

```
参数 --app  →  环境变量 WORKBUDDY_EXE  →  已有 env.cmd  →  备份的原始快捷方式
  →  桌面/开始菜单快捷方式  →  附近的其他换肤工程  →  默认安装位置
```

其中两条值得单独说：

- **备份的原始快捷方式**（`backup\*.original`）是最可靠的线索之一 ——
  快捷方式被换成皮肤启动器之后，原始那份还指着真正的主程序。
- **桌面/开始菜单快捷方式**对**第一次用的人**有效（那时还没被换过）；
  对已经换过的人则失效，所以要靠上面那条兜底。

全都不命中时，`--app` 指定一次，结果会被记住。

**故意不查注册表**：那要起 `reg.exe`，而企业安全软件会把它整个拉黑，
探测脚本一跑就被拦，用户还得处理权限提示 —— 收益远小于代价。

---

## 7. 交付铁律（全部是实测踩出来的）

这一节是本 skill 最该被反复读的部分。每条都对应一个**静默故障**——
不报错、不崩溃，只是不干活或干错活。

### 7.1 产物里不许有绝对路径

产物要能整体搬走、换机器还能用，所以路径必须**运行时从自身位置推导**：

| 载体 | 怎么推导自身位置 |
|---|---|
| `.hta` | `document.location.href`（记得对空格/中文做百分号解码） |
| `.cmd` | `%~dp0`；上一级用 `for %%I in ("%~dp0..") do set "ROOT=%%~fI"` |
| `.vbs` | `WScript.ScriptFullName` → 取父目录两次 |
| `.ps1` | `$PSScriptRoot` |
| `.mjs` | `import.meta.url` |

**推导不出来的东西用 env 桥接**：node 解释器和 WorkBuddy 主程序的位置无法从工程位置推出，
由 `tools\write-env.mjs` 探测后写进 `launcher\env.cmd`，`.cmd`/`.vbs`/`.hta` 三方统一读它。

> 反模式：构建时把绝对路径**注入**模板（替换 `__ROOT__` 之类占位符）。
> 那正是「产物被绑死在生成它的那台机器上」的根因。
> 改成运行时推导后，要加一道**反向保险**：模板里若再出现 `__[A-Z_]+__` 就 fail。

### 7.2 判断「本模块是否被直接执行」必须用 `pathToFileURL`

```js
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { /* 直接执行 */ }
```

手写 `` `file:///${process.argv[1]}` `` 不给空格和中文做百分号编码，而 `import.meta.url`
是编码过的形式 —— 两者对不上，后果是**直接执行时静默不干活**（既不报错也不做事）。

这个坑特别阴：路径里没空格没中文时就一直正常，**一换机器就踩到**。

### 7.3 `.cmd` 必须 GBK 无 BOM + CRLF

- **编码**：含中文的 `.cmd` 存成 UTF-8，双击必乱码。必须是 GBK/ANSI。
- **行尾**：**裸 LF** 会让 cmd 无法可靠切行，把注释和 `echo` 的残片当成命令去执行，
  报一串「不是内部或外部命令」。中文看着完全正常，**只有在字节层才看得见缺了 `0x0D`**。

纯 ASCII 的 `.cmd` 两种编码都合法，判不出来也没必要判 —— 只判含非 ASCII 的文件。

### 7.4 `.vbs` 与 `.ps1` 必须纯 ASCII

PowerShell 5.1 把**无 BOM** 的 `.ps1` 按 ANSI/GBK 解析，里面任何非 ASCII 字面量都会损坏路径。

### 7.5 `.ps1` 的 `param()` 必须是**文件第一条语句**

上面哪怕只多一行 `$ErrorActionPreference = "Stop"`，PowerShell 就不再把它当 param 块，
而是当一次命令调用来解析括号 —— 报出来的却是
**「赋值表达式无效（InvalidLeftHandSide）」**，指向第一个默认值那一行。

**报错位置和真实病因差着好几行，光看错误信息根本想不到。**

后果特别难发现：脚本平时没人跑，只有真要建/改快捷方式时才炸，而那时用户已经在换肤流程里了。
→ 已纳入自检第 12 项常设门禁（静态查 param 位置 + 真实解析校验，**只解析不执行**）。

### 7.6 常驻用「替换启动入口」，不用守护进程

守护进程要一张常驻进程表、要处理崩溃重启，还会和 Electron 的单实例机制打架。
替换启动入口把「注入」这件事挂到**用户本来就要做的动作**上（启动应用），零额外进程。

### 7.7 `.lnk` 用二进制字符串扫描，不依赖 COM

有些机器拦 `New-Object -ComObject`，所以读快捷方式目标用不上 COM。
直接扫 `.lnk` 的可打印字符串（**ASCII 与 UTF-16LE 两种编码都要扫，且要试奇数起始偏移**）
就能拿到目标路径与参数。

### 7.8 探测类脚本不要有副作用

扫盘找工程时，盘根下一层里的系统目录（`Users` / `Windows` / `Program Files` / `$Recycle.Bin` …）
一律跳过 —— 一是没必要，二是碰到用户目录下的受保护子目录（`.ssh` 之类）会**弹权限框**。

### 7.9 截屏用 `PrintWindow` 的 **flags=0**

`PW_RENDERFULLCONTENT`(flags=2) 会抓到**不完整或陈旧的 DWM 缓存**。
实测同一场景：flags=2 在 2.5s / 6.0s 两次都不完整，flags=0 三次都完整。
用 flags=2 去判断「界面渲染漏了元素」会得出错误结论。

### 7.10 HTA 的硬约束

- 只支持 **ES3/ES5**：不能有箭头函数、`let/const`、模板字符串、展开运算符。
  **构建器的 ES5 正则扫描器会拦注释里的 `...`** —— 注释里也别写。
- 产物必须**纯 ASCII**：中文全部转义成 `\uXXXX`（FSO 只认 ASCII/UTF-16）。
- `window.close()` **关不掉**宿主，不要靠它退出。

### 7.11 清理类操作的三铁律

只要涉及「删 / 移走 / 归档」，先问三个问题：

1. **谁列的名单？** 是用户点名的，还是我自己推导出来的？后者要给出全部受影响路径并确认。
2. **动作可逆吗？** 移进归档目录（可逆）≠ 直接删除（不可逆）。
3. **失败会怎样？** 单张失败要不要中止整批？

并且要分清**「来源集合」与「已提交集合」** —— 用户说「其他的不用保留」时，
他说的「其他」是**待选项里的其他**，不是**已经收进库的其他**。
这两者混淆会造成真实的数据丢失。

### 7.12 幂等与升级的分界线要写进代码注释

`--force`（补缺口）和 `--upgrade`（换实现）是两件事。分界线是
**代码 vs 用户数据**，且这条线必须写在源码注释里 —— 否则下一个人会想当然地
把 `--upgrade` 实现成「覆盖全部」，把用户改过的主题配色冲掉。

---

## 8. 排障

| 现象 | 原因 | 怎么办 |
|---|---|---|
| 双击 `.cmd` 满屏「不是内部或外部命令」 | 编码或行尾不对（§7.3） | 工程里有修复脚本，跑一次即可 |
| 快捷方式点了没反应 | `.vbs` 编码坏了，或 `env.cmd` 没生成 | 跑自检第 1 项；重跑 `tools\write-env.mjs` |
| 建/改快捷方式报 `InvalidLeftHandSide` | `.ps1` 的 `param()` 不在第一条语句（§7.5） | 跑自检第 12 项定位 |
| 提示「主题包不存在」 | `build\` 下没有 `.codedrobe-theme` | 重跑 `init.mjs --upgrade`，或手工 `theme pack` |
| 皮肤注入了但界面没变 | WorkBuddy 有多窗口/多进程，注入打到了另一个 | 跑 `tools\cdp-probe.mjs` 看 `targets` 数量 |
| 换壁纸后看不见壁纸 | 被结构容器挡住 | 调档位到「淡」，或跑 `tools\diag-occluders.mjs` |
| 重启后皮肤没了 | 快捷方式没指向启动器 | 按 §3 重新指向 `workbuddy-skin-launcher.vbs` |
| 壁纸选择器打开是空的 | 壁纸库还没图 | 用 `换壁纸.cmd` 拖一张图进去，或重跑 `init.mjs` |
| 找不到 WorkBuddy 主程序 | 装在非标准路径（§6） | `init.mjs --app "C:\...\WorkBuddy.exe"` |

**通用第一步**：`node <工程>\tools\verify-launcher.mjs`（14 项自检，会直接告诉你哪一环坏了）。

---

## 9. 目录结构

```
<工程根>\
├── launcher\                 ← 用户唯一需要接触的目录（全部双击）
│   ├── 注入皮肤.cmd / 换壁纸.cmd / 调强度.cmd / 查看状态.cmd / 还原原生.cmd
│   ├── 壁纸选择器.hta         （生成物；带缩略图，最直观的换壁纸方式）
│   ├── workbuddy-skin-launcher.vbs   ← 常驻启动器（快捷方式指向它）
│   ├── env.cmd               （生成物；本机路径，换机器要重生成）
│   └── 使用说明.txt
├── tools\                    ← 全部脚本
│   ├── init 相关：write-env.mjs
│   ├── 主题相关：build-theme.mjs
│   ├── 壁纸相关：set-wallpaper.mjs / skin-state.mjs / lib-cdp.mjs
│   ├── 界面相关：picker.template.hta / build-wallpaper-picker.mjs
│   └── 自检相关：verify-launcher.mjs / check-shortcuts.mjs / cdp-probe.mjs / diag-occluders.mjs
├── themes\<主题>\            ← 主题源
│   ├── theme.json            （CodeDrobe 清单：id / displayName / version / targets）
│   ├── workbuddy.css         （自动生成，勿手改）
│   └── assets\
│       ├── legacy-skin-workbuddy.css   ← 改配色改这里
│       └── hero.webp                   （主题自带图，同时用作默认壁纸）
├── build\                    ← 主题包产物
├── wallpapers\               ← 壁纸库 + current.json
├── backup\                   ← 原始快捷方式的备份（还原用）
└── logs\                     ← 运行日志
```

---

## 10. 想改成自己的皮肤

1. 改 `themes\<主题>\assets\legacy-skin-workbuddy.css` 里的 `--heige-*` 令牌值
   （四个核心色：强调色 / 辅助色 / 表面色 / 文字色）
2. 重新生成主题 CSS：
   ```bat
   node <工程>\tools\build-theme.mjs
   ```
   产物会自报规则块数 / 令牌数 / 残留 data URL，可核对
3. 重新打包：
   ```bat
   node <工程>\tools\run-codedrobe.mjs theme pack <工程>\themes\<主题>\theme.json --output <工程>\build\<id>-<版本>.codedrobe-theme
   ```
4. 注入并**看图确认**：
   ```bat
   node <工程>\tools\launcher.mjs
   ```
   > 不要只看 JSON 的 `pass: true` —— 视觉要靠眼睛。
5. 视觉达标后递增 `theme.json` 的 `version`，重打包

> `theme pack` 会报几条 `long-selector` / `deep-child-chain` 警告 —— 那是选择器
> 与 DOM 结构耦合的提示，**不阻塞**，属已知技术债。

想从**参考图**做一套全新主题（而不是改现有配色），走 `codedrobe-theme` skill 的
`references/reference-image.md` + `dom-snapshot.md` 流程。
