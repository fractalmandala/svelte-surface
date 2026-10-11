// Shapes exchanged with app/server (kept structural so the UI never imports server code).
import type { Layer, Ref, StylePatch } from '../../../src/contract.ts'
import type { Inspection } from '../../../src/edit/inspect.ts'
import type { SvelteEdit, ComponentEdit, VariantInfo } from '../../../src/edit/types.ts'

export type { Layer, Ref, Inspection, SvelteEdit, ComponentEdit, StylePatch, VariantInfo }

export type Kind = 'sveltekit' | 'vite-svelte'
export interface Warning { code: 'no-git' | 'dirty'; message: string }
export interface ProjectInfo {
  root: string; name: string; kind: string; versions: Record<string, string | undefined>; hasTailwind: boolean
  devUrl: string; scratch: boolean; warnings: Warning[]; dirty: string[]
}
export interface Recent { path: string; name: string; kind: string; openedAt: number; missing?: boolean }
export interface Shortcut { name: string; path: string }
export interface AppInfo { current: ProjectInfo | null; recents: Recent[]; shortcuts: Shortcut[]; home: string; example: string }
export interface BrowseEntry { name: string; path: string; kind: Kind | null; git: boolean }
export interface BrowseResult { path: string; parent: string | null; crumbs: Shortcut[]; entries: BrowseEntry[]; kind: Kind | null; shortcuts: Shortcut[] }
export interface GitState { repo: boolean; branch?: string; dirty?: boolean; changes?: number; sample?: string[] }
export interface InspectResult {
  path: string; supported: boolean; reason?: string; name: string; kind: Kind; versions: Record<string, string | undefined>
  depsInstalled: boolean; packageManager: string; git: GitState; warnings: Warning[]
}
export interface Page { route: string; file: string | null; dynamic: boolean }
export interface DraftInfo { file: string; conflict: boolean; deleted: boolean }
export interface FileState { file: string; text: string; disk: string | null; base: string | null; dirty: boolean; conflict: boolean }
export interface History { undo: { file: string; label: string }[]; canUndo: boolean; canRedo: boolean; redoLabel: string | null }
export interface EditResult { ok: boolean; changed: boolean; label: string; file: string }
export interface VariantsResult { variants: VariantInfo[]; states: unknown[]; props: { name: string }[] }
export type StatusKind = '' | 'ok' | 'err'
export type Mode = 'design' | 'opencode' | 'code'
export type Tool = 'select' | 'comment' | 'preview'
export interface Pin { id: string; fx: number; fy: number; n: number; draft?: boolean }

export class ApiFailure extends Error {
  status = 0
  code = ''
  files?: string[]
  inspect?: InspectResult
  details?: string
}
