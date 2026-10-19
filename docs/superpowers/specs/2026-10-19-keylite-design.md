# KeyLite — 轻量 KDBX 密码管理器 · 设计文档

- 日期：2026-10-19
- 状态：待评审
- 代号：KeyLite（占位名，正式名称待定）

## 1. 概述

**定位**：Windows 优先的轻量级、现代化 KDBX 密码管理器。KeePassXC 的数据格式，Raycast 式的访问体验，KeeWeb 停更后空出的生态位。

**一句话卖点**：3MB 的安装包，打开的就是你现有的 KeePassXC 密码库，全局快捷键按一下、输两三个字、回车，密码就填进去了。

### 目标

- 与 KDBX 4/4.1 格式完全互操作（KeePass / KeePassXC 用户零迁移）
- 解决 KeePassXC 的四大痛点：功能臃肿、界面老旧、访问繁琐、自动填充体验差
- 产物体积 < 10MB，冷启动 < 1s
- 单人可维护的代码规模，开源发布

### 非目标（v1 明确不做）

- SSH Agent、Secret Service、KeeShare、Passkeys、CLI、插件系统
- 内置云同步引擎（不做自己的服务器和同步协议）
- 移动端自研（iOS/Android）——移动场景先由生态现成 KDBX 客户端承接，自研列为远期候选（见 §14）
- macOS / Linux 适配（架构不排斥，但 v1 不投入、不测试、不承诺；macOS 为远期候选，见 §14）

## 2. 背景与动机

| 事实 | 含义 |
|---|---|
| KeePassXC 功能强但臃肿、Qt 界面老旧、交互繁琐 | 用户痛点真实存在 |
| KeePassXC 自身提供 `KPXC_MINIMAL` 构建开关裁剪高级功能 | 连官方都承认"重" |
| KeeWeb（Web 技术的 KDBX 客户端）停止活跃维护 | 生态位空出，且有完整前车之鉴 |
| KDBX 是冻结的稳定格式，且不受 GPL 传染（兼容文件格式不涉及复制代码） | 新客户端可以长期稳定维护，法律干净 |

**放弃 fork KeePassXC 的理由**：几十万行 C++/Qt 的裁剪成本、Qt Widgets 改现代 UI 的痛苦、GPLv3 传染堵死商业化退路、持续 merge 上游安全补丁的长期税。

## 3. 技术选型（决策记录）

| 决策点 | 选择 | 理由 | 被否掉的备选 |
|---|---|---|---|
| 应用壳 | **Tauri 2** | 产物 3-10MB（WebView2 为 Win10/11 自带），"轻"的卖点由框架做实；全局快捷键/托盘/自启/通知/窗口防截屏全是官方插件 | Electron（100MB+，与产品叙事矛盾） |
| 前端框架 | **Vue 3 + TypeScript** | 按作者手感定 | React、Svelte 5 |
| UI 组件库 | **Radix-Vue + Tailwind CSS + 自写手绘外壳** | 手绘涂鸦风（见 §6.5）的 token 字典是纯 Tailwind 驱动，与 Naive UI 这类成品组件库外观不兼容；用无头组件库 Radix-Vue 提供可访问性骨架，外壳全自写以贯彻手绘风 | Naive UI（外观不可改造为 dashed 边框/硬偏移阴影）、shadcn-vue、Element Plus |
| KDBX 引擎 | **kdbxweb（vendor 收编进仓库）** | MIT、KDBX3/4 全支持、merge 是现成 API、ProtectedValue 内存 XOR 保护、KeeWeb 生产验证 | 自写格式层（绝对不做）、keepass-rs（Rust，成熟度低） |
| Argon2 KDF | **hash-wasm 的 argon2id** | 活跃维护，经 kdbxweb 的 `setArgon2Impl` 接入 | 纯 JS 实现（性能差一个量级） |
| Auto-Type | **Rust `enigo`**（Windows SendInput） | 唯一必须手写的 Rust 模块，边界小 | nut-js（Electron 生态） |
| 目标平台 | **仅 Windows 10/11 x64** | 作者自用 + 最大用户盘，范围锁死换取聚焦 | 全平台（成本翻数倍） |
| 许可证 | **MIT** | kdbxweb/Tauri/Vue/Radix-Vue 全部宽松许可，无传染，留商业化退路 | GPL（只有真 fork KeePassXC 才被迫用） |

## 4. 架构

