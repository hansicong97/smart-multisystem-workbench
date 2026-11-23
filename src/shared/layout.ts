export type SidebarMode = 'expanded' | 'rail';

export interface SidebarLayout {
  mode: SidebarMode;
  width: number;
}

// Two user-controlled states (spec: 侧栏与设置): the toggle switches between the
// full sidebar and the 56px icon rail on both hosts, persisted in preferences.
// The window's 860px minimum content width always fits the expanded sidebar.
export function sidebarLayout(collapsed: boolean): SidebarLayout {
  if (collapsed) return { mode: 'rail', width: 56 };
  return { mode: 'expanded', width: 192 };
}

export interface BoundsRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Renderer reports arrive in CSS pixels; main clamps them into the content area.
export function clampRect(rect: BoundsRect, contentWidth: number, contentHeight: number): BoundsRect {
  const x = Math.min(Math.max(0, Math.round(rect.x)), Math.max(0, contentWidth));
  const y = Math.min(Math.max(0, Math.round(rect.y)), Math.max(0, contentHeight));
  return {
    x,
    y,
    width: Math.min(Math.max(0, Math.round(rect.width)), Math.max(0, contentWidth - x)),
    height: Math.min(Math.max(0, Math.round(rect.height)), Math.max(0, contentHeight - y)),
  };
}
