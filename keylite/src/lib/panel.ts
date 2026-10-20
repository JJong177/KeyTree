/** 主窗口 ↔ 快速面板（独立窗口）之间的事件协议 */

export interface PanelEntry {
  id: string;
  title: string;
  username: string;
  url: string;
  hasTotp: boolean;
  tags: string[];
  updatedAt: number | null;
}

export type PanelRequest =
  | { kind: "sync" }
  | { kind: "copy-password"; id: string }
  | { kind: "copy-totp"; id: string }
  | { kind: "auto-type"; id: string }
  | { kind: "focus"; id: string };

export type PanelResponse =
  | { kind: "state"; unlocked: boolean; entries: PanelEntry[] }
  | { kind: "password"; id: string; value: string; ttl: number }
  | { kind: "totp"; id: string; code: string; remaining: number };

/** 面板 → 主窗口 */
export const PANEL_REQUEST_EVENT = "keytree:panel-request";
/** 主窗口 → 面板 */
export const PANEL_RESPONSE_EVENT = "keytree:panel-response";
/** Rust 侧每次呼出面板时广播（需与 lib.rs 里的字符串一致） */
export const PANEL_OPENED_EVENT = "panel:opened";
