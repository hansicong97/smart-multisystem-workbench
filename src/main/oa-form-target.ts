import type { WebFrameMain } from 'electron';
import type { PageAssistant } from '../shared/assistant.js';

export interface FormTarget {
  pageId: number;
  generation: number;
  selection: number;
  frame: WebFrameMain;
  identity?: FormIdentity;
}

export interface FormIdentity {
  instance: string;
  account: string;
  accountKey: string;
  document: string;
  documentId: string;
}

export interface AssistantForm extends FormTarget {
  identity: FormIdentity;
  context: PageAssistant;
}

export function sameTarget(a: FormTarget, b: FormTarget): boolean {
  return a.pageId === b.pageId && a.selection === b.selection && a.generation === b.generation &&
    a.frame === b.frame && a.identity === b.identity;
}

export function sameForm(a: FormIdentity, b: FormIdentity): boolean {
  return a.instance === b.instance && a.account === b.account && a.accountKey === b.accountKey &&
    a.documentId === b.documentId;
}
