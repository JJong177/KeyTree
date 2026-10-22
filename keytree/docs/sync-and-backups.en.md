# Backup and recovery

Open **Settings → Data → Versioned encrypted backups (设置 → 数据 → 多版本加密备份)**:

1. Click **Back up now (立即备份)** to copy the saved version. KeyTree also preserves the previous version before overwriting an existing valid vault.
2. Select a version and click **Verify preview (验证预览)**.
3. After verification, export a recovery copy to a new filename. The original is not overwritten.

Backups sit next to the vault in `<vault filename>.keytree-backups`. Limits per vault: **30 copies / 256 MiB total**, **64 MiB per copy**. Built-in sync does not upload this directory.

Older backups may need the old master password or key file. Retry failed saves or save a new copy. Keep another protected backup on an independent device.

For sync, see the [WebDAV guide](webdav-sync.en.md).
