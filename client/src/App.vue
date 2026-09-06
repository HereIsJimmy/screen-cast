<script setup lang="ts">
import { onMounted } from "vue";
import { initializeCast } from "@/services/cast";

// Kick off Cast SDK loading as soon as the app mounts so the "Cast" button
// is ready by the time the user picks a video.
onMounted(() => {
  initializeCast().catch((err) => {
    console.warn("No se pudo inicializar Google Cast todavía:", err);
  });
});
</script>

<template>
  <router-view />
</template>
