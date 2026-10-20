<script setup lang="ts">
import { useVault } from "./composables/useVault";
import { useAutoLock } from "./composables/useAutoLock";
import { useSystemGuard } from "./composables/useSystemGuard";
import { useVaultSync } from "./composables/useVaultSync";
import { usePanelHost } from "./composables/usePanelHost";
import UnlockView from "./components/UnlockView.vue";
import MainView from "./components/MainView.vue";
import ToastHost from "./components/ToastHost.vue";

const { unlocked } = useVault();

useAutoLock();
useSystemGuard();
useVaultSync();
usePanelHost();
</script>

<template>
  <UnlockView v-if="!unlocked" />
  <MainView v-else />
  <ToastHost />
</template>
