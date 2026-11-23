import { computed, ref, watch } from 'vue';
import { sidebarLayout } from '../shared/layout.js';
import type { WorkbenchCommand } from '../shared/workbench.js';

// Two user-controlled states (spec: 侧栏与设置): expanded ↔ 56px icon rail on
// both hosts. The toggle flips locally for an instant repaint, then persists
// via setPreference; the first snapshot seeds the state and later ui echoes
// (theme pushes) never revert a just-toggled value.
export function useSidebar(
  persisted: () => boolean | null,
  dispatch: (command: WorkbenchCommand) => void,
) {
  const collapsed = ref(false);
  let seeded = false;
  watch(persisted, (value) => {
    if (!seeded && value !== null) {
      collapsed.value = value;
      seeded = true;
    }
  }, { immediate: true });

  const layout = computed(() => sidebarLayout(collapsed.value));
  const mode = computed(() => layout.value.mode);
  const sidebarWidth = computed(() => layout.value.width);
  const expanded = computed(() => !collapsed.value);

  // The width slide/fade runs only for user toggles, never for the first
  // snapshot seed: a persisted rail must paint instantly, not animate in from
  // the expanded default (independent of when the seed flushes).
  const animated = ref(false);
  const toggle = () => {
    animated.value = true;
    collapsed.value = !collapsed.value;
    dispatch({ type: 'setPreference', patch: { sidebarCollapsed: collapsed.value } });
  };

  return { mode, sidebarWidth, expanded, toggle, animated };
}