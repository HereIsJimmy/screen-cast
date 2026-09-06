import { createRouter, createWebHistory } from "vue-router";
import LibraryView from "@/views/LibraryView.vue";
import SettingsView from "@/views/SettingsView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "library", component: LibraryView },
    { path: "/play/:id", name: "player", component: LibraryView },
    { path: "/ver/:id", name: "watch", component: LibraryView },
    { path: "/ajustes", name: "settings", component: SettingsView },
  ],
});
