import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { Drafts } from '../app/server/drafts.ts'

let root: string
let drafts: any
let changes: string[][]
const disk = (f: string) => readFileSync(path.join(root, f), 'utf8')
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'fs-drafts-'))
  mkdirSync(path.join(root, 'src'))
  writeFileSync(path.join(root, 'src/a.svelte'), '<h1>A</h1>\n')
  writeFileSync(path.join(root, 'src/b.css'), 'b {}\n')
  changes = []
  drafts = new Drafts(root, (f: string[]) => changes.push(f))
})

describe('Drafts', () => {
  it('keeps edits in memory; the disk changes only on save', async () => {
    await drafts.write('src/a.svelte', '<h1>A2</h1>\n', { label: 'Text' })
    expect(await drafts.read('src/a.svelte')).toBe('<h1>A2</h1>\n')
    expect(drafts.overlay('src/a.svelte')).toBe('<h1>A2</h1>\n')
    expect(disk('src/a.svelte')).toBe('<h1>A</h1>\n')
    expect(drafts.dirtyFiles()).toEqual(['src/a.svelte'])
    expect(await drafts.save(['src/a.svelte'])).toEqual(['src/a.svelte'])
    expect(disk('src/a.svelte')).toBe('<h1>A2</h1>\n')
    expect(drafts.dirtyFiles()).toEqual([])
    expect(drafts.overlay('src/a.svelte')).toBeNull()
    expect(changes.flat()).toContain('src/a.svelte')
  })

  it('undo/redo spans files; typed edits coalesce; going back to disk content is clean', async () => {
    await drafts.write('src/a.svelte', '<h1>x</h1>\n', { label: 'Text' })
    await drafts.write('src/b.css', 'b { color: red }\n', { label: 'CSS' })
    await drafts.write('src/b.css', 'b { color: re', { typed: true, label: 'Typed' })
    await drafts.write('src/b.css', 'b { color: blue }\n', { typed: true, label: 'Typed' })
    expect(drafts.history().undo.map((h: any) => h.label)).toEqual(['Typed', 'CSS', 'Text'])
    expect((await drafts.undo()).label).toBe('Typed') // both typed writes were one step
    expect(await drafts.read('src/b.css')).toBe('b { color: red }\n')
    await drafts.undo()
    expect(drafts.dirtyFiles()).toEqual(['src/a.svelte'])
    await drafts.undo()
    expect(drafts.dirtyFiles()).toEqual([]) // identical to disk: no draft left
    expect(drafts.history().canRedo).toBe(true)
    await drafts.redo()
    expect(await drafts.read('src/a.svelte')).toBe('<h1>x</h1>\n')
    await drafts.write('src/b.css', 'new', { label: 'N' })
    expect(drafts.history().canRedo).toBe(false) // a new edit clears redo
  })

  it('revert drops the draft and its history; the overlay falls back to disk', async () => {
    await drafts.write('src/a.svelte', 'changed', { label: 'T' })
    drafts.revert(['src/a.svelte'])
    expect(drafts.overlay('src/a.svelte')).toBeNull()
    expect(await drafts.read('src/a.svelte')).toBe('<h1>A</h1>\n')
    expect(drafts.history().canUndo).toBe(false)
  })

  it('refuses to save when the disk file changed since the draft began; force / rebase resolve it', async () => {
    await drafts.write('src/a.svelte', '<h1>mine</h1>\n', { label: 'T' })
    writeFileSync(path.join(root, 'src/a.svelte'), '<h1>theirs</h1>\n')
    expect(await drafts.list()).toEqual([{ file: 'src/a.svelte', conflict: true, deleted: false }])
    await expect(drafts.save(['src/a.svelte'])).rejects.toMatchObject({ code: 'conflict', status: 409 })
    expect(disk('src/a.svelte')).toBe('<h1>theirs</h1>\n')
    await drafts.rebase('src/a.svelte') // keep my draft on top of the new disk text
    expect((await drafts.list())[0].conflict).toBe(false)
    await drafts.save(['src/a.svelte'])
    expect(disk('src/a.svelte')).toBe('<h1>mine</h1>\n')

    await drafts.write('src/a.svelte', '<h1>again</h1>\n', { label: 'T' })
    writeFileSync(path.join(root, 'src/a.svelte'), 'external')
    await drafts.save(['src/a.svelte'], { force: true })
    expect(disk('src/a.svelte')).toBe('<h1>again</h1>\n')
  })

  it('save with several files is all-or-nothing on conflicts; paths cannot escape; big and binary files are refused', async () => {
    await drafts.write('src/a.svelte', 'a2', { label: 'T' })
    await drafts.write('src/b.css', 'b2', { label: 'T' })
    writeFileSync(path.join(root, 'src/b.css'), 'external')
    await expect(drafts.save()).rejects.toMatchObject({ code: 'conflict' })
    expect(disk('src/a.svelte')).toBe('<h1>A</h1>\n') // a was not written either
    expect(() => drafts.abs('../x')).toThrow(/outside/)
    writeFileSync(path.join(root, 'bin.dat'), Buffer.from([1, 0, 2]))
    await expect(drafts.file('bin.dat')).rejects.toMatchObject({ code: 'binary' })
    await expect(drafts.write('nope.txt', 'x')).rejects.toMatchObject({ code: 'not-found' })
  })
})
