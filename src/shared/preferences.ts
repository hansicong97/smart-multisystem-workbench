import { z } from 'zod';

export const APPEARANCES = ['system', 'light', 'dark'] as const;
export type Appearance = (typeof APPEARANCES)[number];

export const FONT_SIZES = ['small', 'standard', 'large'] as const;
export type FontSize = (typeof FONT_SIZES)[number];

export const FONT_SCALES: Record<FontSize, number> = { small: 0.92, standard: 1, large: 1.15 };

export interface Preferences {
  appearance: Appearance;
  fontSize: FontSize;
  sidebarCollapsed: boolean;
}

export const preferencesPatch = z.object({
  appearance: z.enum(APPEARANCES).optional(),
  fontSize: z.enum(FONT_SIZES).optional(),
  sidebarCollapsed: z.boolean().optional(),
}).strict();

export type PreferencesPatch = z.infer<typeof preferencesPatch>;

export function defaultPreferences(): Preferences {
  return {
    appearance: 'system',
    fontSize: 'standard',
    sidebarCollapsed: false,
  };
}

// Invalid keys fall back individually so a partially corrupt file still loads.
// Legacy files may carry a platformStyle key from the dual-style UI; unknown
// keys are ignored.
export function parsePreferences(value: unknown): Preferences {
  const defaults = defaultPreferences();
  if (typeof value !== 'object' || value === null) return defaults;
  const record = value as Record<string, unknown>;
  const pick = <T extends string>(options: readonly T[], key: string, fallback: T): T =>
    options.includes(record[key] as T) ? record[key] as T : fallback;
  return {
    appearance: pick(APPEARANCES, 'appearance', defaults.appearance),
    fontSize: pick(FONT_SIZES, 'fontSize', defaults.fontSize),
    sidebarCollapsed: typeof record.sidebarCollapsed === 'boolean' ? record.sidebarCollapsed : false,
  };
}
