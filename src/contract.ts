/**
 * The wire/ref contracts, mirrored from the upstream contract files (kept as parse-only copies in reference/) so this package is
 * self-contained: it runs inside a user's project and imports nothing from outside this package.
 *
 * KEEP IN SYNC with, and checked by `test/contract-sync.test.ts` against:
 *  - reference/shared-types.ts         (Fs, FsI, FsU, Ref, Layer)
 *  - reference/bridge-protocol.ts      (MARK_ATTR, Tool, StylePatch, PinSpec, BridgeMessage, HostCommand, parseLoc, refName, refFile)
 * The only allowed divergence is `EXTENSIONS` below.
 */

export type Fs = string
export type FsI = string
export type FsU = string

export interface Ref {
  /** project-root-relative path, e.g. `src/routes/+page.svelte` */
  file: string
  /** 1-based line of the opening tag */
  line: number
  /** 1-based column of the opening tag */
  col: number
  /** lowercase tag name, e.g. `div`, `h1`, `img` */
  tag: string
  /** the text content as it renders on the canvas */
  text: string
  /** the component instance that rendered it, if any */
  component?: string
  /** `Name|file:line:col` of the component instance */
  fsi?: FsI
  /** usage chain of the component */
  fsu?: FsU
  /** copy index when one source line renders many copies (`.map()`) */
  i?: number
  /** CSS selector fallback, when there is no mark */
  sel?: string
  /** data-fs verbatim, `file:line:col` */
  fs?: Fs
}

export interface Layer {
  ref: Ref
  name: string
  depth: number
  selected?: boolean
  floating?: boolean
  locked?: boolean
  hidden?: boolean
  /** copy index for list items */
  i?: number
  children?: Layer[]
}

/**
 * Deliberate extensions over the scaffold (the sync test allows exactly these):
 *  - MARK_ATTR.fsc: usage chain handed down when a component instance is itself
 *    a top element of another component.
 */
export const EXTENSIONS = { MARK_ATTR: ['fsc'] as const }

export const MARK_ATTR = {
  /** `file:line:col` — where the element's half-open tag is written */
  fs: 'data-fs',
  /** `Name|file:line:col` — the component instance that rendered it */
  fsi: 'data-fsi',
  /** `Ref1 Ref2 …` — where the component is used, outermost first */
  fsu: 'data-fsu',
  /** the frame is showing one component in isolation */
  iso: 'data-fs-iso',
  /** temporary, while probing which element sits under an embed */
  probe: 'data-fs-probe',
  /** incremented to force a restyle when the injected stylesheet must re-apply */
  kick: '--fs-kick',
  fsc: 'data-fsc'
} as const

export interface StylePatch {
  ref: Ref
  props: Record<string, string>
  label: string
}

export interface PinSpec {
  id: string
  /** where on the element, 0…1 across and down */
  fx: number
  fy: number
  /** the comment's number on the canvas; the draft pin draws a + instead */
  n?: number
  /** resolved comments go grey */
  resolved?: boolean
  /** the comment open in the panel (or being written) goes blue and grows */
  active?: boolean
  /** the pin the user is currently placing */
  draft?: boolean
}

export type Tool = 'select' | 'comment' | 'preview'

export type BridgeMessage =
  | { __surface: true; t: 'ready'; frame: string; url: string; title: string; route: string; height: number }
  | { __surface: true; t: 'hover'; ref: Ref | null }
  | { __surface: true; t: 'select'; ref: Ref; add: boolean; parent: boolean }
  | { __surface: true; t: 'dblclick'; ref: Ref }
  | { __surface: true; t: 'commit'; patch: StylePatch }
  | { __surface: true; t: 'live'; patch: StylePatch }
  | { __surface: true; t: 'layers'; layers: Layer[] }
  | { __surface: true; t: 'pin'; comment: { id: string; fx: number; fy: number } | null }
  | { __surface: true; t: 'navigate'; route: string }
  | { __surface: true; t: 'scroll'; y: number; h: number }
  | { __surface: true; t: 'route'; route: string }
  | { __surface: true; t: 'log'; level: 'info' | 'warn' | 'error'; message: string }

export type BridgeMessageKind = BridgeMessage['t']

export type FrameMessage = Omit<BridgeMessage, '__surface' | 'frame'> & {
  __surface: true
  frame: string
}

export interface HostCommand {
  __surface: true
  frame?: string
  setHover?: Ref | null
  select?: { ref: Ref | null; add?: boolean }
  pin?: PinSpec[] | null
  setZoom?: number
  setLayers?: Layer[]
  scrollTo?: number
  navigate?: string
  init?: {
    frame: string
    tool?: Tool
    zoom?: number
    viewportHeight?: number
    paused?: boolean
    canvas?: boolean
    wantTree?: boolean
  }
  setTool?: Tool
  setPaused?: boolean
  repaint?: boolean
  setHandles?: { w: boolean; h: boolean; style: boolean }
  previewStyle?: { ref: Ref; style: Record<string, string> | null }
  reveal?: { ref: Ref }
}

/** `file:line:col` → `{file, line, col}`. Tolerates a `Name|` prefix. */
export function parseLoc(loc: string | null | undefined): { file: string; line: number; col: number } | null {
  if (!loc) return null
  const bare = loc.includes('|') ? loc.slice(loc.indexOf('|') + 1) : loc
  const m = /^(.*):(\d+):(\d+)$/.exec(bare)
  if (!m) return null
  return { file: m[1]!, line: Number(m[2]), col: Number(m[3]) }
}

/** The `Name` of a `Name|file:line:col` ref, or null. */
export function refName(ref: string | null | undefined): string | null {
  if (!ref || !ref.includes('|')) return null
  return ref.slice(0, ref.indexOf('|'))
}

/** `file:line:col` → `file`, dropping the numbers. */
export function refFile(ref: string | null | undefined): string | null {
  const loc = parseLoc(ref)
  return loc ? loc.file : null
}

export function formatLoc(file: string, line: number, col: number): string {
  return `${file}:${line}:${col}`
}

export function isBridgeMessage(data: unknown): data is FrameMessage {
  if (!data || typeof data !== 'object') return false
  const d = data as { __surface?: unknown; t?: unknown }
  return d.__surface === true && typeof d.t === 'string'
}

export function isHostCommand(data: unknown): data is HostCommand {
  if (!data || typeof data !== 'object') return false
  return (data as { __surface?: unknown }).__surface === true
}
