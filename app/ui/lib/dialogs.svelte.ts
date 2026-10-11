// Promise-based confirm dialog (rendered by components/ConfirmDialog.svelte).
export interface ConfirmButton<T> { label: string; value: T; kind?: 'primary' | 'danger' }
export interface ConfirmSpec<T = unknown> { title: string; text?: string; list?: string[]; buttons: ConfirmButton<T>[] }

export const confirmState = $state<{ open: boolean; spec: ConfirmSpec<any> | null; resolve: ((v: unknown) => void) | null }>({ open: false, spec: null, resolve: null })

export function confirmBox<T>(spec: ConfirmSpec<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    confirmState.spec = spec
    confirmState.resolve = resolve as (v: unknown) => void
    confirmState.open = true
  })
}
export function answerConfirm(value: unknown): void {
  confirmState.open = false
  const r = confirmState.resolve
  confirmState.resolve = null
  r?.(value)
}
