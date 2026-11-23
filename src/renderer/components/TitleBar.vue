<template>
  <header class="caption">
    <div v-if="host === 'darwin'" class="traffic-spacer" aria-hidden="true"></div>
    <button
      type="button"
      class="caption-toggle"
      :aria-expanded="expanded"
      aria-controls="left-sidebar"
      :aria-label="label"
      :title="label"
      @click="emit('toggle')"
    >
      <AppIcon name="sidebar" :size="15" />
    </button>
    <span class="caption-title">
      <AppIcon name="brand" :size="14" class="caption-glyph" />
      SMSW · 多系统工作台
    </span>
    <div v-if="host === 'win32'" class="wco-spacer" aria-hidden="true"></div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useWorkbench } from '../store.js';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ expanded: boolean }>();
const emit = defineEmits<{ toggle: [] }>();
const { ui } = useWorkbench();
const host = computed(() => ui.value?.host ?? 'win32');
const label = computed(() => props.expanded ? '收起侧栏' : '展开侧栏');
</script>
