# workbuddy-skin — WorkBuddy 换肤工程

给 WorkBuddy（腾讯 CodeBuddy 桌面端）装上「夜街 · 白吊带」主题，
并让它**每次开机自动回来**。

装一次，之后全部操作都是**双击** —— 换壁纸、调透出强度、看状态、还原原生。

---

## 快速开始

```bat
rem 1. 展开工程（把 <skill目录> 换成实际路径）
node <skill目录>\scripts\init.mjs --dest D:\my\workbuddy-skin

rem 2. 自检，12 项全绿才算装好
node D:\my\workbuddy-skin\tools\verify-launcher.mjs

rem 3. 注入皮肤（WorkBuddy 需要在运行）
双击 D:\my\workbuddy-skin\launcher\注入皮肤.cmd
```

**让皮肤每次开机自动回来**：把桌面 / 开始菜单的 WorkBuddy 快捷方式指向
`launcher\workbuddy-skin-launcher.vbs`。原来的快捷方式会自动备份到 `backup\`，随时可还原。

> 初始化脚本会探测本机路径、生成壁纸选择器、构建并打包主题、装一张默认壁纸。
> 主程序装在非标准路径也能识别；识别不到就加 `--app "C:\...\WorkBuddy.exe"` 指定一次。

---

## 前置条件

| 项 | 要求 |
|---|---|
| 系统 | **Windows**（依赖 `.cmd` / `.vbs` / `.hta` / `.lnk`） |
| Node.js | **≥ 22.4** |
| WorkBuddy | 已安装的桌面端 |
| CodeDrobe CLI | `npm install --prefix "%USERPROFILE%\.workbuddy\tools\codedrobe" @codedrobe/core` |

> Node 版本不是随便定的：主题打包交给上游 `@codedrobe/core`，它声明
> `engines.node >= 22.4`。Node 18/20 能跑本工程的脚本，但走到 `theme pack` 会失败。

---

## 日常使用（全部双击）

| 想做什么 | 双击什么 | 也可以 |
|---|---|---|
| 注入皮肤（装完必做一次） | `launcher\注入皮肤.cmd` | — |
| **换壁纸**（有缩略图） | `launcher\壁纸选择器.hta` | — |
| 换壁纸（列表版） | `launcher\换壁纸.cmd` | 把图片**拖到它图标上** → 收进库并立刻启用 |
| 调壁纸透出强度 | `launcher\调强度.cmd` | 按 1/2/3 选淡 / 中 / 浓 |
| 看当前状态 | `launcher\查看状态.cmd` | — |
| 还原成原生外观 | `launcher\还原原生.cmd` | — |

> ⚠️ **`.cmd` / `.hta` 都得「双击」，单击只是选中。**
> 这曾经造成一次误判「点了换壁纸没反应」—— 文件被单击选中（蓝色高亮 + 右侧预览窗格），
> 脚本其实一行都没跑。

---

## 目录结构

```
<工程根>\
├── launcher\                  ← 唯一需要接触的目录（全部双击）
│   ├── 注入皮肤.cmd / 换壁纸.cmd / 调强度.cmd / 查看状态.cmd / 还原原生.cmd
│   ├── 壁纸选择器.hta          （生成物；缩略图界面，最直观的换壁纸方式）
│   ├── workbuddy-skin-launcher.vbs    ← 常驻启动器（快捷方式指向它）
│   ├── env.cmd                （生成物；本机路径，换机器要重生成）
│   └── 使用说明.txt
├── tools\                     ← 全部脚本
├── themes\<主题>\             ← 主题源（改配色改这里）
│   └── assets\legacy-skin-workbuddy.css   ← 四个核心色在 --heige-* 段
├── build\                     ← 主题包产物
├── wallpapers\                ← 壁纸库 + current.json
├── backup\                    ← 原始快捷方式的备份（还原用）
└── logs\                      ← 运行日志
```

---

## 架构

```
桌面 / 开始菜单 / 任务栏快捷方式（三者指向同一个启动器）
   └─> wscript.exe + workbuddy-skin-launcher.vbs      （无窗口，零闪烁）
          ├─ 步骤 1：确保应用已启动 —— sh.Run WorkBuddy.exe
          │           ↑ 不依赖 node / launcher.mjs / CDP
          └─ 步骤 2：node tools/launcher.mjs --no-launch   （纯增强层，干完即退）
                       ├─ 等 CDP 端口就绪
                       ├─ 等 renderer landmark 就绪
                       ├─ codedrobe apply --no-launch       （注入主题）
                       ├─ codedrobe verify                  （主题自检）
                       └─ 应用皮肤层：壁纸 + 薄纱 + 玻璃     ← 必须在 apply 之后
