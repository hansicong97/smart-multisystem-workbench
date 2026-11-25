import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { _electron } from 'playwright-core';
import { reimbursementFiles, railNumber, taxiNumber } from '../fixtures/reimbursement-files.js';
import { assistantContext, assistantEntry, openAssistant } from './assistant-helpers.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cache = join(root, '.cache');
const button = (page, name) => page.getByRole('button', { name, exact: true });
const state = async (shell) => {
  const target = await assistantContext(shell);
  return target ? shell.evaluate(async (target) => (await window.workbench.reimbursement({ target, command: { type: 'state' } })).state, target) : null;
};
const rowValues = (form, field) => form.locator('[data-field=' + field + ']').evaluateAll((rows) => rows.map((row) => row.value));

async function waitFor(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await check();
    if (result) return result;
    await delay(60);
  }
  throw new Error('waiting for reimbursement state');
}

async function setDialogs(electron, opens, saves = []) {
  await electron.evaluate(({ dialog }, { opens, saves }) => {
    dialog.showOpenDialog = async () => {
      const filePaths = opens.shift() ?? [];
      return { filePaths, canceled: filePaths.length === 0 };
    };
    dialog.showSaveDialog = async () => {
      const filePath = saves.shift();
      return { filePath, canceled: !filePath };
    };
  }, { opens, saves });
}

