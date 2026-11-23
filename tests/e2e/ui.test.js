import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { _electron } from 'playwright-core';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cache = join(root, '.cache');
const oaLogin = '/seeyon/index.jsp';

async function retry(check) {
  const deadline = Date.now() + 8_000;
  let lastError;
  do {
    try {
      return await check();
    } catch (error) {
      lastError = error;
      await delay(50);
    }
  } while (Date.now() < deadline);
  throw lastError;
}

const byName = (page, role, name) => page.getByRole(role, { name, exact: true });
const shellState = (page) => page.evaluate(() => window.workbench.snapshot());

async function start(profile) {
  const electron = await _electron.launch({ cwd: root, args: ['.', `--user-data-dir=${profile}`], timeout: 25_000 });
  try {
    const shell = await electron.firstWindow({ timeout: 10_000 });
    shell.setDefaultTimeout(8_000);
    await shell.locator('body[data-ready=true]').waitFor();
    return { electron, shell };
  } catch (error) {
    await electron.close();
    throw error;
  }
}

function waitForPage(electron, paths) {
  return retry(() => {
    const match = electron.context().pages().find((page) =>
      page.url().startsWith('http://127.0.0.1:') && paths.includes(new URL(page.url()).pathname),
    );
    assert.ok(match, `缺少网页视图 ${paths.join(', ')}`);
    match.setDefaultTimeout(8_000);
    return match;
  });
}

// 收起/展开时全部侧栏图标（首页、应用徽章、设置）的纵向位置必须逐一不变：
// 分组标题带、品牌行与底部提示在图标栏中同高保留。
const iconTops = (shell) => shell.locator('.sidebar .side-icon').evaluateAll(
  (elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)),
);

const slotRect = (shell) => shell.locator('.web-slot').evaluate((element) => {
  const rect = element.getBoundingClientRect();
  const x = Math.round(rect.left);
  const y = Math.round(rect.top);
  return { x, y, width: Math.round(rect.right) - x, height: Math.round(rect.bottom) - y };
});

const activeBounds = (electron) => electron.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows()[0];
  const view = window.contentView.children.find((child) =>
    child.webContents?.id !== window.webContents.id && child.getVisible(),
  );
  return view ? view.getBounds() : null;
});

const visibleViewCount = (electron) => electron.evaluate(({ BrowserWindow }) => {
  const window = BrowserWindow.getAllWindows()[0];
  return window.contentView.children.filter((child) =>
    child.webContents?.id !== window.webContents.id && child.getVisible(),
  ).length;
});

// 窗口默认最大化打开；像素级验收需先还原为普通窗口，setContentSize 才能生效。
const setContentSize = (electron, width, height) => electron.evaluate(
  ({ BrowserWindow }, size) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (window.isMaximized()) window.unmaximize();
    window.setContentSize(size.width, size.height);
  },
  { width, height },
);

// 分数 DPI 下 getContentSize() 与渲染层视口有 ≤1px 的系统舍入差（125% 时 861 对 862），
// 主进程按前者夹取，故仅该场景允许 1px 余量；整数落位尺寸要求逐像素一致。
async function assertBoundsFollowSlot(electron, shell, slack = 0) {
  const rect = await slotRect(shell);
  const bounds = await activeBounds(electron);
  assert.ok(bounds, '活动网页视图不可见');
  assert.equal(bounds.x, rect.x);
  assert.equal(bounds.y, rect.y);
  assert.ok(Math.abs(bounds.width - rect.width) <= slack, `视图宽 ${bounds.width} 偏离槽位宽 ${rect.width} 超过 ${slack}px`);
  assert.ok(Math.abs(bounds.height - rect.height) <= slack, `视图高 ${bounds.height} 偏离槽位高 ${rect.height} 超过 ${slack}px`);
  return rect;
}

async function openOa({ electron, shell }) {
  await byName(shell, 'button', '打开 OA').click();
  const page = await waitForPage(electron, [oaLogin]);
  await byName(page, 'heading', 'OA 模拟登录').waitFor();
  return page;
}

