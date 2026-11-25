<template>
  <div class="sourcebar">
    <ToolbarRoot v-if="active" class="browser-tools" aria-label="网页导航">
      <ToolbarButton class="icon-button" aria-label="后退" title="后退" :disabled="!active.canGoBack" @click="navigate('back')">
        <AppIcon name="left" />
      </ToolbarButton>
      <ToolbarButton class="icon-button" aria-label="前进" title="前进" :disabled="!active.canGoForward" @click="navigate('forward')">
        <AppIcon name="right" />
      </ToolbarButton>
      <ToolbarButton class="icon-button" aria-label="刷新" title="刷新" @click="navigate('reload')">
        <AppIcon name="refresh" />
      </ToolbarButton>
    </ToolbarRoot>
    <span id="address" class="address" :title="address">{{ address }}</span>
    <button v-if="active?.address" type="button" class="icon-button" aria-label="复制地址" title="复制地址" @click="copyAddress">
      <AppIcon name="copy" :size="14" />
    </button>
    <span id="notice" role="status" :title="notice">{{ notice }}</span>
    <slot name="assistant" />
  </div>
</template>

<script setup lang="ts">
import { ToolbarButton, ToolbarRoot } from 'reka-ui';
import { useWorkbench } from '../store.js';
import AppIcon from './AppIcon.vue';

const { active, address, notice, navigate } = useWorkbench();

function copyAddress() {
  const value = active.value?.address;
  if (value) void navigator.clipboard.writeText(value).catch(() => {});
}
</script>
