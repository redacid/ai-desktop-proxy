import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type Api, type AppStatus, type CheckProgress, type ToolInfo, type AppUpdateState } from '@shared/ipc'

const api: Api = {
  getUpdate: () => ipcRenderer.invoke(IPC.getUpdate),
  updateAction: (action) => ipcRenderer.invoke(IPC.updateAction, action),
  updatePreferences: (prefs) => ipcRenderer.invoke(IPC.updatePreferences, prefs),
  onUpdate: (listener) => {
    const handler = (_: unknown, state: AppUpdateState): void => listener(state)
    ipcRenderer.on(IPC.updateChanged, handler)
    return () => ipcRenderer.removeListener(IPC.updateChanged, handler)
  },
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  refreshStatus: () => ipcRenderer.invoke(IPC.refreshStatus),
  setClientEnabled: (id, enabled) => ipcRenderer.invoke(IPC.setClientEnabled, id, enabled),
  proxyAction: (action) => ipcRenderer.invoke(IPC.proxyAction, action),
  proxyLogs: () => ipcRenderer.invoke(IPC.proxyLogs),
  compressorAction: (action) => ipcRenderer.invoke(IPC.compressorAction, action),
  compressorLogs: () => ipcRenderer.invoke(IPC.compressorLogs),
  requestDetail: (id) => ipcRenderer.invoke(IPC.requestDetail, id),
  getSettings: () => ipcRenderer.invoke(IPC.getSettings),
  saveSettings: (settings) => ipcRenderer.invoke(IPC.saveSettings, settings),
  getTools: () => ipcRenderer.invoke(IPC.getTools),
  checkTools: () => ipcRenderer.invoke(IPC.checkTools),
  toolAction: (id, action) => ipcRenderer.invoke(IPC.toolAction, id, action),
  onTools: (listener) => {
    const handler = (_: unknown, tools: ToolInfo[]): void => listener(tools)
    ipcRenderer.on(IPC.toolsChanged, handler)
    return () => ipcRenderer.removeListener(IPC.toolsChanged, handler)
  },
  onInstallLog: (listener) => {
    const handler = (_: unknown, line: string): void => listener(line)
    ipcRenderer.on(IPC.installLog, handler)
    return () => ipcRenderer.removeListener(IPC.installLog, handler)
  },
  onStatus: (listener) => {
    const handler = (_: unknown, status: AppStatus): void => listener(status)
    ipcRenderer.on(IPC.statusChanged, handler)
    return () => ipcRenderer.removeListener(IPC.statusChanged, handler)
  },
  onCheckProgress: (listener) => {
    const handler = (_: unknown, progress: CheckProgress): void => listener(progress)
    ipcRenderer.on(IPC.checkProgress, handler)
    return () => ipcRenderer.removeListener(IPC.checkProgress, handler)
  }
}

contextBridge.exposeInMainWorld('api', api)
