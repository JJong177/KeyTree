# WebDAV sync

1. Back up your vault, then open **Settings → Sync (设置 → 同步)** and enter the full HTTPS `.kdbx` file URL, username and application-specific password.
2. Save, test the connection, then click **Sync now (立即同步)**.
3. Sync before and after editing on another device. Optional sync on lock locks first, then uploads saved ciphertext only if the remote has not changed; otherwise unlock and sync manually to merge. There is no periodic sync.

**Jianguoyun:** upload the same KDBX first, then use its file URL, such as `https://dav.jianguoyun.com/dav/KeyTree/vault.kdbx`. Use an application password, not a sharing link.

Do not sync the same local file with a cloud-drive client at the same time. Mobile devices need a separate compatible app; transfer key files safely and independently. Real-service compatibility still needs verification.

On conflict, back up and sync again—do not force an overwrite. A local save or a successful connection test does not confirm an upload.
