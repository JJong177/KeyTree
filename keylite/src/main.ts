import { createApp } from "vue";
import App from "./App.vue";
import PanelApp from "./panel/PanelApp.vue";
import "./style.css";

const isPanel =
  new URLSearchParams(window.location.search).get("panel") === "1";

if (isPanel) {
  document.documentElement.classList.add("panel-window");
  createApp(PanelApp).mount("#app");
} else {
  createApp(App).mount("#app");
}
