import { computed, ref, shallowRef } from 'vue';
import type { AppId, WorkbenchApp, WorkbenchCommand, WorkbenchPage, WorkbenchState } from '../shared/workbench.js';

// Single workbench instance: state lives in the main process and arrives via
// snapshot/onState; components share these refs through useWorkbench().
const api = window.workbench;
const state = shallowRef<WorkbenchState | null>(null);
const error = ref('');

const apps = computed(() => state.value?.apps ?? []);
const pages = computed(() => state.value?.pages ?? []);
const active = computed(() => pages.value.find(({ id }) => id === state.value?.active));
const tabs = computed(() => pages.value.filter(({ siteId }) => siteId === active.value?.siteId));
const ui = computed(() => state.value?.ui ?? null);
const address = computed(() => {
  if (!state.value) return '正在启动';
  return active.value?.address ?? (pages.value.length ? `${pages.value.length} 个页面已打开` : '尚未打开页面');
});
const notice = computed(() => error.value || state.value?.notice || active.value?.error ||
  (active.value?.loading ? '正在加载' : active.value?.loginHint ?? ''));

function dispatch(command: WorkbenchCommand) {
  error.value = '';
  if (!api) {
    error.value = '无法连接桌面宿主';
    return;
  }
  void api.command(command).catch(() => { error.value = '操作失败，请重试'; });
}

function openApp(appId: AppId) {
  dispatch({ type: 'open', appId });
}

function pageName(page: WorkbenchPage) {
  const name = apps.value.find(({ id }) => id === page.appId)?.name ?? page.appId;
  return page.popup && page.appId !== 'worktime' ? page.title || `${name} 子页` : name;
}

function cardAction(entry: WorkbenchApp) {
  if (!entry.configured) return '等待配置';
  if (entry.id === 'worktime') return '从 OA 进入 →';
  return pages.value.some((page) => page.appId === entry.id && !page.popup) ? '继续 →' : '打开 →';
}

function navigate(type: 'back' | 'forward' | 'reload') {
  if (active.value) dispatch({ type, id: active.value.id });
}

export function useWorkbench() {
  return { api, state, error, apps, pages, active, tabs, ui, address, notice, dispatch, openApp, pageName, cardAction, navigate };
}
