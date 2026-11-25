import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { importPdfSources, IMPORT_LIMITS, verifiedPdf } from '../../dist/main/reimbursement/sources.js';
import { readPdfPages, renderPdfPage } from '../../dist/main/reimbursement/pdf.js';
import { pdfWithText, railText, taxiText, reimbursementFiles, writeZip } from '../fixtures/reimbursement-files.js';

async function directory(t) {
  const cache = resolve('.cache');
  await mkdir(cache, { recursive: true });
  const folder = await mkdtemp(join(cache, 'reimb-source-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const stage = join(folder, 'stage');
  await mkdir(stage);
  return { folder, stage };
}

test('直接 PDF 与含中文目录的 ZIP 共用原件字节，同内容合并并可渲染原页', async (t) => {
  const { folder, stage } = await directory(t);
  const fixture = await reimbursementFiles(folder);
  const text = [];
  const { sources, issues } = await importPdfSources([fixture.direct, fixture.zip], stage, async (source) => {
    text.push((await readPdfPages(source))[0]);
  }, () => {});
  assert.equal(sources.length, 3);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].kind, 'skipped');
  assert.equal(sources[0].locations.length, 2);
  assert.match(sources[1].locations[0], /交通\/网约车\.pdf/u);
  assert.match(text[0], /乘车日期/u);
  assert.match(text[1], /网约车/u);
  assert.deepEqual(await verifiedPdf(sources[1]), fixture.bundledTaxi);
  const image = await renderPdfPage(sources[0], 1);
  assert.equal(image.pages, 1);
  assert.equal(Buffer.from(image.png, 'base64').subarray(1, 4).toString('ascii'), 'PNG');
  await writeFile(sources[0].path, fixture.bundledTaxi);
  await assert.rejects(verifiedPdf(sources[0]), /缓存不可用/u);
});

test('ZIP 文件名、加密、伪 PDF 和损坏包有明确失败结果，目录内同名不同内容分开', async (t) => {
  const { folder, stage } = await directory(t);
  const zip = join(folder, '混合.zip');
  const malformed = join(folder, '无法读取.zip');
  await writeFile(malformed, 'not a zip');
  const rail = pdfWithText(railText);
  await writeZip(zip, [
    ['一/同名.pdf', rail],
    ['二/同名.pdf', pdfWithText(taxiText)],
    ['../外部.pdf', rail],
    ['加密.pdf', rail, { password: 'fixture' }],
    ['伪装.pdf', 'not a pdf'],
    ['内层.zip', 'not a nested fixture'],
  ]);
  const { sources, issues } = await importPdfSources([zip, malformed], stage, async () => {}, () => {});
  assert.equal(sources.length, 2);
  assert.notEqual(sources[0].id, sources[1].id);
  assert.equal((await readdir(stage)).length, 2);
  assert.equal(issues.filter(({ kind }) => kind === 'failed').length, 4);
  assert.equal(issues.filter(({ kind }) => kind === 'skipped').length, 1);
});

test('解压的实际文件大小受限，超限时删除临时内容', async (t) => {
  const { folder, stage } = await directory(t);
  const zip = join(folder, '限额.zip');
  const file = join(folder, '独立.pdf');
  const pdf = pdfWithText(railText);
  await writeFile(file, pdf);
  await writeZip(zip, [['上传.pdf', pdf]]);
  const { sources, issues } = await importPdfSources([file, zip], stage, async () => {}, () => {},
    { ...IMPORT_LIMITS, batchBytes: pdf.length + 10 });
  assert.equal(sources.length, 1);
  assert.match(issues[0].message, /批次超出解压/u);
  assert.equal((await readdir(stage)).length, 1);
});
