import { z } from 'zod';
import type { FormPreview, OaFields, ReadyExpense } from '../../shared/reimbursement.js';
import { sameForm } from '../oa-form-target.js';
import type { FormTarget } from '../oa-form-target.js';
import { amountText, cents, ReimbursementError } from './batch.js';

const fields = z.object({
  major: z.string().max(200), minor: z.string().max(200), date: z.string().max(200),
  invoiceType: z.string().max(200), amount: z.string().max(200), tax: z.string().max(200),
  invoiceNumber: z.string().max(200), summary: z.string().max(2000),
});
const rowSchema = z.object({ blank: z.boolean(), fields });
const formSchema = z.object({
  instance: z.string().min(1).max(128), account: z.string().min(1).max(128),
  accountKey: z.string().max(128), document: z.string().min(1).max(200), documentId: z.string().max(200),
  kind: z.enum(['native', 'cap4']), total: z.string().max(120).nullable(),
  rows: z.array(rowSchema).max(1000),
});
export type FormState = z.infer<typeof formSchema>;
type FormRow = z.infer<typeof rowSchema>;

type FrameOperation = { type: 'read' } | {
  type: 'write'; before: FormState; expense: OaFields; includeTax: boolean;
};

// Serialized and evaluated in one authorized CAP4 frame. Keep all of its page
// helpers inside this function and pass only the confirmed row as data.
async function inForm(operation: FrameOperation) {
  type Field = keyof OaFields;
  type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  type CapField = { name: string; inputType: string; value: string };
  const runtime = window as Window & {
    CurrentUserId?: string;
    calculating?: boolean;
    $?: { parseJSON(text: string): unknown };
    addEmpty?: (event: { data: { currentNode: HTMLTableRowElement } }) => unknown;
    calc?: (control: Control, all?: boolean) => unknown;
    formPreSubmitData?: (done: () => void) => unknown;
    __smswReimbursementForms?: WeakMap<HTMLTableElement, string>;
  };
  let topDocument: Document | null = null;
  try { topDocument = window.top?.document ?? null; } catch { /* different allowed origin */ }
  const subject = (topDocument?.getElementById('subject') as HTMLInputElement | null)?.value ?? '';
  const cap4 = /差旅\s*报销/u.test(subject) && typeof runtime.CurrentUserId === 'string' &&
    !!runtime.CurrentUserId && typeof runtime.$?.parseJSON === 'function' &&
    typeof runtime.calc === 'function' && typeof runtime.addEmpty === 'function' &&
    typeof runtime.formPreSubmitData === 'function';
  const labels: Record<Field, readonly string[]> = {
    major: ['费用大类'],
    minor: ['费用小类'],
    date: ['发票日期'],
    invoiceType: ['发票类型'],
    amount: ['发票金额(价税合计)', '价税合计'],
    tax: ['税额'],
    invoiceNumber: ['发票号', '发票号码'],
    summary: ['摘要'],
  };
  const keys = Object.keys(labels) as Field[];
  const clean = (value: string) => value.normalize('NFKC').replace(/\s+|\*/gu, '');
  const label = (node: Element | null) => node?.textContent?.trim() ?? '';
  const nearby = (title: string) => label(Array.from(document.querySelectorAll('td'))
    .find((cell) => label(cell) === title)?.nextElementSibling ?? null);
  const fieldModel = (control: Element) => {
    const wrapper = control.closest('[fieldval]');
    const raw = wrapper?.getAttribute('fieldval');
    if (!wrapper || !raw) return null;
    try {
      const data = (cap4 ? runtime.$?.parseJSON(raw) : JSON.parse(raw)) as Omit<CapField, 'value'> & { value: string | number };
      return data && (typeof data.value === 'string' || typeof data.value === 'number')
        ? { wrapper, data: { ...data, value: String(data.value) } } : null;
    } catch {
      return null;
    }
  };
  const displayed = (control: Control) => control.closest('[fieldval]')?.querySelector<HTMLInputElement>('input[id="' + control.id + '_txt"]');
  const readControl = (control: Control) => {
    if (control instanceof HTMLSelectElement) {
      return control.value === '' ? '' : (control.selectedOptions.item(0)?.text ?? '').trim();
    }
    return (cap4 ? control.value : fieldModel(control)?.data.value ?? control.value).trim();
  };
  const controls = (row: HTMLTableRowElement, columns: Record<Field, number>) => {
    const result = {} as Record<Field, Control>;
    for (const key of keys) {
      const cell = row.cells.item(columns[key]);
      const options = cell?.querySelectorAll<Control>(cap4
        ? 'select[id][name],input[id][name]:not([type=hidden],[type=button],[id$=_txt]),textarea[id][name]'
        : 'select,textarea,input:not([type=hidden],[type=button],[type=submit],[type=file],[type=checkbox],[type=radio])');
      if (options?.length !== 1) return null;
      const control = options[0];
      if (control.disabled || control.closest('[aria-disabled="true"]') ||
          (!(control instanceof HTMLSelectElement) && control.readOnly)) return null;
      if (cap4 && (!/^field\d+$/u.test(control.id) || fieldModel(control)?.data.name !== control.id)) return null;
      result[key] = control;
    }
    if (!(result.major instanceof HTMLSelectElement) || !(result.minor instanceof HTMLSelectElement) ||
        !(result.invoiceType instanceof HTMLSelectElement)) return null;
    return result;
  };
  const hasOtherContent = (row: HTMLTableRowElement, controlsForRow: Record<Field, Control>, justAddedByCap4 = false) => {
    // The legacy OA page defines its own global Set constructor.
    const known: Control[] = Object.values(controlsForRow);
    for (const control of Object.values(controlsForRow)) {
      const display = displayed(control);
      if (display) known.push(display);
    }
    const emptyAttachment = (model: NonNullable<ReturnType<typeof fieldModel>>) => {
      if (!model.data.value) return true;
      // CAP4 allocates an attachment reference for a newly inserted empty row.
      const editor = model.wrapper.querySelector<HTMLInputElement>('input[type=hidden][id$=_editAtt]');
      return justAddedByCap4 && editor?.value === 'true' && /^\d{1,20}$/u.test(model.data.value) &&
        !label(model.wrapper) && !model.wrapper.querySelector('a[href]');
    };
    return Array.from(row.querySelectorAll<Control>('input,select,textarea')).some((input) => {
      if (known.includes(input) || input.value === '') return false;
      if (!(input instanceof HTMLInputElement)) return true;
      if (input.type === 'file') return !!input.files?.length;
      if (['button', 'submit'].includes(input.type)) return false;
      if (cap4 && input.type === 'hidden') {
        if (input.name === 'id' && input.closest('td')?.cellIndex === 0) return false;
        const model = fieldModel(input);
        if (input.id.endsWith('_editAtt') && model?.data.inputType === 'attachment' && emptyAttachment(model)) return false;
      }
      return true;
    }) || (cap4 && Array.from(row.querySelectorAll('[fieldval]')).some((wrapper) => {
      const model = fieldModel(wrapper);
      return model?.data.inputType === 'attachment' && !emptyAttachment(model);
    }));
  };
  const cap4Total = () => {
    const wrapper = document.querySelector('[fieldval*="报销汇总-合计"]');
    return label(wrapper) || fieldModel(wrapper ?? document.body)?.data.value || '';
  };
  const read = () => {
    const uri = new URL(location.href);
    const marker = document.querySelector('[data-reimbursement-document]');
    const title = [document.title, topDocument?.title ?? '', label(document.querySelector('h1'))].join(' ');
    if (!cap4 && !/差旅\s*报销/u.test(title)) return null;
    const account = cap4 ? nearby('代办人') || nearby('申请人') :
      label(document.querySelector('[data-oa-account], #currentUserName')) ||
        label(topDocument?.querySelector('[data-oa-account], #currentUserName') ?? null);
    if (!account) return null;
    const number = (marker?.getAttribute('data-reimbursement-document') || (cap4 ? nearby('单据编号') : '')).trim();
    const validId = (id: string | null) => id && !['0', '-1', '-', '—'].includes(id);
    const topUri = topDocument ? new URL(topDocument.URL) : uri;
    const documentId = (validId(number) ? number : '') || [uri, topUri].flatMap(({ searchParams }) =>
      [searchParams.get('summaryId'), searchParams.get('affairId')]).find(validId) || '';
    const candidates = [];
    for (const table of document.querySelectorAll<HTMLTableElement>('table.xdRepeatingTable')) {
      for (const row of Array.from(table.rows)) {
        const cells = Array.from(row.cells).map((cell) => clean(label(cell)));
        const columns = {} as Record<Field, number>;
        if (!keys.every((key) => {
          const matches = cells.flatMap((text, index) => labels[key].includes(text) ? [index] : []);
          if (matches.length !== 1) return false;
          columns[key] = matches[0];
          return true;
        })) continue;
        candidates.push({ table, header: row, columns });
      }
    }
    if (candidates.length !== 1) return null;
    const { table, header, columns } = candidates[0];
    const rows = [];
    const body = Array.from(table.rows).slice(header.rowIndex + 1);
    for (const row of body) {
      const rowHasFields = row.querySelector('input,select,textarea');
      if (!rowHasFields) continue;
      const rowControls = controls(row, columns);
      if (!rowControls) return null;
      const fields = Object.fromEntries(keys.map((key) => [key, readControl(rowControls[key])])) as unknown as OaFields;
      const blank = Object.values(fields).every((value) => value === '') && !hasOtherContent(row, rowControls);
      rows.push({ row, fields, blank });
    }
    const root = table.closest('[data-reimbursement-document]') ?? table.parentElement;
    const trustedButton = (id: string, text: readonly string[]) => {
      const element = root?.querySelector('#' + id);
      return element instanceof HTMLButtonElement && element.type === 'button' && !element.disabled &&
        text.includes(clean(label(element))) ? element : null;
    };
    const blankAdd = trustedButton('reimbursement-add-blank', ['空白新增', '新增费用明细']);
    const cloneAdd = trustedButton('reimbursement-add-clone', ['克隆新增']);
    if (!rows.length && !blankAdd) return null;
    // A detached/replaced table is a different editable form instance even if
    // the document URL and visible fields are the same.
    const instances = runtime.__smswReimbursementForms ??= new WeakMap();
    let instance = instances.get(table);
    if (!instance) {
      instance = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
      instances.set(table, instance);
    }
    const snapshot = {
      instance, account, accountKey: String(runtime.CurrentUserId ?? ''),
      document: documentId || '新建差旅报销单', documentId,
      kind: cap4 ? 'cap4' : 'native', total: cap4 ? cap4Total() : null,
      rows: rows.map(({ blank, fields }) => ({ blank, fields })),
    };
    return { snapshot, rows, columns, blankAdd, cloneAdd };
  };
  const current = read();
  if (operation.type === 'read') return current?.snapshot ?? null;
  if (!current || JSON.stringify(current.snapshot) !== JSON.stringify(operation.before)) {
    return { error: 'OA 表单已变化，请重新预览' };
  }
  const delay = (ms = 50) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const sameForm = (after: typeof current.snapshot) => after.instance === current.snapshot.instance &&
    after.account === current.snapshot.account && after.accountKey === current.snapshot.accountKey &&
    after.documentId === current.snapshot.documentId;
  const settled = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await delay();
      if (!runtime.calculating) return true;
    }
    return false;
  };
  if (cap4 && (/[\r\n]/u.test(operation.expense.summary) || operation.expense.summary.length > 255)) {
    return { error: '该 OA 模板的摘要需在一行内且长度最多 255 个字符' };
  }
  let row = current.rows.find((candidate) => candidate.blank)?.row;
  let cloned = false;
  if (!row) {
    const add = current.blankAdd ?? current.cloneAdd;
    const previous = current.rows.map((entry) => entry.row);
    if (add) add.click();
    else if (cap4 && current.rows.length && !runtime.calculating) {
      runtime.addEmpty?.({ data: { currentNode: current.rows[current.rows.length - 1].row } });
    } else return { error: '当前页面缺少已就绪的费用新增控件，请先在 OA 添加空白行' };
    for (let attempt = 0; attempt < (cap4 ? 120 : 30); attempt += 1) {
      const next = read();
      if (!next && cap4) {
        await delay();
        continue;
      }
      if (!next || !sameForm(next.snapshot)) return { error: '新增时 OA 表单已变化' };
      const existing = next.rows.filter((entry) => previous.includes(entry.row));
      const newRows = next.rows.filter((entry) => !previous.includes(entry.row));
      if (existing.length !== previous.length ||
          JSON.stringify(existing.map(({ fields: value }) => value)) !== JSON.stringify(current.rows.map(({ fields: value }) => value)) ||
          newRows.length > 1) return { error: '新增后旧行或行数不一致，请在 OA 核对' };
      if (newRows.length === 1) {
        const created = newRows[0];
        const addedControls = controls(created.row, current.columns);
        cloned = !!add && add === current.cloneAdd;
        if ((!cloned && Object.values(created.fields).some(Boolean)) || !addedControls ||
            hasOtherContent(created.row, addedControls, cap4 && !add)) {
          return { error: '新增行包含未适配的原有内容，请在 OA 核对' };
        }
        row = created.row;
        break;
      }
      await delay();
    }
  }
  if (!row) return { error: '等待 OA 费用行超时，请回读后重试' };
  const changed = (control: Control) => {
    control.dispatchEvent(new Event('input', { bubbles: true }));
    control.dispatchEvent(new Event('change', { bubbles: true }));
    control.dispatchEvent(new FocusEvent('blur'));
    control.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  };
  const updateModel = (control: Control) => {
    const current = fieldModel(control);
    if (!current || current.data.name !== control.id) return false;
    current.wrapper.setAttribute('fieldval', JSON.stringify({ ...current.data, value: control.value }));
    return true;
  };
  const chooseCap4Minor = async (value: string) => {
    const visiblePopups = () => [...document.querySelectorAll('.autocomplete-popup')].filter((popup) =>
      popup.getClientRects().length && getComputedStyle(popup).visibility === 'visible');
    for (let selection = 0; selection < 2; selection += 1) {
      const control = controls(row, current.columns)?.minor;
      const display = control && displayed(control);
      const toggle = display?.parentElement?.querySelector<HTMLInputElement>('input[type=button][name=acToggle]');
      if (!row.isConnected || !toggle || toggle.disabled || visiblePopups().length) return false;
      toggle.click();
      // CAP4 displays the list before its autocomplete handlers are ready.
      await delay(350);
      let item: Element | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const popups = visiblePopups();
        if (popups.length > 1) return false;
        const options = [...popups[0]?.querySelectorAll('.menu .item') ?? []].filter((option) =>
          option.getClientRects().length && label(option) === value);
        if (options.length > 1) return false;
        item = options[0];
        if (item) break;
        await delay();
      }
      if (!item || !row.isConnected) return false;
      // CAP4 records the active item on mouseover and applies it on mousedown.
      const rect = item.getBoundingClientRect();
      for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup', 'click']) {
        item.dispatchEvent(new MouseEvent(type, {
          bubbles: true, cancelable: true, view: window, button: 0, buttons: type === 'mousedown' ? 1 : 0,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
        }));
      }
      if (!(await settled())) return false;
      const updated = controls(row, current.columns)?.minor;
      if (updated && readControl(updated) === value && displayed(updated)?.value.trim() === value) return true;
    }
    return false;
  };
  if (cloned && (!operation.includeTax || operation.expense.tax === '')) {
    const tax = controls(row, current.columns)?.tax;
    if (!tax) return { error: '无法清理新增行继承的税额' };
    tax.value = '';
    changed(tax);
  }
  const writeField = async (key: Field) => {
    if (key === 'tax' && (!operation.includeTax || operation.expense.tax === '')) return true;
    const value = operation.expense[key];
    for (let attempt = 0; attempt < (cap4 ? 100 : 20); attempt += 1) {
      const control = controls(row, current.columns)?.[key];
      if (!row.isConnected) break;
      if (!control && cap4) {
        await delay();
        continue;
      }
      if (!control) break;
      if (control instanceof HTMLSelectElement) {
        const options = Array.from(control.options).filter((option) =>
          value === '' ? option.value === '' : option.text.trim() === value && option.value !== '');
        if (options.length !== 1 || options[0].disabled) {
          await delay();
          continue;
        }
        if (cap4 && key === 'minor') return chooseCap4Minor(value);
        control.value = options[0].value;
        if (cap4) {
          const display = displayed(control);
          if (display) display.value = value;
          if (!updateModel(control)) break;
          if (key === 'major') control.dispatchEvent(new Event('change', { bubbles: true }));
        } else changed(control);
      } else if (cap4) {
        control.value = value;
        const display = displayed(control);
        if (display) display.value = value;
        if (!updateModel(control)) break;
      } else {
        control.value = value;
        changed(control);
      }
      return !cap4 || await settled();
    }
    return false;
  };
  for (const key of keys) {
    if (cap4 && key === 'minor') continue;
    if (!(await writeField(key))) return { error: 'OA 控件或下拉选项已变化，请在原页核对当前行' };
  }
  if (cap4) {
    const amountField = controls(row, current.columns)?.amount;
    if (!amountField) return { error: '找不到回读金额的 OA 控件' };
    // CAP4 uses this synchronization in its own dependent-select handler. It
    // updates the form session used by calculate, separately from the workflow.
    const synchronized = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 6000);
      runtime.formPreSubmitData?.(() => {
        clearTimeout(timeout);
        resolve(true);
      });
    });
    if (!synchronized) return { error: 'OA 表单计算会话未返回，请核对当前行后重试' };
    runtime.calc?.(amountField, true);
    const readNumber = (value: string) => Number(value.replace(/[,¥￥\s]/gu, ''));
    for (let i = 0; i < 160; i += 1) {
      const candidate = read();
      if (candidate && !sameForm(candidate.snapshot)) return { error: '计算合计时 OA 表单已变化' };
      if (candidate?.snapshot.total && !runtime.calculating) {
        const subtotal = candidate.rows.reduce((sum, entry) => sum + Math.round(readNumber(entry.fields.amount) * 100), 0);
        if (Math.round(readNumber(candidate.snapshot.total) * 100) === subtotal) break;
      }
      await delay();
    }
    // The full calculation rebuilds the dependent expense list. Select its
    // entry afterwards and let CAP4 perform the minor-specific calculation.
    if (!(await writeField('minor'))) return { error: 'OA 费用小类联动未就绪，请在原页核对当前行' };
  }
  await delay();
  const final = read();
  if (!final || !sameForm(final.snapshot)) return { error: '回读时 OA 表单已变化' };
  const otherRows = (entries: typeof final.rows) => entries.filter((entry) => entry.row !== row)
    .map(({ fields: value, blank }) => ({ value, blank }));
  if (JSON.stringify(otherRows(current.rows)) !== JSON.stringify(otherRows(final.rows))) {
    return { error: '填写时其他费用行发生变化，请在 OA 核对' };
  }
  const written = final.rows.findIndex((entry) => entry.row === row);
  return written < 0 ? { error: '无法定位已写入的费用行' } : { snapshot: final.snapshot, index: written };
}

