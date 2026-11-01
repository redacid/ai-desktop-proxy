import { join } from 'node:path'
import { app } from 'electron'

/** A file under resources/: shipped next to the app when packaged, the repo folder in dev. */
export function resourcePath(...parts: string[]): string {
  const base = app.isPackaged ? join(process.resourcesPath, 'resources') : join(__dirname, '../../resources')
  return join(base, ...parts)
}
