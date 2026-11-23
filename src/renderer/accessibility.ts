import { onBeforeUnmount, onMounted } from 'vue';
import type { WorkbenchCommand } from '../shared/workbench.js';

// The main process cannot read renderer media queries; report the accessibility
// flags that gate native materials (reduced transparency, contrast, forced colors).
export function useAccessibilityReporter(dispatch: (command: WorkbenchCommand) => void) {
  const queries = {
    reducedTransparency: window.matchMedia('(prefers-reduced-transparency: reduce)'),
    increasedContrast: window.matchMedia('(prefers-contrast: more)'),
    forcedColors: window.matchMedia('(forced-colors: active)'),
  };

  const report = () => dispatch({
    type: 'reportAccessibility',
    reducedTransparency: queries.reducedTransparency.matches,
    increasedContrast: queries.increasedContrast.matches,
    forcedColors: queries.forcedColors.matches,
  });

  onMounted(() => {
    report();
    for (const query of Object.values(queries)) query.addEventListener('change', report);
  });

  onBeforeUnmount(() => {
    for (const query of Object.values(queries)) query.removeEventListener('change', report);
  });
}
