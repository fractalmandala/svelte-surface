#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { createSurface } from './surface.js'
import type { SvelteEdit } from './edit/types.js'
import { EditError } from './edit/types.js'

const HELP = `surface-svelte <command> [project-root] [options]

  detect                       what kind of project this is
  pages                        list src/routes/**/+page.svelte
  new-page <route> [--title T] scaffold src/routes/<route>/+page.svelte
  mark <file>                  print the file as the dev server hands it to Svelte (marks injected)
  dev [--port N]               run the project's own vite dev with the marks plugin first
  edit <file:line:col> <json>  apply one edit (or '-' for JSON on stdin); --dry prints, writes nothing
  usages <component-file>      where a component is used
  
edit JSON examples:
  {"op":"setText","text":"Hello"}   {"op":"setClasses","add":["p-4"],"remove":["p-2"]}
  {"op":"setAttr","name":"href","value":"/x"}   {"op":"remove"}   {"op":"duplicate"}
`

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const [, v] = args.splice(i, 2)
  return v
}

export async function main(argv: string[]): Promise<number> {
  const args = [...argv]
  const cmd = args.shift()
  if (!cmd || cmd === '-h' || cmd === '--help') {
    process.stdout.write(HELP)
    return 0
  }
  const dry = args.includes('--dry')
  if (dry) args.splice(args.indexOf('--dry'), 1)
  const port = flag(args, '--port')
  const title = flag(args, '--title')
  const rootFlag = flag(args, '--root')
  const out = (v: unknown): void => void process.stdout.write(JSON.stringify(v, null, 2) + '\n')
  const surface = createSurface(rootFlag ?? process.cwd())
  try {
    switch (cmd) {
      case 'detect':
        out(surface.info)
        return 0
      case 'pages':
        out(await surface.pages())
        return 0
      case 'new-page':
        out({ created: await surface.newPage(args[0] ?? '', { title }) })
        return 0
      case 'mark': {
        const code = await surface.marked(args[0] ?? '')
        process.stdout.write(code ?? '(no marks: file has no elements or does not parse)\n')
        return 0
      }
      case 'usages':
        out(await surface.usages(args[0] ?? ''))
        return 0
      case 'edit': {
        const raw = args[1] === '-' ? readFileSync(0, 'utf8') : args[1]
        if (!args[0] || !raw) throw new Error('usage: edit <file:line:col> <json>')
        const r = await surface.edit(args[0], JSON.parse(raw) as SvelteEdit, { dryRun: dry })
        out({ file: r.file, changed: r.changed, label: r.label, changes: r.changes })
        return 0
      }
      case 'dev': {
        const dev = await surface.startDev({ port: port ? Number(port) : undefined, onLog: (l) => process.stderr.write(l + '\n') })
        process.stdout.write(`surface dev server (marks on): ${dev.url}\n`)
        const stop = (): void => void surface.stopDev().then(() => process.exit(0))
        process.on('SIGINT', stop)
        process.on('SIGTERM', stop)
        await new Promise(() => undefined)
        return 0
      }
      default:
        process.stderr.write(`unknown command: ${cmd}\n${HELP}`)
        return 2
    }
  } catch (e) {
    process.stderr.write(`${e instanceof EditError ? `[${e.code}] ` : ''}${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

main(process.argv.slice(2)).then((c) => {
  if (c !== 0) process.exitCode = c
})
