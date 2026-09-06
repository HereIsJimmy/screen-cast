import { fileURLToPath, URL } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    host: true, // listen on LAN too, useful for testing from your phone in dev mode
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
    watch: {
      // Native OS file-change notifications don't reach chokidar reliably on
      // some network/virtual drives (mapped drives, cloud-synced folders,
      // etc.) — if that's the case here, changes silently never trigger a
      // reload. Polling is slightly heavier but always works. If you're on a
      // normal local disk and don't need this, feel free to remove it.
      usePolling: true,
      interval: 300,
    },
  },
});
