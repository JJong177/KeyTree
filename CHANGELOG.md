# 更新日志 / Changelog

## 0.2.1 — 2026-11-14

### 新增与优化

- 侧栏支持按账号筛选；过长名称会裁切，并可通过主题化提示查看完整名称。
- 凭据字段可独立复制；账号支持自动补全与已保存账号复用。
- 新建条目可先填写网址并自动获取网站标题；失败时安全回退到域名，且不覆盖手动标题。
- 支持账号预填和不阻塞保存的相似条目预览；凭据候选优先匹配当前账号，并按最近使用排序。
- 支持批量移动、追加标签和移至回收站，不提供永久批量删除；采用受保护的单次保存，失败时仅重试保存。
- 底部以紧凑状态显示同步进度。
- 关于页面显示原生应用版本，支持手动或静默启动检查更新并缓存 24 小时；更新说明以纯文本显示，并提供安全的官方 Release 与安装包链接。不自动安装或重启。

### 发布说明

- Windows x64 安装包未签名，Windows 可能显示 SmartScreen 或未知发布者警告。
- 已安装 0.2.0 的用户须先手动安装 0.2.1，之后才能收到后续版本提醒。

### English summary

- Filter accounts in the sidebar; long names are clipped with a themed tooltip for the full name.
- Copy credential fields independently; account autocomplete and reuse of saved accounts are supported.
- Create entries URL-first with automatic website titles, a safe domain fallback, and preservation of manually entered titles.
- Account prefill and similar-entry previews do not block saving; credential candidates prioritize the current account and recent use.
- Bulk move, tag append and move-to-recycle-bin actions use one guarded save with save-only retry on failure; there is no permanent bulk deletion.
- A compact footer shows sync status.
- About displays the native app version and supports manual or silent-on-startup release checks with a 24-hour cache. Notes are plain text, with safe official release and installer links; there is no automatic installation or restart.

### Release notes

- The Windows x64 installer is unsigned; Windows may show a SmartScreen or unknown-publisher warning.
- Users on 0.2.0 must manually install 0.2.1 before they can receive reminders about later versions.

## 0.2.0 — 2026-10-26

### 新增与优化

- 分组支持新建一级与子分组、拖拽排序和调整层级，提供六点拖拽手柄与右键菜单。
- 侧栏隐藏根分组；默认展示全部条目，重复点击当前分组可取消筛选。
- 删除分组改为确认弹窗，明确子分组与条目的影响，区分回收站与永久删除。
- 登录页最近访问支持逐条移除，仅删除访问记录，不删除密码库文件。
- 新增按密码库设置的“锁定时自动同步”开关，默认关闭；先保存并锁定，再上传密文。远端版本不一致时停止，提示解锁后手动合并，不强制覆盖。没有定时或保存后自动同步。
- 精简设置说明，进阶说明按需展开，统一下拉选择控件并改善键盘与焦点交互。
- 改善本机剪贴板账号识别：支持更多字段语义与文本/HTML 组合；歧义值须明确选择，密码字符保持原样，确认后仍需手动保存。

### 修复与安全

- 修复重新解锁后加密档位固定显示“推荐”的问题，按实际参数显示标准档位或自定义参数。
- 新建密码库使用 Argon2id 推荐参数，提供带备份与解密验证的加密强度升级；保留更高的已有成本。
- 加强本机快捷解锁策略、设置与编辑状态保护，锁定同步失败不阻止安全锁定。

### 发布说明

- Windows x64 安装包：`KeyTree-Setup.exe`。安装包未签名，Windows 可能显示 SmartScreen 或未知发布者提示。
- 旧备份与云端历史不会随加密参数或主密码更改而自动更新，请独立保管主密码、密钥文件与备份。
- 发布检查：176 项前端回归、65 项 Rust 测试、两组浏览器回归、类型检查和 Windows x64 NSIS 构建通过。
- 本次未执行实际安装、真实网盘账户或完整桌面端到端验收。

### English summary

- Improved groups: create, reorder/reparent by drag-and-drop, context menus and explicit delete confirmation; hide vault roots and toggle group filtering.
- Remove recent-vault records without deleting vault files.
- Optional per-vault sync on lock: lock first, then conditionally upload saved ciphertext; changed remote versions require manual merge after unlocking. No periodic or save-triggered automatic sync.
- Simplified settings, consistent selects, better focus handling and local clipboard recognition with explicit ambiguous-field choices.
- Correct encryption-profile display after reopening; stronger new-vault defaults and verified, backed-up upgrades.
- Unsigned Windows x64 installer. Fresh installation, real cloud services and full native end-to-end acceptance were not tested for this release.

## 0.1.0 — 2026-10-22

- 首个公开版本：本地 KDBX 密码库、分组与搜索、密码生成、TOTP、快速面板与自动输入。
- Windows Hello、空闲自动锁定、剪贴板清理、手动 WebDAV 同步与多版本加密备份。
- First public Windows x64 release with local vault management, everyday access tools, manual WebDAV sync and encrypted backups.
