import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type Api, type AppStatus } from '@shared/ipc'

const api: Api = {
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  refreshStatus: () => ipcRenderer.invoke(IPC.refreshStatus),
  setClientEnabled: (id, enabled) => ipcRenderer.invoke(IPC.setClientEnabled, id, enabled),
  onStatus: (listener) => {
    const handler = (_: unknown, status: AppStatus): void => listener(status)
    ipcRenderer.on(IPC.statusChanged, handler)
    return () => ipcRenderer.removeListener(IPC.statusChanged, handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
