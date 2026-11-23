<template>
  <svg
    class="icon"
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="1.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="markup"
  ></svg>
</template>

<script setup lang="ts">
import { computed } from 'vue';

// Inline SVG only: the workbench CSP forbids remote assets.
const ICONS: Record<string, string> = {
  brand: '<rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" fill="currentColor" stroke="none"/><rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" fill="currentColor" stroke="none" opacity=".5"/><rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" fill="currentColor" stroke="none" opacity=".5"/><rect x="9" y="9" width="5.5" height="5.5" rx="1.2" fill="currentColor" stroke="none"/>',
  sidebar: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M5.5 2.5v11"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4"/>',
  home: '<path d="M2.5 7L8 2.5 13.5 7v6a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z"/>',
  copy: '<rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/>',
  close: '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/>',
  left: '<path d="M10 3L5 8l5 5"/>',
  right: '<path d="M6 3l5 5-5 5"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5"/>',
  chevron: '<path d="M6 3l5 5-5 5"/>',
};

const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 16 });
const markup = computed(() => ICONS[props.name] ?? '');
</script>
