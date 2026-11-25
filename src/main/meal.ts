import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { mealRoster } from '../shared/assistant.js';
import type { MealCommand, MealInput, MealPreview, MealReply, MealResult } from '../shared/assistant.js';
import { buildMealPlan, diffMealFill, mealFormScript } from './oa-enhance.js';
import type { MealTask } from './oa-enhance.js';
import { sameTarget } from './oa-form-target.js';
import type { AssistantForm, FormTarget } from './oa-form-target.js';

const identity = z.object({
  instance: z.string().min(1).max(128), account: z.string().min(1).max(128), accountKey: z.string().min(1).max(128),
  document: z.string().min(1).max(200), documentId: z.string().max(200),
});
const row = z.object({
  date: z.string().max(128), type: z.string().max(128), personId: z.string().max(128), personName: z.string().max(200),
  org: z.string().max(128), empty: z.boolean(), note: z.string().max(4000), amount: z.string().max(128),
  controls: z.string().max(24_000),
});
const snapshot = identity.extend({ total: z.string().max(128), rows: z.array(row).max(1000) });
type MealFormState = z.infer<typeof snapshot>;
const people = z.object({ roster: mealRoster, peopleInForm: mealRoster });
const writeReply = z.union([
  z.object({ snapshot, index: z.number().int().nonnegative().optional() }), z.object({ error: z.string().max(400) }),
]);

async function inMealForm(target: FormTarget, operation: object): Promise<unknown> {
  if (target.frame.detached) return null;
  return target.frame.executeJavaScript(mealFormScript({ ...operation, identity: target.identity }), true).catch(() => null);
}

export async function identifyMealForm(target: FormTarget) {
  return identity.safeParse(await inMealForm(target, { type: 'identify' })).data ?? null;
}

async function read(target: AssistantForm) {
  const state = snapshot.safeParse(await inMealForm(target, { type: 'read' })).data;
  if (!state) throw new Error('当前误餐表单已变化，请重新预览');
  return state;
}

const description = (task: MealTask) => `${task.date} · ${task.type} · ${task.personName}（${task.org}）`;
const matches = (row: MealFormState['rows'][number], task: MealTask) =>
  row.date === task.date && row.type === task.type && row.personId === task.personId && row.org === task.org &&
  row.personName === task.personName && row.note === task.note.trim() && row.amount !== '';
const occupied = (form: MealFormState) => JSON.stringify(form.rows.filter(({ empty }) => !empty));

interface Prepared {
  target: AssistantForm;
  input: MealInput;
  before: MealFormState;
  tasks: MealTask[];
  view: MealPreview;
}

export class Meal {
  #preview: Prepared | undefined;
  #results = new Map<string, MealResult>();
  #interrupted = new Map<string, { task: MealTask; before: string }>();
  #busy = false;

  constructor(private readonly current: (target: AssistantForm) => AssistantForm | undefined) {}

