import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PreferencesStore } from '../../dist/main/preferences.js';
import { micaSupported, overlayColors, resolveMaterial, windowBackground } from '../../dist/main/materials.js';
import { defaultPreferences, FONT_SCALES, parsePreferences, preferencesPatch } from '../../dist/shared/preferences.js';
import { clampRect, sidebarLayout } from '../../dist/shared/layout.js';
import { workbenchCommand } from '../../dist/shared/workbench.js';

const solid = { reducedTransparency: false, increasedContrast: false, forcedColors: false };

test('偏好默认值统一，无效键逐项回落，旧风格键被忽略', () => {
  assert.deepEqual(defaultPreferences(), { appearance: 'system', fontSize: 'standard', sidebarCollapsed: false });
  assert.deepEqual(parsePreferences(null), defaultPreferences());
  assert.deepEqual(parsePreferences('x'), defaultPreferences());
  assert.deepEqual(
    parsePreferences({ platformStyle: 'macos', appearance: 'dark', fontSize: 'huge' }),
    { appearance: 'dark', fontSize: 'standard', sidebarCollapsed: false },
  );
  assert.equal(parsePreferences({ sidebarCollapsed: 'yes' }).sidebarCollapsed, false);
  assert.equal(parsePreferences({ sidebarCollapsed: true }).sidebarCollapsed, true);
  assert.deepEqual(FONT_SCALES, { small: 0.92, standard: 1, large: 1.15 });
});

test('偏好补丁严格校验，新命令经统一 zod 通道', () => {
  assert.equal(preferencesPatch.safeParse({ appearance: 'dark' }).success, true);
  assert.equal(preferencesPatch.safeParse({ appearance: 'neon' }).success, false);
  assert.equal(preferencesPatch.safeParse({ unknown: 1 }).success, false);
  assert.equal(preferencesPatch.safeParse({ platformStyle: 'macos' }).success, false);
  assert.equal(preferencesPatch.safeParse({ sidebarCollapsed: true }).success, true);
  assert.equal(preferencesPatch.safeParse({ sidebarCollapsed: 1 }).success, false);
  assert.equal(workbenchCommand.safeParse({ type: 'setPreference', patch: { fontSize: 'large' } }).success, true);
  assert.equal(workbenchCommand.safeParse({ type: 'setPreference', patch: { sidebarCollapsed: true } }).success, true);
  assert.equal(workbenchCommand.safeParse({ type: 'setPreference', patch: { platformStyle: 'windows' } }).success, false);
  assert.equal(workbenchCommand.safeParse({ type: 'reportBounds', rect: { x: 204, y: 99, width: 612, height: 681 } }).success, true);
  assert.equal(workbenchCommand.safeParse({ type: 'reportBounds', rect: { x: -1, y: 0, width: 10, height: 10 } }).success, false);
  assert.equal(workbenchCommand.safeParse({ type: 'reportBounds', rect: { x: 0, y: 0, width: Number.NaN, height: 10 } }).success, false);
  assert.equal(workbenchCommand.safeParse({ type: 'setOverlay', open: true, pageId: null }).success, true);
  assert.equal(workbenchCommand.safeParse({ type: 'setOverlay', open: true, pageId: 3 }).success, true);
  assert.equal(workbenchCommand.safeParse({ type: 'reportAccessibility', reducedTransparency: true, increasedContrast: false, forcedColors: false }).success, true);
});

test('偏好存储原子写往返，损坏文件回落默认，容忍 BOM，旧风格键静默忽略', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smsw-prefs-'));
  try {
    const store = new PreferencesStore(dir);
    assert.deepEqual(store.value, defaultPreferences());
    store.update({ appearance: 'dark', fontSize: 'large' });
    store.update({ sidebarCollapsed: true });
    await store.flush();
    const reloaded = new PreferencesStore(dir);
    assert.deepEqual(reloaded.value, { appearance: 'dark', fontSize: 'large', sidebarCollapsed: true });
    assert.deepEqual(JSON.parse(await readFile(join(dir, 'preferences.json'), 'utf8')), reloaded.value);

    await writeFile(join(dir, 'preferences.json'), '{');
    assert.deepEqual(new PreferencesStore(dir).value, defaultPreferences());

    await writeFile(join(dir, 'preferences.json'), `${String.fromCharCode(0xFEFF)}${JSON.stringify({ appearance: 'light' })}`);
    assert.equal(new PreferencesStore(dir).value.appearance, 'light');

    // 双风格时代留下的 platformStyle 键被忽略，其余偏好照常恢复。
    await writeFile(join(dir, 'preferences.json'), JSON.stringify({ platformStyle: 'macos', appearance: 'light', fontSize: 'small', sidebarCollapsed: true }));
    assert.deepEqual(new PreferencesStore(dir).value, { appearance: 'light', fontSize: 'small', sidebarCollapsed: true });
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 4 });
  }
});

test('侧栏两态：手动收起为图标栏，展开宽度统一 192', () => {
  assert.deepEqual(sidebarLayout(false), { mode: 'expanded', width: 192 });
  assert.deepEqual(sidebarLayout(true), { mode: 'rail', width: 56 });
});

test('边界矩形取整并夹取到内容区', () => {
  assert.deepEqual(clampRect({ x: 203.6, y: 99.2, width: 612.4, height: 680.6 }, 1130, 780), { x: 204, y: 99, width: 612, height: 681 });
  assert.deepEqual(clampRect({ x: -5, y: -5, width: 5000, height: 5000 }, 1130, 780), { x: 0, y: 0, width: 1130, height: 780 });
  assert.deepEqual(clampRect({ x: 1200, y: 800, width: 100, height: 100 }, 1130, 780), { x: 1130, y: 780, width: 0, height: 0 });
  assert.deepEqual(clampRect({ x: 0, y: 0, width: 100, height: 100 }, 0, 0), { x: 0, y: 0, width: 0, height: 0 });
});

test('材质解析：Win11 用 Mica，其余宿主与无障碍旗标回退实色', () => {
  assert.equal(micaSupported('win32', '10.0.22621'), true);
  assert.equal(micaSupported('win32', '10.0.26300'), true);
  assert.equal(micaSupported('win32', '10.0.22000'), false);
  assert.equal(micaSupported('darwin', '25.0.0'), false);
  assert.equal(resolveMaterial('win32', '10.0.26300', solid), 'mica');
  assert.equal(resolveMaterial('win32', '10.0.22000', solid), 'solid');
  assert.equal(resolveMaterial('win32', '10.0.26300', { ...solid, reducedTransparency: true }), 'solid');
  assert.equal(resolveMaterial('win32', '10.0.26300', { ...solid, forcedColors: true }), 'solid');
  assert.equal(resolveMaterial('darwin', '25.0.0', solid), 'solid');
  assert.deepEqual(overlayColors('light', 'solid'), { color: '#f9fafc', symbolColor: '#21262f' });
  assert.deepEqual(overlayColors('dark', 'solid'), { color: '#1b1e24', symbolColor: '#e6e8ec' });
  assert.equal(overlayColors('dark', 'mica').color, '#00000000');
  assert.equal(windowBackground('light', 'solid'), '#f8f9fb');
  assert.equal(windowBackground('dark', 'solid'), '#121418');
  assert.equal(windowBackground('dark', 'mica'), '#00000000');
});
