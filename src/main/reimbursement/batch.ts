import {
  CATEGORY_MINORS, EXPENSE_CATEGORIES, INVOICE_TYPES,
} from '../../shared/reimbursement.js';
import type {
  ExpenseAttachment, InvoiceFields, InvoiceRecord, OaFields, ReadyExpense,
} from '../../shared/reimbursement.js';

export class ReimbursementError extends Error {}
export const EXPENSE_MAJOR = '差旅费';

export function cents(value: string): bigint | null {
  if (!/^[0-9]{1,14}(?:\.[0-9]{1,2})?$/u.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

export function amountText(value: bigint): string {
  return (value / 100n).toString() + '.' + (value % 100n).toString().padStart(2, '0');
}

export function totalOf(rows: readonly OaFields[]): string {
  return amountText(rows.reduce((total, row) => total + (cents(row.amount) ?? 0n), 0n));
}

export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value) || value.startsWith('0000')) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

export function dateFor(fields: Pick<InvoiceFields, 'category' | 'dateSource' | 'invoiceDate' | 'travelStart' | 'travelEnd' | 'manualDate'>):
  [ReadyExpense['actualDateSource'], string] {
  let source = fields.dateSource;
  if (source === '自动') {
    if (fields.category === '高铁票' || fields.category === '机票') source = '乘坐日期';
    else if (fields.category === '差旅补贴') source = '出差结束日期';
    else source = '开票日期';
  }
  const values = {
    乘坐日期: fields.travelStart,
    开票日期: fields.invoiceDate,
    出差结束日期: fields.travelEnd,
    手动日期: fields.manualDate,
  };
  return [source, values[source]];
}

export function rowProblems(row: ReadyExpense): string[] {
  const errors: string[] = [];
  const total = cents(row.amount);
  const tax = cents(row.tax);
  if (row.major !== EXPENSE_MAJOR || !CATEGORY_MINORS[row.category]?.some((minor) => minor === row.minor)) {
    errors.push('费用大类或小类与票据分类不符');
  }
  if (!INVOICE_TYPES.some((type) => type === row.invoiceType)) errors.push('请选择发票类型');
  if (!validDate(row.date)) errors.push('请填写有效的' + row.actualDateSource);
  if (total === null) errors.push('请填写有效的价税合计');
  if (row.tax !== '' && (tax === null || (total !== null && tax > total))) errors.push('请核对税额');
  if (row.category === '差旅补贴' ? row.invoiceNumber !== '' : !/^\d{8,24}$/u.test(row.invoiceNumber)) {
    errors.push(row.category === '差旅补贴' ? '差旅补贴的票号应留空' : '请填写有效的发票号码');
  }
  if (row.invoiceCode !== '' && !/^\d{10,12}$/u.test(row.invoiceCode)) errors.push('请核对发票代码');
  if (!row.summary.trim() || row.summary.length > 500) errors.push('请填写 500 字以内的 OA 摘要');
  return errors;
}

export function expenseFromRecord(record: InvoiceRecord): ReadyExpense | null {
  const fields = record.fields;
  if (fields.kind !== 'expense' || !fields.category) return null;
  const [actualDateSource, date] = dateFor(fields);
  return {
    id: record.id, category: fields.category, major: EXPENSE_MAJOR, minor: fields.minor,
    date, dateSource: fields.dateSource, actualDateSource, invoiceType: fields.invoiceType,
    invoiceNumber: fields.invoiceNumber, invoiceCode: fields.invoiceCode,
    amount: fields.amount, tax: fields.tax, summary: fields.summary, note: fields.note,
    invoiceDate: fields.invoiceDate, travelStart: fields.travelStart, travelEnd: fields.travelEnd,
    attachments: [{ sourceId: record.sourceId, page: record.page, role: 'original' }],
  };
}

export function reviewProblems(record: InvoiceRecord, records: readonly InvoiceRecord[]): string[] {
  if (record.fields.kind === 'support') {
    const target = records.find((row) => row.id === record.fields.linkedExpense);
    return target?.fields.kind === 'expense' && target.status !== 'excluded' && target.sourceId !== record.sourceId
      ? [] : ['请将附件关联到另一份有效的费用原件'];
  }
  const row = expenseFromRecord(record);
  return row ? rowProblems(row) : ['请选择票据分类'];
}

export function buildReadyExpenses(records: readonly InvoiceRecord[]) {
  const active = records.filter(({ status }) => status !== 'excluded');
  const blockers: string[] = [];
  const supports = new Map<string, ExpenseAttachment[]>();
  const expenses: ReadyExpense[] = [];
  for (const record of active) {
    if (record.status === 'pending') blockers.push('还有待复核的票据或附件');
    blockers.push(...reviewProblems(record, active));
    const expense = expenseFromRecord(record);
    if (expense) expenses.push(expense);
    if (record.fields.kind !== 'support' || record.status !== 'reviewed') continue;
    const attached = supports.get(record.fields.linkedExpense) ?? [];
    if (!attached.some(({ sourceId }) => sourceId === record.sourceId)) {
      attached.push({ sourceId: record.sourceId, page: record.page, role: 'support' });
    }
    supports.set(record.fields.linkedExpense, attached);
  }
  for (const expense of expenses) expense.attachments.push(...(supports.get(expense.id) ?? []));
  expenses.sort((a, b) => EXPENSE_CATEGORIES.indexOf(a.category) - EXPENSE_CATEGORIES.indexOf(b.category));
  blockers.push(...batchProblems(expenses));
  return { expenses, blockers: [...new Set(blockers)] };
}

export function batchProblems(expenses: readonly ReadyExpense[]): string[] {
  const errors: string[] = [];
  if (!expenses.length) errors.push('批次需要至少一条费用');
  if (new Set(expenses.map(({ id }) => id)).size !== expenses.length) errors.push('清单包含重复明细 ID');
  const invoiceCodes = new Map<string, Set<string>>();
  for (const expense of expenses) {
    if (!expense.invoiceNumber) continue;
    const codes = invoiceCodes.get(expense.invoiceNumber) ?? new Set<string>();
    if (codes.has(expense.invoiceCode) || codes.has('') || (!expense.invoiceCode && codes.size)) {
      errors.push('批次包含重复票号，请核对并排除重复记录');
    }
    codes.add(expense.invoiceCode);
    invoiceCodes.set(expense.invoiceNumber, codes);
  }
  return [...new Set(errors)];
}
