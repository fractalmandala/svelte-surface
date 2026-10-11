import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadSvelte } from '../svelte/ast.js'
import { applyEdit } from './engine.js'
import { applyComponentEdit } from './component.js'
import { EditError, type ComponentEdit, type EditResult, type SvelteEdit, type Target } from './types.js'

/** Where file text comes from / goes to. Default: the disk. A host can put drafts in memory instead. */
export interface FileIO {
  read(file: string): Promise<string>
  write(file: string, text: string, meta: { label: string }): Promise<void>
}

export interface FileEditOptions {
  /** compute only; do not write */
  dryRun?: boolean
  /** read/write through this instead of the disk (project-relative paths) */
  io?: FileIO
}

export interface FileEditResult extends EditResult {
  file: string
  before: string
}

/** Re-read, edit and (atomically) write one project file. `file` is project-root-relative. */
export async function applyEditToFile(
  root: string,
  file: string,
  at: Target,
  edit: SvelteEdit,
  options: FileEditOptions = {}
): Promise<FileEditResult> {
  const abs = path.resolve(root, file)
  if (!abs.startsWith(path.resolve(root) + path.sep)) throw new EditError('invalid', 'That file is outside the project.')
  if (!abs.endsWith('.svelte')) throw new EditError('unsupported', 'Only .svelte files are edited here.')
  const svelte = await loadSvelte(root)
  const before = options.io ? await options.io.read(file) : await fs.readFile(abs, 'utf8')
  const result = applyEdit(before, svelte, at, edit)
  if (result.changed && !options.dryRun && options.io) {
    await options.io.write(file, result.code, { label: result.label })
  } else if (result.changed && !options.dryRun) {
    const tmp = `${abs}.fs-${process.pid}.tmp`
    await fs.writeFile(tmp, result.code)
    await fs.rename(tmp, abs)
  }
  return { ...result, file, before }
}

export async function applyComponentEditToFile(
  root: string,
  file: string,
  edit: ComponentEdit,
  options: FileEditOptions = {}
): Promise<FileEditResult> {
  const abs = path.resolve(root, file)
  if (!abs.startsWith(path.resolve(root) + path.sep)) throw new EditError('invalid', 'That file is outside the project.')
  if (!abs.endsWith('.svelte')) throw new EditError('unsupported', 'Only .svelte files are edited here.')
  const svelte = await loadSvelte(root)
  const before = options.io ? await options.io.read(file) : await fs.readFile(abs, 'utf8')
  const result = applyComponentEdit(before, svelte, edit)
  if (result.changed && !options.dryRun && options.io) {
    await options.io.write(file, result.code, { label: result.label })
  } else if (result.changed && !options.dryRun) {
    const tmp = `${abs}.fs-${process.pid}.tmp`
    await fs.writeFile(tmp, result.code)
    await fs.rename(tmp, abs)
  }
  return { ...result, file, before }
}