```

### 皮肤层为什么必须排在主题之后

皮肤层（`tools/lib-cdp.mjs` 的 `buildSkinCss`）与 CodeDrobe 注入的主题 style
**选择器同特异性**，靠「谁在文档里靠后谁生效」取胜：

- 顺序对了 → 玻璃层压过主题给 `.cr-agent__body` 的 90% 不透明底色，壁纸透出来
- 顺序反了 → 被主题的 90% 压回去，表现为**「壁纸怎么都看不见」**

同理，还原时也要**先撤皮肤层再撤主题**，否则原生界面上会剩一层玻璃。

### 为什么「启动应用」和「注入皮肤」必须分开

最初的实现是 `vbs → node → node 判断并 spawn 应用`。这在**替换启动入口之后**是不可接受的
单向门：一旦 node 或 `launcher.mjs` 损坏，用户就**双击不开 WorkBuddy 了**。

拆开之后：

| 故障 | 结果 |
|---|---|
| node 不存在 / 版本目录被换掉 | 应用正常启动，日志记 `SKIN SKIPPED`，只是没皮肤 |
| `launcher.mjs` 语法错误 / 崩溃 | 同上 |
| 主题包被删 | 应用正常启动，日志记「主题包缺失，跳过注入」（退出码 2） |
| CDP 端口未就绪 | 应用正常启动，只是没注入（退出码 5） |

**皮肤层的任何故障，最坏结果都只是「没皮肤」，绝不影响应用可用性。**

### 为什么不做守护进程

WorkBuddy 的 `supportsControlChannel` 与 CodeDrobe 的 `host.supported` **都是 false** ——
官方不存在「常驻主题」钩子，注入只活在 renderer 内存里，重启必丢。所以「持久」只有三条路：

| 方案 | 结论 |
|---|---|
| 改 `app.asar` 内资源 | ❌ 禁止。破坏包完整性、升级失效 |
| 常驻守护 + `apply --watch` 轮询 | ⚠️ 可行但留常驻进程 |
| **启动器：启动后注入一次，即退** | ✅ **采用**。零常驻、零轮询 |

前提是应用自带 CDP 通道（用户级环境变量 `WORKBUDDY_REMOTE_DEBUGGING_PORT`）。
启动器要做的只是「等就绪 + 注入」。

---

## 自定义壁纸与透出强度

### 三层结构

换壁纸不是「换张图」那么简单 —— 壁纸画在 `#root` 的 `background` 上，
而它上面盖着一堆不透明容器。所以皮肤层是**三层一起下**：

| 层 | 作用 | 手段 |
|---|---|---|
| ① 壁纸层 | 换图 | 覆盖 `--codedrobe-image-hero`（`#root` background 的第三层） |
| ② 薄纱层 | 决定壁纸「透出多少」 | 重写 `#root` 的两个方向性遮罩 |
| ③ 玻璃层 | 让挡路的容器透光 | 结构容器降不透明度 + `backdrop-filter: blur()` |

三层共用一个档位，所以换图和调观感都是**一条命令**。

### 档位

| 档 | 遮罩 X/Y | 结构面 | 内容面 | 毛玻璃 | 适用 |
|---|---|---|---|---|---|
| **淡** `light` | 56% / 42% | 46% | 80% | 22px | 氛围优先，壁纸最抢眼 |
| **中** `medium`（默认） | 74% / 60% | 62% | 88% | 18px | 日常挂后台干活 |
| **浓** `strong` | 90% / 78% | 80% | 92% | 12px | 看代码、审 diff |