```
┌─────────────────────────────────────────────┐
│  前端层（WebView2 内，Vue 3 + TS + Pinia）    │
│  · 主界面（三栏）    · 快速访问面板（spotlight 窗口）│
│  · 密码生成器/编辑器 · 设置                   │
├─────────────────────────────────────────────┤
│  数据层（纯 JS，与 UI 同进程 webview 内）      │
│  · kdbxweb（vendor）   · hash-wasm argon2    │
│  · 仓库层：打开/保存/merge/自动重载的状态机     │
├─────────────────────────────────────────────┤
│  系统层（Rust）                               │
│  · Tauri 官方插件：全局快捷键/托盘/自启/       │
│    通知/窗口防截屏/单实例                      │
│  · 手写 Rust（约几百行）：Auto-Type（enigo）、 │
│    Windows Hello 解锁、文件 watcher           │
└─────────────────────────────────────────────┘
```

**原则**：

- 加密 100% 发生在 kdbxweb + WebCrypto + hash-wasm 内，本项目不写任何加密代码
- 密码等敏感值在前端只以 `ProtectedValue`（XOR 混淆）形式存在，渲染时才转明文
- Rust 层只做"眼睛和手"（读文件、敲键盘、问 Hello），不理解数据库内容
- 两类窗口：主窗口（常驻/可关闭到托盘）+ 快速面板窗口（无边框、置顶、失焦即隐）

## 5. 功能范围

### v1（MVP，发布标准）

| 模块 | 功能 | 验收标准 |
|---|---|---|
| 数据库 | 新建 / 打开 / 保存 KDBX 4.1（Argon2id + ChaCha20） | KeePassXC 2.7.12 能打开 KeyLite 写的库，反之亦然 |
| 数据库 | 密钥文件支持、主密码修改 | |
| 条目 | 增删改查、分组（多级）、标签、回收站、favicon 下载 | favicon 下载失败静默降级为默认图标 |
| 条目 | 条目历史（查看/恢复）、过期标记 | |
| 搜索 | 主界面即时搜索 + 快速面板共用同一索引 | 千条目级搜索 < 50ms |
| TOTP | 存储与生成（时间型 + Steam），复制带倒计时提示 | |
| 生成器 | 随机密码 + 口诀（passphrase），排除相似字符、估算强度 | |
| 快速面板 | 全局快捷键呼出 → 搜索 → Enter 复制密码 / Tab 展开动作（复制用户名/TOTP/Auto-Type/打开 URL） | 呼出到可用 < 300ms（库已解锁时） |
| Auto-Type | 选中条目对前台窗口键入，默认序列 `{USERNAME}{TAB}{PASSWORD}{ENTER}`，条目可自定义序列（支持 `{USERNAME}` `{PASSWORD}` `{TAB}` `{ENTER}` `{DELAY n}` 五个占位符，超出部分 v1 不做） | 不做窗口关联规则（见 §6.4） |
| 安全 | Windows Hello 快速解锁（DPAPI 包裹密钥）、自动锁定（空闲/锁屏/休眠）、剪贴板 N 秒清空、窗口防截屏 | |
| 同步 | 文件 watcher 自动重载 + 保存前外部变更检测与 merge | §8 |
| 进出 | 导入：CSV（Chrome/Edge 导出格式）；导出：KDBX 另存、CSV（双确认+明文警告） | |
| 外观 | 手绘涂鸦风纸张美学（奶白纸 #fffef5 + 墨黑 + 标记笔红/蓝绿/黄），虚线边框 + 硬偏移阴影；详见 §6.5；不做暗色模式（手绘涂鸦风无暗色范式） | 首屏一眼可识别为手绘涂鸦风；禁用项零出现 |
| 发布 | GitHub Releases + winget 清单，安装包 < 10MB | |

### v2（按用户反馈排优先级）

- 浏览器扩展（Chrome/Edge，MV3 + native messaging，自动填充/保存/TSV 推断）
- YubiKey challenge-response（第二解锁因子）
- 密码健康报告 + HIBP 离线 k-匿名查询（默认关闭，保持离线哲学）
- Bitwarden / 1Password / Proton Pass 导入器
- 附件
- **多设备同步矩阵**（详见 §8.5）：本地网盘文件夹（v1 已含 watcher，零开发）+ 应用内通用 WebDAV 连接器（一套代码覆盖坚果云/Nextcloud/NAS/自托管 VPS）+ 应用内 OneDrive OAuth 连接器；自托管部署套件（仓库 `deploy/` 目录，docker compose：Caddy + WebDAV + 可选服务端版本快照）作为通用 WebDAV 连接器的下游场景
- 离线缓存（本地保留密文副本，断网可用，联网后下次保存一并同步）

