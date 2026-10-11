/**
 * Contract sync: every type mirrored in src/contract.ts must be declared identically
 * (comments ignored) in reference/shared-types.ts and reference/bridge-protocol.ts, verbatim copies of the
 * upstream src/shared/types.ts and packages/bridge/src/protocol.ts (parsed only, never compiled).
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { PKG } from './helpers.js'

const SHARED = path.join(PKG, 'reference/shared-types.ts')
const PROTOCOL = path.join(PKG, 'reference/bridge-protocol.ts')
const OURS = path.join(PKG, 'src/contract.ts')

const printer = ts.createPrinter({ removeComments: true })

function decls(file: string): Map<string, string> {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true)
  const out = new Map<string, string>()
  for (const st of sf.statements) {
    let name: string | undefined
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) name = st.name.text
    else if (ts.isFunctionDeclaration(st) && st.name) name = st.name.text
    else if (ts.isVariableStatement(st)) name = (st.declarationList.declarations[0]!.name as ts.Identifier).text
    if (!name) continue
    out.set(name, printer.printNode(ts.EmitHint.Unspecified, st, sf).replace(/\]!/g, ']').replace(/\s+/g, ' ').trim())
  }
  return out
}

describe('contract types vs reference/shared-types.ts + reference/bridge-protocol.ts', () => {
  const ours = decls(OURS)
  const theirs = new Map([...decls(SHARED), ...decls(PROTOCOL)])

  const MIRRORED = [
    'Fs', 'FsI', 'FsU', 'Ref', 'Layer', 'StylePatch', 'PinSpec', 'Tool', 'BridgeMessage',
    'BridgeMessageKind', 'FrameMessage', 'HostCommand', 'parseLoc', 'refName', 'refFile'
  ]

  for (const name of MIRRORED) {
    it(`${name} is identical`, () => {
      expect(theirs.has(name), `${name} missing upstream`).toBe(true)
      expect(ours.get(name), `${name} missing here`).toBeDefined()
      // upstream protocol.ts exports `export type X = …`; we compare the printed declaration
      expect(ours.get(name)).toBe(theirs.get(name))
    })
  }

  it('MARK_ATTR matches upstream except the documented extension', () => {
    const up = theirs.get('MARK_ATTR')!
    const mine = ours.get('MARK_ATTR')!
    const pairs = (s: string): string[] => [...s.matchAll(/(\w+): '([^']+)'/g)].map((m) => `${m[1]}=${m[2]}`)
    const extra = pairs(mine).filter((p) => !pairs(up).includes(p))
    expect(pairs(up).every((p) => pairs(mine).includes(p))).toBe(true)
    expect(extra).toEqual(['fsc=data-fsc'])
  })

  it('upstream mark attributes are the same three names', () => {
    const up = theirs.get('MARK_ATTR')!
    for (const a of ['data-fs', 'data-fsi', 'data-fsu']) expect(up).toContain(`'${a}'`)
  })
})
