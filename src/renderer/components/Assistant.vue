<template>
  <button v-if="context" ref="entry" id="open-assistant" class="assistant-entry" type="button"
    aria-haspopup="dialog" :aria-expanded="open" @click="open ? close() : open = true">助手</button>
  <Teleport v-if="surface" :to="surface">
    <div v-show="open" class="assistant-layer" :class="{ 'assistant-layer-large': large }">
      <section ref="panel" class="assistant-panel" :class="{ 'assistant-panel-large': large }"
        :style="large ? undefined : panelStyle" :role="large ? undefined : 'dialog'"
        :aria-labelledby="large ? undefined : 'assistant-heading'">
        <header v-show="!large" class="assistant-header">
          <h2 id="assistant-heading" ref="heading" tabindex="-1">助手</h2>
          <button type="button" class="icon-button" aria-label="关闭助手" title="关闭助手" @click="close(true)">
            <AppIcon name="close" />
          </button>
        </header>
        <div class="assistant-tools">
          <slot name="page-tools" />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, watchEffect } from 'vue';
import { ASSISTANT_FRAME } from '../../shared/workbench.js';
import type { PageAssistant } from '../../shared/assistant.js';
import type { BoundsRect } from '../../shared/layout.js';
import { elementBounds } from '../bounds.js';
import { useWorkbench } from '../store.js';
import AppIcon from './AppIcon.vue';

const props = defineProps<{ context: PageAssistant | null; webSlot?: HTMLElement; large: boolean }>();
const emit = defineEmits<{ escape: [] }>();
const open = defineModel<boolean>({ required: true });
const { api, ui, error } = useWorkbench();
const entry = ref<HTMLButtonElement>();
const panel = ref<HTMLElement>();
const heading = ref<HTMLElement>();
const surface = shallowRef<HTMLElement>();
const geometry = shallowRef<{ box: BoundsRect; frame: BoundsRect; maxHeight: number }>();
const panelStyle = computed(() => {
  const value = geometry.value;
  return value ? {
    width: `${value.box.width}px`, maxHeight: `${value.maxHeight}px`,
    marginLeft: `${value.box.x - value.frame.x}px`, marginTop: `${value.box.y - value.frame.y}px`,
  } : { width: '320px', visibility: 'hidden' as const };
});

let child: Window | null = null;
let pendingSurface: Promise<HTMLElement> | undefined;
let visibleFor: PageAssistant | null = null;
let restoreFocus = false;
let focusOnReport = false;
let animation = 0;
let last = '';
let unsubscribe: (() => void) | undefined;

// The blank native view adopts the DOM of this Vue app. It shares the local
// workbench's CSP and styles, and has no independent IPC bridge.
function createSurface(): Promise<HTMLElement> {
  if (surface.value && child && !child.closed) return Promise.resolve(surface.value);
  pendingSurface ??= (async () => {
    child = window.open('about:blank', ASSISTANT_FRAME);
    if (!child) throw new Error('无法打开助手');
    const doc = child.document;
    doc.documentElement.lang = 'zh-CN';
    doc.documentElement.dataset.assistantSurface = '';
    doc.title = '助手';
    await Promise.all([...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].map((source) =>
      new Promise<void>((resolve, reject) => {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = source.href;
        link.onload = () => resolve();
        link.onerror = () => reject(new Error('无法载入助手样式'));
        doc.head.append(link);
      })));
    doc.addEventListener('keydown', keydown);
    const root = doc.createElement('div');
    root.className = 'assistant-portal';
    doc.body.append(root);
    surface.value = root;
    return root;
  })().catch((failure) => {
    child?.close();
    child = null;
    throw failure;
  }).finally(() => { pendingSurface = undefined; });
  return pendingSurface;
}

watchEffect(() => {
  if (!surface.value) return;
  const { dataset } = surface.value.ownerDocument.documentElement;
  dataset.appearance = ui.value?.appearance ?? 'light';
  dataset.fontSize = ui.value?.fontSize ?? 'standard';
  dataset.material = ui.value?.material ?? 'solid';
});

function close(focus = false) {
  restoreFocus = focus;
  open.value = false;
}

function keydown(event: KeyboardEvent) {
  if (!open.value) return;
  if (event.key === 'Tab' && props.large && event.currentTarget === surface.value?.ownerDocument) {
    const elements = [...panel.value?.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]') ?? []]
      .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length);
    const edge = event.shiftKey ? elements[0] : elements.at(-1);
    const current = surface.value?.ownerDocument.activeElement;
    if (edge && (current === edge || !elements.some((element) => current === element))) {
      event.preventDefault();
      (event.shiftKey ? elements.at(-1) : elements[0])?.focus();
    }
    return;
  }
  if (event.key === 'Escape') {
    // Let an open native select consume its own Escape first.
    if (event.defaultPrevented) return;
    event.preventDefault();
    event.stopPropagation();
    if (props.large) emit('escape');
    else close(true);
  }
}

