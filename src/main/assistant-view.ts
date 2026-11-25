import { WebContentsView } from 'electron';
import type { BrowserWindow, WebContents, WebPreferences, WindowOpenHandlerResponse } from 'electron';
import { clampRect } from '../shared/layout.js';
import type { BoundsRect } from '../shared/layout.js';
import { IPC } from '../shared/workbench.js';
import type { WorkbenchCommand } from '../shared/workbench.js';

type Report = Extract<WorkbenchCommand, { type: 'reportAssistant' }>;

function scaleRect(rect: BoundsRect, zoom: number): BoundsRect {
  const x = Math.round(rect.x * zoom);
  const y = Math.round(rect.y * zoom);
  return { x, y, width: Math.round((rect.x + rect.width) * zoom) - x, height: Math.round((rect.y + rect.height) * zoom) - y };
}

export class AssistantView {
  #view?: WebContentsView;
  #open?: { pageId: number; rect: BoundsRect; popover: BoundsRect | null; page: WebContents; slot: BoundsRect };

  constructor(private readonly window: BrowserWindow) {}

  openHandler(preferences: WebPreferences): WindowOpenHandlerResponse {
    if (this.#view) return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: { webPreferences: preferences },
      createWindow: (options) => {
        const { webContents } = options as typeof options & { webContents?: WebContents };
        const view = new WebContentsView({ webContents, webPreferences: preferences });
        this.#view = view;
        view.setVisible(false);
        view.setBackgroundColor('#00000000');
        this.window.contentView.addChildView(view);
        const contents = view.webContents;
        contents.setWindowOpenHandler(() => ({ action: 'deny' }));
        contents.on('will-frame-navigate', (event) => event.preventDefault());
        contents.on('will-redirect', (event) => event.preventDefault());
        contents.on('content-bounds-updated', (event) => event.preventDefault());
        // The CSS shadow occupies transparent pixels in the native view. Pass
        // clicks in those pixels to the OA view, where they would have landed.
        contents.on('before-mouse-event', (event, mouse) => {
          const open = this.#open;
          if (!open?.popover || !['mouseDown', 'mouseWheel'].includes(mouse.type) || open.page.isDestroyed()) return;
          const x = open.rect.x + mouse.x;
          const y = open.rect.y + mouse.y;
          const box = open.popover;
          if (x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) return;
          event.preventDefault();
          if (mouse.type === 'mouseDown') {
            this.dismiss(open.pageId);
            open.page.focus();
          }
          open.page.sendInputEvent({ ...mouse, x: x - open.slot.x, y: y - open.slot.y });
        });
        contents.once('destroyed', () => {
          this.#view = undefined;
          if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
          if (this.#open) this.dismiss(this.#open.pageId, true);
        });
        return contents;
      },
    };
  }

  report(command: Report, zoom: number, page: WebContents, slot: BoundsRect) {
    if (!command.rect) {
      this.hide();
      if (command.focus) this.window.webContents.focus();
      return;
    }
    if (!this.#view) return;
    const [width, height] = this.window.getContentSize();
    const desired = scaleRect(command.rect, zoom);
    const x = Math.max(slot.x, desired.x);
    const y = Math.max(slot.y, desired.y);
    const rect = clampRect({ x, y, width: desired.x + desired.width - x, height: desired.y + desired.height - y },
      Math.min(width, slot.x + slot.width), Math.min(height, slot.y + slot.height));
    if (!rect.width || !rect.height) return;
    const popover = command.popover ? scaleRect(command.popover, zoom) : null;
    this.#open = { pageId: command.pageId, rect, popover, page, slot };
    if (this.window.contentView.children.at(-1) !== this.#view) this.window.contentView.addChildView(this.#view);
    this.#view.setBounds(rect);
    this.#view.setVisible(true);
    if (command.focus) this.#view.webContents.focus();
  }

  isPopover(pageId: number) {
    return this.#open?.pageId === pageId && !!this.#open.popover;
  }

  dismiss(pageId: number, focus = false) {
    if (this.#open?.pageId !== pageId) return;
    this.hide();
    if (!this.window.isDestroyed()) {
      if (focus) this.window.webContents.focus();
      this.window.webContents.send(IPC.assistantDismissed, pageId, focus);
    }
  }

  hide() {
    this.#open = undefined;
    this.#view?.setVisible(false);
  }

  dispose() {
    this.#open = undefined;
    if (this.#view && !this.#view.webContents.isDestroyed()) this.#view.webContents.close();
  }
}
