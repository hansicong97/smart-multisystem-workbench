import { session, webFrameMain, WebContentsView } from 'electron';
import type { BrowserWindow, DownloadItem, Event as ElectronEvent, Rectangle, Session, WebContents, WebPreferences } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { allowsNavigation, APPS, displayAddress } from './sites.js';
import type { SitePolicy, SiteRegistry } from './sites.js';
import { describeSitePage, WORKTIME_GUIDANCE } from './site-flow.js';
import { CITY_SWAP_SCRIPT, isOaFormFrame } from './oa-enhance.js';
import { identifyMealForm } from './meal.js';
import { readForm } from './reimbursement/oa-form.js';
import { AssistantView } from './assistant-view.js';
import { clampRect } from '../shared/layout.js';
import type { BoundsRect } from '../shared/layout.js';
import { IPC } from '../shared/workbench.js';
import type { SiteId, WorkbenchCommand, WorkbenchState, WorkbenchUi } from '../shared/workbench.js';
import type { AssistantTarget, PageAssistant } from '../shared/assistant.js';
import { sameForm } from './oa-form-target.js';
import type { AssistantForm, FormIdentity, FormTarget } from './oa-form-target.js';

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
  generation: number;
  assistant: Omit<AssistantForm, 'selection'> | null;
  assistantProbe?: ReturnType<typeof setTimeout>;
}

type DownloadListener = (event: ElectronEvent, item: DownloadItem, contents: WebContents | null) => void;

export class Pages {
  readonly assistantView: AssistantView;
  #pages = new Map<number, Page>();
  #sessions = new Map<SiteId, { browserSession: Session; download: DownloadListener }>();
  #active: number | null = null;
  #selection = 0;
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
    this.assistantView = new AssistantView(window);
    window.on('resize', () => this.#layout());
  }

  setUi(ui: WorkbenchUi) {
    this.ui = ui;
    this.#emit();
  }

  currentAssistant(target?: AssistantTarget, tool?: PageAssistant['tool']): AssistantForm | undefined {
    const page = this.#active === null ? undefined : this.#pages.get(this.#active);
    const found = page?.assistant;
    if (!page || !found || (tool && found.context.tool !== tool) ||
        (target && (target.pageId !== page.id || target.revision !== found.context.revision))) return;
    const live = this.#formTargets(page).find(({ frame, generation }) => frame === found.frame && generation === found.generation);
    if (live) return { ...found, selection: live.selection };
  }

  reimbursementTargets(documentKey: string): FormTarget[] {
    const target = this.currentAssistant(undefined, 'reimbursement');
    return target?.context.documentKey === documentKey ? [target] : [];
  }

  recheckAssistant(pageId: number) {
    const page = this.#pages.get(pageId);
    if (page) this.#scheduleAssistantProbe(page);
  }

