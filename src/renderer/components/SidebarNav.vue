<template>
  <aside id="left-sidebar" class="sidebar">
    <nav aria-label="工作台导航">
      <button
        id="home"
        type="button"
        class="side-button"
        aria-label="工作台"
        :aria-current="active ? undefined : 'page'"
        @click="dispatch({ type: 'select', id: null })"
      >
        <span class="side-icon"><AppIcon name="home" /></span>
        <span class="label">工作台</span>
      </button>
      <div class="group-label">应用入口</div>
      <div id="apps">
        <button
          v-for="entry in apps"
          :key="entry.id"
          type="button"
          class="side-button"
          :aria-label="`打开 ${entry.name}`"
          :aria-current="active?.appId === entry.id ? 'page' : undefined"
          :disabled="!entry.configured"
          @click="openApp(entry.id)"
        >
          <span class="side-icon"><span class="mark" :data-site="entry.id" aria-hidden="true">{{ entry.mark }}</span></span>
          <span class="label">{{ entry.name }}</span>
        </button>
      </div>
    </nav>
    <div class="side-end">
      <button type="button" class="side-button settings-entry" aria-label="设置" aria-haspopup="dialog" @click="emit('settings')">
        <span class="side-icon"><AppIcon name="settings" /></span>
        <span class="label">设置</span>
      </button>
      <p v-if="state?.mode === 'mock'" id="mode" class="mode">本地模拟站</p>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { useWorkbench } from '../store.js';
import AppIcon from './AppIcon.vue';

const emit = defineEmits<{ settings: [] }>();
const { state, apps, active, dispatch, openApp } = useWorkbench();
</script>
