# KeyTree

<div align="center">

**为 Windows 而生的轻量级 KDBX 密码管理器**

*A lightweight, KDBX-native password manager built for Windows*

`Tauri 2` · `Vue 3` · `TypeScript` · `Rust` · `MIT License`

</div>

---

## 简介.Introduction

KeyTree 是一款 Windows 优先的轻量密码管理器，数据格式 100% 兼容 KeePass（`.kdbx`）。不 fork、不重造加密轮子——加密核心完全复用经过实战检验的 kdbxweb（Argon2 + AES-256），自研部分只做体验：更快的启动、更顺手的交互、更贴近 Windows 原生的集成。

*KeyTree is a Windows-first, lightweight password manager with 100% KeePass compatibility (`.kdbx`). We don't fork, and we don't reinvent cryptography — the crypto core is the battle-tested kdbxweb (Argon2 + AES-256); our own code only handles the experience: faster startup, smoother interaction, and deeper Windows integration.*

## 核心特性.Features

| | |
|---|---|
| 🔐 **KDBX 完全兼容** · *Full KDBX compatibility* | 打开/保存 `.kdbx` 3.1 / 4.0，支持 Argon2d / Argon2id；与 KeePass2、KeePassXC、pykeepass、KeePassium 双向互通 |
| | *Open/save `.kdbx` 3.1/4.0 with Argon2d/Argon2id; interops bidirectionally with KeePass2, KeePassXC, pykeepass, KeePassium* |
| 🪟 **Windows 原生集成** · *Native Windows integration* | Windows Hello 快速解锁（DPAPI 密钥副本）、托盘常驻、防截屏、锁屏/休眠立即锁定 |
| | *Windows Hello quick unlock (DPAPI), tray resident, screenshot protection, instant lock on lock-screen/sleep* |
| ⌨️ **Auto-Type 快速面板** · *Auto-Type quick panel* | 全局快捷键唤起，快速搜索并自动填充用户名/密码，抛弃繁琐的窗口关联规则 |
| | *Global hotkey summons a quick panel to search & auto-fill credentials — no fiddly window-matching rules* |
| 🔑 **TOTP** · *One-time passwords* | 内置 RFC 6238 与 Steam 令牌，条目详情页直接显示倒计时 |
| | *Built-in RFC 6238 & Steam tokens with live countdown on the entry detail page* |
| 📋 **安全剪贴板** · *Secure clipboard* | 复制的密码按设定秒数自动清空，防截屏窗口内不可被捕捉 |
| | *Copied secrets auto-clear after a configurable delay; protected windows can't be captured* |
| 🔄 **WebDAV 同步** · *WebDAV sync* | 文件哲学：网盘分发 + 文件监视自动重载 + kdbxweb 合并 + 冲突副本兜底 |
| | *File-based philosophy: cloud distribution + file watching with auto-reload + kdbxweb merge + conflict-copy fallback* |
| 🩺 **库健康与审计** · *Vault health & audit* | 密码强度/复用/过期报告、HIBP 风格审计、库诊断与损坏恢复（滚动 .bak + 快照） |
| | *Strength/reuse/expiry reports, audit timeline, vault diagnostics & corruption recovery (rolling .bak + snapshots)* |
| 🗂 **完整的条目管理** · *Full entry management* | 收藏、回收站、历史版本、过期提醒、自定义图标/favicon 抓取、CSV 导入 |
| | *Favorites, recycle bin, history, expiry, custom icons/favicon fetch, CSV import* |

## 安全设计.Security Model

- **零自研加密** — 所有加密操作交给 kdbxweb + argon2-browser（WASM），本应用只做格式与交互。
  *Zero homemade crypto — all cryptography is delegated to kdbxweb + argon2-browser (WASM); the app only handles format & UX.*
- **原子写盘** — 临时文件 + fsync + rename 替换，进程崩溃不会留下半个库文件。
  *Atomic writes — temp file + fsync + rename; a crash never leaves half a vault.*
- **多重备份** — 滚动 `.bak`、快照、冲突副本三层兜底。
  *Layered backups — rolling `.bak`, snapshots, and conflict copies.*
- **最小权限** — 主密码提示存放在库文件公共头部（不开库也能读），快速解锁密钥副本由 DPAPI 绑定账户加密。
  *Least privilege — the master password hint lives in the vault's public header (readable without unlocking); the quick-unlock key copy is DPAPI-encrypted, bound to your Windows account.*

## 技术栈.Tech Stack

| 层.Layer | 选型.Choice | 理由.Why |
|---|---|---|
| 框架.Framework | Tauri 2 + Vue 3 + TypeScript | 体积小、启动快、原生 WebView2 |
| 组件.Components | Radix-Vue + Tailwind CSS | 无头组件 + 自绘自然有机风格外壳 |
| 加密.Crypto | kdbxweb (vendored) + argon2-browser (WASM) | 格式冻结、久经考验，覆盖 Argon2d/i/id |
| Rust 侧.Rust side | enigo / WinRT / syswatch | 仅 Auto-Type、Hello/DPAPI、文件监视三处自写 |

## 开发与构建.Development & Build

```bash
cd keylite

# 安装依赖 / Install dependencies
npm install

# 开发模式（需要 Rust + Tauri 2 环境）/ Dev (requires Rust + Tauri 2)
npm run tauri dev

# 构建 Windows 安装包 / Build the Windows installer
npm run tauri build

# 运行核心链路测试（Node + kdbxweb 互操作）/ Run core pipeline tests
npm test
```

> **文档.Docs**：同步与备份见 [`keylite/docs/sync-and-backups.md`](keylite/docs/sync-and-backups.md)；WebDAV 配置见 [`keylite/docs/webdav-sync.md`](keylite/docs/webdav-sync.md)。
> *For sync/backup details see the links above; WebDAV setup is covered in the docs.*

## 平台路线.Platform Roadmap

Windows 优先（当前），macOS / iOS / Android 为远期候选。过渡期建议移动端使用 [KeePassium](https://keepassium.com/)（iOS）或 [KeePassDX](https://www.keepassdx.com/)（Android）打开同一网盘库——这正是 KDBX 兼容的价值。

*Windows first (current); macOS/iOS/Android are long-term candidates. In the meantime, use KeePassium (iOS) or KeePassDX (Android) on mobile to open the same cloud-synced vault — that's exactly what KDBX compatibility buys you.*

## 许可证.License

[MIT](LICENSE) — 加密库与依赖各自的许可见其仓库。
*MIT — third-party components carry their own licenses, see their respective repos.*

---

<div align="center">

**KeyTree** · 你的密码，像树一样扎根在自己的文件里。

*Your passwords, rooted in your own files like a tree.*

</div>
