import { app, BrowserWindow, ipcMain, Menu, nativeTheme } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';
import { mkdir, readFile } from 'node:fs/promises';
import { release } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Pages, SITE_PREFERENCES } from './pages.js';
import { PreferencesStore } from './preferences.js';
import { Meal } from './meal.js';
import { Reimbursement } from './reimbursement/service.js';
import { overlayColors, resolveMaterial, SOLID_ACCESSIBILITY, windowBackground } from './materials.js';
import type { AccessibilityFlags } from './materials.js';
import { mockSites, parseSites } from './sites.js';
import type { SiteRegistry } from './sites.js';
import { ASSISTANT_FRAME, IPC, uiFromPreferences, workbenchCommand } from '../shared/workbench.js';
import type { WorkbenchState, WorkbenchUi } from '../shared/workbench.js';
import { mealRequest, reimbursementRequest } from '../shared/assistant.js';

const shellFile = fileURLToPath(new URL('../renderer/index.html', import.meta.url));
const shellUrl = pathToFileURL(shellFile).href;
const preload = fileURLToPath(new URL('../preload/bridge.cjs', import.meta.url));

const customProfile = app.commandLine.getSwitchValue('user-data-dir');
const configProfile = customProfile ? resolve(customProfile) : app.getPath('userData');
// Share the default site list while keeping development browser data separate.
if (customProfile || !app.isPackaged) {
  const profile = customProfile ? configProfile : join(app.getPath('appData'), 'SMSW-Local');
  await mkdir(profile, { recursive: true });
  app.setPath('userData', profile);
}

const preferences = new PreferencesStore(app.getPath('userData'));
let accessibility: AccessibilityFlags = SOLID_ACCESSIBILITY;

const host = (): WorkbenchUi['host'] =>
  process.platform === 'win32' || process.platform === 'darwin' ? process.platform : 'linux';

function currentUi(): WorkbenchUi {
  const prefs = preferences.value;
  return uiFromPreferences(
    host(),
    prefs,
    nativeTheme.shouldUseDarkColors,
    resolveMaterial(host(), release(), accessibility),
  );
}

// Keep native window chrome (material, background, window-control overlay) in
// sync with the resolved appearance and accessibility flags.
function syncChrome(window: BrowserWindow, ui: WorkbenchUi) {
  if (window.isDestroyed()) return;
  if (process.platform === 'win32') {
    window.setBackgroundMaterial(ui.material === 'mica' ? 'mica' : 'none');
    if (chromeOverlay) window.setTitleBarOverlay({ ...overlayColors(ui.appearance, ui.material), height: CAPTION_HEIGHT });
  } else if (process.platform === 'darwin') {
    // Traffic lights sit in the shared 43px caption strip, a drag region with
    // controls excluded. macOS renders solid surfaces (no vibrancy).
    window.setWindowButtonPosition({ x: 12, y: 15 });
  }
  window.setBackgroundColor(windowBackground(ui.appearance, ui.material));
}

const CAPTION_HEIGHT = 43;
// Native window controls need the custom titlebar; the renderer draws the same
// caption strip on both hosts.
const chromeOverlay = process.platform === 'win32';

interface Registry {
  sites: SiteRegistry;
  mode: WorkbenchState['mode'];
  message: string;
}

interface MockSites {
  siteOrigin: string;
  frameOrigin: string;
  close(): void;
}

async function loadMockRegistry(): Promise<Registry> {
  const moduleUrl = pathToFileURL(join(app.getAppPath(), 'tests', 'fixtures', 'mock-sites.js')).href;
  const { startMockSites }: { startMockSites(): Promise<MockSites> } = await import(moduleUrl);
  const fixtures = await startMockSites();
  app.once('before-quit', fixtures.close);
  return { sites: mockSites(fixtures.siteOrigin, fixtures.frameOrigin), mode: 'mock', message: '' };
}

async function loadRegistry(): Promise<Registry> {
  if (!app.isPackaged && app.commandLine.hasSwitch('mock-sites')) return loadMockRegistry();

  const file = join(configProfile, 'sites.json');
  try {
    const json = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
    const sites = parseSites(JSON.parse(json));
    return { sites, mode: 'configured', message: sites.size ? '' : '站点配置为空，请在 sites.json 添加应用入口。' };
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    if (missing && !app.isPackaged) return loadMockRegistry();
    const message = missing
      ? '尚未配置站点。请在应用数据目录添加 sites.json。'
      : '站点配置无效。请检查 sites.json 格式及 HTTP 或 HTTPS 来源。';
    return { sites: new Map(), mode: 'configured', message };
  }
}

