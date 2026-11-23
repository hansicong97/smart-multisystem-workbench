<template>
  <div class="workbench" :class="shellClass" :style="shellVars">
    <TitleBar :expanded="expanded" @toggle="toggle" />
    <SidebarNav @settings="settingsOpen = true" />
    <main class="workspace">
      <header class="chrome">
        <TabStrip />
        <CommandBar />
      </header>
      <div class="content-cell">
        <div ref="slot" class="web-slot" aria-hidden="true"></div>
        <DashboardHome v-if="!active" />
      </div>
    </main>
    <SettingsDialog v-model:open="settingsOpen" @patch="dispatch({ type: 'setPreference', patch: $event })" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, watchEffect } from 'vue';
import { useAccessibilityReporter } from './accessibility.js';
import { useBoundsReporter } from './bounds.js';
import { useSidebar } from './sidebar.js';
import { useWorkbench } from './store.js';
import CommandBar from './components/CommandBar.vue';
import DashboardHome from './components/DashboardHome.vue';
import SettingsDialog from './components/SettingsDialog.vue';
import SidebarNav from './components/SidebarNav.vue';
import TabStrip from './components/TabStrip.vue';
import TitleBar from './components/TitleBar.vue';

const { api, state, error, active, ui, dispatch } = useWorkbench();
const slot = ref<HTMLElement>();
const settingsOpen = ref(false);

const host = computed(() => ui.value?.host ?? 'win32');
// The 43px caption strip is universal; only the host window controls differ
// (Windows overlay buttons on the right, macOS traffic lights on the left).
const { mode, sidebarWidth, expanded, toggle, animated } = useSidebar(
  () => ui.value?.sidebarCollapsed ?? null,
  dispatch,
);

// shell-pending holds the first paint until the snapshot (or an error) lands,
// so a persisted rail never flashes as the expanded default sidebar.
const shellClass = computed(() => [
  `host-${host.value}`,
  {
    'rail-compact': mode.value === 'rail',
    'shell-pending': !state.value && !error.value,
    'shell-animated': animated.value,
  },
]);
const shellVars = computed(() => ({ '--sidebar-width': `${sidebarWidth.value}px` }));

watchEffect(() => {
  const value = ui.value;
  const root = document.documentElement;
  root.dataset.appearance = value?.appearance ?? 'light';
  root.dataset.fontSize = value?.fontSize ?? 'standard';
  root.dataset.material = value?.material ?? 'solid';
});

// The settings dialog covers the web area: main hides the active view while it
// is open and restores bounds plus visibility on close.
watch(settingsOpen, (open) => {
  dispatch({ type: 'setOverlay', open, pageId: active.value?.id ?? null });
});

useBoundsReporter(slot, dispatch);
useAccessibilityReporter(dispatch);

let unsubscribe: (() => void) | undefined;

onMounted(async () => {
  if (!api) {
    error.value = '无法连接桌面宿主';
    return;
  }
  unsubscribe = api.onState((snapshot) => { state.value = snapshot; });
  try {
    const initial = await api.snapshot();
    if (!initial) {
      error.value = '无法读取工作台状态';
      return;
    }
    state.value ??= initial;
    await nextTick();
    performance.mark('workbench-ready');
    document.body.dataset.ready = 'true';
  } catch {
    error.value = '无法读取工作台状态';
  }
});

onBeforeUnmount(() => unsubscribe?.());
</script>