export function formScript(operation: FrameOperation): string {
  return '(' + inForm.toString() + ')(' + JSON.stringify(operation) + ')';
}

async function run(target: FormTarget, operation: FrameOperation): Promise<unknown> {
  return target.frame.executeJavaScript(formScript(operation));
}

export async function readForm(target: FormTarget): Promise<FormState | null> {
  try {
    const result = formSchema.safeParse(await run(target, { type: 'read' }));
    return result.success && (!target.identity || sameForm(result.data, target.identity)) ? result.data : null;
  } catch {
    return null;
  }
}

function normalizedAmount(value: string) {
  return cents(value.normalize('NFKC').replace(/[¥,\s]/gu, ''));
}

export function verifyFormTotal(form: FormState) {
  if (form.total === null) return;
  let subtotal = 0n;
  for (const { fields } of form.rows) {
    if (!fields.amount) continue;
    const amount = normalizedAmount(fields.amount);
    if (amount === null) throw new ReimbursementError('OA 当前费用行含无法核对的金额');
    subtotal += amount;
  }
  if (normalizedAmount(form.total) !== subtotal) {
    throw new ReimbursementError('OA 汇总与明细不同，明细合计 ¥' + amountText(subtotal) +
      (form.total ? '，OA 汇总 ¥' + form.total : '') + '。请在原页核对后重新预览');
  }
}

