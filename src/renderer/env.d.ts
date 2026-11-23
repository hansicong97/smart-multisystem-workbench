import type { WorkbenchApi } from '../shared/workbench.js';

declare global {
  interface Window {
    workbench?: WorkbenchApi;
  }
}
