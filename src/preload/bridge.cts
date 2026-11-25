import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { WorkbenchApi, WorkbenchState } from '../shared/workbench.js' with { 'resolution-mode': 'import' };
import type { ReimbursementState } from '../shared/reimbursement.js' with { 'resolution-mode': 'import' };

// A sandboxed preload can require Electron, so the channels are declared inline.
const bridge: WorkbenchApi = {
  snapshot: () => ipcRenderer.invoke('smsw:snapshot'),
  command: (command) => ipcRenderer.invoke('smsw:command', command),
  onState: (listener) => {
    const receive = (_event: IpcRendererEvent, state: WorkbenchState) => listener(state);
    ipcRenderer.on('smsw:state', receive);
    return () => { ipcRenderer.removeListener('smsw:state', receive); };
  },
  reimbursement: (command) => ipcRenderer.invoke('smsw:reimbursement', command),
  onReimbursementState: (listener) => {
    const receive = (_event: IpcRendererEvent, documentKey: string, state: ReimbursementState) => listener(documentKey, state);
    ipcRenderer.on('smsw:reimbursement-state', receive);
    return () => { ipcRenderer.removeListener('smsw:reimbursement-state', receive); };
  },
  meal: (command) => ipcRenderer.invoke('smsw:meal', command),
  onAssistantDismissed: (listener) => {
    const receive = (_event: IpcRendererEvent, pageId: number, focus: boolean) => listener(pageId, focus);
    ipcRenderer.on('smsw:assistant-dismissed', receive);
    return () => { ipcRenderer.removeListener('smsw:assistant-dismissed', receive); };
  },
};

contextBridge.exposeInMainWorld('workbench', bridge);