### 为什么不把内容面也调透

**结构面可以糊，内容面不能糊。** 代码块、diff、工具卡片如果跟着壁纸一起透，
文字就会糊在墙上，皮肤越好看看起来越没法干活。所以这三类保持 80~92% 不透明，
不参与毛玻璃 —— 这是换肤唯一不能破的底线。

### 为什么不用 base64、不重打包

renderer 是 `file://` 协议、CSP 为 `null`，**实测能直接加载本地图片**。所以：

| 做法 | 代价 | 结论 |
|---|---|---|
| 图片 base64 进 CSS + 重打包主题 | 每换一张图就要重建、重打包、重新 apply | ❌ |
| 改 `theme.json` 的 `images.hero` | 同上，且要过 CodeDrobe 的 pack | ❌ |
| **注入一条 targeting `#root` 的规则** | 秒级、不打包、不重启、可一键撤销 | ✅ **采用** |

### 壁纸库的语义

**每收一张就多一张，旧的一张不动。**

想清理用 `node tools\set-wallpaper.mjs prune` —— 它只留当前那张，其余**移进归档目录**
（可逆），不是删除。

### 关闭语义

「还原原生」写的是**禁用标记**（`{"disabled": true}`），而不是删记录文件。
删了的话启动器下次会当成「从未配置」并默认装回玻璃层，用户看到的是「关了又自己回来」。

---

## 图形化壁纸选择器（HTA）

**为什么是 HTA**：Windows 原生（`mshta.exe`）、双击即开、能跑 `ActiveXObject`
（读目录 / 跑 node）、能显示缩略图，且**不依赖 node**（node 坏了界面照样能开，只是换不了图）。

**核心设计 —— 产物必须是纯 ASCII。** HTA 跑在 MSHTML（IE 内核），
而 MSHTML 对 `<meta charset>` 缺失时的解码行为不可控。所以走「**模板 + 生成器**」两步：

```
tools/picker.template.hta        正常写中文（可读、可维护）
        │  node tools/build-wallpaper-picker.mjs
        │  ① 所有非 ASCII → \uXXXX 转义
        ▼
launcher/壁纸选择器.hta          纯 ASCII 产物（中文字符数以转义形式存在）
```

无论 MSHTML 按哪种编码解析，**纯 ASCII 的结果都一样** —— 从根上绕开编码坑。

---

## 两条必须守的编码铁律（都是踩出来的）

**铁律一：`.cmd` 必须是 GBK 无 BOM + CRLF 行尾。**

| 维度 | 错了会怎样 |
|---|---|
| 编码 | 中文满屏乱码 —— **不报错**，只是没法读 |
| 行尾（写成裸 LF） | **cmd 会把注释和 echo 残片当命令执行**，双击弹一串「不是内部或外部命令」 |

行尾这一条发现得晚：当时 5 个 cmd 全是裸 LF，报错原文如 `'给出口。少了这一行...'`、`'/p'`
—— 此前双击一直是坏的。中文看着完全正常，**只有在字节层才看得见缺了 `0x0D`**。

规范化用 `tools\_fix-cmd.ps1`（GBK + CRLF 双归一，幂等，写完回读验证）。
自检第 7 项做**字节级裸 LF 断言**（逐字节找 `0x0A` 且前一个不是 `0x0D`）防复发。

**铁律二：`.ps1` / `.vbs` 自己必须纯 ASCII。**

连中文路径都不能写进去 —— 目录靠枚举拿，不硬编码。PowerShell 5.1 在 `.ps1` 无 BOM 时
按 ANSI 解析，脚本里出现非 ASCII 字节会**自己坏掉**（不是读不对，是整段语法错误）。

> 真实案例：诊断脚本里写了中文 marker 文本，而文件按 `"ascii"` 写 →
> 非 ASCII 被按位截断产生 NUL → 整段脚本语法错误 → 表现「什么都没跑」，
> 看起来像产物坏了。**打桩文本一律纯 ASCII。**

> ⚠️ 还有些环境里 PowerShell 不回传 stdout（退出码 0 但零输出），
> 所以脚本都把结果写进 `logs\*.log`。
> **退出码 0 不等于成功 —— 必须读日志。**

