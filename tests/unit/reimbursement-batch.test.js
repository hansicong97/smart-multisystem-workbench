import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { buildReadyExpenses, validDate, totalOf } from '../../dist/main/reimbursement/batch.js';
import { parseCsv, readV2, resolveV2Attachment, READY_HEADERS, ATTACHMENT_HEADERS } from '../../dist/main/reimbursement/csv-v2.js';
import { parseInvoicePage, suggestAttachmentLinks } from '../../dist/main/reimbursement/invoice-parse.js';
import { planRows } from '../../dist/main/reimbursement/oa-form.js';
import { csv, railText, taxiText, supportText, railNumber, taxiNumber, reimbursementFiles } from '../fixtures/reimbursement-files.js';

test('v2 CSV 保留 BOM、长票号、带引号和换行的摘要及零税额', async (t) => {
  const cache = resolve('.cache');
  await mkdir(cache, { recursive: true });
  const folder = await mkdtemp(join(cache, 'reimb-csv-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const fixture = await reimbursementFiles(folder);
  const { expenses, attachments } = await readV2(fixture.ready);
  assert.equal(expenses[0].invoiceNumber, taxiNumber);
  assert.equal(expenses[0].summary, '出行，例子 "A"\n第二行');
  assert.equal(expenses[0].tax, '0.00');
  assert.equal(expenses[0].actualDateSource, '开票日期');
  assert.equal(await resolveV2Attachment(folder, attachments[0].path), fixture.taxiFile);
  for (const path of ['../原件.pdf', 'C:/原件.pdf', '下级\\原件.pdf', '/原件.pdf']) {
    await assert.rejects(resolveV2Attachment(folder, path), /路径/u);
  }
  const old = [...fixture.readyRow];
  old[10] = '1';
  await writeFile(fixture.ready, csv([READY_HEADERS, old]));
  await assert.rejects(readV2(fixture.ready), /版本/u);
  await writeFile(fixture.ready, csv([READY_HEADERS, fixture.readyRow]));
  await writeFile(join(folder, '附件清单.csv'), csv([ATTACHMENT_HEADERS]));
  await assert.rejects(readV2(fixture.ready), /缺少费用原件/u);
  assert.deepEqual(parseCsv('\uFEFFa,"b,c","x""y","x\r\ny",\r\n'), [['a', 'b,c', 'x"y', 'x\r\ny', '']]);
  assert.throws(() => parseCsv('a,"missing'), /未闭合/u);
});

test('识别建议保留日期来源，支持材料单独复核并挂载，合计使用分', () => {
  const rail = parseInvoicePage(railText.join('\n'), 'rail', 1);
  const taxi = parseInvoicePage(taxiText.join('\n'), 'taxi', 1);
  const support = parseInvoicePage(supportText.join('\n'), 'support', 1);
  const records = [taxi, rail, support];
  suggestAttachmentLinks(records);
  assert.equal(support.fields.linkedExpense, taxi.id);
  assert.match(buildReadyExpenses(records).blockers.join(','), /待复核/u);
  for (const record of records) record.status = 'reviewed';
  const { expenses, blockers } = buildReadyExpenses(records);
  assert.deepEqual(blockers, []);
  assert.deepEqual(expenses.map(({ invoiceNumber }) => invoiceNumber), [railNumber, taxiNumber]);
  assert.deepEqual(expenses.map(({ date, tax, attachments }) => [date, tax, attachments.length]),
    [['2026-11-21', '', 1], ['2026-11-23', '0.00', 2]]);
  assert.equal(totalOf(expenses), '376.70');
  assert.equal(validDate('2026-02-29'), false);
  assert.equal(parseInvoicePage('发票号码：' + railNumber + '\n发票号码：' + taxiNumber, 'mixed', 1).fields.amount, '');
  assert.equal(parseInvoicePage('', 'scanned', 1).status, 'pending');
  assert.match(buildReadyExpenses([...records, { ...rail, id: 'another', sourceId: 'another' }]).blockers.join(','), /重复票号/u);
});

test('OA 比对只跳过唯一匹配的行，保留税额精度和重复行歧义', () => {
  const rail = parseInvoicePage(railText.join('\n'), 'rail', 1);
  const taxi = parseInvoicePage(taxiText.join('\n'), 'taxi', 1);
  const { expenses } = buildReadyExpenses([rail, taxi]);
  const row = { blank: false, fields: { ...expenses[1], amount: '56.2', tax: '' } };
  assert.deepEqual(planRows([row], expenses, false).map(({ status }) => status), ['new', 'matched']);
  assert.deepEqual(planRows([row], expenses, true).map(({ status }) => status), ['new', 'conflict']);
  assert.deepEqual(planRows([row, row], expenses, false).map(({ status }) => status), ['new', 'conflict']);
});
