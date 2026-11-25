import { open, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DATE_SOURCES, EXPENSE_CATEGORIES } from '../../shared/reimbursement.js';
import type { ReadyExpense } from '../../shared/reimbursement.js';
import { batchProblems, dateFor, ReimbursementError, rowProblems } from './batch.js';

export const READY_CSV = '可填写清单.csv';
export const READY_HEADERS = [
  '序号', '费用大类', '费用小类', '发票日期', '发票类型', '发票金额(价税合计)', '税额', '发票号', '发票文件', '摘要',
  '格式版本', '明细ID', '票据分类', '日期来源', '实际日期来源', '原始开票或补贴日期', '行程开始日期', '行程结束日期',
  '发票代码', '税额状态', '源目录', '源文件', '源页码', '人工备注',
] as const;
export const ATTACHMENT_HEADERS = [
  '格式版本', '明细ID', '附件顺序', '附件角色', '附件记录ID', '源目录', '源文件', '源页码', '文件SHA256', '关联状态',
] as const;

const ATTACHMENT_CSV = '附件清单.csv';
const MAX_CSV_BYTES = 8 * 1024 * 1024;

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/u, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'start' | 'text' | 'quote' | 'closed' = 'start';
  const finishField = () => {
    row.push(field);
    field = '';
    state = 'start';
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (state === 'quote') {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') state = 'closed';
      else field += char;
      continue;
    }
    if (char === ',') finishField();
    else if (char === '\r' || char === '\n') {
      finishField();
      rows.push(row);
      row = [];
      if (char === '\r' && text[index + 1] === '\n') index += 1;
    } else if (char === '"' && state === 'start') state = 'quote';
    else if (char === '"' || state === 'closed') throw new ReimbursementError('CSV 引号或分隔符格式无效');
    else {
      field += char;
      state = 'text';
    }
  }
  if (state === 'quote') throw new ReimbursementError('CSV 有未闭合的引号');
  if (row.length || state !== 'start') {
    finishField();
    rows.push(row);
  }
  return rows;
}