  async handle(target: AssistantForm, command: MealCommand): Promise<MealReply> {
    const { documentKey } = target.context;
    if (this.#busy) return { error: '正在处理误餐明细，请稍候' };
    this.#busy = true;
    try {
      switch (command.type) {
        case 'state':
        case 'readPeople': {
          const available = people.safeParse(await inMealForm(target, { type: 'people' })).data;
          this.#checkTarget(target);
          if (!available) throw new Error('未能读取当前误餐表单的人员');
          return { ...available, result: this.#results.get(documentKey) };
        }
        case 'savePeople':
          if (!await inMealForm(target, command)) throw new Error('未能保存人员名册');
          return {};
        case 'preview':
          return { preview: await this.#plan(target, command.input) };
        case 'fill':
          return { result: await this.#fill(target, command.input, command.token) };
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : '误餐操作失败，请核对原单后重试' };
    } finally {
      this.#busy = false;
    }
  }

  #checkTarget(target: AssistantForm) {
    const current = this.current(target);
    if (!current || !sameTarget(current, target)) throw new Error('目标 OA 表单已变化，请重新预览');
  }

  async #plan(target: AssistantForm, input: MealInput) {
    this.#preview = undefined;
    const { documentKey } = target.context;
    const before = await read(target);
    this.#checkTarget(target);
    const plan = buildMealPlan(input);
    const diff = diffMealFill(before.rows, plan.tasks);
    const clear = input.clearFirst && before.rows.some(({ empty }) => !empty);
    const tasks = clear ? plan.tasks : diff.fillTasks;
    const reuse = Math.min(tasks.length, clear ? 1 : diff.emptyCount);
    const view: MealPreview = {
      token: randomUUID(), document: before.document, first: plan.first, last: plan.last,
      rows: plan.rows, sum: plan.sum, matched: clear ? 0 : diff.matchedCount, pending: tasks.length,
      reuse, add: tasks.length - reuse, conflicts: clear ? 0 : diff.conflicts.length, clear,
    };
    const interrupted = this.#interrupted.get(documentKey);
    if (interrupted) {
      if (occupied(before) === interrupted.before || before.rows.some((row) => matches(row, interrupted.task))) {
        this.#interrupted.delete(documentKey);
      } else if (!clear) {
        view.blocked = '上次写入的行待核对，请在原单修正或清空该行后重新预览';
      }
    }
    this.#preview = { target, input, before, tasks, view };
    return view;
  }

  async #fill(target: AssistantForm, input: MealInput, token: string) {
    const prepared = this.#preview;
    this.#preview = undefined;
    if (!prepared || prepared.view.token !== token || !sameTarget(prepared.target, target) ||
        JSON.stringify(prepared.input) !== JSON.stringify(input)) {
      throw new Error('目标 OA 表单或填写参数已变化，请重新预览');
    }
    if (prepared.view.blocked) throw new Error(prepared.view.blocked);
    const { documentKey } = target.context;
    const result: MealResult = {
      read: [], pending: prepared.tasks.map(description), matched: prepared.view.matched, total: '', message: '', clearApplied: false,
    };
    try {
      let expected = await read(target);
      this.#checkTarget(target);
      if (JSON.stringify(expected) !== JSON.stringify(prepared.before)) throw new Error('OA 明细已变化，请重新预览');
      if (prepared.view.clear) {
        // Once issued, a retry must calculate against whatever OA actually kept.
        result.clearApplied = true;
        expected = await this.#write(target, { type: 'clear', before: expected });
        this.#interrupted.delete(documentKey);
      }
      for (const task of prepared.tasks) {
        this.#checkTarget(target);
        this.#interrupted.set(documentKey, { task, before: occupied(expected) });
        expected = await this.#write(target, { type: 'write', before: expected, task });
        this.#interrupted.delete(documentKey);
        result.read.push(description(task));
        result.pending.shift();
        result.total = expected.total;
      }
      result.total = expected.total;
      result.message = result.read.length ? '已回读 OA 明细，请在原单核对后提交' : '没有需要填入的行，明细已匹配';
    } catch (error) {
      result.message = error instanceof Error ? error.message : '填写已暂停，请核对原单后重新预览';
    }
    this.#results.set(documentKey, result);
    return result;
  }

  async #write(target: AssistantForm, operation: { type: 'clear' | 'write'; before: MealFormState; task?: MealTask }) {
    this.#checkTarget(target);
    const response = writeReply.safeParse(await inMealForm(target, operation)).data;
    this.#checkTarget(target);
    if (!response) throw new Error('未读回当前明细，请在原单核对后重新预览');
    if ('error' in response) throw new Error(response.error);
    if (operation.task && (response.index === undefined || !response.snapshot.rows[response.index] ||
        !matches(response.snapshot.rows[response.index], operation.task))) {
      throw new Error('明细回读不一致，请在原单核对后重新预览');
    }
    return response.snapshot;
  }
}
