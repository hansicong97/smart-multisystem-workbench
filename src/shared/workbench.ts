import { z } from 'zod';
import { FONT_SCALES, preferencesPatch } from './preferences.js';
import type { Appearance, FontSize, Preferences } from './preferences.js';
import type { ReimbursementReply, ReimbursementState } from './reimbursement.js';
import type { MealReply, MealRequest, PageAssistant, ReimbursementRequest } from './assistant.js';

export const APP_IDS = ['oa', 'gitlab', 'worktime', 'zentao'] as const;
export type AppId = (typeof APP_IDS)[number];
export type SiteId = Exclude<AppId, 'worktime'>;

export const IPC = {
  snapshot: 'smsw:snapshot', command: 'smsw:command', state: 'smsw:state',
  reimbursement: 'smsw:reimbursement', reimbursementState: 'smsw:reimbursement-state',
  meal: 'smsw:meal', assistantDismissed: 'smsw:assistant-dismissed',
} as const;

export const ASSISTANT_FRAME = 'smsw-assistant';

const pageId = z.number().int().positive();

// The renderer measures the reserved web rectangle in CSS pixels; main converts
// and clamps it before calling WebContentsView.setBounds().
const boundsRect = z.object({
  x: z.number().min(0).max(100_000),
  y: z.number().min(0).max(100_000),
  width: z.number().min(0).max(100_000),
  height: z.number().min(0).max(100_000),
});

export const workbenchCommand = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open'), appId: z.enum(APP_IDS) }),
  z.object({ type: z.literal('select'), id: pageId.nullable() }),
  z.object({ type: z.enum(['close', 'back', 'forward', 'reload']), id: pageId }),
  z.object({ type: z.literal('setPreference'), patch: preferencesPatch }),
  z.object({ type: z.literal('reportBounds'), rect: boundsRect }),
  z.object({
    type: z.literal('reportAssistant'), pageId, revision: z.string().min(1).max(128), rect: boundsRect.nullable(),
    popover: boundsRect.nullable(), focus: z.boolean(),
  }),
  z.object({ type: z.literal('setOverlay'), open: z.boolean(), pageId: pageId.nullable() }),
  z.object({
    type: z.literal('reportAccessibility'),
    reducedTransparency: z.boolean(),
    increasedContrast: z.boolean(),
    forcedColors: z.boolean(),
  }),
]);

export type WorkbenchCommand = z.infer<typeof workbenchCommand>;

export interface WorkbenchApp {
  id: AppId;
  name: string;
  mark: string;
  description: string;
  configured: boolean;
}

export interface WorkbenchPage {
  id: number;
  appId: AppId;
  siteId: SiteId;
  popup: boolean;
  title: string;
  address: string;
  loading: boolean;
  error: string;
  loginHint: string;
  canGoBack: boolean;
  canGoForward: boolean;
  assistant: PageAssistant | null;
}

export interface WorkbenchUi {
  host: 'win32' | 'darwin' | 'linux';
  appearance: 'light' | 'dark';
  appearancePreference: Appearance;
  fontSize: FontSize;
  fontScale: number;
  material: 'mica' | 'solid';
  sidebarCollapsed: boolean;
}

export function uiFromPreferences(
  host: WorkbenchUi['host'],
  prefs: Preferences,
  dark: boolean,
  material: WorkbenchUi['material'],
): WorkbenchUi {
  return {
    host,
    appearance: dark ? 'dark' : 'light',
    appearancePreference: prefs.appearance,
    fontSize: prefs.fontSize,
    fontScale: FONT_SCALES[prefs.fontSize],
    material,
    sidebarCollapsed: prefs.sidebarCollapsed,
  };
}

export interface WorkbenchState {
  mode: 'mock' | 'configured';
  configMessage: string;
  apps: WorkbenchApp[];
  pages: WorkbenchPage[];
  active: number | null;
  notice: string;
  ui: WorkbenchUi;
}

export interface WorkbenchApi {
  snapshot(): Promise<WorkbenchState | null>;
  command(value: WorkbenchCommand): Promise<void>;
  onState(listener: (state: WorkbenchState) => void): () => void;
  reimbursement(value: ReimbursementRequest): Promise<ReimbursementReply>;
  onReimbursementState(listener: (documentKey: string, state: ReimbursementState) => void): () => void;
  meal(value: MealRequest): Promise<MealReply>;
  onAssistantDismissed(listener: (pageId: number, focus: boolean) => void): () => void;
}
