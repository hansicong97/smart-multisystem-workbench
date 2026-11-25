import { z } from 'zod';
import { reimbursementCommand } from './reimbursement.js';

const key = z.string().min(1).max(128);
export const assistantTarget = z.object({ pageId: z.number().int().positive(), revision: key });
export type AssistantTarget = z.infer<typeof assistantTarget>;

export interface PageAssistant extends AssistantTarget {
  tool: 'meal' | 'reimbursement';
  documentKey: string;
}

export const reimbursementRequest = z.object({ target: assistantTarget, command: reimbursementCommand });
export type ReimbursementRequest = z.infer<typeof reimbursementRequest>;

export const mealType = z.enum(['夜宵补贴', '误正餐补贴']);
export const mealOrg = z.enum(['A编', 'B编']);
export const mealPerson = z.object({ id: z.string().regex(/^\d{1,24}$/u), name: z.string().min(1).max(100), org: mealOrg });
const mealRosterPerson = mealPerson.extend({ isSelf: z.boolean(), lastUsed: z.number().nonnegative() });
export const mealRoster = z.array(mealRosterPerson).max(21);
export type MealRosterPerson = z.infer<typeof mealRosterPerson>;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
export const mealInput = z.object({
  start: date, end: date, skipWeekend: z.boolean(), skipText: z.string().max(4000), noteText: z.string().max(4000),
  entries: z.array(mealType).min(1).max(2).refine((entries) => new Set(entries).size === entries.length),
  people: z.array(mealPerson).min(1).max(21).refine((people) => new Set(people.map(({ id }) => id)).size === people.length),
  clearFirst: z.boolean(),
});
export type MealInput = z.infer<typeof mealInput>;

const mealCommand = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['state', 'readPeople']) }),
  z.object({ type: z.literal('savePeople'), people: mealRoster }),
  z.object({ type: z.literal('preview'), input: mealInput }),
  z.object({ type: z.literal('fill'), input: mealInput, token: key }),
]);
export type MealCommand = z.infer<typeof mealCommand>;
export const mealRequest = z.object({ target: assistantTarget, command: mealCommand });
export type MealRequest = z.infer<typeof mealRequest>;

export interface MealPreview {
  token: string;
  document: string;
  first: string;
  last: string;
  rows: number;
  sum: number;
  matched: number;
  pending: number;
  reuse: number;
  add: number;
  conflicts: number;
  clear: boolean;
  blocked?: string;
}

export interface MealResult {
  read: string[];
  pending: string[];
  matched: number;
  total: string;
  message: string;
  clearApplied: boolean;
}

export interface MealReply {
  roster?: MealRosterPerson[];
  peopleInForm?: MealRosterPerson[];
  preview?: MealPreview;
  result?: MealResult;
  error?: string;
}