function createWindow(registry: Registry) {
  const ui = currentUi();
  const window = new BrowserWindow({
    title: 'SMSW',
    width: 1130,
    height: 780,
    minWidth: 860,
    minHeight: 650,
    useContentSize: true,
    show: false,
    backgroundColor: windowBackground(ui.appearance, ui.material),
    ...(process.platform === 'win32'
      ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { ...overlayColors(ui.appearance, ui.material), height: CAPTION_HEIGHT } }
      : process.platform === 'darwin'
        ? { titleBarStyle: 'hiddenInset' as const }
        : {}),
    webPreferences: { ...SITE_PREFERENCES, preload },
  });
  syncChrome(window, ui);
  const pages = new Pages(window, registry.sites, registry.mode, registry.message, ui);
  const meal = new Meal(({ context }) => pages.currentAssistant(context, 'meal'));
  const reimbursements = new Map<string, Reimbursement>();
  const refreshUi = () => {
    const next = currentUi();
    syncChrome(window, next);
    pages.setUi(next);
  };
  nativeTheme.on('updated', refreshUi);
  const trustedSender = (event: IpcMainInvokeEvent) =>
    event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame &&
    event.senderFrame?.url === shellUrl;

  window.webContents.once('dom-ready', () => { void window.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {}); });
  window.webContents.setWindowOpenHandler(({ url, frameName, postBody }) =>
    url === 'about:blank' && frameName === ASSISTANT_FRAME && !postBody &&
    window.webContents.getURL() === shellUrl && pages.currentAssistant()
      ? pages.assistantView.openHandler(SITE_PREFERENCES)
      : { action: 'deny' });
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.webContents.on('will-redirect', (event) => event.preventDefault());
  ipcMain.handle(IPC.snapshot, (event) => trustedSender(event) ? pages.snapshot() : null);
  ipcMain.handle(IPC.reimbursement, async (event, request: unknown) => {
    if (!trustedSender(event)) return { error: '当前页面无法调用报销功能' };
    const parsed = reimbursementRequest.safeParse(request);
    if (!parsed.success) return { error: '报销命令无效' };
    const current = pages.currentAssistant(parsed.data.target, 'reimbursement');
    if (!current) return { error: '目标 OA 表单已变化，请重新打开助手' };
    const { documentKey } = current.context;
    let reimbursement = reimbursements.get(documentKey);
    if (!reimbursement) {
      reimbursement = new Reimbursement(window, join(app.getPath('userData'), 'reimbursement-cache'),
        () => pages.reimbursementTargets(documentKey), (state) => {
          if (!window.isDestroyed()) window.webContents.send(IPC.reimbursementState, documentKey, state);
        });
      reimbursements.set(documentKey, reimbursement);
    }
    const { command } = parsed.data;
    const result = await reimbursement.handle(command);
    if (command.type === 'preview' || command.type === 'fill') pages.recheckAssistant(current.pageId);
    return result;
  });
  ipcMain.handle(IPC.meal, async (event, request: unknown) => {
    if (!trustedSender(event)) return { error: '当前页面无法调用误餐补贴' };
    const parsed = mealRequest.safeParse(request);
    if (!parsed.success) return { error: '误餐参数无效，请检查日期、补贴类型和人员' };
    const current = pages.currentAssistant(parsed.data.target, 'meal');
    if (!current) return { error: '目标 OA 表单已变化，请重新打开助手' };
    const result = await meal.handle(current, parsed.data.command);
    if (result.error || parsed.data.command.type === 'fill') pages.recheckAssistant(current.pageId);
    return result;
  });
  ipcMain.handle(IPC.command, (event, command: unknown) => {
    if (!trustedSender(event)) return;
    const parsed = workbenchCommand.safeParse(command);
    if (!parsed.success) return;
    const value = parsed.data;
    if (value.type === 'setPreference') {
      preferences.update(value.patch);
      nativeTheme.themeSource = preferences.value.appearance;
      refreshUi();
      return;
    }
    if (value.type === 'reportAccessibility') {
      accessibility = {
        reducedTransparency: value.reducedTransparency,
        increasedContrast: value.increasedContrast,
        forcedColors: value.forcedColors,
      };
      refreshUi();
      return;
    }
    pages.dispatch(value, event.sender.getZoomFactor());
  });

  window.once('closed', () => {
    nativeTheme.removeListener('updated', refreshUi);
    ipcMain.removeHandler(IPC.snapshot);
    ipcMain.removeHandler(IPC.command);
    ipcMain.removeHandler(IPC.reimbursement);
    ipcMain.removeHandler(IPC.meal);
    for (const reimbursement of reimbursements.values()) reimbursement.dispose();
    pages.dispose();
  });
  // Open maximized by default. Maximize while still hidden (Windows applies it
  // asynchronously) so the window reveals already maximized on ready-to-show,
  // without a normal-size flash.
  window.maximize();
  window.once('ready-to-show', () => window.show());
  window.loadFile(shellFile).catch((error) => {
    console.error('工作台页面加载失败', error);
    app.exit(1);
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.whenReady().then(async () => {
  nativeTheme.themeSource = preferences.value.appearance;
  Menu.setApplicationMenu(process.platform === 'darwin'
    ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }])
    : null);
  const registry = await loadRegistry();
  createWindow(registry);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(registry);
  });
}).catch((error) => {
  console.error('工作台启动失败', error);
  app.exit(1);
});