---

## 产物可移植性

**工程里没有任何一处写死绝对路径。** 产物要能整体搬走、换机器还能用，
所以路径全部**运行时从自身位置推导**：

| 载体 | 怎么推导自身位置 |
|---|---|
| `.hta` | `document.location.href`（要对空格/中文做百分号解码） |
| `.cmd` | `%~dp0`；上一级用 `for %%I in ("%~dp0..") do set "ROOT=%%~fI"` |
| `.vbs` | `WScript.ScriptFullName` → 取两次父目录 |
| `.ps1` | `$PSScriptRoot` |
| `.mjs` | `import.meta.url` |

**推导不出来的东西用 env 桥接**：node 解释器与 WorkBuddy 主程序的位置无法从工程位置推出，
由 `tools\write-env.mjs` 探测后写进 `launcher\env.cmd`，`.cmd` / `.vbs` / `.hta` 三方统一读它。

> 反模式：构建时把绝对路径**注入**模板（替换 `__ROOT__` 之类占位符）。
> 那正是「产物被绑死在生成它的那台机器上」的根因。

**换机器 / 挪目录之后**：重跑一次 `init.mjs --upgrade` 即可，`env.cmd` 会按新机器重新生成。

---

## 升级已有工程

```bat
node <skill目录>\scripts\init.mjs --dest <已有工程> --upgrade
```

分界线只有一条：**代码刷成新版，用户的东西一律不动。**

| 覆盖 | 保留 |
|---|---|
| `tools\**`、`launcher\**` | `themes\**`（用户可能改过配色） |
| | `wallpapers\` `backup\` `logs\` |
| | `env.cmd`、`README.md`、`使用说明.txt` |

`--force` 与 `--upgrade` 是两件事：前者**补缺口**（不覆盖任何已有文件），
后者**换实现**（把代码刷成新版）。

---

## 排障

| 现象 | 怎么办 |
|---|---|
| 双击 `.cmd` 满屏「不是内部或外部命令」 | 编码或行尾不对 → 跑 `tools\_fix-cmd.ps1` |
| 快捷方式点了没反应 | 跑 `node tools\verify-launcher.mjs --only=1`；重跑 `node tools\write-env.mjs` |
| 提示「主题包不存在」 | `build\` 下没有 `.codedrobe-theme` → 重跑 `init.mjs --upgrade` |
| 皮肤注入了但界面没变 | `node tools\cdp-probe.mjs` 看 `targets` 数量（可能打到了另一个窗口） |
| 换壁纸后看不见壁纸 | 档位调到「淡」，或跑 `node tools\diag-occluders.mjs` |
| 重启后皮肤没了 | 快捷方式没指向启动器 → 按「快速开始」重新指向 |
| 壁纸选择器打开是空的 | 壁纸库还没图 → 用 `换壁纸.cmd` 拖一张进去 |
| 找不到 WorkBuddy 主程序 | `init.mjs --app "C:\...\WorkBuddy.exe"` 指定一次 |

**通用第一步**：

```bat
node <工程>\tools\verify-launcher.mjs
```

12 项自检，会直接告诉你哪一环坏了。

---

## 想改成自己的皮肤

1. 改 `themes\<主题>\assets\legacy-skin-workbuddy.css` 里的 `--heige-*` 令牌值
2. `node tools\build-theme.mjs` —— 重新生成主题 CSS（产物会自报规则块数 / 令牌数）
3. `node tools\run-codedrobe.mjs theme pack <工程>\themes\<主题>\theme.json --output <工程>\build\<id>-<版本>.codedrobe-theme`
4. `node tools\launcher.mjs` —— 注入并**看图确认**（不要只看 JSON 的 `pass: true`）
5. 视觉达标后递增 `theme.json` 的 `version`，重打包

> `theme pack` 会报几条 `long-selector` / `deep-child-chain` 警告 —— 那是选择器与 DOM
> 结构耦合的提示，**不阻塞**，属已知技术债。

想从**参考图**做一套全新主题，走 `codedrobe-theme` skill 的 reference-image 流程。
