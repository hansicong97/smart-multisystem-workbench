import { parentPort, workerData } from 'node:worker_threads';
import type { ImportIssue, InvoiceRecord, ReadyExpense } from '../../shared/reimbursement.js';
import { ReimbursementError } from './batch.js';
import { resolveV2Attachment } from './csv-v2.js';
import type { V2Batch } from './csv-v2.js';
import { parseInvoicePage, suggestAttachmentLinks } from './invoice-parse.js';
import { readPdfPages, renderPdfPage } from './pdf.js';
import { directPdf, importPdfSources, IMPORT_LIMITS, SourceStore } from './sources.js';
import type { StoredPdf } from './sources.js';

interface ImportResult {
  sources: StoredPdf[];
  records: InvoiceRecord[];
  issues: ImportIssue[];
  expenses: ReadyExpense[];
}

interface FileTasks {
  files: { input: { paths: string[]; folder: string }; output: ImportResult };
  csv: { input: { batch: V2Batch; root: string; folder: string }; output: ImportResult };
  image: { input: { source: StoredPdf; page: number }; output: { png: string; pages: number } };
}

export type FileTaskName = keyof FileTasks;
export type FileTaskInput<K extends FileTaskName> = FileTasks[K]['input'];
export type FileTaskOutput<K extends FileTaskName> = FileTasks[K]['output'];
export type FileTask = { [K in FileTaskName]: { type: K } & FileTaskInput<K> }[FileTaskName];

async function execute(task: FileTask) {
  const update = (done: number, total: number) => parentPort?.postMessage({ progress: { done, total } });
  if (task.type === 'image') return renderPdfPage(task.source, task.page);
  if (task.type === 'files') {
    const records: InvoiceRecord[] = [];
    const result = await importPdfSources(task.paths, task.folder, async (source) => {
      const pages = await readPdfPages(source);
      if (records.length + pages.length > IMPORT_LIMITS.entries) {
        throw new ReimbursementError('批次票据页数已达上限，请分批导入');
      }
      records.push(...pages.map((text, index) => parseInvoicePage(text, source.id, index + 1)));
    }, update);
    suggestAttachmentLinks(records);
    return { ...result, records, expenses: [] } satisfies ImportResult;
  }
  if (task.batch.attachments.length > IMPORT_LIMITS.entries || task.batch.expenses.length > IMPORT_LIMITS.entries) {
    throw new ReimbursementError('清单明细或附件数量已达上限，请分批导入');
  }
  const store = new SourceStore(task.folder);
  const staged = new Map<string, StoredPdf>();
  const pagesBySource = new Map<string, number>();
  const expenseById = new Map(task.batch.expenses.map((expense) => [expense.id, expense]));
  for (const [index, entry] of task.batch.attachments.entries()) {
    update(index, task.batch.attachments.length);
    let source = staged.get(entry.path);
    if (!source) {
      const path = await resolveV2Attachment(task.root, entry.path);
      source = await store.add(directPdf(path, entry.path, entry.sha256), async (pdf) => {
        pagesBySource.set(pdf.id, (await readPdfPages(pdf)).length);
      });
      staged.set(entry.path, source);
    }
    if (source.sha256 !== entry.sha256 || entry.page > (pagesBySource.get(source.id) ?? 0)) {
      throw new ReimbursementError('附件清单的指纹或页码与原件不符');
    }
    expenseById.get(entry.expenseId)?.attachments.push({ sourceId: source.id, page: entry.page, role: entry.role });
  }
  update(task.batch.attachments.length, task.batch.attachments.length);
  return { sources: store.sources, expenses: task.batch.expenses, records: [], issues: [] } satisfies ImportResult;
}

if (parentPort) {
  const port = parentPort;
  execute(workerData as FileTask).then((output) => port.postMessage({ output }), (error: unknown) => {
    port.postMessage({ error: error instanceof ReimbursementError ? error.message : '无法处理发票文件，请重试' });
  });
}
