import { reactive, watch } from "vue";

export interface AppSettings {
  /** 空闲多少分钟后自动锁定；0 = 关闭 */
  autoLockMinutes: number;
  /** 复制密码后多少秒清空剪贴板；0 = 不清空 */
  clipboardSeconds: number;
  /** 解锁成功后缓存 DPAPI 密钥副本，之后可用 Windows Hello 快速解锁 */
  quickUnlock: boolean;
  /** 窗口防截屏（截图/录屏里 KeyTree 显示为黑块） */
  screenshotProtection: boolean;
  /** 上次打开的库路径，解锁页预填 */
  lastVaultPath: string;
  /** 最近使用的库（多库支持，方案 A：一次解锁一个） */
  vaults: VaultMeta[];
  /** 开机自启（走 tauri-plugin-autostart，注册当前用户登录项） */
  launchAtLogin: boolean;
}

export interface VaultMeta {
  path: string;
  /** 展示名 = 文件名去掉 .kdbx */
  name: string;
  lastOpenedAt: number;
}

const MAX_VAULTS = 10;

/** 登记一个最近使用的库（去重、置顶、限量） */
export function upsertVault(path: string): void {
  if (!path) return;
  const normalized = path.replace(/\//g, "\\");
  const rest = settings.vaults.filter(
    (v) => v.path.replace(/\//g, "\\") !== normalized
  );
  const name = (path.split(/[\\/]/).pop() ?? path).replace(/\.kdbx$/i, "");
  settings.vaults = [
    { path, name, lastOpenedAt: Date.now() },
    ...rest,
  ].slice(0, MAX_VAULTS);
}

const STORAGE_KEY = "keytree.settings.v1";
/** 品牌改名前的旧键：首次读取时迁移过来 */
const LEGACY_STORAGE_KEY = "keylite.settings.v1";

function readStored(): string | null {
  return (
    localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
  );
}

const defaults: AppSettings = {
  autoLockMinutes: 10,
  clipboardSeconds: 30,
  quickUnlock: true,
  screenshotProtection: true,
  lastVaultPath: "",
  vaults: [],
  launchAtLogin: false,
};

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function load(): AppSettings {
  try {
    const raw = readStored();
    if (!raw) return { ...defaults };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      autoLockMinutes: clamp(
        Number(parsed.autoLockMinutes),
        0,
        240,
        defaults.autoLockMinutes
      ),
      clipboardSeconds: clamp(
        Number(parsed.clipboardSeconds),
        0,
        300,
        defaults.clipboardSeconds
      ),
      // 旧版本存的 JSON 没有这几项：布尔缺省 true（!== false），路径缺省空
      quickUnlock: parsed.quickUnlock !== false,
      screenshotProtection: parsed.screenshotProtection !== false,
      lastVaultPath:
        typeof parsed.lastVaultPath === "string" ? parsed.lastVaultPath : "",
      vaults: Array.isArray(parsed.vaults)
        ? parsed.vaults
            .filter((v) => v && typeof v.path === "string")
            .map((v) => ({
              path: v.path,
              name:
                typeof v.name === "string" && v.name
                  ? v.name
                  : (v.path.split(/[\\/]/).pop() ?? v.path),
              lastOpenedAt: Number(v.lastOpenedAt) || 0,
            }))
        : [],
      launchAtLogin: parsed.launchAtLogin === true,
    };
  } catch {
    return { ...defaults };
  }
}

export const settings = reactive<AppSettings>(load());

watch(
  settings,
  (value) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      // 存不进去也不影响使用
    }
  },
  { deep: true }
);
