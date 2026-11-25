import type { InvoiceFields, InvoiceRecord } from '../../shared/reimbursement.js';
import { amountText, cents, validDate } from './batch.js';

const compact = (value: string) => value.normalize('NFKC').replace(/\s+/gu, '');

export function blankInvoice(): InvoiceFields {
  return {
    kind: 'expense', category: '', minor: '', invoiceType: '', invoiceNumber: '', invoiceCode: '',
    invoiceDate: '', travelStart: '', travelEnd: '', manualDate: '', dateSource: '自动',
    amount: '', tax: '', summary: '', note: '', linkedExpense: '',
  };
}

function dateIn(text: string): string {
  const parts = text.match(/(20\d{2})[年./-](\d{1,2})[月./-](\d{1,2})(?!\d)/u);
  if (!parts) return '';
  const date = [parts[1], parts[2].padStart(2, '0'), parts[3].padStart(2, '0')].join('-');
  return validDate(date) ? date : '';
}

function uniqueMatch(text: string, pattern: RegExp): string {
  const matches = [...new Set([...text.matchAll(pattern)].map((match) => match[1]))];
  return matches.length === 1 ? matches[0] : '';
}

function decimal(value: string): string {
  const amount = cents(value.replaceAll(',', ''));
  return amount === null ? '' : amountText(amount);
}

export function parseInvoicePage(text: string, sourceId: string, page: number): InvoiceRecord {
  const fields = blankInvoice();
  const warnings: string[] = [];
  const record: InvoiceRecord = { id: sourceId + ':' + page, sourceId, page, fields, warnings, status: 'pending' };
  const content = compact(text);
  if (!content) {
    warnings.push('此页没有可读取的文字，请对照原件补录');
    return record;
  }
  if (/(滴滴出行|网约车|DIDITRAVEL).{0,24}行程单|DIDITRAVEL-TRIPTABLE/iu.test(content) &&
      !/航空运输电子客票行程单/u.test(content)) {
    fields.kind = 'support';
    fields.amount = decimal(uniqueMatch(content, /合计[:：]?[¥]?(\d[\d,]*\.\d{2})元?/gu));
    const period = content.match(/行程起止日期[:：]?(20\d{2}-\d{2}-\d{2})至(20\d{2}-\d{2}-\d{2})/u);
    if (period) {
      fields.travelStart = dateIn(period[1]);
      fields.travelEnd = dateIn(period[2]);
    }
    warnings.push('行程单需要确认所对应的费用');
    return record;
  }
  const numbers = new Set([...content.matchAll(/(?:发票号码|发票号)[:：]?(\d{8,24})(?!\d)/gu)].map((match) => match[1]));
  if (numbers.size > 1) {
    warnings.push('本页包含多个票号，请拆分原件后重新导入');
    return record;
  }
  fields.invoiceNumber = numbers.values().next().value ?? '';
  fields.invoiceCode = uniqueMatch(content, /发票代码[:：]?(\d{10,12})(?!\d)/gu);
  fields.invoiceDate = dateIn(content.match(/开票日期[:：]?(20\d{2}[年./-]\d{1,2}[月./-]\d{1,2}(?!\d))/u)?.[1] ?? '');

  const railway = /铁路电子客票|电子客票号|中国铁路|12306/u.test(content);
  const train = content.match(/(?<![A-Za-z])G\d{1,5}(?!\d)/u)?.[0] ?? '';
  const electronic = /电子发票|增值税电子(?:专用|普通)发票/u.test(content);
  if (/增值税电子专用发票/u.test(content) || (electronic && content.includes('专用发票'))) {
    fields.invoiceType = '增值税电子专用发票';
  } else if (/增值税电子普通发票/u.test(content) || (electronic && content.includes('普通发票')) || railway) {
    fields.invoiceType = '增值税电子普通发票';
  } else if (content.includes('增值税专用发票')) fields.invoiceType = '增值税专用发票';
  else if (content.includes('增值税普通发票')) fields.invoiceType = '增值税普通发票';

  let total = uniqueMatch(content, /小写[)）]?[:：]?[¥]?(\d[\d,]*\.\d{2})/gu);
  if (railway && train) {
    fields.category = '高铁票';
    fields.minor = '火车票';
    if (!/小写/u.test(content)) total = uniqueMatch(content, /票价[:：]?[¥]?(\d[\d,]*\.\d{2})/gu);
    const travelDates = text.split(/\r?\n/u).map(compact)
      .filter((line) => !line.includes('开票') && /开车|乘车|发车|\d:\d{2}开/u.test(line))
      .map(dateIn).filter(Boolean);
    const explicit = dateIn(content.match(/(?:乘车日期|出发日期|开车日期)[:：]?(20\d{2}[年./-]\d{1,2}[月./-]\d{1,2})/u)?.[1] ?? '');
    const dates = [...new Set([explicit, ...travelDates].filter(Boolean))];
    fields.travelStart = dates.length === 1 ? dates[0] : '';
    fields.travelEnd = fields.travelStart;
    fields.summary = [fields.travelStart, train, '火车票'].filter(Boolean).join(' ');
  } else if (electronic && /滴滴|网约车|出租汽车|出租车|客运出租/u.test(content) && !railway) {
    fields.category = '出租车电子票';
    fields.minor = '出租车费';
    fields.summary = '出租车费用';
  } else {
    warnings.push('未匹配已支持的自动识别票种，请人工选择类别或排除');
  }
  fields.amount = decimal(total);
  const vatTotals = [...content.matchAll(/合计[:：]?¥(\d[\d,]*\.\d{2})¥(\d[\d,]*\.\d{2})/gu)];
  if (vatTotals.length === 1) {
    fields.tax = decimal(vatTotals[0][2]);
    const net = cents(decimal(vatTotals[0][1]));
    const tax = cents(fields.tax);
    if (net !== null && tax !== null && fields.amount && net + tax !== cents(fields.amount)) {
      warnings.push('票面不含税金额与税额之和与价税合计不一致');
    }
  }
  if (!fields.invoiceNumber) warnings.push('未识别到唯一发票号码');
  if (!fields.invoiceDate) warnings.push('未识别到开票日期');
  if (fields.category === '高铁票' && !fields.travelStart) warnings.push('请核对乘坐日期');
  if (!fields.amount) warnings.push('未识别到唯一的票价或价税合计');
  if (!fields.tax) warnings.push('税额未识别，暂留空');
  return record;
}

export function suggestAttachmentLinks(records: InvoiceRecord[]): void {
  for (const { fields } of records.filter((record) => record.fields.kind === 'support')) {
    if (!fields.amount || !fields.travelStart || !fields.travelEnd) continue;
    const candidates = records.filter(({ fields: expense }) => expense.category === '出租车电子票' &&
      expense.amount === fields.amount && expense.invoiceDate >= fields.travelStart && expense.invoiceDate <= fields.travelEnd);
    if (candidates.length === 1) fields.linkedExpense = candidates[0].id;
  }
}
