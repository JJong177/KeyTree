import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
export type AuditKind = "unlock" | "copy-password" | "auto-type" | "merge";
export interface AuditState { enabled: boolean; epoch: number }
export interface AuditEvent { kind: AuditKind; entryUuid: string | null; at: number }
export const auditState = ref<AuditState>({ enabled: false, epoch: 0 });
export const auditError = ref("");
let ready = false, loading: Promise<void> | undefined, generation = 0;
let changes: Promise<void> = Promise.resolve();
let transitioning = 0;
export async function refreshAudit(): Promise<void> {
  const ticket = generation;
  try {
    const result = await invoke<AuditState>("audit_status");
    if (ticket !== generation) return;
    auditState.value = result; auditError.value = ""; ready = true;
  } catch {
    if (ticket !== generation) return;
    auditState.value = { enabled: false, epoch: 0 }; auditError.value = "本地审计不可用";
  }
}
export async function recordAudit(kind: AuditKind, entryUuid: string | null = null): Promise<void> {
  const ticket = generation;
  if (!ready) {
    loading ??= refreshAudit().finally(() => { loading = undefined; });
    await loading;
  }
  if (ticket !== generation || transitioning || !auditState.value.enabled) return;
  const epoch = auditState.value.epoch;
  try { await invoke<boolean>("audit_append", { kind, entryUuid, epoch }); }
  catch { auditError.value = "审计记录写入失败，密码操作不受影响"; }
}
function transition(command: string, args?: Record<string, unknown>): Promise<void> {
  generation++; transitioning++;
  // 后端 epoch 拒绝已经发出的旧追加；本地 generation 拒绝尚在等状态的旧动作。
  const task = changes.catch(() => {}).then(async () => {
    auditState.value = await invoke<AuditState>(command, args);
    auditError.value = ""; ready = true;
  });
  const settled = task.finally(() => { transitioning--; });
  changes = settled;
  return settled;
}
export function setAuditEnabled(enabled: boolean): Promise<void> { return transition("audit_set_enabled", { enabled }); }
export function clearAudit(): Promise<void> { return transition("audit_clear"); }
export async function readAudit(): Promise<AuditEvent[]> {
  const ticket = generation;
  await changes.catch(() => {});
  const result = await invoke<AuditState & { events: AuditEvent[] }>("audit_read");
  if (ticket !== generation) return [];
  auditState.value = { enabled: result.enabled, epoch: result.epoch }; ready = true;
  return result.events;
}