  #formTargets(page: Page): FormTarget[] {
    if (page.siteId !== 'oa') return [];
    const contents = page.view.webContents;
    if (contents.isDestroyed() || !allowsNavigation(page.site, contents.getURL(), true) ||
        describeSitePage('oa', page.site, contents.getURL()).appId !== 'oa') return [];
    const mainFrame = contents.mainFrame;
    return mainFrame.framesInSubtree
      .filter((frame) => !frame.detached && isOaFormFrame('oa', frame.url) &&
        allowsNavigation(page.site, frame.url, frame === mainFrame))
      .map((frame) => ({ pageId: page.id, generation: page.generation, selection: this.#selection, frame }));
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
        assistant: page.assistant?.context ?? null,
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
      if (command.open && this.#active !== null) this.assistantView.dismiss(this.#active);
      this.#syncVisibility();
      return;
    }
    if (command.type === 'reportAssistant') {
      const target = this.currentAssistant(command);
      const page = target && this.#pages.get(target.pageId);
      if (page && this.#rect && !this.#overlay) this.assistantView.report(command, zoom, page.view.webContents, this.#rect);
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
    this.assistantView.dispose();
    for (const { view, assistantProbe } of this.#pages.values()) {
      clearTimeout(assistantProbe);
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
    this.#pages.get(this.#active)?.view.setVisible(
      this.#rect !== null && this.#rect.width > 0 && this.#rect.height > 0 && this.#overlay === null,
    );
  }

  #select(id: number | null) {
    if (this.#active !== null) this.#pages.get(this.#active)?.view.setVisible(false);
    if (this.#active !== id) {
      this.assistantView.hide();
      this.#selection += 1;
    }
    this.#active = id;
    this.#layout();
    this.#syncVisibility();
    this.#emit();
    if (id !== null) this.recheckAssistant(id);
  }

  #invalidateAssistant(page: Page) {
    page.generation += 1;
    clearTimeout(page.assistantProbe);
    if (!page.assistant) return;
    page.assistant = null;
    if (this.#active === page.id) this.assistantView.hide();
    this.#emit();
  }

  #scheduleAssistantProbe(page: Page, attempt = 0) {
    if (this.#disposed || page.siteId !== 'oa') return;
    clearTimeout(page.assistantProbe);
    const generation = page.generation;
    page.assistantProbe = setTimeout(() => { void this.#probeAssistant(page, generation, attempt); }, attempt ? 250 : 0);
  }

  async #probeAssistant(page: Page, generation: number, attempt: number) {
    if (this.#disposed || page.generation !== generation || !this.#pages.has(page.id)) return;
    const targets = this.#formTargets(page);
    const matches = (await Promise.all(targets.map(async (target) => {
      const meal = await identifyMealForm(target);
      if (meal) return { target, form: meal, tool: 'meal' as const };
      const reimbursement = await readForm(target);
      return reimbursement ? { target, form: reimbursement, tool: 'reimbursement' as const } : null;
    }))).filter((match) => match !== null);
    if (this.#disposed || page.generation !== generation || !this.#pages.has(page.id)) return;
    const match = matches.length === 1 && this.#formTargets(page).some(({ frame }) => frame === matches[0].target.frame)
      ? matches[0] : null;
    if (match) {
      const documentKey = this.#documentKey(page, match.target, match.tool, match.form);
      const previous = page.assistant;
      if (previous?.frame === match.target.frame && sameForm(previous.identity, match.form) &&
          previous.context.tool === match.tool && previous.context.documentKey === documentKey) return;
      const { instance, account, accountKey, document, documentId } = match.form;
      page.assistant = { ...match.target, identity: { instance, account, accountKey, document, documentId }, context: {
        tool: match.tool, pageId: page.id, documentKey, revision: randomUUID(),
      } };
    } else if (page.assistant) {
      page.assistant = null;
    } else {
      if (targets.length && !matches.length && attempt < 40) this.#scheduleAssistantProbe(page, attempt + 1);
      return;
    }
    if (this.#active === page.id) this.assistantView.hide();
    this.#emit();
  }

  #documentKey(page: Page, target: FormTarget, tool: PageAssistant['tool'], form: FormIdentity) {
    const origin = new URL(target.frame.url).origin;
    const top = new URL(page.view.webContents.getURL()).origin;
    // Unsaved forms have no stable document number. Keep their draft scoped
    // to that table instance so another blank form cannot inherit it.
    return createHash('sha256').update(JSON.stringify([
      top, origin, tool, form.accountKey || form.account, form.documentId || [page.id, form.instance],
    ])).digest('hex');
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
    const page: Page = { id: contents.id, view, siteId, site, opener, requestedUrl, error: '', downloads: new Set(), generation: 0, assistant: null };
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
      this.#invalidateAssistant(page);
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
    contents.on('did-stop-loading', () => { publish(); this.#scheduleAssistantProbe(page); });
    contents.on('did-navigate', publish);
    contents.on('did-navigate-in-page', () => {
      this.#invalidateAssistant(page);
      publish();
      this.#scheduleAssistantProbe(page);
    });
    // Inject OA form enhancements into the CAP4 form frame's main world. The
    // script self-waits for readiness and observes row changes, so injection
    // timing and server-backed row adds are both covered. The page keeps its
    // sandbox; this adds no IPC from the remote page.
    contents.on('did-frame-navigate', (_event, url, _code, _text, isMainFrame, processId, routingId) => {
      this.#scheduleAssistantProbe(page);
      if (!isOaFormFrame(siteId, url)) return;
      const frame = webFrameMain.fromId(processId, routingId);
      if (!frame || !allowsNavigation(site, contents.getURL(), true) || !allowsNavigation(site, url, isMainFrame)) return;
      frame.executeJavaScript(CITY_SWAP_SCRIPT, true).catch(() => {});
    });
    contents.on('before-mouse-event', (_event, input) => {
      if (input.type === 'mouseDown' && this.assistantView.isPopover(page.id)) this.assistantView.dismiss(page.id);
    });
    contents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape' && this.assistantView.isPopover(page.id)) {
        event.preventDefault();
        this.assistantView.dismiss(page.id, true);
      }
    });
    contents.on('page-title-updated', publish);
    contents.on('render-process-gone', () => {
      this.#invalidateAssistant(page);
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
    clearTimeout(page.assistantProbe);
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
