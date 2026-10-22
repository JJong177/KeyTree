/** 独立面板只接收展示数据；敏感值按会话和单次动作临时请求。 */
export interface PanelEntry {
  id: string; title: string; username: string; url: string; tags: string[];
  hasTotp: boolean; totpPeriod: number | null; icon: string | null;
  updatedAt: number | null; lastUsedAt: number | null; usageCount: number; favorite: boolean;
}
export type CopyAction = "password" | "username" | "totp";
export type PanelRequest =
  | { kind: "sync" }
  | { kind: "copy"; action: CopyAction; id: string; requestId: string; session: number }
  | { kind: "copied"; id: string; requestId: string; session: number }
  | { kind: "auto-type" | "focus"; id: string; session: number };
export type PanelResponse =
  | { kind: "state"; unlocked: boolean; session: number; entries: PanelEntry[] }
  | { kind: "copy"; action: CopyAction; id: string; value: string; ttl: number; requestId: string; session: number }
  | { kind: "notice"; message: string };
export const PANEL_REQUEST_EVENT = "keytree:panel-request";
export const PANEL_RESPONSE_EVENT = "keytree:panel-response";
export const PANEL_OPENED_EVENT = "panel:opened";