### 永久不做

SSH Agent、Secret Service、KeeShare、Passkeys、CLI、插件系统、自有云服务。（移动端自研已从"永久不做"调整为远期候选，见 §14）

## 6. 核心体验设计

### 6.1 解锁流

1. 应用启动 → 若上次库路径存在且已启用 Quick Unlock → 直接弹 Windows Hello 指纹/PIN → 解锁（DPAPI 解包密钥，见 §7）
2. Hello 失败/未启用 → 主密码 + 可选密钥文件输入框
3. 解锁后主窗口进入就绪态，快速面板全局可用

### 6.2 快速访问面板（产品灵魂）

- 全局快捷键（默认 `Alt+Space`，可配）呼出无边框置顶小窗，居中偏上
- 单输入框即时搜索：标题/用户名/URL/标签；结果按「最近使用 > 收藏 > 匹配度」排序
- `Enter` 复制密码（气泡确认+倒计时清空剪贴板）；`Tab` 展开次级动作；`Esc` 关闭
- TOTP 条目显示实时倒计时环；`Ctrl+C` 再按一次直接复制当前 TOTP
- 失焦自动隐藏；面板内所有键盘操作可达，鼠标可选

### 6.3 主界面

经典三栏手绘风重制：左侧分组树（可折叠/拖拽）、中列条目列表（紧凑/舒适双密度、最近使用置顶）、右侧详情面板。卡片用虚线边框 + 硬偏移阴影（见 §6.5）。编辑用抽屉/弹窗表单，所有"复制"按钮带一次性反馈。空态给新手引导（新建/导入/打开现有库）。

### 6.4 Auto-Type 策略（关键产品决策）

**抛弃 KeePassXC 的窗口关联规则系统**（那是它"繁琐"的主要来源之一）。KeyLite 的流程：焦点放在目标窗口 → 按全局快捷键 → 面板里搜两下 → 选中 → Auto-Type 键入。条目可选自定义序列（KeePass 语法的常用子集），最近使用自动置顶。不做自动匹配，把选择权显式交还用户，换取零配置。

### 6.5 设计语言：手绘涂鸦风

整体采用手绘涂鸦风（Hand-Drawn Doodle）作为唯一设计语言——纸张美学、虚线手绘线条、标记笔配色。完整提示词与 token 字典存于 `docs/design/hand-drawn-doodle-stylekit.md`，本节是 spec 内的摘要与适配策略。

**核心 token**：
- 背景：奶白纸张 `#fffef5`、辅 `#f8f7f0`
- 文字/边框：墨黑 `#2c2c2c`
- 标记笔强调色：红 `#ff6b6b`、蓝绿 `#4ecdc4`、黄 `#ffd93d`
- 边框：`border-2 border-dashed border-[#2c2c2c]`，圆角 `rounded-sm`
- 阴影：硬偏移 `shadow-[4px_4px_0px_#4ecdc4]`（hover 加大并改色）
- 动效：`transition-all duration-200 ease-in-out`；hover 微小位移，active 压平阴影 + `scale-[0.98]`

**绝对禁止**（出现即重写）：`bg-gradient-*`、`shadow-sm/md/lg/xl`、`backdrop-blur`、`rounded-none/lg/xl/2xl/full`、`border-solid`、`font-mono`。

**适配策略**：
- 不用成品 UI 组件库（Naive UI 等外观不可改造）；用 Radix-Vue 提供无头可访问性骨架，外壳全自写
- v1 不做暗色模式（手绘涂鸦风无暗色范式）；"深色手绘纸张"留作后期彩蛋
- 主界面、快速面板、解锁页、设置、空态、错误态全部贯彻同一套 token，无例外
- 主界面三栏数据组件（树/列表/详情）外壳开发量约两周，构成 M1 的主要工作

**校验**：每次前端 PR 自检 token 字典与禁止项（stylekit 文件末尾的 CHECKLIST）。

### 6.6 条目数据模型

**建库时（一次性）**：

