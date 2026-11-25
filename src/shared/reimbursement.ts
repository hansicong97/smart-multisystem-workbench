import { z } from 'zod';

export const EXPENSE_CATEGORIES = ['高铁票', '机票', '差旅补贴', '出租车电子票', '出租车实体票'] as const;
export const EXPENSE_MINORS = ['火车票', '境内机票', '境外机票', '出差补贴', '出租车费'] as const;
export const INVOICE_TYPES = ['增值税专用发票', '增值税电子专用发票', '增值税电子普通发票', '增值税普通发票', '其他发票'] as const;
export const DATE_SOURCES = ['自动', '乘坐日期', '开票日期', '出差结束日期', '手动日期'] as const;
export const CATEGORY_MINORS: Record<ExpenseCategory, readonly ExpenseMinor[]> = {
  高铁票: ['火车票'],
  机票: ['境内机票', '境外机票'],
  差旅补贴: ['出差补贴'],
  出租车电子票: ['出租车费'],
  出租车实体票: ['出租车费'],
};

export type ExpenseCategory = typeof EXPENSE_CATEGORIES[number];
export type ExpenseMinor = typeof EXPENSE_MINORS[number];
export type InvoiceType = typeof INVOICE_TYPES[number];

const id = z.string().min(1).max(128);
const shortText = z.string().max(128);
const localDate = z.string().max(10);
const invoiceFields = z.object({
  kind: z.enum(['expense', 'support']),
  category: z.enum(EXPENSE_CATEGORIES).or(z.literal('')),
  minor: z.enum(EXPENSE_MINORS).or(z.literal('')),
  invoiceType: z.enum(INVOICE_TYPES).or(z.literal('')),
  invoiceNumber: shortText,
  invoiceCode: shortText,
  invoiceDate: localDate,
  travelStart: localDate,
  travelEnd: localDate,
  manualDate: localDate,
  dateSource: z.enum(DATE_SOURCES),
  amount: shortText,
  tax: shortText,
  summary: z.string().max(500),
  note: z.string().max(1000),
  linkedExpense: id.or(z.literal('')),
});

export type InvoiceFields = z.infer<typeof invoiceFields>;
export type ReviewStatus = 'pending' | 'reviewed' | 'excluded';

export interface InvoiceRecord {
  id: string;
  sourceId: string;
  page: number;
  fields: InvoiceFields;
  status: ReviewStatus;
  warnings: string[];
}

export interface PdfSource {
  id: string;
  name: string;
  locations: string[];
  size: number;
  sha256: string;
}

export interface ImportIssue {
  id: string;
  label: string;
  message: string;
  kind: 'failed' | 'skipped';
  excluded: boolean;
}

export interface ExpenseAttachment {
  sourceId: string;
  page: number;
  role: 'original' | 'support';
}

export interface OaFields {
  major: string;
  minor: string;
  date: string;
  invoiceType: string;
  amount: string;
  tax: string;
  invoiceNumber: string;
  summary: string;
}

export interface ReadyExpense extends OaFields {
  id: string;
  category: ExpenseCategory;
  invoiceCode: string;
  note: string;
  dateSource: InvoiceFields['dateSource'];
  actualDateSource: Exclude<InvoiceFields['dateSource'], '自动'>;
  invoiceDate: string;
  travelStart: string;
  travelEnd: string;
  attachments: ExpenseAttachment[];
}

export interface FormPreview {
  token: string;
  pageId: number;
  account: string;
  document: string;
  includeTax: boolean;
  total: string;
  entries: Array<{ expenseId: string; status: 'new' | 'matched' | 'conflict'; reason?: string }>;
}

export interface FillResult {
  filled: number;
  matched: number;
  remaining: number;
  readRows: number[];
  pendingRows: number[];
  message: string;
}

export interface ReimbursementState {
  input: 'files' | 'csv' | null;
  records: InvoiceRecord[];
  sources: PdfSource[];
  issues: ImportIssue[];
  expenses: ReadyExpense[];
  blockers: string[];
  progress: { label: string; done: number; total: number } | null;
  preview: FormPreview | null;
  result: FillResult | null;
}

export const reimbursementCommand = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['state', 'importFiles', 'importCsv', 'clear', 'cancel']) }),
  z.object({ type: z.literal('edit'), id, fields: invoiceFields }),
  z.object({ type: z.literal('review'), id }),
  z.object({ type: z.literal('exclude'), id, excluded: z.boolean() }),
  z.object({ type: z.literal('dismissIssue'), id, excluded: z.boolean() }),
  z.object({ type: z.literal('pageImage'), sourceId: id, page: z.number().int().min(1).max(1000) }),
  z.object({ type: z.literal('savePdf'), sourceId: id }),
  z.object({ type: z.literal('preview'), includeTax: z.boolean() }),
  z.object({ type: z.literal('fill'), token: id, includeTax: z.boolean() }),
]);

export type ReimbursementCommand = z.infer<typeof reimbursementCommand>;
export interface ReimbursementReply {
  state?: ReimbursementState;
  image?: { png: string; pages: number };
  error?: string;
  saved?: boolean;
}
