import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { _electron } from 'playwright-core';
import { startMockSites } from '../fixtures/mock-sites.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cache = join(root, '.cache');
const apps = [['oa', 'OA'], ['gitlab', 'GitLab'], ['zentao', '禅道']];
const oaLogin = '/seeyon/index.jsp';
const oaHome = '/seeyon/main.do?method=main';
const worktimeHome = '/ws/pages/worksheet/my-work.html';
const zentaoLogin = '/user-login-L215Lmh0bWw=.html';
const homePaths = { oa: [oaLogin, '/seeyon/main.do'], gitlab: ['/'], zentao: [zentaoLogin, '/my.html'] };

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

async function expireSession(electron, id, url) {
  await electron.evaluate(({ webContents }, { id, url }) =>
    webContents.fromId(id).session.cookies.remove(url, 'smsw_mock_login'), { id, url });
}

async function start(profile, ...flags) {
  const args = ['.', `--user-data-dir=${profile}`, ...flags];
  const electron = await _electron.launch({ cwd: root, args, timeout: 25_000 });
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

async function open({ electron, shell }, id, name) {
  await byName(shell, 'button', `打开 ${name}`).click();
  const page = await waitForPage(electron, homePaths[id]);
  await page.getByRole('heading', { name: new RegExp(`^${name} 模拟(?:首页|登录)$`) }).waitFor();
  return page;
}

test('Electron 实窗模拟站验证', { timeout: 110_000 }, async (t) => {
  await mkdir(cache, { recursive: true });
  const profile = await mkdtemp(join(cache, 'e2e-profile-'));
  let instance;
  t.after(async () => {
    if (instance?.electron.process().exitCode === null) await instance.electron.close();
    if (dirname(profile) === cache) await rm(profile, { recursive: true, force: true, maxRetries: 4 });
  });

  instance = await start(profile);
  const { electron, shell } = instance;
  const opened = new Map();

  await t.test('四个入口按需创建网页，工时入口先打开 OA 登录页', async () => {
    const state = await shellState(shell);
    assert.equal(state.mode, 'mock');
    assert.equal(state.pages.length, 0);
    assert.equal(await electron.evaluate(({ webContents }) => webContents.getAllWebContents().length), 1);
    await byName(shell, 'heading', '工作台').waitFor();
    await byName(shell, 'button', '进入 工时').click();
    await shell.locator('#notice').filter({ hasText: '请在 OA 原页点击工时入口' }).waitFor();
    const oaFromWorktime = await waitForPage(electron, [oaLogin]);
    assert.equal((await shellState(shell)).pages.length, 1);
    for (const [id, name] of apps) opened.set(id, await open(instance, id, name));
    assert.equal(opened.get('oa'), oaFromWorktime);
    assert.equal((await shellState(shell)).pages.length, apps.length);
    await byName(shell, 'button', '打开 OA').click();
    assert.equal((await shellState(shell)).pages.length, apps.length);
  });

  await t.test('禅道原页登录回跳及会话失效提示', async () => {
    await byName(shell, 'button', '打开 禅道').click();
    const zentao = opened.get('zentao');
    const origin = new URL(zentao.url()).origin;
    assert.notEqual(origin, new URL(opened.get('gitlab').url()).origin);
    assert.equal(zentao.url(), origin + zentaoLogin);
    await shell.locator('#notice').filter({ hasText: '使用企业微信扫码登录' }).waitFor();
    await byName(zentao, 'button', '模拟企业微信扫码').click();
    await zentao.waitForURL(origin + '/my.html');
    await byName(zentao, 'heading', '禅道 模拟首页').waitFor();
    assert.equal(await zentao.locator('#login-status').textContent(), '已模拟登录');
    assert.equal(await opened.get('gitlab').locator('#login-status').textContent(), '未登录');

    await expireSession(electron, (await shellState(shell)).active, zentao.url());
    await byName(shell, 'button', '刷新').click();
    await zentao.waitForURL(origin + zentaoLogin);
    await shell.locator('#notice').filter({ hasText: '重新扫码' }).waitFor();
    await byName(zentao, 'button', '模拟企业微信扫码').click();
    await zentao.waitForURL(origin + '/my.html');
    await zentao.locator('#login-status').filter({ hasText: '已模拟登录' }).waitFor();
  });

  await t.test('切换隐藏旧视图，草稿保留，模拟登录会话按应用隔离', async () => {
    await byName(shell, 'button', '打开 OA').click();
    const oa = opened.get('oa');
    assert.equal(await oa.locator('#login-status').textContent(), '未登录');
    const portal = new URL(oaHome, oa.url()).href;
    await byName(oa, 'button', '模拟登录').click();
    await oa.waitForURL(portal);
    assert.equal(await oa.locator('#login-status').textContent(), '已模拟登录');
    assert.equal(await opened.get('gitlab').locator('#login-status').textContent(), '未登录');
    for (const [id, name] of apps) {
      await byName(shell, 'button', `打开 ${name}`).click();
      await opened.get(id).getByLabel('本页草稿').fill(`${name} 草稿`);
    }
    for (const [id, name] of apps) {
      await byName(shell, 'button', `打开 ${name}`).click();
      assert.equal(await opened.get(id).getByLabel('本页草稿').inputValue(), `${name} 草稿`);
      const active = (await shellState(shell)).active;
      const visibleIds = await electron.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return window.contentView.children.filter((view) => view.webContents?.id !== window.webContents.id && view.getVisible())
          .map((view) => view.webContents.id);
      });
      assert.deepEqual(visibleIds, [active]);
    }
  });

  await t.test('工时复用 OA 原页及会话，认证后识别工时落点', async () => {
    await byName(shell, 'button', '打开 工时').click();
    await shell.locator('#notice').filter({ hasText: '请在 OA 原页点击工时入口' }).waitFor();
    const before = await shellState(shell);
    const oaId = before.pages.find((page) => page.appId === 'oa').id;
    assert.equal(before.active, oaId);
    assert.equal(before.pages.length, apps.length);

    const oa = opened.get('oa');
    await byName(oa, 'link', '进入工时').click();
    const worktime = await waitForPage(electron, [worktimeHome]);
    await byName(worktime, 'heading', '工时模拟首页').waitFor();
    assert.equal(worktime.url(), new URL(worktimeHome, oa.url()).href);
    assert.equal(await worktime.locator('#login-status').textContent(), '已模拟登录');
    const after = await shellState(shell);
    const timeTab = after.pages.find((page) => page.id === after.active);
    assert.equal(timeTab?.appId, 'worktime');
    assert.equal(timeTab?.siteId, 'oa');
    await retry(async () => assert.deepEqual(await shell.locator('#tabs .tab-select').allTextContents(), ['OA', '工时']));
    assert.ok(await electron.evaluate(({ webContents, BrowserWindow }, { ids, oaId, timeId }) => {
      const sessions = ids.map((id) => webContents.fromId(id).session);
      return new Set(sessions).size === ids.length &&
        webContents.fromId(oaId).session === webContents.fromId(timeId).session &&
        BrowserWindow.getAllWindows().length === 1;
    }, { ids: before.pages.map((page) => page.id), oaId, timeId: after.active }));

    await byName(shell, 'button', '关闭 工时').click();
    await retry(async () => {
      const state = await shellState(shell);
      assert.equal(state.pages.length, apps.length);
      assert.equal(state.active, oaId);
    });
    assert.equal(await oa.getByLabel('本页草稿').inputValue(), 'OA 草稿');

    await expireSession(electron, oaId, oa.url());
    await byName(oa, 'link', '进入工时').click();
    const expired = await waitForPage(electron, [oaLogin]);
    await byName(expired, 'heading', 'OA 模拟登录').waitFor();
    assert.equal((await shellState(shell)).pages.some((page) => page.appId === 'worktime'), false);
    await shell.locator('#notice').filter({ hasText: '请在 OA 原页登录' }).waitFor();
    await byName(expired, 'button', '模拟登录').click();
    await expired.waitForURL(new URL(oaHome, oa.url()).href);
    await byName(shell, 'button', '关闭 OA 模拟首页').click();
    await retry(async () => assert.equal((await shellState(shell)).active, oaId));
  });

  await t.test('顶部只显示当前来源，切回 OA 时保留原标签和子页', async () => {
    const oa = opened.get('oa');
    const tabs = shell.locator('#tabs .tab-select');
    await byName(shell, 'button', '打开 OA').click();
    const oaId = (await shellState(shell)).active;
    await byName(oa, 'button', '打开弹窗').click();
    const popup = await waitForPage(electron, ['/oa/popup']);
    await byName(popup, 'heading', 'OA 模拟弹窗').waitFor();
    await retry(async () => assert.deepEqual(await tabs.allTextContents(), ['OA', 'OA 模拟弹窗']));
    const withPopup = await shellState(shell);

    for (const name of ['GitLab', '禅道']) {
      await byName(shell, 'button', `打开 ${name}`).click();
      await retry(async () => assert.deepEqual(await tabs.allTextContents(), [name]));
      assert.deepEqual((await shellState(shell)).pages.map(({ id }) => id), withPopup.pages.map(({ id }) => id));
    }
    await byName(shell, 'button', '工作台').click();
    await shell.locator('#tabs').waitFor({ state: 'hidden' });
    await byName(shell, 'button', '打开 OA').click();
    await retry(async () => assert.deepEqual(await tabs.allTextContents(), ['OA', 'OA 模拟弹窗']));
    await byName(shell, 'button', '切换到 OA 模拟弹窗').click();
    assert.equal((await shellState(shell)).active, withPopup.active);
    assert.equal(await popup.locator('#opener').textContent(), '已连接来源页面');
    assert.equal(await oa.getByLabel('本页草稿').inputValue(), 'OA 草稿');
    await byName(shell, 'button', '关闭 OA 模拟弹窗').click();
    await retry(async () => assert.equal((await shellState(shell)).active, oaId));
  });

  await t.test('各应用嵌套跨源 iframe 可见，控件和附件输入可用', async () => {
    for (const [id, name] of apps) {
      await byName(shell, 'button', `打开 ${name}`).click();
      const page = opened.get(id);
      const outer = page.frameLocator('iframe[title="外层 iframe"]');
      const inner = outer.frameLocator('iframe[title="内层 iframe"]');
      await byName(inner, 'heading', '内层 iframe').waitFor();
      const outerOrigin = await outer.locator('body').evaluate(() => location.origin);
      const innerState = await inner.locator('body').evaluate(() => {
        let parentAccessible = true;
        try { void parent.document; } catch { parentAccessible = false; }
        return { origin: location.origin, parentAccessible, bridge: typeof window.workbench };
      });
      assert.notEqual(outerOrigin, new URL(page.url()).origin);
      assert.deepEqual(innerState, { origin: new URL(page.url()).origin, parentAccessible: false, bridge: 'undefined' });
      await inner.getByLabel('费用类型').selectOption('差旅费');
      assert.equal(await inner.getByLabel('费用类型').inputValue(), '差旅费');
      await inner.getByLabel('附件').setInputFiles({ name: 'sample.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') });
      assert.equal(await inner.getByLabel('附件').evaluate((input) => input.files[0]?.name), 'sample.txt');
      assert.deepEqual(await page.evaluate(() => [typeof window.workbench, typeof require]), ['undefined', 'undefined']);
    }
  });

  await t.test('OA 差旅表单注入城市互换，按行生效，克隆新增与空白新增均可互换', async () => {
    await byName(shell, 'button', '打开 OA').click();
    const oa = opened.get('oa');
    await byName(oa, 'link', '差旅申请').click();
    await oa.waitForURL(new URL('/oa/travel', oa.url()).href);
    try {
      const form = oa.frameLocator('iframe#zwIframe');
      await byName(form, 'button', '添加一行').waitFor();
      const swap = form.locator('[data-smsw-swap]');
      await retry(async () => assert.equal(await swap.count(), 1));

      const fillRow = (body, from, to) => body.evaluate((_body, { from, to }) => {
        const set = (name, value) => {
          const span = document.querySelector(`[id="${name}_span"]`);
          const fv = JSON.parse(span.getAttribute('fieldval'));
          fv.value = value;
          span.setAttribute('fieldval', JSON.stringify(fv));
          document.querySelector(`[id="${name}"]`).textContent = value;
          document.querySelector(`span.correlation_form_16[name="${name}"]`).setAttribute('hasrelatied', 'true');
        };
        set('field0001', from);
        set('field0002', to);
      }, { from, to });
      await fillRow(form.locator('body'), '北京', '上海');
      await swap.first().click();
      const swapped = await form.locator('body').evaluate(() => {
        const get = (name) => JSON.parse(document.querySelector(`[id="${name}_span"]`).getAttribute('fieldval')).value;
        return {
          from: get('field0001'), to: get('field0002'),
          fromText: document.querySelector('[id="field0001"]').textContent,
          toText: document.querySelector('[id="field0002"]').textContent,
          fields: window.getFields().filter((f) => f.name === 'field0001' || f.name === 'field0002').map((f) => f.value),
        };
      });
      assert.deepEqual(swapped, { from: '上海', to: '北京', fromText: '上海', toText: '北京', fields: ['上海', '北京'] });

      const readRows = () => form.locator('body').evaluate(() =>
        Array.from(document.querySelectorAll('#formson_100 tr.data-row')).map((row) => ({
          from: JSON.parse(row.querySelector('[id="field0001_span"]').getAttribute('fieldval')).value,
          to: JSON.parse(row.querySelector('[id="field0002_span"]').getAttribute('fieldval')).value,
        })));

      // CAP4's left-side add clones the row client-side: values and button markup
      // are copied but listeners are not. The cloned button must still swap.
      await byName(form, 'button', '添加一行').click();
      await retry(async () => assert.equal(await swap.count(), 2));
      await swap.nth(1).click();
      assert.deepEqual(await readRows(), [{ from: '上海', to: '北京' }, { from: '北京', to: '上海' }]);

      // A blank add returns fresh server-rendered HTML; the observer decorates it.
      await byName(form, 'button', '空白新增').click();
      await retry(async () => assert.equal(await swap.count(), 3));
      await swap.nth(2).evaluate((btn, { from, to }) => {
        const row = btn.closest('tr');
        const set = (name, value) => {
          const span = row.querySelector(`[id="${name}_span"]`);
          const fv = JSON.parse(span.getAttribute('fieldval'));
          fv.value = value;
          span.setAttribute('fieldval', JSON.stringify(fv));
          row.querySelector(`[id="${name}"]`).textContent = value;
          row.querySelector(`span.correlation_form_16[name="${name}"]`).setAttribute('hasrelatied', 'true');
        };
        set('field0001', from);
        set('field0002', to);
      }, { from: '广州', to: '深圳' });
      await swap.nth(2).click();
      assert.deepEqual(await readRows(), [
        { from: '上海', to: '北京' }, { from: '北京', to: '上海' }, { from: '深圳', to: '广州' },
      ]);
    } finally {
      // Return OA to its home page even on failure so later subtests stay isolated.
      await oa.evaluate(() => { location.href = '/seeyon/main.do?method=main'; }).catch(() => {});
      await byName(oa, 'link', '查看详情').waitFor().catch(() => {});
    }
  });

  await t.test('OA 误餐补贴批量填写：默认上月、单人/多人、续填、收起展开', async () => {
    await byName(shell, 'button', '打开 OA').click();
    const oa = opened.get('oa');
    const form = oa.frameLocator('iframe#zwIframe');
    const pad = (n) => (n < 10 ? '0' : '') + n;
    const fmt = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    const loadMeal = async () => {
      await oa.evaluate(() => { location.href = '/oa/meal'; });
      await oa.waitForURL(new URL('/oa/meal', oa.url()).href);
      await form.locator('#__smswMealPanel').waitFor();
    };
    const setRange = async (s, e) => {
      await form.locator('#__smswMealStart').fill(s);
      await form.locator('#__smswMealEnd').fill(e);
    };
    const doFill = async () => {
      await form.locator('#__smswMealFill').click();
      await form.locator('#__smswMealConfirmYes').click();
      await retry(async () => assert.match(await form.locator('#__smswMealLog').textContent(), /完成/));
    };
    const readRows = () => form.locator('body').evaluate(() =>
      Array.from(document.querySelectorAll('#formson_200 tr.data-row')).map((tr) => {
        const cells = tr.querySelectorAll('td');
        const typeSel = cells[2].querySelector('select');
        const orgSel = cells[3].querySelector('select');
        const nameCell = cells[4].querySelector('input[type="hidden"]') ? cells[4] : cells[5];
        const hid = nameCell.querySelector('input[type="hidden"]');
        const txt = nameCell.querySelector('input[type="text"]');
        return {
          date: cells[1].querySelector('input').value,
          type: typeSel.options[typeSel.selectedIndex].text,
          org: orgSel.options[orgSel.selectedIndex].text,
          personId: hid ? hid.value : '',
          personName: txt ? txt.value : '',
          note: cells[9].querySelector('input').value,
          amount: cells[6].querySelector('.amount').textContent,
        };
      }));
    const total = () => form.locator('body').evaluate(() => document.querySelector('#field0015').textContent);

    try {
      await byName(oa, 'link', '误餐补贴').click();
      await oa.waitForURL(new URL('/oa/meal', oa.url()).href);
      await form.locator('#__smswMealPanel').waitFor();

      // 默认区间为上一个自然月整月，默认用餐人员为申请人。
      const now = new Date();
      assert.equal(await form.locator('#__smswMealStart').inputValue(), fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
      assert.equal(await form.locator('#__smswMealEnd').inputValue(), fmt(new Date(now.getFullYear(), now.getMonth(), 0)));
      assert.equal(await form.locator('#__smswMealSummary').textContent(), '已选 1 人：张三');

      // 单人填入：2 天 × 2 类 = 4 行，金额与合计重算，必填格黄底转白。
      await setRange('2026-10-08', '2026-10-09');
      await form.locator('#__smswMealPreview').click();
      await retry(async () => assert.match(await form.locator('#__smswMealLog').textContent(), /4 行/));
      await doFill();
      let rows = await readRows();
      assert.equal(rows.length, 4);
      assert.deepEqual(rows.map((r) => r.date), ['2026-10-08', '2026-10-08', '2026-10-09', '2026-10-09']);
      assert.deepEqual(rows.map((r) => r.type), ['夜宵补贴', '误正餐补贴', '夜宵补贴', '误正餐补贴']);
      assert.deepEqual(rows.map((r) => r.amount), ['15.00', '25.00', '15.00', '25.00']);
      assert.ok(rows.every((r) => r.personId === 'Member|277469390601667094' && r.personName === '张三' && r.org === 'A编'));
      assert.equal(await total(), '80.00');
      const dateBg = await form.locator('body').evaluate(() =>
        document.querySelector('#formson_200 tr.data-row td:nth-child(2) input').style.backgroundColor);
      assert.equal(dateBg, 'rgb(255, 255, 255)');

      // 同批次重复执行不产生重复行。
      await doFill();
      assert.equal((await readRows()).length, 4);

      // 收起再展开，输入原样保留。
      await form.locator('#__smswMealSkip').fill('2026-10-09');
      await form.locator('#__smswMealMin').click();
      await form.locator('#__smswMealPanel').waitFor({ state: 'hidden' });
      await form.locator('#__smswMealChip').waitFor({ state: 'visible' });
      await form.locator('#__smswMealChip').click();
      await form.locator('#__smswMealPanel').waitFor({ state: 'visible' });
      assert.equal(await form.locator('#__smswMealSkip').inputValue(), '2026-10-09');
      await form.locator('#__smswMealSkip').fill('');

      // 多人：首行 B 编格选李四 → 读取表单自动识别 B 编；清空后按人员优先填入。
      await loadMeal();
      await form.locator('body').evaluate(() => {
        const cells = document.querySelector('#formson_200 tr.data-row').querySelectorAll('td');
        cells[5].querySelector('input[type="hidden"]').value = 'Member|222222222222222222';
        cells[5].querySelector('input[type="text"]').value = '李四';
      });
      await form.locator('#__smswMealReadForm').click();
      await form.locator('#__smswMealRosterToggle').click();
      assert.equal(await form.locator('#__smswMealRoster select[data-org="222222222222222222"]').inputValue(), 'B编');
      await setRange('2026-10-08', '2026-10-08');
      await form.locator('#__smswMealClear').check();
      await doFill();
      rows = await readRows();
      assert.equal(rows.length, 4);
      assert.deepEqual(rows.map((r) => r.personName), ['张三', '张三', '李四', '李四']);
      assert.deepEqual(rows.map((r) => r.org), ['A编', 'A编', 'B编', 'B编']);
      assert.deepEqual(rows.map((r) => r.personId), [
        'Member|277469390601667094', 'Member|277469390601667094', 'Member|222222222222222222', 'Member|222222222222222222',
      ]);
      assert.equal(await total(), '80.00');

      // 续填：预填一行后重开，只补缺行，不重复、不重排。
      await loadMeal();
      await form.locator('#__smswMealOnlyMe').click();
      await form.locator('body').evaluate(() => {
        const cells = document.querySelector('#formson_200 tr.data-row').querySelectorAll('td');
        cells[1].querySelector('input').value = '2026-10-08';
        cells[2].querySelector('select').value = 'night';
        cells[3].querySelector('select').value = 'A';
        cells[4].querySelector('input[type="hidden"]').value = 'Member|277469390601667094';
        cells[4].querySelector('input[type="text"]').value = '张三';
        cells[2].querySelector('select').dispatchEvent(new Event('change', { bubbles: true }));
      });
      await setRange('2026-10-08', '2026-10-09');
      await doFill();
      rows = await readRows();
      assert.equal(rows.length, 4);
      assert.deepEqual(rows.map((r) => r.date), ['2026-10-08', '2026-10-08', '2026-10-09', '2026-10-09']);
      assert.deepEqual(rows.map((r) => r.type), ['夜宵补贴', '误正餐补贴', '夜宵补贴', '误正餐补贴']);

      // 差旅表单帧不出现误餐面板或圆钮。
      await oa.evaluate(() => { location.href = '/oa/travel'; });
      await oa.waitForURL(new URL('/oa/travel', oa.url()).href);
      await byName(form, 'button', '添加一行').waitFor();
      assert.equal(await form.locator('#__smswMealPanel').count(), 0);
      assert.equal(await form.locator('#__smswMealChip').count(), 0);
    } finally {
      await oa.evaluate(() => { location.href = '/seeyon/main.do?method=main'; }).catch(() => {});
      await byName(oa, 'link', '查看详情').waitFor().catch(() => {});
    }
  });

  await t.test('同站详情、前进后退和刷新可用，模拟登录保留', async () => {
    for (const [id, name] of apps) {
      await byName(shell, 'button', `打开 ${name}`).click();
      const page = opened.get(id);
      await byName(page, 'link', '查看详情').click();
      await byName(page, 'heading', `${name} 模拟详情`).waitFor();
      await byName(shell, 'button', '后退').click();
      await byName(page, 'heading', `${name} 模拟首页`).waitFor();
      await byName(shell, 'button', '前进').click();
      await byName(page, 'heading', `${name} 模拟详情`).waitFor();
      await byName(shell, 'button', '后退').click();
      await byName(page, 'heading', `${name} 模拟首页`).waitFor();
      const reloaded = page.waitForEvent('framenavigated', (frame) => frame === page.mainFrame());
      await byName(shell, 'button', '刷新').click();
      await reloaded;
      await page.locator('#login-status').filter({ hasText: id === 'gitlab' ? '未登录' : '已模拟登录' }).waitFor();
    }
  });

  await t.test('各应用弹窗在同窗打开，回传后关闭并释放', async () => {
    for (const [id, name] of apps) {
      await byName(shell, 'button', `打开 ${name}`).click();
      const page = opened.get(id);
      await byName(page, 'button', '打开弹窗').click();
      const popup = await waitForPage(electron, [`/${id}/popup`]);
      await byName(popup, 'heading', `${name} 模拟弹窗`).waitFor({ timeout: 8_000 });
      assert.equal(await popup.locator('#opener').textContent(), '已连接来源页面');
      const popupId = (await shellState(shell)).active;
      assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
      await byName(popup, 'button', '回传并关闭').click({ timeout: 8_000 });
      await page.getByText('已收到弹窗结果').waitFor();
      await retry(async () => {
        assert.equal(await electron.evaluate(({ webContents }, id) => Boolean(webContents.fromId(id)), popupId), false);
        const state = await shellState(shell);
        assert.equal(state.active, state.pages.find((tab) => tab.appId === id)?.id);
      });
    }
  });

  await t.test('OA 链接、子页表单、iframe 与延迟导航均在当前窗口打开', async () => {
    await byName(shell, 'button', '打开 OA').click();
    const page = opened.get('oa');
    const oaId = (await shellState(shell)).active;
    const outerFrame = page.frameLocator('iframe[title="外层 iframe"]');
    const openers = [
      () => byName(page, 'link', '打开链接子页').click(),
      () => byName(page, 'button', '提交子页表单').click(),
      () => byName(outerFrame, 'link', '从 iframe 打开 OA 子页').click(),
      async () => {
        await page.evaluate(() => { window.fixtureChild = window.open('', '_blank'); });
        await retry(async () => assert.equal((await shellState(shell)).pages.length, apps.length + 1));
        await page.evaluate(() => { window.fixtureChild.location.href = '/oa/popup'; });
      },
    ];
    for (const openPopup of openers) {
      await openPopup();
      const popup = await waitForPage(electron, ['/oa/popup']);
      await byName(popup, 'heading', 'OA 模拟弹窗').waitFor();
      assert.equal((await shellState(shell)).pages.length, apps.length + 1);
      assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
      await byName(shell, 'button', '关闭 OA 模拟弹窗').click();
      await retry(async () => assert.equal((await shellState(shell)).active, oaId));
    }
  });

  await t.test('拦截越出允许来源的导航、重定向和弹窗', async () => {
    await byName(shell, 'button', '打开 OA').click();
    const page = opened.get('oa');
    await page.getByText('来源限制', { exact: true }).click();
    for (const label of ['跳转到 iframe 来源', '重定向到 iframe 来源', '弹窗打开 iframe 来源']) {
      const url = page.url();
      // A navigation veto has no load event for Playwright's click to wait on.
      await page.evaluate((name) => [...document.links].find((link) => link.textContent === name).click(), label);
      const text = label.startsWith('弹窗') ? '已拦截未授权来源的弹窗' : '已拦截未授权来源 ·';
      await shell.locator('#notice').filter({ hasText: text }).waitFor();
      assert.equal(page.url(), url);
      assert.equal((await shellState(shell)).pages.length, apps.length);
      await byName(shell, 'button', '切换到 OA').click();
    }
    const otherOrigin = new URL(opened.get('zentao').url()).origin;
    await page.evaluate(() => { window.fixtureChild = window.open('', '_blank'); });
    await retry(async () => assert.equal((await shellState(shell)).pages.length, apps.length + 1));
    await page.evaluate((url) => { window.fixtureChild.location.href = url; }, otherOrigin + '/my.html');
    await shell.locator('#notice').filter({ hasText: '已拦截未授权来源 ·' }).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureChild.location.href), 'about:blank');
    const activeTab = shell.locator('#tabs .tab').filter({ has: shell.locator('[aria-pressed="true"]') });
    await activeTab.locator('.tab-close').click();
    await retry(async () => assert.equal((await shellState(shell)).pages.length, apps.length));
  });

  await t.test('拦截未配置端口的 iframe 初始加载、替换和重定向', async () => {
    await byName(shell, 'button', '打开 OA').click();
    const page = opened.get('oa');
    let hits = 0;
    const probe = createServer((_request, response) => {
      hits += 1;
      response.end('unauthorized frame');
    });
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    try {
      const { port } = probe.address();
      const blocked = `http://127.0.0.1:${port}/probe`;
      const redirect = new URL(`/frame-redirect?port=${port}`, page.url()).href;
      for (const [index, src] of [blocked, redirect].entries()) {
        await page.evaluate(({ src, index }) => {
          const frame = document.createElement('iframe');
          frame.src = src;
          if (index === 0) document.body.append(frame);
          else document.querySelector('iframe[title="外层 iframe"]').replaceWith(frame);
        }, { src, index });
        await shell.locator('#notice').filter({ hasText: `已拦截未授权来源 · ${blocked}` }).waitFor();
        assert.equal(hits, 0);
        await byName(shell, 'button', '切换到 OA').click();
      }
    } finally {
      await new Promise((resolve) => probe.close(resolve));
    }
  });

  await t.test('下载写入完整合成文件并反馈完成', async () => {
    const downloadPath = join(profile, 'oa-sample.txt');
    await electron.evaluate(({ webContents }, { id, path }) => {
      webContents.fromId(id).session.once('will-download', (_event, item) => item.setSavePath(path));
    }, { id: (await shellState(shell)).active, path: downloadPath });
    await opened.get('oa').evaluate(() => document.querySelector('a[download]').click());
    await shell.locator('#notice').filter({ hasText: '下载完成' }).waitFor();
    assert.equal(await readFile(downloadPath, 'utf8'), 'SMSW synthetic download for oa\n');
  });

  await t.test('关闭标签销毁网页，重新打开时保留持久会话', async () => {
    const original = (await shellState(shell)).pages;
    for (const [appId, name] of apps) {
      const id = original.find((page) => page.appId === appId).id;
      await byName(shell, 'button', `打开 ${name}`).click();
      await byName(shell, 'button', `关闭 ${name}`).click();
      await retry(async () => {
        assert.equal(await electron.evaluate(({ webContents }, id) => Boolean(webContents.fromId(id)), id), false);
        const state = await shellState(shell);
        assert.equal(state.active, null);
        assert.equal(state.pages.length, apps.length - 1);
      });
      const page = await open(instance, appId, name);
      assert.equal((await shellState(shell)).pages.some((candidate) => candidate.id === id), false);
      assert.equal(await page.locator('#login-status').textContent(), appId === 'gitlab' ? '未登录' : '已模拟登录');
    }
  });

  await t.test('关闭主窗口释放所有站点视图，退出重开仍保持模拟登录', async () => {
    const ids = (await shellState(shell)).pages.map((page) => page.id);
    await electron.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      // Keep the process observable after the normal close of its workbench window.
      new BrowserWindow({ show: false });
      const closed = new Promise((resolve) => main.once('closed', resolve));
      main.close();
      await closed;
    });
    await retry(async () => {
      assert.equal(await electron.evaluate(({ webContents }, ids) => ids.some((id) => Boolean(webContents.fromId(id))), ids), false);
    });
    await electron.close();
    instance = await start(profile);
    assert.equal((await shellState(instance.shell)).pages.length, 0);
    const oa = await open(instance, 'oa', 'OA');
    assert.equal(await oa.locator('#login-status').textContent(), '已模拟登录');
  });
});

