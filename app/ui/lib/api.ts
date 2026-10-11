import { ApiFailure } from './types.ts'

/** GET when `body` is undefined, else POST JSON. Throws ApiFailure carrying the server's error fields. */
export async function api<T = any>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const data = await res.json()
  if (!res.ok) throw Object.assign(new ApiFailure(data.error || res.statusText), data, { status: res.status })
  return data as T
}
export const query = (o: Record<string, string | number>): string => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString()
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))
