<script setup lang="ts">
import Modal from "./Modal.vue";

defineProps<{
  title: string;
  message: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{ confirm: []; close: [] }>();
</script>

<template>
  <Modal @close="emit('close')">
    <div class="confirm-dialog">
      <h3>{{ title }}</h3>
      <p>{{ message }}</p>
      <p v-if="error" class="error-box">{{ error }}</p>
      <div class="confirm-actions">
        <button class="btn secondary" type="button" :disabled="busy" @click="emit('close')">Cancelar</button>
        <button class="btn danger" type="button" :disabled="busy" @click="emit('confirm')">
          {{ busy ? "Eliminando…" : (confirmLabel ?? "Eliminar") }}
        </button>
      </div>
    </div>
  </Modal>
</template>
