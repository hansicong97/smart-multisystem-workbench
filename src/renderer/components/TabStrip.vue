<template>
  <div class="tabbar">
    <span v-if="tabs.length" class="tab-heading">页面</span>
    <nav v-if="tabs.length" id="tabs" aria-label="已打开页面" @keydown="onKeydown">
      <div v-for="page in tabs" :key="page.id" class="tab" :data-page-id="page.id">
        <button
          class="tab-select"
          type="button"
          :aria-label="`切换到 ${pageName(page)}`"
          :aria-pressed="page.id === active?.id"
          :tabindex="page.id === active?.id ? 0 : -1"
          :title="page.title || pageName(page)"
          @click="dispatch({ type: 'select', id: page.id })"
        >{{ pageName(page) }}</button>
        <button
          class="tab-close"
          type="button"
          :aria-label="`关闭 ${pageName(page)}`"
          :tabindex="page.id === active?.id ? 0 : -1"
          @click="dispatch({ type: 'close', id: page.id })"
        >
          <AppIcon name="close" :size="12" />
        </button>
      </div>
    </nav>
  </div>
</template>

<script setup lang="ts">
import { useWorkbench } from '../store.js';
import AppIcon from './AppIcon.vue';

const { tabs, active, dispatch, pageName } = useWorkbench();

// Spec keyboard path: Tab enters the selected tab, arrows move, Home/End jump,
// Delete closes. Buttons keep role=button + aria-pressed for the existing contract.
function onKeydown(event: KeyboardEvent) {
  const list = tabs.value;
  if (!list.length) return;
  const index = list.findIndex((page) => page.id === active.value?.id);
  const focusTab = (id: number) => {
    dispatch({ type: 'select', id });
    const root = event.currentTarget as HTMLElement;
    root.querySelector<HTMLElement>(`[data-page-id="${id}"] .tab-select`)?.focus();
  };
  if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = list[(Math.max(0, index) + step + list.length) % list.length];
    if (next) focusTab(next.id);
  } else if (event.key === 'Home' || event.key === 'End') {
    event.preventDefault();
    const target = event.key === 'Home' ? list[0] : list[list.length - 1];
    if (target) focusTab(target.id);
  } else if (event.key === 'Delete') {
    const holder = (event.target as HTMLElement).closest<HTMLElement>('.tab');
    const id = Number(holder?.dataset.pageId) || active.value?.id;
    if (id) {
      event.preventDefault();
      dispatch({ type: 'close', id });
    }
  }
}
</script>
