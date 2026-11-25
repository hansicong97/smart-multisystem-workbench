import { dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type {
  FillResult, FormPreview, ImportIssue, InvoiceRecord, ReadyExpense,
  ReimbursementCommand, ReimbursementReply, ReimbursementState,
} from '../../shared/reimbursement.js';
import { buildReadyExpenses, ReimbursementError, reviewProblems, totalOf } from './batch.js';
import { readV2 } from './csv-v2.js';
import type { FileTask, FileTaskName, FileTaskOutput } from './file-worker.js';
import { matchesExpense, planRows, readForm, verifyFormTotal, writeExpense } from './oa-form.js';
import type { FormState } from './oa-form.js';
import { sameTarget } from '../oa-form-target.js';
import type { FormTarget } from '../oa-form-target.js';
import { verifiedPdf } from './sources.js';
import type { StoredPdf } from './sources.js';

type Progress = NonNullable<ReimbursementState['progress']>;
type ImportOutput = FileTaskOutput<'files'>;
const windowClosed = '窗口已关闭';
const cancelled = '已取消文件处理';
const removeFolder = (folder: string) => rm(folder, { recursive: true, force: true, maxRetries: 3 });
const occupied = (form: FormState) => JSON.stringify(form.rows.filter(({ blank }) => !blank));

function issuedError(error: unknown, fallback: string): string {
  return error instanceof ReimbursementError ? error.message : fallback;
}

function taskInWorker<K extends FileTaskName>(
  task: Extract<FileTask, { type: K }>,
  signal: AbortSignal,
  onProgress?: (progress: { done: number; total: number }) => void,
): Promise<FileTaskOutput<K>> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./file-worker.js', import.meta.url), { workerData: task, stdout: true, stderr: true });
    // PDF diagnostics are local to the worker and may include document data.
    worker.stdout.resume();
    worker.stderr.resume();
    let done = false;
    const finish = (receive: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      worker.terminate().then(receive, receive);
    };
    const abort = () => finish(() => reject(new ReimbursementError(cancelled)));
    const timer = setTimeout(() => finish(() => reject(new ReimbursementError('处理文件超时，请缩小批次后重试'))),
      task.type === 'image' ? 30_000 : 5 * 60_000);
    signal.addEventListener('abort', abort, { once: true });
    worker.on('message', (message) => {
      if (done) return;
      if (message.progress) onProgress?.(message.progress);
      else if (message.error) finish(() => reject(new ReimbursementError(message.error)));
      else finish(() => resolve(message.output));
    });
    worker.on('error', () => finish(() => reject(new ReimbursementError('本地文件处理进程启动失败'))));
    worker.on('exit', () => finish(() => reject(new ReimbursementError('本地文件处理进程已退出'))));
  });
}

