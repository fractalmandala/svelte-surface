/**
 * The one object a host talks to: project detection, pages, the marked dev
 * server, and "ref in → file edited". Ties marks ↔ bridge ↔ edit engine together.
 */
import path from 'node:path'
import { applyComponentEditToFile, applyEditToFile, type FileEditResult, type FileIO } from './edit/files.js'
import { listStates, listVariants } from './edit/component.js'
import { inspectAt, type Inspection } from './edit/inspect.js'
import type { ComponentEdit, StateInfo, SvelteEdit, VariantInfo } from './edit/types.js'
import { parseLoc, type FrameMessage, type Ref, type StylePatch } from './contract.js'
import { promises as fs } from 'node:fs'
import { loadSvelte, type SvelteCompiler } from './svelte/ast.js'
import { markFile } from './marks/plugin.js'
import { detectProject, listPages, scaffoldPage, type PageEntry, type ProjectInfo, type ScaffoldOptions } from './orchestrator/project.js'
import { startDevServer, type DevOptions, type DevServer } from './orchestrator/dev.js'
import { findUsages, importClosure, type Usage } from './orchestrator/graph.js'

export type Locator = Ref | string | { file: string; line: number; col: number }

export class Surface {
  readonly root: string
  private dev: DevServer | null = null

  private readonly io?: FileIO

  /** `io`: read/write project files through this (e.g. in-memory drafts) instead of the disk. */
  constructor(root: string, options: { io?: FileIO } = {}) {
    this.root = path.resolve(root)
    this.io = options.io
  }
  private readFile(file: string): Promise<string> {
    return this.io ? this.io.read(file) : fs.readFile(path.join(this.root, file), 'utf8')
  }

  get info(): ProjectInfo {
    return detectProject(this.root)
  }
  compiler(): Promise<SvelteCompiler> {
    return loadSvelte(this.root)
  }
  pages(): Promise<PageEntry[]> {
    return listPages(this.root)
  }
  newPage(route: string, options?: ScaffoldOptions): Promise<string> {
    return scaffoldPage(this.root, route, options)
  }
  /** The marked source of one file, exactly as the dev server hands it to Svelte. */
  marked(file: string): Promise<string | null> {
    return markFile(this.root, file)
  }
  usages(componentFile: string): Promise<Usage[]> {
    return findUsages(this.root, componentFile)
  }
  closure(file: string, depth = 3): Promise<Map<string, number>> {
    return importClosure(this.root, file, depth)
  }

  /** Resolve a click's Ref / `data-fs` string to file + position. */
  resolve(at: Locator): { file: string; line: number; col: number } {
    if (typeof at === 'string') {
      const loc = parseLoc(at)
      if (!loc) throw new Error(`Not a mark: ${at}`)
      return loc
    }
    return { file: at.file, line: at.line, col: at.col }
  }

  /** Mark → edit: change the source file under the element the mark points at. */
  edit(at: Locator, edit: SvelteEdit, options?: { dryRun?: boolean }): Promise<FileEditResult> {
    const loc = this.resolve(at)
    return applyEditToFile(this.root, loc.file, { line: loc.line, col: loc.col }, edit, { ...options, io: this.io })
  }

  /**
   * A style gesture from the bridge (`commit` message) → source. Tailwind classes when the project has
   * Tailwind and the property maps, else the inline `style` attribute.
   */
  applyPatch(patch: StylePatch, options: { mode?: 'auto' | 'inline' | 'tailwind'; dryRun?: boolean } = {}): Promise<FileEditResult> {
    const mode = options.mode ?? (this.info.hasTailwind ? 'auto' : 'inline')
    return this.edit(patch.ref, { op: 'patchStyle', props: patch.props, mode }, { dryRun: options.dryRun })
  }

  /** Host-side handler for frame messages: `commit` writes the patch; everything else is ignored here. */
  async onBridgeMessage(message: FrameMessage): Promise<FileEditResult | null> {
    const m = message as unknown as { t: string; patch?: StylePatch }
    if (m.t === 'commit' && m.patch) return this.applyPatch(m.patch)
    return null
  }

  /** Component authoring (variants) on a whole `.svelte` file. */
  componentEdit(file: string, edit: ComponentEdit, options?: { dryRun?: boolean }): Promise<FileEditResult> {
    return applyComponentEditToFile(this.root, file, edit, { ...options, io: this.io })
  }
  async variants(file: string): Promise<VariantInfo[]> {
    return listVariants(await this.readFile(file), await this.compiler())
  }
  async states(file: string): Promise<StateInfo[]> {
    return listStates(await this.readFile(file), await this.compiler())
  }

  /** Panel data for the element a ref/mark points at (reads the file fresh). */
  async inspect(at: Locator): Promise<Inspection> {
    const loc = this.resolve(at)
    return inspectAt(await this.readFile(loc.file), await this.compiler(), loc)
  }

  async startDev(options?: DevOptions): Promise<DevServer> {
    if (this.dev) return this.dev
    this.dev = await startDevServer(this.root, options)
    return this.dev
  }
  async stopDev(): Promise<void> {
    const d = this.dev
    this.dev = null
    await d?.stop()
  }
}

export function createSurface(root: string): Surface {
  return new Surface(root)
}
