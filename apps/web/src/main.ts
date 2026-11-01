import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./legacy-features.css";
import "./template-bridge.css";

createApp(App).use(createPinia()).mount("#app");