test('统一界面边界、侧栏、设置与偏好持久化', { timeout: 150_000 }, async (t) => {
  await mkdir(cache, { recursive: true });
  const profile = await mkdtemp(join(cache, 'ui-profile-'));
  let instance;
  t.after(async () => {
    if (instance?.electron.process().exitCode === null) await instance.electron.close();
    if (dirname(profile) === cache) await rm(profile, { recursive: true, force: true, maxRetries: 4 });
  });

  instance = await start(profile);
  const { electron, shell } = instance;

  await t.test('网页视图边界等于渲染层实测矩形，随窗口缩放收敛', async () => {
    await openOa(instance);
    // 初始窗口在分数 DPI 下有创建期舍入（125% 时内容高 782），先显式设定验收尺寸。
    await setContentSize(electron, 1130, 780);
    // 默认布局：标题栏 43 + 边框 1 + 标签 40 + 命令栏 46，侧栏 192 + 分隔 1。
    await retry(async () => {
      const rect = await assertBoundsFollowSlot(electron, shell);
      assert.deepEqual(rect, { x: 193, y: 130, width: 937, height: 650 });
    });
    await setContentSize(electron, 1000, 700);
    await retry(async () => {
      const rect = await assertBoundsFollowSlot(electron, shell, 1);
      // 侧栏不再按宽度自动收起，1000px 下保持展开。
      assert.equal(rect.x, 193);
      assert.ok(Math.abs(rect.width - (1000 - rect.x)) <= 1, `槽位宽 ${rect.width} 未收敛到内容宽`);
    });
    await setContentSize(electron, 1130, 780);
    await retry(() => assertBoundsFollowSlot(electron, shell));
  });

  await t.test('侧栏收起为图标栏保留应用图标，展开恢复，窄窗不再自动切换', async () => {
    const topsExpanded = await iconTops(shell);
    await byName(shell, 'button', '收起侧栏').click();
    await retry(async () => {
      const rect = await assertBoundsFollowSlot(electron, shell);
      assert.equal(rect.x, 57);
    });
    assert.equal(await shell.locator('.sidebar .mark:visible').count(), 4);
    assert.equal(await shell.locator('.sidebar .label:visible').count(), 0);
    await shell.locator('.sidebar .settings-entry').waitFor({ state: 'visible' });
    assert.equal(await shell.locator('.collapsed-footer').count(), 0);
    // 分组标题带换成同高分隔线：所有图标纵向零位移。
    assert.deepEqual(await iconTops(shell), topsExpanded);
    await byName(shell, 'button', '展开侧栏').click();
    await retry(async () => assert.equal((await slotRect(shell)).x, 193));
    assert.deepEqual(await iconTops(shell), topsExpanded);
    assert.equal(await shell.locator('#mode').textContent(), '本地模拟站');

    // 最小内容尺寸下展开侧栏仍放得下，形态只由按钮决定。
    await setContentSize(electron, 860, 650);
    await retry(async () => {
      const rect = await assertBoundsFollowSlot(electron, shell, 1);
      assert.equal(rect.x, 193);
    });
    await byName(shell, 'button', '收起侧栏').click();
    await retry(async () => assert.equal((await slotRect(shell)).x, 57));
    await byName(shell, 'button', '展开侧栏').click();
    await retry(async () => assert.equal((await slotRect(shell)).x, 193));
    await setContentSize(electron, 1130, 780);
    await retry(() => assertBoundsFollowSlot(electron, shell));
  });

  await t.test('设置覆盖网页时隐藏视图，Esc 恢复边界与焦点', async () => {
    await byName(shell, 'button', '设置').click();
    await shell.getByRole('dialog').waitFor();
    // 统一界面后设置只剩字号与外观两行，无界面风格切换。
    assert.equal(await shell.locator('.preference-row').count(), 2);
    await retry(async () => assert.equal(await visibleViewCount(electron), 0));
    await shell.keyboard.press('Escape');
    await shell.getByRole('dialog').waitFor({ state: 'hidden' });
    await retry(async () => {
      assert.equal(await visibleViewCount(electron), 1);
      await assertBoundsFollowSlot(electron, shell);
    });
    assert.equal(await shell.evaluate(() => document.activeElement?.getAttribute('aria-label')), '设置');
  });

  await t.test('字号与外观即时生效并保留标签，侧栏开关唯一', async () => {
    const tabsBefore = await shell.locator('#tabs .tab-select').allTextContents();
    await byName(shell, 'button', '设置').click();
    await byName(shell, 'button', '较大').click();
    await retry(async () => assert.equal(
      await shell.evaluate(() => getComputedStyle(document.documentElement).fontSize), '16.1px',
    ));
    await byName(shell, 'button', '深色').click();
    await retry(async () => {
      assert.equal(await shell.evaluate(() => document.documentElement.dataset.appearance), 'dark');
      assert.equal(await electron.evaluate(({ nativeTheme }) => nativeTheme.themeSource), 'dark');
    });
    assert.deepEqual(await shell.locator('#tabs .tab-select').allTextContents(), tabsBefore);
    await shell.keyboard.press('Escape');
    await retry(async () => {
      assert.equal(await visibleViewCount(electron), 1);
      await assertBoundsFollowSlot(electron, shell);
    });

    // 侧栏开关唯一入口在标题条；1px 分隔是工作区 border-left（x=57）。
    assert.equal(await shell.locator('.caption-toggle').count(), 1);
    assert.equal(await shell.locator('.sidebar-toggle').count(), 0);
    const tops = await iconTops(shell);
    await shell.locator('.caption-toggle').click();
    await retry(async () => assert.equal((await slotRect(shell)).x, 57));
    assert.deepEqual(await iconTops(shell), tops);
    await shell.locator('.caption-toggle').click();
    await retry(async () => assert.equal((await slotRect(shell)).x, 193));
  });

  await t.test('标签键盘路径：方向键、Home/End 与 Delete', async () => {
    const oa = await openOa(instance);
    // 弹窗按钮在 OA 门户首页，先从模拟登录页进入。
    await byName(oa, 'button', '模拟登录').click();
    await oa.waitForURL(new URL('/seeyon/main.do?method=main', oa.url()).href);
    await byName(oa, 'button', '打开弹窗').click();
    await waitForPage(electron, ['/oa/popup']);
    await retry(async () => assert.deepEqual(await shell.locator('#tabs .tab-select').allTextContents(), ['OA', 'OA 模拟弹窗']));
    const selected = shell.locator('#tabs .tab-select[aria-pressed="true"]');
    await selected.focus();
    await shell.keyboard.press('ArrowLeft');
    await retry(async () => assert.equal(await selected.textContent(), 'OA'));
    await shell.keyboard.press('End');
    await retry(async () => assert.equal(await selected.textContent(), 'OA 模拟弹窗'));
    await shell.keyboard.press('Home');
    await retry(async () => assert.equal(await selected.textContent(), 'OA'));
    await shell.keyboard.press('End');
    await retry(async () => assert.equal(await selected.textContent(), 'OA 模拟弹窗'));
    await shell.keyboard.press('Delete');
    await retry(async () => assert.deepEqual(await shell.locator('#tabs .tab-select').allTextContents(), ['OA']));
  });

  await t.test('偏好重启恢复', async () => {
    await byName(shell, 'button', '设置').click();
    await byName(shell, 'button', '浅色').click();
    await retry(async () => assert.equal(await shell.evaluate(() => document.documentElement.dataset.appearance), 'light'));
    await shell.keyboard.press('Escape');
    await retry(async () => assert.equal(await visibleViewCount(electron), 1));
    await byName(shell, 'button', '收起侧栏').click();
    // 等主进程回显收起状态，确保偏好已处理后再关闭。
    await retry(async () => assert.equal((await shellState(shell)).ui.sidebarCollapsed, true));
    await electron.close();

    instance = await start(profile);
    const state = await shellState(instance.shell);
    assert.equal(state.ui.appearancePreference, 'light');
    assert.equal(state.ui.appearance, 'light');
    assert.equal(state.ui.fontSize, 'large');
    assert.equal(state.ui.fontScale, 1.15);
    assert.equal(state.ui.host, 'win32');
    assert.equal(state.ui.sidebarCollapsed, true);
    const saved = JSON.parse(await readFile(join(profile, 'preferences.json'), 'utf8'));
    assert.deepEqual(saved, { appearance: 'light', fontSize: 'large', sidebarCollapsed: true });
    assert.equal(await instance.shell.evaluate(() => document.documentElement.dataset.appearance), 'light');
    // 重启后保持图标栏，直到用户主动展开。
    assert.equal((await slotRect(instance.shell)).x, 57);
    await byName(instance.shell, 'button', '展开侧栏').click();
    await retry(async () => assert.equal((await slotRect(instance.shell)).x, 193));
  });
});
