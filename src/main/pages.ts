import { session, webFrameMain, WebContentsView } from 'electron';
import type { BrowserWindow, DownloadItem, Event as ElectronEvent, Rectangle, Session, WebContents, WebPreferences } from 'electron';
import { allowsNavigation, APPS, displayAddress } from './sites.js';
import type { SitePolicy, SiteRegistry } from './sites.js';
import { describeSitePage, WORKTIME_GUIDANCE } from './site-flow.js';
import { CITY_SWAP_SCRIPT, MEAL_FILL_SCRIPT, isOaFormFrame } from './oa-enhance.js';
import { clampRect } from '../shared/layout.js';
import type { BoundsRect } from '../shared/layout.js';
import { IPC } from '../shared/workbench.js';
import type { SiteId, WorkbenchCommand, WorkbenchState, WorkbenchUi } from '../shared/workbench.js';

export const SITE_PREFERENCES = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
} satisfies WebPreferences;

interface Page {
  id: number;
  view: WebContentsView;
  siteId: SiteId;
  site: SitePolicy;
  opener: number | null;
  requestedUrl: string;
  error: string;
  downloads: Set<DownloadItem>;
}

type DownloadListener = (event: ElectronEvent, item: DownloadItem, contents: WebContents | null) => void;

export class Pages {
  #pages = new Map<number, Page>();
  #sessions = new Map<SiteId, { browserSession: Session; download: DownloadListener }>();
  #active: number | null = null;
  #disposed = false;
  #notice = '';
  // The renderer measures the reserved web rectangle; views stay hidden until
  // the first report so no hardcoded layout constant is needed.
  #rect: BoundsRect | null = null;
  #overlay: { pageId: number | null } | null = null;

  constructor(
    private readonly window: BrowserWindow,
    private readonly sites: SiteRegistry,
    private readonly mode: WorkbenchState['mode'],
    private readonly configMessage: string,
    private ui: WorkbenchUi,
  ) {
    window.on('resize', () => this.#layout());
  }

  setUi(ui: WorkbenchUi) {
    this.ui = ui;
    this.#emit();
  }

  snapshot(): WorkbenchState {
    const pages = [...this.#pages.values()].map((page) => {
      const contents = page.view.webContents;
      const address = contents.getURL();
      return {
        id: page.id,
        siteId: page.siteId,
        ...describeSitePage(page.siteId, page.site, address),
        popup: page.opener !== null,
        title: contents.getTitle(),
        address: displayAddress(address || page.requestedUrl),
        loading: contents.isLoading(),
        error: page.error,
        canGoBack: contents.navigationHistory.canGoBack(),
        canGoForward: contents.navigationHistory.canGoForward(),
      };
    });
    return {
      mode: this.mode,
      configMessage: this.configMessage,
      apps: APPS.map((entry) => ({ ...entry, configured: this.sites.has(entry.id === 'worktime' ? 'oa' : entry.id) })),
      pages,
      active: this.#active,
      notice: this.#notice === WORKTIME_GUIDANCE && pages.some(({ id, appId }) => id === this.#active && appId === 'worktime')
        ? ''
        : this.#notice,
      ui: this.ui,
    };
  }