| 字段 | 必填 | 落点 |
|---|---|---|
| 主密码 | 是 | 经 Argon2id 派生加密密钥；忘了 = 库报废，UI 二次确认 |
| 密钥文件 | 否 | 第二因子；KeyLite 可生成随机 key file |
| 库名称/描述 | 否 | 纯元数据 |

**条目录入（核心五件套为表单默认露出的字段）**：

| 字段 | UI 必填 | KDBX 落点 |
|---|---|---|
| 标题 | 是 | `entry.fields.Title` |
| 用户名 | 否 | `entry.fields.UserName` |
| 密码 | 否（生成器可代填） | `entry.fields.Password`（ProtectedValue） |
| 网址 | 否（favicon 与"打开 URL"靠它，强烈建议填） | `entry.fields.URL` |
| 备注 | 否 | `entry.fields.Notes` |

**组织**：分组（必属一组，默认根组）、标签（多值，逗号分隔）。

**可选增强**（折叠在"高级"区）：

| 字段 | 落点 | 典型用途 |
|---|---|---|
| TOTP 密钥 | 自定义属性 `otp` = `otpauth://` URI | 与 KeePassXC/KeeWeb 通用兼容格式，互认 |
| 自定义 Auto-Type 序列 | `entry.autotype.defaultSequence` | 登录框顺序特殊的网站 |
| 过期时间 | `entry.times` | 到期提醒改密码 |
| 自定义字段（键值对） | `entry.fields` 扩展 | 恢复码、安全问题答案、CVV——勾"保护"则存为 ProtectedValue |

**自动处理（用户不填）**：favicon（按 URL 自动下载）、UUID、创建/修改/访问时间、条目历史版本（每次保存自动快照）、回收站归属。

**物理存储**：全部落在单个 `vault.kdbx` 文件里——条目、分组、TOTP、历史、图标、附件（v2）一体打包，密文一体。位置由用户决定（本地/网盘/远程 WebDAV，见 §8/§8.5）。

## 7. 数据安全设计

| 主题 | 设计 |
|---|---|
| 加密边界 | 全部由 kdbxweb（ChaCha20/AES）+ hash-wasm（Argon2id）承担；本项目零自研加密 |
| 内存保护 | 敏感值以 kdbxweb `ProtectedValue`（XOR）驻留；锁定时销毁凭据与解密态；不做内存 swap 排除（v1 接受该权衡，文档明示） |
| Quick Unlock | 解锁成功后把库密钥用 Windows DPAPI（`CryptProtectData`，绑定当前用户）加密缓存；Hello 验证通过才解包使用；锁定/改密/关机即弃。权衡同 KeePassXC 现行方案 |
| 剪贴板 | 复制后默认 30s 清空（可配 10-90s），清空前 5s 提示 |
| 自动锁定 | 空闲（默认 5min）/ Windows 锁屏 / 系统休眠，任一触发 |
| 防截屏 | 主窗口与快速面板默认开启 `SetThreadDisplayAffinity`（Tauri 插件提供），可关 |
| 原子写入 | 保存 = 写 `*.kdbx.tmp` → fsync → rename 替换；任何中断不损坏原库 |
| 备份 | 每次成功打开库时滚动维护 `*.kdbx.bak`（保留上一版）；损坏库的恢复路径写进错误提示 |
| 数据库默认参数 | KDBX 4.1 + Argon2id（64MB / 2 迭代）+ ChaCha20，与 KeePassXC 默认一致 |

### 7.1 Quick Unlock（Windows Hello 快速解锁）详解

两阶段机制：

**① 启用一次**（用户勾「启用快速解锁」时）：输主密码 → kdbxweb 解密库 → 把库密钥用 Windows DPAPI（`CryptProtectData`，绑定当前 Windows 账户）加密 → 存本机 AppData `quick-unlock.key`。

**② 日常解锁**（每次启动 KeyLite）：按「Hello 解锁」→ Windows 弹指纹/PIN → 验证通过 → DPAPI 解包 `quick-unlock.key` → 拿到库密钥 → 解密 `vault.kdbx` → 进入就绪态。

**安全降级点**：从「主密码强度」降到「Windows 账户 + Hello 验证强度」。最糟攻击链：有人偷你 Windows 密码 + 知道你的 PIN → 密码库跟着失守。只要 Windows 账户本身干净，安全性与电脑本身的安全等同。

**先例**：KeePassXC、1Password、Bitwarden 桌面端、Enpass——所有桌面密码管理器都这么做，成熟权衡。

