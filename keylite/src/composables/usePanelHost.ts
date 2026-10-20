import { onBeforeUnmount, onMounted } from "vue";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useVault } from "./useVault";
import { settings } from "../lib/settings";
import { generateTotp } from "../lib/totp";
import {
  PANEL_REQUEST_EVENT,
  PANEL_RESPONSE_EVENT,
  type PanelEntry,
  type PanelRequest,
  type PanelResponse,
} from "../lib/panel";

/**
 * 主窗口这一侧的「快速面板宿主」。
 * 面板是独立窗口，拿不到主窗口的内存状态，所以由主窗口应答它的事件请求。
 * 事件是进程内 IPC；密码只在「面板明确要复制」时才单独发一条，不随列表批量下发。
 */
export function usePanelHost(): void {
  const {
    unlocked,
    entries,
    draftOf,
    totpConfigOf,
    autoType,
    selectGroup,
    selectEntry,
  } = useVault();

  let unlisten: UnlistenFn | undefined;

  function snapshot(): PanelEntry[] {
    return entries.value
      .filter((entry) => !entry.inTrash)
      .map((entry) => ({
        id: entry.uuid,
        title: entry.title,
        username: entry.username,
        url: entry.url,
        hasTotp: entry.hasTotp,
        tags: entry.tags,
        updatedAt: entry.updatedAt ? entry.updatedAt.getTime() : null,
      }));
  }

  async function reply(payload: PanelResponse): Promise<void> {
    await emit(PANEL_RESPONSE_EVENT, payload);
  }

  async function handle(request: PanelRequest): Promise<void> {
    switch (request.kind) {
      case "sync":
        await reply({
          kind: "state",
          unlocked: unlocked.value,
          entries: snapshot(),
        });
        break;

      case "copy-password": {
        const draft = draftOf(request.id);
        if (!draft) return;
        await reply({
          kind: "password",
          id: request.id,
          value: draft.password,
          ttl: settings.clipboardSeconds,
        });
        break;
      }

      case "copy-totp": {
        const config = totpConfigOf(request.id);
        if (!config) return;
        const result = await generateTotp(config);
        await reply({
          kind: "totp",
          id: request.id,
          code: result.code,
          remaining: result.remaining,
        });
        break;
      }

      case "auto-type": {
        await autoType(request.id);
        break;
      }

      case "focus": {
        await invoke("show_main_window");
        selectGroup("all");
        selectEntry(request.id);
        break;
      }
    }
  }

  onMounted(async () => {
    unlisten = await listen<PanelRequest>(PANEL_REQUEST_EVENT, (event) => {
      void handle(event.payload);
    });
  });

  onBeforeUnmount(() => unlisten?.());
}
