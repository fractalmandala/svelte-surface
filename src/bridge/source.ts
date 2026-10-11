import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { snapshotDom, stampLate, watchMarks } from './browser.js'

let cached: string | null = null

/** The bridge as a browser-ready ES module (compiled JS; transpiled on the fly when running from TS source). */
export function bridgeSource(): string {
  if (cached) return cached
  const dir = path.dirname(fileURLToPath(import.meta.url))
  const js = path.join(dir, 'browser.js')
  if (existsSync(js)) return (cached = readFileSync(js, 'utf8'))
  const ts = path.join(dir, 'browser.ts')
  const req = createRequire(import.meta.url)
  const typescript = req('typescript') as typeof import('typescript')
  const out = typescript.transpileModule(readFileSync(ts, 'utf8'), {
    compilerOptions: { target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.ES2022 }
  })
  return (cached = out.outputText)
}

/** Page script: walk the DOM → `[parent, tag, class, id, text, attrs, childCount][]` (≤8000 elements). */
export const SNAPSHOT_SCRIPT = `(${snapshotDom.toString()})()`

/** Page script: retro-stamp `data-fs` on late-rendered elements, from Svelte dev `__svelte_meta`. */
export const stampScript = (root: string): string => `(${stampLate.toString()})(${JSON.stringify(root)})`

/** Page script: a promise resolving once marks exist and the DOM settled (CSR-safe). */
export const WATCH_SCRIPT = (timeoutMs = 5000): string => `(${watchMarks.toString()})(${timeoutMs})`
