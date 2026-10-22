import { onBeforeUnmount, onMounted } from "vue";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useVault } from "./useVault";

/**
 * 主窗口专属：响应 Rust watcher 的 keytree:vault-changed 事件。
 * 只挂在主窗口（面板窗口不挂，否则两边同时 merge + save 会打架）。
 * stat 比对（区分「自己刚写的」与「外部改的」）在 useVault 内部完成。
 */
export function useVaultSync(): void {
  const { unlocked, vaultPath, busy, syncExternalChanges } = useVault();
  let unlisten: UnlistenFn | undefined;

  onMounted(async () => {
    unlisten = await listen<string>("keytree:vault-changed", async (event) => {
      if (event.payload !== vaultPath.value) return; // 不是当前库
      if (!unlocked.value || busy.value) return; // 锁定态/进行中：下次操作时 saveVault 的前置检查兜底
      await syncExternalChanges();
    });
  });

  onBeforeUnmount(() => {
    unlisten?.();
  });
}
