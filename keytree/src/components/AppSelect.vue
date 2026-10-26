<script setup lang="ts" generic="T extends string | number">
import { onMounted, ref, watch } from "vue";
import {
  SelectRoot, SelectTrigger, SelectValue, SelectIcon, SelectPortal,
  SelectContent, SelectViewport, SelectItem, SelectItemText, SelectItemIndicator,
  SelectScrollUpButton, SelectScrollDownButton,
} from "radix-vue";

defineOptions({ inheritAttrs: false });
const props = withDefaults(defineProps<{
  modelValue: T;
  options: ReadonlyArray<{ value: T; label: string; description?: string; disabled?: boolean; depth?: number }>;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  size?: "default" | "compact" | "large";
  placeholder?: string;
}>(), { size: "default", placeholder: "请选择…" });
const emit = defineEmits<{ "update:modelValue": [value: T] }>();
const host = ref<HTMLElement | null>(null);
const portalTarget = ref<HTMLElement>();
const open = ref(false);
onMounted(() => {
  // Keep the popup in its dialog focus scope, but outside scroll/overflow containers.
  portalTarget.value = host.value?.closest<HTMLElement>('[role="dialog"]') ?? document.body;
});
watch(() => props.disabled, disabled => { if (disabled) open.value = false; });
function updateValue(value: string) {
  if (props.disabled) return;
  const option = props.options.find(item => String(item.value) === value);
  if (option && !option.disabled) emit("update:modelValue", option.value);
}
</script>

<template>
  <span ref="host" class="app-select" :class="$attrs.class" :style="$attrs.style">
    <SelectRoot v-model:open="open" :model-value="String(modelValue)" :disabled="disabled" @update:model-value="updateValue">
      <SelectTrigger :id="id" :aria-label="ariaLabel" :disabled="disabled" class="app-select-trigger" :data-size="size">
        <SelectValue :placeholder="placeholder" class="app-select-value" />
        <SelectIcon class="app-select-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8 10 4 4 4-4" /></svg>
        </SelectIcon>
      </SelectTrigger>
      <SelectPortal :to="portalTarget">
        <SelectContent data-app-select-content class="app-select-content" position="popper" align="start" :side-offset="6" :collision-padding="12" :body-lock="false">
          <SelectScrollUpButton class="app-select-scroll" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m7 14 5-5 5 5" /></svg></SelectScrollUpButton>
          <SelectViewport class="app-select-viewport">
            <SelectItem v-for="option in options" :key="String(option.value)" :value="String(option.value)" :disabled="option.disabled" :text-value="option.label" class="app-select-item">
              <span class="app-select-option" :style="option.depth ? { paddingInlineStart: `${Math.min(option.depth, 8) * 12}px` } : undefined">
                <SelectItemText class="app-select-label">{{ option.label }}</SelectItemText>
                <span v-if="option.description" class="app-select-description">{{ option.description }}</span>
              </span>
              <SelectItemIndicator class="app-select-check"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg></SelectItemIndicator>
            </SelectItem>
          </SelectViewport>
          <SelectScrollDownButton class="app-select-scroll" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m7 10 5 5 5-5" /></svg></SelectScrollDownButton>
        </SelectContent>
      </SelectPortal>
    </SelectRoot>
  </span>
</template>
