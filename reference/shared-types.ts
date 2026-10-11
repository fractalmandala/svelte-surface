/**
 * The three marks. Injected into the user's source at compile time (in memory only).
 * These strings are the contract between the loaders, the bridge, and the edit engine.
 */

/** Where an element's half-open tag `<` is written. `file:line:col` */
export type Fs = string
/** Which component + where the instance is written. `Name|file:line:col` */
export type FsI = string
/** Where the component is used, outermost first. `Ref1 Ref2 …` */
export type FsU = string

export interface Marks {
  fs?: Fs
  fsi?: FsI
  fsu?: FsU
}

/**
 * A reference to something editable, as resolved by the bridge from a click.
 * `file` is always project-root-relative with forward slashes.
 */
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

/** project-root-relative path with forward slashes. */
export type RelPath = string

export interface ProjectMeta {
  id: string
  path: string
  name: string
  hub: string
  framework: FrameworkId
  lastOpenedAt: number
  thumbnail?: string
}

export type FrameworkId =
  | 'next'
  | 'vite'
  | 'react-router'
  | 'remix'
  | 'sveltekit'
  | 'svelte-vite'
  | 'vue'
  | 'nuxt'
  | 'astro'
  | 'angular'
  | 'html'
  | 'webpack'
  | 'laravel'
  | 'wordpress'
  | 'php'
  | 'python'
  | 'rails'
  | 'static'
  | 'shopify'
  | 'custom'
  | 'unknown'

export interface Breakpoint {
  id: string
  name: string
  /** viewport width in px */
  width: number
  /** viewport height in px */
  height: number
  /** the route this breakpoint writes at */
  route: string
  /** enabled breakpoints render side by side on the canvas */
  enabled: boolean
  /** the Tailwind / min-width screen this maps to */
  screen?: string
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

export interface EditChange {
  id: string
  file: RelPath
  /** a human sentence for the Publish list */
  label: string
  at: number
  before: string
  after: string
  /** undoing a file-creating edit deletes the file */
  createdFile?: boolean
}

export interface UndoEntry {
  file: RelPath
  before: string
  after: string
  label: string
  createdFile?: boolean
}

export interface CodeWriteRequest {
  id: string
  ref: Ref
  oldText: string
  newText: string
}

export interface SetClassesRequest {
  id: string
  ref: Ref
  oldText: string
  newText: string
  label: string
}

export interface Comment {
  id: string
  body: string
  anchor: {
    ref: Ref
    tag?: string
    text?: string
  }
  page: string
  breakpoint: string
  fx: number
  fy: number
  createdAt: number
  resolvedAt: number | null
  attachments?: string[]
}

export interface ServerState {
  id: string
  status: 'idle' | 'starting' | 'running' | 'error' | 'stopped'
  url?: string
  port?: number
  pid?: number
  error?: string
}

export interface ServerLog {
  id: string
  line: string
  stream: 'stdout' | 'stderr'
  at: number
}

export interface GitStatus {
  branch: string
  ahead: number
  behind: number
  files: Array<{
    path: RelPath
    status: 'added' | 'modified' | 'deleted' | 'renamed'
    staged: boolean
    label?: string
  }>
}

export interface AgentInfo {
  id: string
  name: string
  /** can drive a chat session over ACP */
  chat: boolean
  /** can run in a terminal */
  terminal: boolean
  installed: boolean
  binary?: string
  needsKey?: boolean
  keySet?: boolean
}