export function matchesExpense(row: OaFields, expense: OaFields, includeTax: boolean): boolean {
  return mismatches(row, expense, includeTax).length === 0;
}

function mismatches(row: OaFields, expense: OaFields, includeTax: boolean) {
  const summary = (value: string) => value.replace(/\r\n/gu, '\n').trim();
  const comparisons = [
    ['费用大类', expense.major, row.major, row.major === expense.major],
    ['费用小类', expense.minor, row.minor, row.minor === expense.minor],
    ['日期', expense.date, row.date, row.date.replaceAll('/', '-') === expense.date],
    ['发票类型', expense.invoiceType, row.invoiceType, row.invoiceType === expense.invoiceType],
    ['价税合计', expense.amount, row.amount, normalizedAmount(row.amount) === cents(expense.amount)],
    ['税额', expense.tax, row.tax, !includeTax || (expense.tax === '' ? row.tax === '' : normalizedAmount(row.tax) === cents(expense.tax))],
    ['票号', expense.invoiceNumber, row.invoiceNumber, row.invoiceNumber === expense.invoiceNumber],
    ['摘要', expense.summary, row.summary, summary(row.summary) === summary(expense.summary)],
  ] as const;
  return comparisons.filter(([, , , equal]) => !equal);
}

const identity = (row: OaFields) => row.invoiceNumber
  ? 'invoice:' + row.invoiceNumber
  : 'subsidy:' + row.minor + ':' + row.date.replaceAll('/', '-');