function pointerdown(event: PointerEvent) {
  if (open.value && !props.large && !event.composedPath().includes(entry.value as EventTarget)) close();
}

function measure() {
  const slot = props.webSlot && elementBounds(props.webSlot);
  const anchor = entry.value && elementBounds(entry.value);
  if (!slot || !anchor || !open.value || !panel.value || !visibleFor) return;
  if (props.large) {
    void report(slot, null);
    return;
  }
  const right = anchor.x + anchor.width;
  const top = anchor.y + anchor.height + 8;
  const bottom = slot.y + slot.height;
  const width = Math.max(0, Math.min(320, right - slot.x - 8));
  const height = Math.max(0, bottom - top - 8);
  const x = right - width;
  const frameX = Math.max(slot.x, x - 24);
  const frameY = Math.max(slot.y, top - 8);
  const box = { x, y: top, width, height: 0 };
  const frame = { x: frameX, y: frameY, width: Math.min(slot.x + slot.width, right + 24) - frameX, height: 0 };
  const value = { box, frame, maxHeight: height };
  if (JSON.stringify(value) !== JSON.stringify(geometry.value)) {
    geometry.value = value;
    // Measure the content once Vue has applied the new width and height cap.
    void nextTick(schedule);
    return;
  }
  const panelHeight = panel.value.offsetHeight;
  if (!width || !height || !panelHeight) return;
  void report({ ...frame, height: Math.min(bottom, top + panelHeight + 32) - frameY }, { ...box, height: panelHeight });
}

async function report(rect: BoundsRect, popover: BoundsRect | null) {
  const current = visibleFor;
  if (!current || !api) return;
  const focus = focusOnReport;
  const key = JSON.stringify([current.revision, rect, popover]);
  if (!focus && key === last) return;
  last = key;
  focusOnReport = false;
  await api.command({ type: 'reportAssistant', pageId: current.pageId, revision: current.revision, rect, popover, focus });
  if (focus && open.value && visibleFor === current) {
    const target = props.large ? panel.value?.querySelector<HTMLElement>('[data-review-heading]') : heading.value;
    target?.focus({ preventScroll: true });
  }
}

function schedule() {
  cancelAnimationFrame(animation);
  animation = requestAnimationFrame(measure);
}

watch(open, async (visible) => {
  if (!visible) {
    const previous = visibleFor;
    visibleFor = null;
    const focus = restoreFocus;
    restoreFocus = false;
    last = '';
    if (previous) await api?.command({ type: 'reportAssistant', pageId: previous.pageId, revision: previous.revision,
      rect: null, popover: null, focus });
    if (focus && !open.value) entry.value?.focus({ preventScroll: true });
    return;
  }
  visibleFor = props.context;
  try {
    await createSurface();
    if (!open.value) return;
    focusOnReport = true;
    await nextTick();
    schedule();
  } catch {
    error.value = '助手窗口加载失败，请重试';
    close(true);
  }
});

watch([() => props.context?.pageId, () => props.context?.revision], () => { if (open.value) close(); });
watch(() => props.large, (large) => {
  if (large) focusOnReport = true;
  schedule();
}, { flush: 'post' });
watchEffect((cleanup) => {
  const observer = new ResizeObserver(schedule);
  if (entry.value) observer.observe(entry.value);
  if (props.webSlot) observer.observe(props.webSlot);
  const ChildObserver = panel.value?.ownerDocument.defaultView?.ResizeObserver;
  const contentObserver = ChildObserver && panel.value ? new ChildObserver(measure) : undefined;
  if (panel.value) contentObserver?.observe(panel.value);
  cleanup(() => { observer.disconnect(); contentObserver?.disconnect(); });
});

onMounted(() => {
  document.addEventListener('keydown', keydown);
  document.addEventListener('pointerdown', pointerdown, true);
  window.addEventListener('resize', schedule);
  unsubscribe = api?.onAssistantDismissed((pageId, focus) => {
    if (visibleFor?.pageId === pageId) close(focus);
  });
});
onBeforeUnmount(() => {
  cancelAnimationFrame(animation);
  document.removeEventListener('keydown', keydown);
  document.removeEventListener('pointerdown', pointerdown, true);
  window.removeEventListener('resize', schedule);
  unsubscribe?.();
  child?.close();
});
</script>
