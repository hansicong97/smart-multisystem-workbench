export type Material = 'mica' | 'solid';

export interface AccessibilityFlags {
  reducedTransparency: boolean;
  increasedContrast: boolean;
  forcedColors: boolean;
}

export const SOLID_ACCESSIBILITY: AccessibilityFlags = {
  reducedTransparency: false,
  increasedContrast: false,
  forcedColors: false,
};

// Mica Base needs Windows 11 22H2 (build 22621) or newer.
export function micaSupported(host: string, release: string): boolean {
  if (host !== 'win32') return false;
  const build = Number.parseInt(release.split('.')[2] ?? '', 10);
  return Number.isFinite(build) && build >= 22621;
}

// Mica is a Windows-only enhancement; every other host renders solid surfaces.
export function resolveMaterial(host: string, release: string, flags: AccessibilityFlags): Material {
  if (flags.reducedTransparency || flags.increasedContrast || flags.forcedColors) return 'solid';
  return micaSupported(host, release) ? 'mica' : 'solid';
}

// Native window-control overlay colors track the resolved appearance. Under Mica
// the caption strip stays transparent so the system material shows through.
export function overlayColors(appearance: 'light' | 'dark', material: Material): { color: string; symbolColor: string } {
  const dark = appearance === 'dark';
  return {
    color: material === 'mica' ? '#00000000' : dark ? '#1b1e24' : '#f9fafc',
    symbolColor: dark ? '#e6e8ec' : '#21262f',
  };
}

export function windowBackground(appearance: 'light' | 'dark', material: Material): string {
  if (material === 'mica') return '#00000000';
  return appearance === 'dark' ? '#121418' : '#f8f9fb';
}
