import { onBeforeUnmount, onMounted } from 'vue';
import type { Ref } from 'vue';
import type { WorkbenchCommand } from '../shared/workbench.js';

export function elementBounds(element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  const x = Math.round(rect.left);
  const y = Math.round(rect.top);
  return {
    x, y,
    width: Math.max(0, Math.round(rect.right) - x),
    height: Math.max(0, Math.round(rect.bottom) - y),
  };
}

// Measures the reserved web rectangle and reports it to the main process, which
// applies it to the active WebContentsView. ResizeObserver covers sidebar folds
// and font scaling; the window resize listener is a fallback.
export function useBoundsReporter(
  slot: Ref<HTMLElement | undefined>,
  dispatch: (command: WorkbenchCommand) => void,
) {
  let observer: ResizeObserver | undefined;
  let frame = 0;
  let last = '';

  const report = () => {
    const element = slot.value;
    if (!element) return;
    const value = elementBounds(element);
    const key = `${value.x},${value.y},${value.width},${value.height}`;
    if (key === last) return;
    last = key;
    dispatch({ type: 'reportBounds', rect: value });
  };

  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(report);
  };

  onMounted(() => {
    report();
    observer = new ResizeObserver(schedule);
    if (slot.value) observer.observe(slot.value);
    window.addEventListener('resize', schedule);
  });

  onBeforeUnmount(() => {
    cancelAnimationFrame(frame);
    observer?.disconnect();
    window.removeEventListener('resize', schedule);
  });

  return { report };
}