async function discardAbandonedFolders(root: string) {
  const entries = await readdir(root, { withFileTypes: true });
  for (const dir of entries) {
    const match = /^batch-(\d+)-[A-Za-z0-9]+$/u.exec(dir.name);
    if (!match || !dir.isDirectory()) continue;
    try {
      process.kill(Number(match[1]), 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') await removeFolder(join(root, dir.name)).catch(() => {});
    }
  }
}

interface PreviewBinding {
  view: FormPreview;
  target: FormTarget;
  before: FormState;
  version: number;
}

interface InterruptedWrite {
  account: string;
  document: string;
  before: string;
  expense: ReadyExpense;
  includeTax: boolean;
}

export class Reimbursement {
  #folder: string | undefined;
  #input: ReimbursementState['input'] = null;
  #sources = new Map<string, StoredPdf>();
  #issues: ImportIssue[] = [];
  #records: InvoiceRecord[] = [];
  #expenses: ReadyExpense[] = [];
  #blockers: string[] = [];
  #version = 0;
  #progress: Progress | null = null;
  #preview: PreviewBinding | null = null;
  #result: FillResult | null = null;
  #interrupted: InterruptedWrite | null = null;
  #fileJob: AbortController | undefined;
  #imageJob: AbortController | undefined;
  #closed = false;

  constructor(
    private readonly window: BrowserWindow,
    private readonly cacheRoot: string,
    private readonly targets: () => FormTarget[],
    private readonly publish: (state: ReimbursementState) => void,
  ) {}

  async handle(command: ReimbursementCommand): Promise<ReimbursementReply> {
    try {
      if (this.#closed) throw new ReimbursementError(windowClosed);
      switch (command.type) {
        case 'state':
          return { state: this.#snapshot() };
        case 'cancel':
          this.#fileJob?.abort();
          break;
        case 'pageImage':
          return { image: await this.#image(command.sourceId, command.page) };
        case 'savePdf':
          return { saved: await this.#save(command.sourceId) };
        default:
          this.#requireIdle();
          switch (command.type) {
            case 'importFiles':
              await this.#import('files');
              break;
            case 'importCsv':
              await this.#import('csv');
              break;
            case 'clear':
              await this.#clear();
              break;
            case 'edit': {
              const record = this.#record(command.id);
              if (JSON.stringify(record.fields) === JSON.stringify(command.fields)) break;
              record.fields = command.fields;
              record.status = 'pending';
              for (const support of this.#records) {
                if (support.fields.linkedExpense === record.id && support.status === 'reviewed') support.status = 'pending';
              }
              this.#recalculate();
              break;
            }
            case 'review': {
              const record = this.#record(command.id);
              const errors = reviewProblems(record, this.#records);
              if (errors.length) throw new ReimbursementError(errors.join('，'));
              record.status = 'reviewed';
              this.#recalculate();
              break;
            }
            case 'exclude':
              this.#record(command.id).status = command.excluded ? 'excluded' : 'pending';
              this.#recalculate();
              break;
            case 'dismissIssue': {
              const issue = this.#issues.find(({ id, kind }) => id === command.id && kind === 'failed');
              if (!issue) throw new ReimbursementError('请选择一条导入失败记录');
              issue.excluded = command.excluded;
              this.#recalculate();
              break;
            }
            case 'preview':
              await this.#plan(command.includeTax);
              break;
            case 'fill':
              await this.#fill(command.token, command.includeTax);
              break;
          }
      }
      this.#emit();
      return { state: this.#snapshot() };
    } catch (error) {
      this.#emit();
      return { state: this.#snapshot(), error: issuedError(error, '报销操作失败，请核对材料或 OA 页面后重试') };
    }
  }

  dispose() {
    this.#closed = true;
    this.#fileJob?.abort();
    this.#imageJob?.abort();
    if (this.#folder) void removeFolder(this.#folder).catch(() => {});
  }

  #snapshot(): ReimbursementState {
    const preview = this.#preview;
    return {
      input: this.#input, records: this.#records,
      sources: [...this.#sources.values()].map(({ id, size, sha256, name, locations }) => ({ id, size, sha256, name, locations })),
      issues: this.#issues, expenses: this.#expenses, blockers: this.#blockers, progress: this.#progress,
      preview: preview && this.#isCurrent(preview.target) ? preview.view : null,
      result: this.#result,
    };
  }

  #isCurrent(target: FormTarget): boolean {
    return !this.#closed && this.targets().some((candidate) => sameTarget(candidate, target));
  }

  #emit() {
    if (!this.#closed) this.publish(this.#snapshot());
  }

  #requireIdle() {
    if (this.#progress) throw new ReimbursementError('请等待当前报销操作结束');
  }

  #record(id: string) {
    const record = this.#records.find((item) => item.id === id);
    if (!record) throw new ReimbursementError('票据已从当前批次移除');
    return record;
  }

  #source(id: string) {
    const source = this.#sources.get(id);
    if (!source) throw new ReimbursementError('原件已从当前批次移除');
    return source;
  }

  #recalculate() {
    this.#version += 1;
    this.#preview = null;
    this.#result = null;
    if (this.#input !== 'files') return;
    const { expenses, blockers } = buildReadyExpenses(this.#records);
    this.#expenses = expenses;
    this.#blockers = blockers;
    if (this.#issues.some(({ kind, excluded }) => kind === 'failed' && !excluded)) {
      this.#blockers.push('请处理或排除导入失败的材料');
    }
  }

  #setProgress(label: string, done = 0, total = 0) {
    this.#progress = { label, done, total };
    this.#emit();
  }

  async #import(input: 'files' | 'csv') {
    if (this.#input) throw new ReimbursementError('请先清空当前批次');
    const job = new AbortController();
    this.#fileJob = job;
    this.#setProgress('选择报销材料');
    let folder: string | undefined;
    try {
      const isFiles = input === 'files';
      const pick = await dialog.showOpenDialog(this.window, {
        title: isFiles ? '选择 PDF 和 ZIP' : '选择 SM-ISA 可填写清单.csv',
        properties: isFiles ? ['openFile', 'multiSelections'] : ['openFile'],
        filters: [{ name: isFiles ? '发票材料' : 'SM-ISA 清单', extensions: isFiles ? ['pdf', 'zip'] : ['csv'] }],
      });
      if (pick.canceled || !pick.filePaths.length || job.signal.aborted) return;
      const batch = isFiles ? null : await readV2(pick.filePaths[0]);
      let root = '';
      if (batch?.attachments.length) {
        const sourceFolder = await dialog.showOpenDialog(this.window, {
          title: '选择 SM-ISA 原件根目录', properties: ['openDirectory'],
        });
        if (sourceFolder.canceled || !sourceFolder.filePaths.length || job.signal.aborted) return;
        root = sourceFolder.filePaths[0];
      }
      await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
      await discardAbandonedFolders(this.cacheRoot);
      folder = await mkdtemp(join(this.cacheRoot, 'batch-' + process.pid + '-'));
      const label = isFiles ? '读取并识别发票材料' : '核验清单与原件';
      this.#setProgress(label);
      const progress = ({ done, total }: { done: number; total: number }) => this.#setProgress(label, done, total);
      const result: ImportOutput = batch
        ? await taskInWorker<'csv'>({ type: 'csv', batch, folder, root }, job.signal, progress)
        : await taskInWorker<'files'>({ type: 'files', paths: pick.filePaths, folder }, job.signal, progress);
      if (job.signal.aborted || this.#closed) return;
      this.#folder = folder;
      folder = undefined;
      this.#input = input;
      this.#sources = new Map(result.sources.map((source) => [source.id, source]));
      this.#records = result.records;
      this.#issues = result.issues;
      this.#expenses = result.expenses;
      this.#blockers = [];
      this.#recalculate();
    } finally {
      if (folder) await removeFolder(folder);
      this.#fileJob = undefined;
      this.#progress = null;
    }
  }

  async #clear() {
    this.#preview = null;
    this.#version += 1;
    this.#imageJob?.abort();
    this.#setProgress('清空本地批次');
    try {
      if (this.#folder) await removeFolder(this.#folder);
      this.#folder = undefined;
      this.#input = null;
      this.#sources.clear();
      this.#records = [];
      this.#issues = [];
      this.#expenses = [];
      this.#blockers = [];
      this.#result = null;
    } finally {
      this.#progress = null;
    }
  }

  async #image(sourceId: string, page: number) {
    const source = this.#source(sourceId);
    this.#imageJob?.abort();
    const job = new AbortController();
    this.#imageJob = job;
    try {
      return await taskInWorker<'image'>({ type: 'image', source, page }, job.signal);
    } finally {
      if (this.#imageJob === job) this.#imageJob = undefined;
    }
  }

  async #save(id: string): Promise<boolean> {
    const source = this.#source(id);
    const safeName = source.name.replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_').replace(/^[. ]+|[. ]+$/gu, '') || '发票原件.pdf';
    const chosen = await dialog.showSaveDialog(this.window, {
      title: '保存 PDF 附件', defaultPath: safeName, filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (chosen.canceled || !chosen.filePath || this.#closed) return false;
    const data = await verifiedPdf(source);
    let handle;
    try {
      handle = await open(chosen.filePath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ReimbursementError('同名文件已存在，请选择新名称');
      throw error;
    }
    try {
      try { await handle.writeFile(data); } finally { await handle.close(); }
    } catch (error) {
      await rm(chosen.filePath, { force: true });
      throw error;
    }
    return true;
  }

  async #checkSources(expenses: readonly ReadyExpense[]) {
    const referenced = new Set(expenses.flatMap(({ attachments }) => attachments.map(({ sourceId }) => sourceId)));
    for (const id of referenced) await verifiedPdf(this.#source(id));
  }

  async #plan(includeTax: boolean) {
    this.#preview = null;
    this.#result = null;
    if (!this.#input || !this.#expenses.length || this.#blockers.length) {
      throw new ReimbursementError('批次尚未就绪，请完成票据、附件和导入问题的复核');
    }
    this.#setProgress('核对 OA 表单');
    try {
      await this.#checkSources(this.#expenses);
      const candidates = await Promise.all(this.targets().map(async (target) => ({ target, before: await readForm(target) })));
      const usable = candidates.filter(({ target, before }) => before && this.#isCurrent(target));
      if (usable.length !== 1 || !usable[0].before) {
        throw new ReimbursementError('当前页面未识别到唯一可编辑的差旅报销表单');
      }
      const { target, before } = usable[0];
      const entries = planRows(before.rows, this.#expenses, includeTax);
      if (before.kind === 'cap4') {
        for (const [index, expense] of this.#expenses.entries()) {
          if (/[\r\n]/u.test(expense.summary) || expense.summary.length > 255) {
            entries[index] = { expenseId: expense.id, status: 'conflict', reason: '该 OA 模板的摘要需在一行内且长度最多 255 个字符' };
          }
        }
      }
      const previous = this.#interrupted;
      if (previous && previous.account === before.account && previous.document === before.document) {
        const written = before.rows.filter(({ blank, fields }) =>
          !blank && matchesExpense(fields, previous.expense, previous.includeTax));
        if (occupied(before) === previous.before || written.length === 1) this.#interrupted = null;
        else {
          const conflict = entries.find(({ expenseId }) => expenseId === previous.expense.id) ??
            entries.find(({ status }) => status === 'new');
          if (conflict) {
            conflict.status = 'conflict';
            conflict.reason = '上次写入结果待核对，请在 OA 修正或清空该行后重新预览';
          }
        }
      }
      this.#preview = { target, before, version: this.#version, view: {
        token: randomUUID(), pageId: target.pageId, account: before.account, document: before.document,
        includeTax, total: totalOf(this.#expenses), entries,
      } };
    } finally {
      this.#progress = null;
    }
  }

  async #fill(token: string, includeTax: boolean) {
    const prepared = this.#preview;
    this.#preview = null;
    if (!prepared || prepared.view.token !== token || !this.#isCurrent(prepared.target) ||
        prepared.version !== this.#version || prepared.view.includeTax !== includeTax) {
      throw new ReimbursementError('目标 OA 页面或填写参数已变化，请重新预览');
    }
    if (prepared.view.entries.some(({ status }) => status === 'conflict')) {
      throw new ReimbursementError('请先处理预览中的费用冲突');
    }
    const { target, view, before } = prepared;
    const mapped = new Map(this.#expenses.map((expense) => [expense.id, expense]));
    const matched = view.entries.filter(({ status }) => status === 'matched').length;
    const pending = view.entries.filter(({ status }) => status === 'new');
    const ordinal = ({ expenseId }: FormPreview['entries'][number]) => this.#expenses.findIndex(({ id }) => id === expenseId) + 1;
    let filled = 0;
    let interrupted: InterruptedWrite | undefined;
    const label = '填写并回读 OA';
    this.#setProgress(label, 0, pending.length);
    try {
      await this.#checkSources(this.#expenses);
      let expected = await readForm(target);
      if (!expected || !this.#isCurrent(target) || JSON.stringify(expected) !== JSON.stringify(before)) {
        throw new ReimbursementError('OA 明细在确认后发生变化，请重新预览');
      }
      for (const entry of pending) {
        if (!this.#isCurrent(target)) throw new ReimbursementError('目标 OA 页面已变化，请返回原单重新预览');
        const expense = mapped.get(entry.expenseId);
        if (!expense) throw new ReimbursementError('复核批次已变化，请重新预览');
        interrupted = {
          account: before.account, document: before.document,
          before: occupied(expected), expense, includeTax: view.includeTax,
        };
        expected = await writeExpense(target, expected, expense, view.includeTax);
        if (!this.#isCurrent(target)) throw new ReimbursementError('当前页面已切换，请返回原单核对最后一行');
        interrupted = undefined;
        filled += 1;
        this.#setProgress(label, filled, pending.length);
      }
      const after = planRows(expected.rows, this.#expenses, view.includeTax);
      if (after.some(({ status }) => status !== 'matched')) throw new ReimbursementError('费用合计或明细发生变化，请重新预览');
      verifyFormTotal(expected);
      this.#result = { filled, matched, remaining: 0, readRows: pending.map(ordinal), pendingRows: [], message: '已填入 OA，待人工核对' };
    } catch (error) {
      if (interrupted) this.#interrupted = interrupted;
      this.#result = {
        filled, matched, remaining: this.#expenses.length - filled - matched,
        readRows: pending.slice(0, filled).map(ordinal), pendingRows: pending.slice(filled).map(ordinal),
        message: issuedError(error, 'OA 填写已暂停，请核对已填行后重新预览'),
      };
    } finally {
      this.#progress = null;
    }
  }
}