async function readTable(path: string, headers: readonly string[]) {
  let text: string;
  try {
    const file = await open(path);
    try {
      if ((await file.stat()).size > MAX_CSV_BYTES) throw new Error();
      const buffer = Buffer.alloc(MAX_CSV_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const part = await file.read(buffer, bytesRead, buffer.length - bytesRead);
        if (!part.bytesRead) break;
        bytesRead += part.bytesRead;
      }
      if (bytesRead > MAX_CSV_BYTES) throw new Error();
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally {
      await file.close();
    }
  } catch {
    throw new ReimbursementError('无法读取 ' + basename(path) + '，请核对文件、大小和 UTF-8 编码');
  }
  const [header, ...rows] = parseCsv(text);
  if (header?.length !== headers.length || header.some((field, index) => field !== headers[index]) ||
      rows.some((row) => row.length !== headers.length)) {
    throw new ReimbursementError(basename(path) + ' 的表头或列数与 SM-ISA v2 不符');
  }
  return rows;
}

export interface V2Attachment {
  expenseId: string;
  path: string;
  page: number;
  sha256: string;
  role: 'original' | 'support';
}

export interface V2Batch {
  expenses: ReadyExpense[];
  attachments: V2Attachment[];
}

export async function readV2(path: string): Promise<V2Batch> {
  if (basename(path) !== READY_CSV) throw new ReimbursementError('请选择 SM-ISA 的 ' + READY_CSV);
  const [ready, manifest] = await Promise.all([
    readTable(path, READY_HEADERS), readTable(join(dirname(path), ATTACHMENT_CSV), ATTACHMENT_HEADERS),
  ]);
  const expenses: ReadyExpense[] = [];
  const originals = new Map<string, { path: string; page: string }>();
  let lastCategory = -1;
  for (const [index, row] of ready.entries()) {
    const [
      sequence, major, minor, date, invoiceType, amount, tax, invoiceNumber, , summary, version, id,
      categoryName, dateSourceName, actualDateSourceName, invoiceDate, travelStart, travelEnd, invoiceCode, taxStatus,
      , originalPath, originalPage, note,
    ] = row;
    const category = EXPENSE_CATEGORIES.find((item) => item === categoryName);
    const dateSource = DATE_SOURCES.find((item) => item === dateSourceName);
    const actualDateSource = DATE_SOURCES.find((item) => item !== '自动' && item === actualDateSourceName);
    if (version !== '2' || sequence !== String(index + 1) || !id.trim() || id.length > 128 ||
        !category || !dateSource || !actualDateSource) {
      throw new ReimbursementError('正式清单第 ' + (index + 1) + ' 条的版本、序号或分类无效');
    }
    const order = EXPENSE_CATEGORIES.indexOf(category);
    const [expectedSource, expectedDate] = dateFor({
      category, dateSource, invoiceDate, travelStart, travelEnd, manualDate: date,
    });
    if (order < lastCategory || actualDateSource !== expectedSource || date !== expectedDate ||
        taxStatus !== (tax ? '票面税额已录入' : '未列示/待核对')) {
      throw new ReimbursementError('正式清单第 ' + (index + 1) + ' 条的顺序、日期或税额状态不一致');
    }
    lastCategory = order;
    const expense: ReadyExpense = {
      id, category, major, minor, date, invoiceType, amount, tax, invoiceNumber, invoiceCode, summary, note,
      dateSource, actualDateSource, invoiceDate, travelStart, travelEnd, attachments: [],
    };
    const problems = rowProblems(expense);
    if (problems.length) throw new ReimbursementError('正式清单第 ' + (index + 1) + ' 条 · ' + problems.join('，'));
    originals.set(id, { path: originalPath, page: originalPage });
    expenses.push(expense);
  }
  const problems = batchProblems(expenses);
  if (problems.length) throw new ReimbursementError(problems.join('，'));

  const attachments: V2Attachment[] = [];
  const sequences = new Map<string, number>();
  const attachmentIds = new Map<string, Set<string>>();
  for (const row of manifest) {
    const [version, expenseId, order, role, id, , path, sourcePage, hash, status] = row;
    const next = (sequences.get(expenseId) ?? 0) + 1;
    const original = originals.get(expenseId);
    const validRole = role === '发票原件'
      ? next === 1 && status === '原件' && path === original?.path && sourcePage === original?.page
      : role === '支持附件' && next > 1 && status === '已确认';
    const ids = attachmentIds.get(expenseId) ?? new Set<string>();
    if (version !== '2' || !original || order !== String(next) || !validRole || !id.trim() ||
        ids.has(id) || !path || !/^[1-9]\d{0,2}$/u.test(sourcePage) || !/^[a-f0-9]{64}$/iu.test(hash)) {
      throw new ReimbursementError('附件清单包含无效的明细、顺序、关联或文件指纹');
    }
    sequences.set(expenseId, next);
    ids.add(id);
    attachmentIds.set(expenseId, ids);
    attachments.push({ expenseId, path, page: Number(sourcePage), sha256: hash.toLowerCase(),
      role: role === '发票原件' ? 'original' : 'support' });
  }
  if (expenses.some((expense) => expense.category !== '差旅补贴' && !sequences.has(expense.id))) {
    throw new ReimbursementError('附件清单缺少费用原件');
  }
  return { expenses, attachments };
}

export async function resolveV2Attachment(root: string, path: string): Promise<string> {
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[:\\\0]/u.test(part)) ||
      isAbsolute(path) || extname(path).toLowerCase() !== '.pdf') {
    throw new ReimbursementError('清单附件路径必须指向原件目录下的 PDF');
  }
  try {
    const folder = await realpath(root);
    const file = await realpath(resolve(folder, ...parts));
    const within = relative(folder, file);
    if (!within || within === '..' || within.startsWith('..' + sep) || isAbsolute(within)) throw new Error();
    return file;
  } catch {
    throw new ReimbursementError('清单附件缺失或超出所选的原件目录');
  }
}