export function planRows(rows: readonly FormRow[], expenses: readonly ReadyExpense[], includeTax: boolean): FormPreview['entries'] {
  const occupied = rows.filter((row) => !row.blank).map((row) => row.fields);
  const counts = new Map<string, number>();
  for (const expense of expenses) {
    const key = identity(expense);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return expenses.map((expense) => {
    const expenseId = expense.id;
    if ((counts.get(identity(expense)) ?? 0) > 1) {
      return { expenseId, status: 'conflict', reason: '批次内存在 OA 无法区分的费用' };
    }
    const matches = occupied.filter((row) => identity(row) === identity(expense));
    if (!matches.length) return { expenseId, status: 'new' };
    if (matches.length === 1 && matchesExpense(matches[0], expense, includeTax)) return { expenseId, status: 'matched' };
    return { expenseId, status: 'conflict', reason: 'OA 已有相同票号或日期的费用，请核对字段和金额' };
  });
}

export async function writeExpense(target: FormTarget, before: FormState, expense: ReadyExpense, includeTax: boolean) {
  const { major, minor, date, invoiceType, amount, tax, invoiceNumber, summary } = expense;
  const written = await run(target, { type: 'write', before, expense: {
    major, minor, date, invoiceType, amount, tax, invoiceNumber, summary,
  }, includeTax });
  const result = z.union([
    z.object({ snapshot: formSchema, index: z.number().int().nonnegative() }),
    z.object({ error: z.string().max(300) }),
  ]).safeParse(written);
  if (!result.success) throw new ReimbursementError('未读回当前费用行，请在 OA 核对');
  if ('error' in result.data) throw new ReimbursementError(result.data.error);
  const row = result.data.snapshot.rows[result.data.index];
  const differences = row ? mismatches(row.fields, expense, includeTax) : [];
  if (!row || row.blank || differences.length) {
    const description = differences.slice(0, 3).map(([name, planned, read]) =>
      name + '（清单 ' + (planned.slice(0, 48) || '空白') + '，OA ' + (read.slice(0, 48) || '空白') + '）');
    throw new ReimbursementError('第 ' + (result.data.index + 1) + ' 行回读不一致' +
      (description.length ? ' · ' + description.join('、') : '') + '。请在原页核对后重新预览');
  }
  verifyFormTotal(result.data.snapshot);
  return result.data.snapshot;
}
