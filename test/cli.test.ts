import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { FIXTURE, PKG } from './helpers.js'

const cli = (...args: string[]): string =>
  execFileSync(process.execPath, [path.join(PKG, 'dist', 'cli.js'), ...args, '--root', FIXTURE], { encoding: 'utf8' })

it('detect / pages / mark / edit --dry', () => {
  expect(JSON.parse(cli('detect')).kind).toBe('sveltekit')
  expect(JSON.parse(cli('pages')).map((p: { route: string }) => p.route)).toEqual(['/', '/about', '/legacy', '/pricing'])
  expect(cli('mark', 'src/routes/+page.svelte')).toContain('data-fs="src/routes/+page.svelte:7:3"')
  const before = readFileSync(path.join(FIXTURE, 'src/routes/+page.svelte'), 'utf8')
  const out = JSON.parse(cli('edit', 'src/routes/+page.svelte:7:3', '{"op":"setText","text":"Hi"}', '--dry'))
  expect(out).toMatchObject({ changed: true, label: 'Changed text of <h1>' })
  expect(readFileSync(path.join(FIXTURE, 'src/routes/+page.svelte'), 'utf8')).toBe(before)
})
