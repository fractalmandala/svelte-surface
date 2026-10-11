import { loadSvelte, type SvelteCompiler } from '../src/svelte/ast.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const FIXTURE = path.join(PKG, 'fixtures', 'sveltekit-app')
export const svelte5 = (): Promise<SvelteCompiler> => loadSvelte(PKG)
export async function svelte4(): Promise<SvelteCompiler> {
  const spec = 'svelte4/compiler' // aliased svelte@4 devDependency
  return (await import(spec)) as SvelteCompiler
}
/** line/col (1-based) of the n-th occurrence of `needle` */
export function at(src: string, needle: string, n = 0): { line: number; col: number } {
  let idx = -1
  for (let i = 0; i <= n; i++) idx = src.indexOf(needle, idx + 1)
  if (idx < 0) throw new Error('needle not found: ' + needle)
  const before = src.slice(0, idx).split('\n')
  return { line: before.length, col: before[before.length - 1]!.length + 1 }
}
