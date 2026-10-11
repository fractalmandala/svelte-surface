export class EditError extends Error {
  constructor(
    readonly code: 'not-found' | 'dynamic' | 'mismatch' | 'unsupported' | 'no-parse' | 'invalid',
    message: string
  ) {
    super(message)
    this.name = 'EditError'
  }
}

export interface Target {
  line: number
  col: number
}

export type StateName = 'hover' | 'active' | 'focus' | 'focus-visible' | 'focus-within' | 'disabled'

export type Position = 'before' | 'after' | 'prepend' | 'append'

/** `{expr: '…'}` writes `name={…}`. */
export type AttrValue = string | boolean | null | { expr: string }

export type SvelteEdit =
  | { op: 'setText'; text: string; expect?: string }
  | { op: 'setClasses'; set?: string; add?: string[]; remove?: string[]; expect?: string }
  | { op: 'setAttr'; name: string; value: AttrValue }
  | { op: 'setProp'; name: string; value: AttrValue }
  | { op: 'setTag'; tag: string }
  | { op: 'insert'; markup: string; position: Position; imports?: string[] }
  | { op: 'move'; to: Target; position: Position }
  /** a style gesture (resize/rotate/panel) as CSS props; null removes. Tailwind classes where it maps, else the inline style attribute. */
  | { op: 'patchStyle'; props: Record<string, string | null>; mode?: 'auto' | 'inline' | 'tailwind' }
  /** add/remove classes under a variant prefix, e.g. `hover:` */
  | { op: 'setPrefixedClasses'; prefix: string; add?: string[]; remove?: string[] }
  /** state classes: `hover:`, `active:`, `focus-visible:` … */
  | { op: 'setStateClasses'; state: StateName; add?: string[]; remove?: string[] }
  /** classes that apply for one value of a component's variant prop: `data-[variant=<value>]:` */
  | { op: 'setVariantClasses'; prop?: string; value: string; add?: string[]; remove?: string[] }
  | { op: 'duplicate' }
  | { op: 'remove' }

export interface Change {
  start: number
  end: number
  text: string
}

export interface EditResult {
  code: string
  changed: boolean
  changes: Change[]
  /** human sentence, as the Changes list shows it */
  label: string
}

export interface PropInfo {
  name: string
  /** the default expression as written, if any */
  default?: string
  required: boolean
  rest?: boolean
}

/** Edits of a whole component file (not tied to one element). */
export type ComponentEdit =
  /** `variant` prop with a default + `data-variant={variant}` and `group/variant` on each top element */
  | { op: 'addVariantProp'; name?: string; default: string; options?: string[]; runes?: boolean }
  | { op: 'setVariantDefault'; name?: string; default: string }
  | { op: 'removeVariantProp'; name?: string }

export interface VariantInfo {
  name: string
  default?: string
  /** values seen in `data-[<name>=value]:` classes (plus the default) */
  options: string[]
}

export interface StateInfo {
  line: number
  col: number
  tag: string
  /** state → classes written under it (without the prefix) */
  states: Record<string, string[]>
}