**失效条件**：库锁定后立刻弃用（要重新输主密码重新启用）、改密即弃、关机即弃、换 Windows 账户即弃。日常体验：开机一次主密码 + 启用，之后整天指纹，第二天再来一次主密码，循环。

**DPAPI 特性**：加密时绑定当前 Windows 账户的密钥链——别的账户、别的机器、拷走 `quick-unlock.key` 文件都解不开。

## 8. 多设备同步（文件哲学）

**心智模型**：库里只有一个加密文件，放哪、怎么传是用户的自由；应用负责感知它的变化。

1. **自动重载**：文件 watcher 监听当前库文件；检测到外部修改（网盘推送）→ 若本端无未保存修改 → 用内存中现有凭据重新解密新版本，界面无感刷新；若库处于锁定态则仅记录"有新版本"并在下次解锁时加载
2. **保存前检测**：落盘前比对 mtime+size；发现外部变更 → 先 `db.merge(remoteDb)`（kdbxweb 条目级三方合并，按 UUID）再保存；合并不可自动完成时提示用户选择（本地版 / 远端版 / 双保存）
3. **兜底**：不拦截 OneDrive/坚果云的冲突副本机制，用户文件永不静默丢弃
4. **v1 边界**：不解析网盘客户端、不内置任何传输协议

### 8.5 多设备同步矩阵（v2，对应 §5 v2 同步条目）

v1 只做"本地文件 + 网盘文件夹自动重载"，零应用内传输代码。v2 把传输收进应用，但仍**不引入自有同步协议**——只是 HTTP 文件读写。

**客户端连接器**：
- **通用 WebDAV 连接器**：URL + 账号密码（DPAPI 包裹存储），拒绝明文 HTTP。一套代码覆盖坚果云、Nextcloud、群晖 NAS、自托管 VPS
- **OneDrive OAuth 连接器**：浏览器登录微软账号 → OAuth 授权 → 自动后台同步。覆盖"没域名没服务器"的最大众人群
- 都复用 §8.1 watcher 重载、§8.2 保存前 merge 的现有逻辑；只是"本地文件"换成"远程 URL"，watcher 换成"窗口获焦时 HEAD/ETag 轮询"
- 保存用 PUT + `If-Match`（ETag 乐观锁）；服务端不支持 ETag 时降级为 mtime+size 比对

**离线缓存**：
- 本地保留一份密文副本，断网仍可读写；联网后下次保存时一并同步
- 与 §8.1 自动重载共用 merge 路径（本地版 + 远程版的条目级合并）

**自托管部署套件**（仓库 `deploy/` 目录，docker compose）：
- Caddy（Let's Encrypt 自动 HTTPS + basic auth + 限流）+ WebDAV 后端 + 可选服务端版本快照（相当于服务端滚动 .bak）
- 用户在自己 VPS 上两条命令拉起；套件不含任何加密代码，只服务静态密文
- 默认公网暴露（HTTPS + 强密码 + 限流）；高级选项可只监听 VPN 接口（Tailscale/WireGuard）
- 作为通用 WebDAV 连接器的下游场景之一，不是必选项

**威胁模型**：服务器永远只见密文；服务器被攻破 = 攻击者拿密文做离线爆破，被 Argon2id（64MB/2 迭代）顶住，与 OneDrive/坚果云同级。若用密钥文件作第二因子，密钥文件不得与库同服务器。

## 9. 错误处理与数据完整性

- 打不开库：区分「坏密码 / 密钥文件不匹配 / 文件损坏 / KDBX 版本过老」，损坏时引导 `.bak` 恢复
- 写失败（磁盘满/占用）：保留内存态，提示重试或另存，绝不半写
- watcher 误触发（临时文件）：只认与库同名的最终文件，忽略 `.tmp` 和网盘的同步中间态
- 崩溃恢复：自动保存草稿仅存于内存，崩溃即弃——宁丢一次编辑，不写坏一个库

## 10. 测试策略