test('开发版优先加载站点配置并支持显式模拟模式', { timeout: 70_000 }, async (t) => {
  await mkdir(cache, { recursive: true });
  const profile = await mkdtemp(join(cache, 'dev-config-profile-'));
  const configFile = join(profile, 'sites.json');
  let instance;
  let fixtures;
  t.after(async () => {
    if (instance?.electron.process().exitCode === null) await instance.electron.close();
    fixtures?.close();
    if (dirname(profile) === cache) await rm(profile, { recursive: true, force: true, maxRetries: 4 });
  });

  fixtures = await startMockSites();
  const entryUrl = `${fixtures.siteOrigin}/`;
  await writeFile(configFile, JSON.stringify({ gitlab: { entryUrl } }));
  instance = await start(profile);
  assert.equal((await shellState(instance.shell)).mode, 'configured');
  assert.equal(await instance.shell.locator('#mode').count(), 0); // 配置模式不再显示「本机站点」
  assert.equal(await byName(instance.shell, 'button', '打开 OA').isDisabled(), true);
  const gitlab = await open(instance, 'gitlab', 'GitLab');
  assert.equal(gitlab.url(), entryUrl);
  await instance.electron.close();

  instance = await start(profile, '--mock-sites');
  assert.equal((await shellState(instance.shell)).mode, 'mock');
  assert.equal(await byName(instance.shell, 'button', '打开 OA').isEnabled(), true);
  await instance.electron.close();

  await writeFile(configFile, '{');
  instance = await start(profile);
  assert.equal((await shellState(instance.shell)).mode, 'configured');
  assert.match(await instance.shell.locator('#configuration').textContent(), /配置无效/);
});
