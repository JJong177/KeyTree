export interface WebdavConfig {
  configured: boolean;
  url: string;
  username: string;
  hasPassword: boolean;
  lastSyncedAt: number | null;
}
export type WebdavEtagStatus = "nutstore-compatible" | "strong" | "missing" | "weak" | "invalid" | "not-checked";
export function isNutstoreWebdavUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "dav.jianguoyun.com" && (!url.port || url.port === "443") && url.pathname.startsWith("/dav/");
  } catch { return false; }
}
export interface WebdavConnection { exists: boolean; etagStatus: WebdavEtagStatus }
export function webdavConnectionMessage(result: WebdavConnection): string {
  if (!result.exists) return "连接已响应，但目标文件不存在；请核对完整目录和文件名。未创建任何文件。";
  switch (result.etagStatus) {
    case "strong": return "只读连接正常，KDBX 文件头和强 ETag 有效；尚未解密、合并或上传。条件写入支持仍需同步时确认。";
    case "nutstore-compatible": return "只读连接正常，已识别坚果云版本标识；同步时将原样条件上传，不补引号。尚未解密、合并或上传；远端版本变化时会停止。";
    case "missing": return "已读取 KDBX 文件头，但本次 GET 未返回 ETag；当前无法安全同步，未上传。";
    case "weak": return "已读取 KDBX 文件头，但本次 GET 只返回弱 ETag；不能用于安全条件上传，未上传。";
    case "invalid": return "已读取 KDBX 文件头，但本次 GET 的 ETag 格式不符合强校验要求；无法安全同步，未上传。";
    default: return "本次检测未返回完整的 ETag 诊断，尚不能确认安全上传条件；请更新应用后重新测试。未上传。";
  }
}

export interface WebdavPrepared { token: string; bytes: number[] | null }
export interface WebdavStat { mtimeMs: number; size: number; mtimeNs: string }
export interface WebdavCommitted { uploadedStat: WebdavStat; syncedAt: number; metadataSaved: boolean }
export type WebdavPhase = "unchecked" | "saving" | "downloading" | "merging" | "uploading" | "synced" | "pending" | "conflict" | "error" | "cancelled";
export interface WebdavState { phase: WebdavPhase; message: string; lastSyncedAt: number | null }
const messages: Record<string, string> = {
  WD_INVALID_URL: "请填写完整的 HTTPS WebDAV .kdbx 文件地址，不含查询参数或账号密码；不能使用网页分享链接。",
  WD_CREDENTIALS_REQUIRED: "请填写用户名和应用专用密码；更换账号或服务地址需重新授权。",
  WD_NOT_CONFIGURED: "请先保存 WebDAV 配置。",
  WD_CONFIG_IO: "本机同步配置无法读取或保存，请检查权限后重试。",
  WD_AUTH: "WebDAV 授权失败，请检查账号和应用专用密码。",
  WD_NETWORK: "无法连接 WebDAV，或请求超时。本地密码库仍可使用。",
  WD_REDIRECT: "服务器返回了重定向，已停止。请填写最终的 HTTPS 文件地址。",
  WD_REMOTE_MISSING: "远端文件不存在；确认地址后，可勾选允许首次创建。",
  WD_REMOTE_CHANGED: "远端在同步期间发生变化，未覆盖。请重新同步以合并最新版本。",
  WD_REMOTE_INVALID: "远端未通过 KDBX 文件验证，可能返回了网页、损坏文件或不支持的格式。请核对 WebDAV 文件路径；未上传。",
  WD_TOO_LARGE: "文件超过 64 MiB，同步已停止。",
  WD_ETAG_REQUIRED: "本次读取未取得可用的条件上传版本标识，已停止上传；请点测试连接查看具体原因。",
  WD_CREATE_UNSUPPORTED: "坚果云无法可靠保证首次创建不覆盖，已停止。请先在坚果云手动上传当前同一份 KDBX，再重新同步。",
  WD_LOCAL_CHANGED: "本地文件在同步期间发生变化，未上传。请重试同步。",
  WD_LOCAL_IO: "无法读取本地密码库，未上传。",
  WD_TICKET_INVALID: "同步授权已失效，请重新同步。",
  WD_CANCELLED: "同步已取消；已经发出的密文请求无法撤回。",
  WD_BUSY: "另一个操作正在进行，请稍后重试。",
  WD_SERVER: "WebDAV 服务器未确认操作成功，请稍后重新同步。",
  WD_UNSUPPORTED: "当前系统不支持安全保存 WebDAV 凭据。",
  WD_REMOTE_KEY: "当前凭据无法打开远端库。请核对主密码和密钥文件，未上传。",
  WD_DIFFERENT_VAULT: "远端与本地不是同一个密码库，已停止。请先下载并打开同一份 KDBX。",
  WD_PUBLIC_CONFLICT: "两端公开提示或其他公开元数据不同，无法自动合并，未上传。请先另存副本并核对。",
  WD_LOCAL_SAVE: "本地修改未能全部保存，未上传。请先重试保存或另存副本。",
};
export function webdavErrorCode(error: unknown): string {
  const value = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return Object.prototype.hasOwnProperty.call(messages, value) ? value : "WD_UNKNOWN";
}
export function webdavErrorMessage(error: unknown): string {
  return messages[webdavErrorCode(error)] ?? "同步操作未完成，请检查配置后重试。本地密码库仍可使用。";
}
export function webdavIsConflict(code: string): boolean {
  return ["WD_REMOTE_CHANGED", "WD_REMOTE_KEY", "WD_DIFFERENT_VAULT", "WD_PUBLIC_CONFLICT", "WD_LOCAL_CHANGED"].includes(code);
}
