# Install and start

1. Run `KeyTree-Setup.exe`, choose Simplified Chinese or English, and follow the installer.
2. Launch KeyTree and create a vault or open an existing `.kdbx`.
3. Add an entry and confirm saving. Sync and backups are in **Settings (设置)**.

The installer targets Windows x64. Node.js and Rust are not required. If WebView2 is missing, the installer attempts an online installation. The language choice affects the installer only; the current app UI is Chinese.

**Keep the master password and key file safe; lost credentials cannot be bypassed.** The installer is unsigned. Check the source and supplied [SHA-256 checksum](SHA256SUMS.txt).

[Sync guide](../docs/webdav-sync.en.md) · [Backup guide](../docs/sync-and-backups.en.md)
