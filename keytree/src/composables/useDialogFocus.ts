import { nextTick, onBeforeUnmount, onMounted, type Ref } from "vue";

const dialogs: symbol[] = [];
const focusable = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/** Topmost dialog owns keyboard focus; unmount for a security lock never asks permission. */
export function useDialogFocus(root: Ref<HTMLElement | null>, onEscape: () => void): void {
  const id = Symbol("dialog");
  let previous: HTMLElement | null = null;
  const topmost = () => dialogs[dialogs.length - 1] === id;
  const scope = () => root.value?.querySelector?.<HTMLElement>("[data-dialog-confirmation]") ?? root.value;
  function elements(): HTMLElement[] {
    return [...(scope()?.querySelectorAll<HTMLElement>(focusable) ?? [])].filter(el => !el.matches(':disabled') && !el.closest('[hidden], [inert]') && el.getClientRects().length > 0);
  }
  function focusFirst() { (elements()[0] ?? scope())?.focus(); }
  function keydown(event: KeyboardEvent) {
    if (!topmost() || event.isComposing) return;
    // A nested select handles Escape/Tab itself; its portal stays inside this scope.
    if ((event.key === "Escape" || event.key === "Tab") && scope()?.querySelector?.('[data-app-select-content][data-state="open"]')) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); onEscape(); }
    if (event.key !== "Tab") return;
    const items = elements();
    const first = items[0], last = items[items.length - 1];
    if (!first) { event.preventDefault(); root.value?.focus(); return; }
    const active = document.activeElement;
    if (!scope()?.contains(active) || (event.shiftKey ? active === first : active === last)) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus();
    }
  }
  function focusin(event: FocusEvent) {
    if (topmost() && scope() && !scope()!.contains(event.target as Node)) focusFirst();
  }
  onMounted(() => {
    previous = document.activeElement as HTMLElement | null;
    dialogs.push(id);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focusin, true);
    void nextTick(() => { if (topmost()) focusFirst(); });
  });
  onBeforeUnmount(() => {
    const wasTopmost = topmost();
    const index = dialogs.indexOf(id);
    if (index >= 0) dialogs.splice(index, 1);
    document.removeEventListener("keydown", keydown, true);
    document.removeEventListener("focusin", focusin, true);
    if (wasTopmost && previous?.isConnected) previous.focus();
  });
}
