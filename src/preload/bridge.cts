import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';
import type { WorkbenchApi, WorkbenchState } from '../shared/workbench.js' with { 'resolution-mode': 'import' };

// A sandboxed preload can require Electron, so the channels are declared inline.
const bridge: WorkbenchApi = {
  snapshot: () => ipcRenderer.invoke('smsw:snapshot'),
  command: (command) => ipcRenderer.invoke('smsw:command', command),
  onState: (listener) => {
    const receive = (_event: IpcRendererEvent, state: WorkbenchState) => listener(state);
    ipcRenderer.on('smsw:state', receive);
    return () => { ipcRenderer.removeListener('smsw:state', receive); };
  },
};

contextBridge.exposeInMainWorld('workbench', bridge);
