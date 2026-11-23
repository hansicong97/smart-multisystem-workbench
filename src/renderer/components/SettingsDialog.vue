<template>
  <DialogRoot :open="open" @update:open="emit('update:open', $event)">
    <DialogPortal>
      <DialogOverlay class="dialog-overlay" />
      <DialogContent class="dialog" aria-describedby="settings-description">
        <div class="dialog-head">
          <DialogTitle class="dialog-title">设置</DialogTitle>
          <button type="button" class="icon-button" aria-label="关闭对话框" title="关闭对话框" @click="emit('update:open', false)">
            <AppIcon name="close" :size="14" />
          </button>
        </div>
        <div class="dialog-body">
          <p id="settings-description" class="small muted">更改即时生效，并保存在本机偏好中，重启后恢复。</p>
          <section v-for="row in rows" :key="row.key" class="preference-row">
            <div>
              <h3>{{ row.title }}</h3>
              <p class="small muted">{{ row.detail }}</p>
            </div>
            <div class="segments" role="group" :aria-label="row.title">
              <button
                v-for="choice in row.choices"
                :key="choice.id"
                type="button"
                :aria-pressed="current(row.key) === choice.id"
                @click="choose(row.key, choice.id)"
              >{{ choice.label }}</button>
            </div>
          </section>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import { DialogContent, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from 'reka-ui';
import { useWorkbench } from '../store.js';
import type { PreferencesPatch } from '../../shared/preferences.js';
import AppIcon from './AppIcon.vue';

defineProps<{ open: boolean }>();
const emit = defineEmits<{ 'update:open': [value: boolean]; patch: [patch: PreferencesPatch] }>();
const { ui } = useWorkbench();

const rows = [
  { key: 'fontSize', title: '字号', detail: '调整工作台文字大小。', choices: [
    { id: 'small', label: '较小' }, { id: 'standard', label: '标准' }, { id: 'large', label: '较大' },
  ] },
  { key: 'appearance', title: '外观', detail: '选择界面的明暗配色。', choices: [
    { id: 'system', label: '跟随系统' }, { id: 'light', label: '浅色' }, { id: 'dark', label: '深色' },
  ] },
] as const;

type RowKey = (typeof rows)[number]['key'];

function current(key: RowKey): string {
  if (!ui.value) return '';
  return key === 'appearance' ? ui.value.appearancePreference : ui.value[key];
}

function choose(key: RowKey, id: string) {
  if (current(key) === id) return;
  emit('patch', { [key]: id } as PreferencesPatch);
}
</script>
