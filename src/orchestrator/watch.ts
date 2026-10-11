import { watch, type FSWatcher } from 'node:fs'
import path from 'node:path'

/** Debounced recursive watcher over `src/` for .svelte changes; calls back with project-relative files. */
export function watchSources(root: string, onChange: (files: string[]) => void, debounceMs = 120): () => void {
  const pending = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const w: FSWatcher = watch(path.join(root, 'src'), { recursive: true }, (_ev, name) => {
    if (!name || !String(name).endsWith('.svelte')) return
    pending.add(path.join('src', String(name)).split(path.sep).join('/'))
    clearTimeout(timer)
    timer = setTimeout(() => {
      const files = [...pending]
      pending.clear()
      onChange(files)
    }, debounceMs)
  })
  return () => {
    clearTimeout(timer)
    w.close()
  }
}
