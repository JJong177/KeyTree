import { ref } from "vue";

/** 全局轻提示：一次只显示一条，2 秒后自动消失 */
export const toastText = ref("");

let timer: number | undefined;

export function toast(msg: string, ms = 2000): void {
  toastText.value = msg;
  if (timer) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    toastText.value = "";
  }, ms);
}