test('报销助手实窗验证 v2 导入、PDF/ZIP 复核、OA 逐行回读及安全重试', { timeout: 130_000 }, async (t) => {
  await mkdir(cache, { recursive: true });
  const temp = await mkdtemp(join(cache, 'reimbursement-e2e-'));
  let electron;
  t.after(async () => {
    if (electron?.process().exitCode === null) await electron.close();
    await rm(temp, { recursive: true, force: true, maxRetries: 4 });
  });
  const inputs = join(temp, '测试发票材料');
  const files = await reimbursementFiles(inputs);
  const savedAttachment = join(temp, '保存的行程单.pdf');
  const deviceScale = process.env.SMSW_TEST_SCALE;
  electron = await _electron.launch({
    cwd: root, args: ['.', '--mock-sites', '--user-data-dir=' + join(temp, 'profile'),
      ...(deviceScale ? ['--force-device-scale-factor=' + deviceScale] : [])], timeout: 25_000,
  });
  t.diagnostic('Electron scaleFactor ' + await electron.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor));
  const shell = await electron.firstWindow();
  shell.setDefaultTimeout(12_000);
  await shell.locator('body[data-ready=true]').waitFor();
  await button(shell, '打开 OA').click();
  const oa = await waitFor(() => electron.context().pages().find((page) => page.url().includes('/seeyon/index.jsp')));
  await button(oa, '模拟登录').click();
  await oa.getByRole('link', { name: '差旅报销', exact: true }).click();
  await oa.waitForURL('**/oa/reimbursement');
  const form = oa.frameLocator('iframe#zwIframe');
  await form.locator('body[data-ready=true]').waitFor();
  const popup = await openAssistant(electron, shell);
  assert.equal(await popup.evaluate(() => typeof window.workbench), 'undefined');
  assert.equal(await oa.evaluate(() => typeof window.workbench), 'undefined');

  await t.test('读取同批正式 CSV 并空白新增，字段写入后读取表单模型', async () => {
    await form.locator('[data-field=invoiceNumber]').fill('88990011');
    await form.locator('[data-field=amount]').fill('20.00');
    await setDialogs(electron, [[files.ready], [inputs]]);
    await button(popup, '导入 SM-ISA 已复核清单').click();
    await popup.getByText('SM-ISA 已复核清单', { exact: true }).waitFor();
    await popup.getByLabel('本次填写已知税额', { exact: true }).check();
    await button(popup, '预览 OA 填写').click();
    await popup.getByText('模拟报销用户', { exact: false }).waitFor();
    await button(popup, '确认填写').click();
    await popup.getByText('已填入 OA，待人工核对', { exact: true }).waitFor();
    assert.deepEqual(await rowValues(form, 'invoiceNumber'), ['88990011', taxiNumber]);
    assert.deepEqual(await rowValues(form, 'tax'), ['', '0.00']);
    assert.deepEqual(await rowValues(form, 'summary'), ['', '出行，例子 "A"\n第二行']);
    assert.equal(await form.locator('#reimbursement-total').textContent(), '76.20');
    assert.equal(await form.locator('#reimbursement-saves').textContent(), '0');
    assert.equal(await form.locator('#reimbursement-submits').textContent(), '0');
    await button(popup, '清空批次').click();
    await button(popup, '确认清空本地批次').click();
    await button(popup, '选择发票文件').waitFor();
  });

  await t.test('混合导入识别并复核，按行保存 ZIP 内的原始 PDF', async () => {
    await oa.goto(new URL('/oa/reimbursement?add=clone', oa.url()).href);
    await form.locator('body[data-ready=true]').waitFor();
    await openAssistant(electron, shell);
    await setDialogs(electron, [[files.direct, files.zip]], [savedAttachment]);
    await button(popup, '选择发票文件').click();
    await popup.getByRole('heading', { name: '票据原件', exact: true }).waitFor();
    await popup.getByRole('img', { name: '发票原件第 1 页', exact: true }).waitFor();
    assert.equal(await popup.locator('.reimb-editor').isVisible(), false);
    await shell.locator('.tab-select[aria-pressed=true]').waitFor();
    const originalContext = await assistantContext(shell);
    await button(popup, '进入复核').click();
    await popup.getByRole('heading', { name: '发票复核', exact: true }).waitFor();
    assert.deepEqual(await assistantContext(shell), originalContext);
    const imported = await state(shell);
    assert.equal(imported.sources.length, 3);
    assert.equal(imported.records.length, 3);
    assert.equal(imported.sources[0].locations.length, 2);
    assert.equal(imported.issues[0].kind, 'skipped');
    for (const category of ['高铁票', '出租车电子票', '支持附件']) {
      const current = popup.locator('.reimb-record').filter({ hasText: category });
      await current.click();
      await button(popup, '确认复核').click();
      await current.getByText('已复核', { exact: true }).waitFor();
    }
    await button(popup, '完成复核').click();
    await waitFor(() => button(popup, '查看原件').evaluate((entry) => entry.ownerDocument.activeElement === entry));
    assert.deepEqual(await assistantContext(shell), originalContext);
    const ready = await state(shell);
    assert.deepEqual(ready.blockers, []);
    assert.deepEqual(ready.expenses.map(({ invoiceNumber, attachments }) => [invoiceNumber, attachments.length]),
      [[railNumber, 1], [taxiNumber, 2]]);
    await button(popup, '保存 滴滴行程单.pdf').click();
    await popup.getByText('已保存 PDF 附件，可在 OA 选择该文件', { exact: true }).waitFor();
    assert.deepEqual(await readFile(savedAttachment), files.bundledSupport);
  });

  await t.test('已有行保留，金额变更后暂停，纠正并重试仍只有原来的三行', async () => {
    await form.locator('[data-field=invoiceNumber]').fill('88990011');
    await form.locator('[data-field=amount]').fill('20.00');
    await button(popup, '预览 OA 填写').click();
    await button(popup, '确认填写').waitFor();
    await form.locator('[data-field=amount]').fill('21.00');
    await button(popup, '确认填写').click();
    await popup.getByText('OA 明细在确认后发生变化，请重新预览', { exact: true }).waitFor();
    assert.deepEqual(await rowValues(form, 'amount'), ['21.00']);
    await form.locator('[data-field=amount]').fill('20.00');
    await form.locator('body').evaluate((body) => { body.dataset.clamp = 'true'; });
    await button(popup, '预览 OA 填写').click();
    await popup.getByText('2 条待新增 · 0 条已匹配 · 0 条冲突', { exact: true }).waitFor();
    await button(popup, '确认填写').click();
    await popup.getByText(/第 3 行回读不一致/u).waitFor();
    await popup.getByText('已回读费用第 1 条').waitFor();
    await popup.getByText('待处理费用第 2 条').waitFor();
    assert.deepEqual(await rowValues(form, 'invoiceNumber'), ['88990011', railNumber, taxiNumber]);
    assert.deepEqual(await rowValues(form, 'amount'), ['20.00', '320.50', '56.00']);
    await button(popup, '预览 OA 填写').click();
    await popup.getByText('0 条待新增 · 1 条已匹配 · 1 条冲突', { exact: true }).waitFor();
    assert.equal(await button(popup, '确认填写').isEnabled(), false);
    await form.locator('body').evaluate((body) => { body.dataset.clamp = 'false'; });
    await form.locator('[data-field=amount]').nth(2).fill('56.20');
    await button(popup, '预览 OA 填写').click();
    await popup.getByText('0 条待新增 · 2 条已匹配 · 0 条冲突', { exact: true }).waitFor();
    await button(popup, '确认填写').click();
    await popup.getByText('已新增 0 条 · 已匹配 2 条 · 待处理 0 条', { exact: true }).waitFor();
    assert.equal(await form.locator('#reimbursement-total').textContent(), '396.70');
    assert.equal(await form.locator('#reimbursement-saves').textContent(), '0');
    assert.equal(await form.locator('#reimbursement-submits').textContent(), '0');
  });

  await t.test('刷新使预览失效，原单的报销批次仍可继续', async () => {
    await button(popup, '预览 OA 填写').click();
    const target = await assistantContext(shell);
    const preview = await waitFor(async () => (await state(shell))?.preview);
    await oa.reload();
    await form.locator('body[data-ready=true]').waitFor();
    const command = { type: 'fill', token: preview.token, includeTax: preview.includeTax };
    const reply = await shell.evaluate((request) => window.workbench.reimbursement(request), { target, command });
    assert.match(reply.error, /目标 OA 表单已变化/u);
    assert.deepEqual(await rowValues(form, 'invoiceNumber'), ['']);
    await assistantEntry(shell).waitFor();
    assert.equal(await assistantEntry(shell).getAttribute('aria-expanded'), 'false');
    await openAssistant(electron, shell);
    await popup.getByText('3 份 PDF', { exact: true }).waitFor();
    assert.equal(await button(popup, '确认填写').count(), 0);
  });

  await t.test('两种逻辑尺寸和侧栏形态下浮窗对齐、原页可点、Esc 与大窗返回', async (t) => {
    for (const size of [[1130, 780], [860, 650]]) {
      await electron.evaluate(async ({ BrowserWindow }, [width, height]) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win.isMaximized()) {
          const restored = new Promise((resolve) => win.once('unmaximize', resolve));
          win.unmaximize();
          await restored;
        }
        win.setContentSize(width, height);
      }, size);
      await waitFor(async () => {
        const slot = await shell.locator('.web-slot').boundingBox();
        const actual = await electron.evaluate(({ BrowserWindow }) => {
          const win = BrowserWindow.getAllWindows()[0];
          const view = win.contentView.children.find((view) => view.webContents?.getURL().includes('/oa/reimbursement'));
          return view?.getVisible() ? view.getBounds() : null;
        });
        return slot && actual && ['x', 'y', 'width', 'height'].every((key) => Math.abs(slot[key] - actual[key]) <= 1);
      });
      for (const label of ['收起侧栏', '展开侧栏']) {
        await button(shell, label).click();
        await openAssistant(electron, shell);
        let measurement;
        await waitFor(async () => {
          const anchor = await assistantEntry(shell).boundingBox();
          const panel = await popup.locator('.assistant-panel').boundingBox();
          const slot = await shell.locator('.web-slot').boundingBox();
          const views = await electron.evaluate(({ BrowserWindow }) => {
            const win = BrowserWindow.getAllWindows()[0];
            return {
              size: win.getContentSize(),
              oa: win.contentView.children.find((view) => view.getVisible() && view.webContents?.getURL().includes('/oa/reimbursement'))?.getBounds(),
              assistant: win.contentView.children.find((view) => view.getVisible() && view.webContents?.getURL() === 'about:blank')?.getBounds(),
            };
          });
          measurement = { requested: size, label, anchor, panel, slot, views };
          if (!anchor || !panel || !slot || !views.oa || !views.assistant) return false;
          // Windows rounds the requested minimum through the non-client area
          // at fractional DPI. Compare the actual native slot separately.
          if (!views.size.every((value, index) => Math.abs(value - size[index]) <= 2)) return false;
          if (Math.abs(slot.x - (label === '收起侧栏' ? 57 : 193)) > 1) return false;
          const surfaceX = views.assistant.x + panel.x;
          const surfaceY = views.assistant.y + panel.y;
          return panel.width === 320 && Math.abs(anchor.x + anchor.width - (surfaceX + panel.width)) <= 1 &&
            Math.abs(surfaceY - (anchor.y + anchor.height) - 8) <= 1 &&
            ['x', 'y', 'width', 'height'].every((key) => Math.abs(slot[key] - views.oa[key]) <= 1);
        }).catch((failure) => assert.fail(`${failure.message} ${JSON.stringify(measurement)}`));
        t.diagnostic(JSON.stringify(measurement));
        assert.equal(await popup.locator('.assistant-tools').evaluate((element) => getComputedStyle(element).overflowY), 'auto');
        if (size[0] === 860) {
          await button(popup, '预览 OA 填写').click();
          await popup.getByText(/条待新增 · \d+ 条已匹配/u).waitFor();
          assert.equal(await popup.locator('.assistant-tools').evaluate((element) => element.scrollHeight > element.clientHeight), true);
        }
        await popup.keyboard.press('Escape');
        await popup.locator('.assistant-panel').waitFor({ state: 'hidden' });
        await waitFor(() => assistantEntry(shell).evaluate((entry) => entry.ownerDocument.activeElement === entry));
      }
      await openAssistant(electron, shell);
      await oa.locator('#subject').click();
      await popup.locator('.assistant-panel').waitFor({ state: 'hidden' });
      assert.equal(await oa.locator('#subject').evaluate((input) => input.ownerDocument.activeElement === input), true);
      await openAssistant(electron, shell);
      await button(popup, '查看原件').click();
      await popup.getByRole('heading', { name: '票据原件', exact: true }).waitFor();
      const slot = await shell.locator('.web-slot').boundingBox();
      const width = await popup.locator('.reimb-document').evaluate((element) => element.getBoundingClientRect().width);
      assert.ok(width > 320 && width < slot.width);
      await button(popup, '关闭票据窗口').click();
      await waitFor(() => button(popup, '查看原件').evaluate((entry) => entry.ownerDocument.activeElement === entry));
      await assistantEntry(shell).click();
      await popup.locator('.assistant-panel').waitFor({ state: 'hidden' });
    }
  });

  await t.test('切换 OA 单据收起助手，不串用批次与确认，返回保留原单草稿', async () => {
    await openAssistant(electron, shell);
    await button(popup, '预览 OA 填写').click();
    const first = await assistantContext(shell);
    const preview = await waitFor(async () => (await state(shell))?.preview);
    await oa.evaluate(() => { window.open('/oa/reimbursement?document=043', '_blank'); });
    const other = await waitFor(async () => {
      const context = await assistantContext(shell);
      return context && context.pageId !== first.pageId ? context : null;
    });
    assert.notEqual(other.documentKey, first.documentKey);
    assert.equal(await assistantEntry(shell).getAttribute('aria-expanded'), 'false');
    await openAssistant(electron, shell);
    await button(popup, '选择发票文件').waitFor();
    const invalid = await shell.evaluate((request) => window.workbench.reimbursement(request), {
      target: first, command: { type: 'fill', token: preview.token, includeTax: preview.includeTax },
    });
    assert.match(invalid.error, /目标 OA 表单已变化/u);
    await shell.locator('.tab').filter({ has: shell.locator('.tab-select[aria-pressed=true]') }).locator('.tab-close').click();
    await waitFor(async () => (await assistantContext(shell))?.pageId === first.pageId);
    assert.equal(await assistantEntry(shell).getAttribute('aria-expanded'), 'false');
    await openAssistant(electron, shell);
    await popup.getByText('3 份 PDF', { exact: true }).waitFor();
    assert.equal(await button(popup, '确认填写').count(), 0);
    const afterReturn = await shell.evaluate((request) => window.workbench.reimbursement(request), {
      target: first, command: { type: 'fill', token: preview.token, includeTax: preview.includeTax },
    });
    assert.match(afterReturn.error, /重新预览/u);
  });

  await t.test('CAP4 使用原生选择值和显示控件，汇总计算后恢复费用小类', async () => {
    await oa.goto(new URL('/oa/reimbursement?controls=cap4', oa.url()).href);
    await oa.waitForFunction(() => document.querySelector('iframe#zwIframe')?.contentDocument?.body?.dataset.ready === 'true');
    await openAssistant(electron, shell);
    await button(popup, '预览 OA 填写').click();
    await popup.getByText('2 条待新增 · 0 条已匹配 · 0 条冲突', { exact: true }).waitFor();
    await button(popup, '确认填写').click();
    await popup.getByText('已填入 OA，待人工核对', { exact: true }).waitFor();
    const live = await oa.evaluate(() => {
      const doc = document.querySelector('iframe#zwIframe').contentDocument;
      const values = (field) => [...doc.querySelectorAll('[data-field=' + field + ']')].map((input) => input.value);
      return { numbers: values('invoiceNumber'), minors: values('minor'), statuses: ['total', 'saves', 'submits']
        .map((id) => doc.getElementById('reimbursement-' + id).textContent) };
    });
    assert.deepEqual(live, { numbers: [railNumber, taxiNumber], minors: ['minor-0', 'minor-4'], statuses: ['376.70', '0', '0'] });
  });
});
