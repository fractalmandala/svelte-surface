// The virtual/draft layer: unsaved file contents live here, in memory. The dev server reads them through
// the Vite overlay; the disk only changes on save(). One undo/redo history spans all drafted files.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ApiError } from './projects.ts'

const MAX_BYTES = 2 * 1024 * 1024
const COALESCE_MS = 4000

interface Entry { base: string; text: string }
interface Step { file: string; before: string; after: string; label: string; typed: boolean; at: number }
export interface DraftInfo { file: string; conflict: boolean; deleted: boolean }
export interface FileState { file: string; text: string; disk: string | null; base: string | null; dirty: boolean; conflict: boolean }
export interface HistoryInfo { undo: { file: string; label: string }[]; canUndo: boolean; canRedo: boolean; redoLabel: string | null }

export class Drafts {
  readonly root: string
  /** rel → { base: text on disk when the draft started, text: the draft } */
  private entries = new Map<string, Entry>()
  private undoStack: Step[] = []
  private redoStack: Step[] = []

  /** @param onChange called after the draft state changed */
  constructor(root: string, private readonly onChange: (files: string[]) => void = () => {}) {
    this.root = path.resolve(root)
  }

  abs(rel: string): string {
    const abs = path.resolve(this.root, rel)
    if (!abs.startsWith(this.root + path.sep)) throw new ApiError(400, 'invalid', 'That file is outside the project.')
    return abs
  }

  async disk(rel: string): Promise<string | null> {
    try {
      const buf = await fs.readFile(this.abs(rel))
      if (buf.length > MAX_BYTES) throw new ApiError(413, 'too-large', `${rel} is larger than 2 MB and is not opened here.`)
      if (buf.includes(0)) throw new ApiError(415, 'binary', `${rel} is a binary file.`)
      return buf.toString('utf8')
    } catch (e) {
      if (e instanceof ApiError) throw e
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw e
    }
  }

  /** current text: the draft if there is one, else the disk */
  async read(rel: string): Promise<string> {
    const e = this.entries.get(rel)
    if (e) return e.text
    const t = await this.disk(rel)
    if (t === null) throw new ApiError(404, 'not-found', `${rel} does not exist.`)
    return t
  }

  /** the draft text for the overlay, or null */
  overlay(rel: string): string | null {
    return this.entries.get(rel)?.text ?? null
  }

  isDirty(rel: string): boolean {
    const e = this.entries.get(rel)
    return !!e && e.text !== e.base
  }
  dirtyFiles(): string[] {
    return [...this.entries.keys()].filter((f) => this.isDirty(f))
  }

  async #set(rel: string, text: string): Promise<string> {
    let e = this.entries.get(rel)
    if (!e) {
      const base = await this.disk(rel)
      if (base === null) throw new ApiError(404, 'not-found', `${rel} does not exist.`)
      e = { base, text: base }
      this.entries.set(rel, e)
    }
    const before = e.text
    e.text = text
    if (e.text === e.base) this.entries.delete(rel) // back to the disk's content: no draft left
    return before
  }

  /** write a new draft text (canvas edit, or typed code with `typed: true`, coalesced into one undo step) */
  async write(rel: string, text: string, { label = 'Edit', typed = false }: { label?: string; typed?: boolean } = {}): Promise<boolean> {
    if (Buffer.byteLength(text) > MAX_BYTES) throw new ApiError(413, 'too-large', 'That would make the file larger than 2 MB.')
    const current = this.entries.get(rel)?.text ?? (await this.disk(rel))
    if (current === text) return false
    const before = await this.#set(rel, text)
    const last = this.undoStack.at(-1)
    const now = Date.now()
    if (typed && last && last.typed && last.file === rel && now - last.at < COALESCE_MS) {
      last.after = text
      last.at = now
    } else this.undoStack.push({ file: rel, before, after: text, label, typed, at: now })
    this.redoStack.length = 0
    this.onChange([rel])
    return true
  }

  async undo(): Promise<Step | null> {
    const h = this.undoStack.pop()
    if (!h) return null
    await this.#set(h.file, h.before)
    this.redoStack.push(h)
    this.onChange([h.file])
    return h
  }
  async redo(): Promise<Step | null> {
    const h = this.redoStack.pop()
    if (!h) return null
    await this.#set(h.file, h.after)
    this.undoStack.push({ ...h, typed: false })
    this.onChange([h.file])
    return h
  }

  /** drafts with their disk state: `conflict` = the disk changed since the draft started */
  async list(): Promise<DraftInfo[]> {
    const out: DraftInfo[] = []
    for (const rel of this.dirtyFiles()) {
      const e = this.entries.get(rel)!
      let disk: string | null = null
      try { disk = await this.disk(rel) } catch { /* unreadable counts as changed */ }
      out.push({ file: rel, conflict: disk !== e.base, deleted: disk === null })
    }
    return out
  }

  /** Everything the editor needs for one file. */
  async file(rel: string): Promise<FileState> {
    const e = this.entries.get(rel)
    const disk = await this.disk(rel)
    if (disk === null && !e) throw new ApiError(404, 'not-found', `${rel} does not exist.`)
    return { file: rel, text: (e ? e.text : disk) as string, disk, base: e ? e.base : disk, dirty: this.isDirty(rel), conflict: !!e && disk !== e.base }
  }

  /** Write drafts to disk. Refuses (409 conflict) if any file changed on disk since its draft began, unless `force`. */
  async save(files?: string[] | null, { force = false }: { force?: boolean } = {}): Promise<string[]> {
    const rels = (files ?? this.dirtyFiles()).filter((f) => this.isDirty(f))
    const conflicts: string[] = []
    for (const rel of rels) {
      const e = this.entries.get(rel)!
      const disk = await this.disk(rel)
      if (!force && disk !== e.base) conflicts.push(rel)
    }
    if (conflicts.length) {
      throw new ApiError(409, 'conflict', `${conflicts.join(', ')} changed on disk since you started editing. Nothing was saved.`, { files: conflicts })
    }
    for (const rel of rels) {
      const abs = this.abs(rel)
      const tmp = `${abs}.fs-${process.pid}.tmp`
      await fs.writeFile(tmp, this.entries.get(rel)!.text)
      await fs.rename(tmp, abs)
      this.entries.delete(rel)
    }
    if (rels.length) this.onChange(rels)
    return rels
  }

  /** Throw drafts away (the file shows the disk again) and forget their history. */
  revert(files?: string[] | null): string[] {
    const rels = files ?? [...this.entries.keys()]
    const set = new Set(rels)
    for (const rel of rels) this.entries.delete(rel)
    this.undoStack = this.undoStack.filter((h) => !set.has(h.file))
    this.redoStack = this.redoStack.filter((h) => !set.has(h.file))
    if (rels.length) this.onChange(rels)
    return rels
  }

  /** After an outside change: keep my draft but make the current disk text its new base. */
  async rebase(rel: string): Promise<void> {
    const e = this.entries.get(rel)
    if (!e) return
    const disk = await this.disk(rel)
    if (disk === null) throw new ApiError(404, 'not-found', `${rel} no longer exists on disk.`)
    e.base = disk
    if (e.text === e.base) this.entries.delete(rel)
    this.onChange([rel])
  }

  history(): HistoryInfo {
    return {
      undo: this.undoStack.slice(-30).reverse().map((h) => ({ file: h.file, label: h.label })),
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      redoLabel: this.redoStack.at(-1)?.label ?? null
    }
  }
}
