import { createRouter, createWebHistory } from "vue-router";
import LibraryView from "@/views/LibraryView.vue";
import PlayerView from "@/views/PlayerView.vue";
import SettingsView from "@/views/SettingsView.vue";
import WatchView from "@/views/WatchView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", name: "library", component: LibraryView },
    { path: "/play/:id", name: "player", component: PlayerView, props: true },
    { path: "/ver/:id", name: "watch", component: WatchView, props: true },
    { path: "/ajustes", name: "settings", component: SettingsView },
  ],
});