  dispatch(command: WorkbenchCommand, zoom = 1) {
    if (command.type === 'reportBounds') {
      const [width, height] = this.window.getContentSize();
      const scaled = {
        x: command.rect.x * zoom,
        y: command.rect.y * zoom,
        width: command.rect.width * zoom,
        height: command.rect.height * zoom,
      };
      this.#rect = clampRect(scaled, width, height);
      this.#layout();
      this.#syncVisibility();
      return;
    }
    if (command.type === 'setOverlay') {
      this.#overlay = command.open ? { pageId: command.pageId } : null;
      this.#syncVisibility();
      return;
    }
    // Preferences and accessibility are handled by the window host in index.ts.
    if (command.type === 'setPreference' || command.type === 'reportAccessibility') return;
    if (command.type === 'open') {
      this.#notice = '';
      const appId = command.appId;
      const page = this.#open(appId === 'worktime' ? 'oa' : appId);
      if (appId === 'worktime' && page) this.#setNotice(WORKTIME_GUIDANCE);
      return;
    }
    if (command.id === null) {
      this.#notice = '';
      this.#select(null);
      return;
    }
    const page = this.#pages.get(command.id);
    if (!page) return;
    const contents = page.view.webContents;
    switch (command.type) {
      case 'select':
        this.#notice = '';
        this.#select(page.id);
        break;
      case 'close':
        contents.close({ waitForBeforeUnload: true });
        break;
      case 'reload':
        if (page.id !== this.#active) return;
        this.#notice = '';
        if (page.error || !contents.getURL()) this.#load(page, page.requestedUrl);
        else contents.reload();
        break;
      case 'back':
        if (page.id === this.#active && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
        break;
      case 'forward':
        if (page.id === this.#active && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
        break;
    }
  }

  dispose() {
    this.#disposed = true;
    for (const { view } of this.#pages.values()) {
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    for (const { browserSession, download } of this.#sessions.values()) {
      browserSession.webRequest.onBeforeRequest(null);
      browserSession.removeListener('will-download', download);
    }
    this.#sessions.clear();
  }

  #emit() {
    if (!this.#disposed && !this.window.isDestroyed()) {
      this.window.webContents.send(IPC.state, this.snapshot());
    }
  }

  #setNotice(text: string) {
    this.#notice = text;
    this.#emit();
  }

  #blockedNavigation(url: string) {
    this.#setNotice(`已拦截未授权来源 · ${displayAddress(url) || '非网页地址'}`);
  }

  #layout() {
    if (this.#active === null || this.#rect === null) return;
    const active = this.#pages.get(this.#active);
    if (!active) return;
    const [width, height] = this.window.getContentSize();
    // Clamp the last reported rectangle immediately on resize; the renderer's
    // ResizeObserver corrects it to the exact slot within a frame.
    active.view.setBounds(clampRect(this.#rect, width, height) satisfies Rectangle);
  }

  #syncVisibility() {
    if (this.#active === null) return;
    this.#pages.get(this.#active)?.view.setVisible(this.#rect !== null && this.#overlay === null);
  }

  #select(id: number | null) {
    if (this.#active !== null) this.#pages.get(this.#active)?.view.setVisible(false);
    this.#active = id;
    this.#layout();
    this.#syncVisibility();
    this.#emit();
  }

  #sessionFor(siteId: SiteId, site: SitePolicy): Session {
    const existing = this.#sessions.get(siteId);
    if (existing) return existing.browserSession;

    // Keep the existing code platform partition when upgrading old site configurations.
    const partition = siteId === 'gitlab' ? 'code' : siteId;
    const browserSession = session.fromPartition(`persist:smsw-${partition}`);
    browserSession.setPermissionCheckHandler(() => false);
    browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    // Check document requests in this partition, including initial iframe loads and history navigations.
    browserSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'], types: ['mainFrame', 'subFrame'] },
      ({ resourceType, url, webContentsId }, respond) => {
        const cancel = !allowsNavigation(site, url, resourceType === 'mainFrame');
        respond({ cancel });
        if (cancel && webContentsId === this.#active) this.#blockedNavigation(url);
      },
    );
    const download: DownloadListener = (event, item, contents) => {
      const page = contents ? this.#pages.get(contents.id) : undefined;
      if (!page || !item.getURLChain().every((url) => allowsNavigation(site, url, false))) {
        event.preventDefault();
        this.#setNotice('已拦截未授权来源的下载');
        return;
      }
      const filename = item.getFilename();
      page.downloads.add(item);
      item.setSaveDialogOptions({ title: '保存下载文件' });
      this.#setNotice(`下载中 · ${filename}`);
      item.once('done', (_event, status) => {
        page.downloads.delete(item);
        const label = { completed: '下载完成', cancelled: '下载取消', interrupted: '下载中断' }[status];
        this.#setNotice(`${label} · ${filename}`);
      });
    };
    browserSession.on('will-download', download);
    this.#sessions.set(siteId, { browserSession, download });
    return browserSession;
  }

  #open(siteId: SiteId): Page | undefined {
    const site = this.sites.get(siteId);
    if (!site) return;
    const existing = [...this.#pages.values()].find((page) => page.siteId === siteId && page.opener === null);
    if (existing) {
      this.#select(existing.id);
      return existing;
    }
    const view = new WebContentsView({
      webPreferences: { ...SITE_PREFERENCES, session: this.#sessionFor(siteId, site) },
    });
    const page = this.#register(view, siteId, site, site.entryUrl);
    this.#load(page, site.entryUrl);
    return page;
  }

  #load(page: Page, url: string) {
    if (!allowsNavigation(page.site, url, true)) return;
    page.view.webContents.loadURL(url).catch((error) => {
      if (error.code !== 'ERR_ABORTED' && this.#pages.has(page.id)) {
        page.error = `页面加载失败 · ${error.code || '请重试'}`;
        this.#emit();
      }
    });
  }

  #register(view: WebContentsView, siteId: SiteId, site: SitePolicy, requestedUrl: string, opener: number | null = null) {
    const contents = view.webContents;
    const page: Page = { id: contents.id, view, siteId, site, opener, requestedUrl, error: '', downloads: new Set() };
    this.#pages.set(page.id, page);
    view.setVisible(false);
    this.window.contentView.addChildView(view);

    const restrict = (event: ElectronEvent & { url: string; isMainFrame: boolean }) => {
      if (!allowsNavigation(site, event.url, event.isMainFrame)) {
        event.preventDefault();
        this.#blockedNavigation(event.url);
      }
    };
    contents.on('will-frame-navigate', restrict);
    contents.on('will-redirect', restrict);
    contents.setWindowOpenHandler(({ url }) => {
      // Some OA pages open an empty child before setting its document URL.
      const oaBlank = siteId === 'oa' && url === 'about:blank' && allowsNavigation(site, contents.getURL(), true);
      if (!oaBlank && !allowsNavigation(site, url, true)) {
        this.#setNotice('已拦截未授权来源的弹窗');
        return { action: 'deny' };
      }
      const webPreferences = { ...SITE_PREFERENCES, session: contents.session };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { webPreferences },
        createWindow: (options) => {
          const { webContents } = options as typeof options & { webContents?: WebContents };
          const popup = new WebContentsView({ webContents, webPreferences });
          this.#register(popup, siteId, site, url, page.id);
          return popup.webContents;
        },
      };
    });

    contents.on('did-start-navigation', (event) => {
      if (event.isMainFrame && allowsNavigation(site, event.url, true)) {
        page.requestedUrl = event.url;
        page.error = '';
      }
    });
    contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) page.error = `页面加载失败 · ${description}`;
      this.#emit();
    });
    const publish = () => this.#emit();
    contents.on('did-start-loading', publish);
    contents.on('did-stop-loading', publish);
    contents.on('did-navigate', publish);
    contents.on('did-navigate-in-page', publish);
    // Inject OA form enhancements into the CAP4 form frame's main world. The
    // script self-waits for readiness and observes row changes, so injection
    // timing and server-backed row adds are both covered. The page keeps its
    // sandbox; this adds no IPC from the remote page.
    contents.on('did-frame-navigate', (_event, url, _code, _text, _isMainFrame, processId, routingId) => {
      if (!isOaFormFrame(siteId, url)) return;
      const frame = webFrameMain.fromId(processId, routingId);
      if (!frame) return;
      frame.executeJavaScript(CITY_SWAP_SCRIPT, true).catch(() => {});
      frame.executeJavaScript(MEAL_FILL_SCRIPT, true).catch(() => {});
    });
    contents.on('page-title-updated', publish);
    contents.on('render-process-gone', () => {
      page.error = '页面进程已退出，请刷新';
      this.#emit();
    });
    contents.on('will-prevent-unload', () => this.#setNotice('页面提示有未保存内容，请在原页处理后重试'));
    contents.once('destroyed', () => this.#remove(page));

    this.#notice = '';
    this.#select(page.id);
    return page;
  }

  #remove(page: Page) {
    this.#pages.delete(page.id);
    for (const item of page.downloads) item.cancel();
    if (this.#disposed || this.window.isDestroyed()) return;
    this.window.contentView.removeChildView(page.view);
    if (this.#active === page.id) {
      const fallback = page.opener !== null && this.#pages.has(page.opener)
        ? page.opener
        : [...this.#pages.values()].findLast(({ siteId }) => siteId === page.siteId)?.id ?? null;
      this.#select(fallback);
    } else {
      this.#emit();
    }
  }
}
