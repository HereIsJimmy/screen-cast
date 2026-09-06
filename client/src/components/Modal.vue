<script setup lang="ts">
import { onBeforeUnmount, onMounted } from "vue";

const emit = defineEmits<{ close: [] }>();

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") emit("close");
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal-panel" role="dialog" aria-modal="true">
      <button class="modal-close" type="button" aria-label="Cerrar" @click="emit('close')">✕</button>
      <slot />
    </div>
  </div>
</template>