| 层 | 手段 |
|---|---|
| 格式互操作 | CI 里用 kdbxweb 往返测试 + 固定样本库集（KeePassXC 2.7.12 与 KeyLite 双向打开/编辑/保存/再打开比对） |
| merge | kdbxweb 自带测试沿用 + 并发编辑场景用例（双向修改、删除 vs 修改） |
| 前端 | Vitest 单测（仓库层状态机、搜索索引、生成器）+ Playwright 组件 E2E |
| Rust | cargo test（Auto-Type 序列解析、watcher 状态机）；Hello/DPAPI 手动测试矩阵（PIN/指纹/未设置/取消） |
| 安全 | 发布前手工清单：锁定后内存扫描不残留明文密码、剪贴板清空计时、防截屏验证、断电写库测试 |

## 11. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| kdbxweb 停更 5 年 | 中 | vendor 收编（MIT 允许），格式本身冻结；有 bug 自己修，升级自己控 |
| Argon2 wasm 性能（解锁延迟） | 中 | KeeWeb 同路径已验证；M0 就做真实库的解锁耗时基线，慢则调 wasm 后端 |
| Windows Hello + DPAPI 集成坑 | 中 | M2 早期先做 spike；失败则 v1 降级为仅主密码解锁，不阻塞发布 |
| 单人维护长跑 | 高 | 范围纪律：v1 清单冻结，新想法一律进 backlog；每个里程碑可发布 |
| 密码管理器安全责任 | 高 | 零自研加密、原子写入、备份兜底、发布前安全清单；issues 里安全类置顶响应 |

## 12. 开放问题（评审时定）

1. 正式名称与图标（KeyLite 是占位）
2. 快速面板默认快捷键 `Alt+Space` 与 PowerToys Run 冲突时的让位策略（检测冲突并提示改键）
3. CSV 导出是否 v1 就给（有明文泄露风险 vs 用户迁移刚需）——倾向给，双确认
4. 发布节奏：MVP 后的 winget 上架时机
5. **代码托管与发布渠道：开发期纯本地（不开 GitHub 仓库），是否/何时公开由 Jong 后期自行决定**——M3 的"GitHub Releases + winget"仅为候选发布形态，不构成对外承诺

## 13. 里程碑草案

| 里程碑 | 内容 | 出口条件 |
|---|---|---|
| M0 骨架 | Tauri+Vue 跑通、kdbxweb vendor+argon2 接入、打开/编辑/保存真实 KDBX、KeePassXC 互操作 demo | 真实库解锁 < 2s，往返无损 |
| M1 核心 | 条目/分组/标签/回收站 CRUD、搜索索引、生成器、TOTP、三栏主界面+主题 | 全功能可日常自用 |
| M2 快捷 | 快速面板、全局快捷键、Auto-Type、Hello 解锁、自动锁定、剪贴板清空 | "便捷"卖点成立 |
| M3 发布 | watcher 同步、merge、导入导出、错误处理打磨、安全清单、安装包+签名 | v1 对外发布 |

## 14. 平台扩展路径（远期，不进 v1 范围）

**原则：先让生态替我们覆盖多端，再谈自研。** KDBX 是平台中性格式——数据格式锁死的是文件而不是客户端，这是选 KDBX 的最大长期红利：将来即使 KeyLite 停更，用户的库仍被整个生态接得住。

| 阶段 | 平台 | 路径 | 成本 |
|---|---|---|---|
| v1 | Windows | KeyLite 本体 | 本设计范围 |
| v1 发布即得 | iOS / Android | 不开发，用生态现成客户端：iOS KeePassium / Strongbox，Android KeePassDX——打开网盘里的同一个 .kdbx 直接读写 | 零开发；移动体验由这些 app 决定 |
| 远期候选 A | macOS | Tauri 2 原生支持 macOS；系统层三处替换：Windows Hello→Touch ID（LocalAuthentication）、DPAPI→Keychain、Auto-Type→CGEvent | 中；壳层与前端全部复用 |
| 远期候选 B | iOS / Android 自研 | Tauri 2 支持移动端，但真正的产品价值在系统级自动填充（iOS AutoFill Credential Provider / Android AutofillService），需双平台原生开发 | 大；独立立项 |
| 顺带 | Linux | Tauri 免费获得，但同样不投入、不承诺 | — |

**自研移动端触发条件**（满足其一才立项）：① 生态组合的体验成为 KeyLite 用户的主要抱怨；② 需要与快速面板/文件哲学一致的闭环体验；③ 有多人维护资源。

**中国区注意**：iOS 客户端在国区 App Store 的上架情况以实际搜索为准（不在则用外区账号）；Android 端可经 F-Droid / GitHub Releases 安装；同步网盘建议坚果云（WebDAV）或 OneDrive。
