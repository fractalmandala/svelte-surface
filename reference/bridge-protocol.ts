/**
 * The wire between a canvas iframe (the frame) and the host renderer (the host).
 *
 * Two rules hold everywhere:
 *  - every frame→host message is a plain object with `__surface: true` and the
 *    frame id it came from, sent with `window.parent.postMessage(..., '*')`;
 *  - every host→frame message is sent with the frame's own `contentWindow`, and
 *    the frame only accepts messages whose `source` is `window.parent`.
 *
 * The bus below is the only place that knows those two rules. Both sides import
 * it: the frame calls `createFrameBus`, the host creates one bus per iframe with
 * `createHostBus(frameId, contentWindow)`.
 */

import type { Layer, Ref } from './shared-types'

/** Attribute the loaders stamp. See `@shared/types` for the full contract. */
export const MARK_ATTR = {
  /** `file:line:col` — where the element's half-open tag is written */
  fs: 'data-fs',
  /** `Name|file:line:col` — the component instance that rendered it */
  fsi: 'data-fsi',
  /** `Ref1 Ref2 …` — where the component is used, outermost first */
  fsu: 'data-fsu',
  /** the frame is showing one component in isolation */
  iso: 'data-fs-iso',
  /** temporary, while probing which element sits under an embed */
  probe: 'data-fs-probe',
  /** incremented to force a restyle when the injected stylesheet must re-apply */
  kick: '--fs-kick'
} as const

/**
 * A style change a gesture produced. `props` are CSS property → value, already
 * resolved by the frame against the element's computed style, so the host can
 * diff them against the file without reading the DOM. `label` is the sentence the
 * Publish list shows.
 */
export interface StylePatch {
  ref: Ref
  props: Record<string, string>
  label: string
}

/** A comment pin as the host stores it and hands back to the frame to draw. */
export interface PinSpec {
  id: string
  /** where on the element, 0…1 across and down */
  fx: number
  fy: number
  /** the comment's number on the canvas; the draft pin draws a + instead */
  n?: number
  /** resolved comments go grey */
  resolved?: boolean
  /** the comment open in the panel (or being written) goes blue and grows */
  active?: boolean
  /** the pin the user is currently placing */
  draft?: boolean
}

/** The frame is a design frame, not the preview. */
export type Tool = 'select' | 'comment' | 'preview'

export type BridgeMessage =
  | {
      __surface: true
      t: 'ready'
      frame: string
      url: string
      title: string
      route: string
      height: number
    }
  | { __surface: true; t: 'hover'; ref: Ref | null }
  | { __surface: true; t: 'select'; ref: Ref; add: boolean; parent: boolean }
  | { __surface: true; t: 'dblclick'; ref: Ref }
  | { __surface: true; t: 'commit'; patch: StylePatch }
  | { __surface: true; t: 'live'; patch: StylePatch }
  | { __surface: true; t: 'layers'; layers: Layer[] }
  | {
      __surface: true
      t: 'pin'
      comment: { id: string; fx: number; fy: number } | null
    }
  | { __surface: true; t: 'navigate'; route: string }
  | { __surface: true; t: 'scroll'; y: number; h: number }
  | { __surface: true; t: 'route'; route: string }
  | { __surface: true; t: 'log'; level: 'info' | 'warn' | 'error'; message: string }

export type BridgeMessageKind = BridgeMessage['t']

/** The frame id that goes on every outbound message. Filled by the bus. */
export type FrameMessage = Omit<BridgeMessage, '__surface' | 'frame'> & {
  __surface: true
  frame: string
}

/** Host→frame commands. Every field past the discriminator is optional. */
export interface HostCommand {
  __surface: true
  /** which frame the command is for; the host sends it to one frame at a time */
  frame?: string

  /** element hover was last reported for, so the frame can draw the hover box */
  setHover?: Ref | null
  /** the current selection, plus `add` when the click was a ⇧-click */
  select?: { ref: Ref | null; add?: boolean }
  /** the pins to draw; `null` clears them */
  pin?: PinSpec[] | null
  /** the canvas zoom; every overlay metric is divided by it */
  setZoom?: number
  /** the layer tree, so the frame can mark rows as selected */
  setLayers?: Layer[]
  /** scroll the frame to a document offset (the host drives frame height) */
  scrollTo?: number
  /** the route to open */
  navigate?: string

  /* ---- one-time setup ---- */
  /** sent once by the host as soon as it has an iframe to talk to */
  init?: {
    frame: string
    tool?: Tool
    zoom?: number
    /** the breakpoint's device height: what `vh` means in this frame */
    viewportHeight?: number
    /** rest animations and videos while designing */
    paused?: boolean
    /** the frame is a design frame rather than a preview */
    canvas?: boolean
    /** ask for the layer tree */
    wantTree?: boolean
  }
  /** inspect / comment / preview */
  setTool?: Tool
  /** rest or resume motion */
  setPaused?: boolean
  /** force a re-measure of the injected stylesheets */
  repaint?: boolean
  /** the selection's size modes: which handles the frame may show */
  setHandles?: { w: boolean; h: boolean; style: boolean }
  /** preview a style panel change without writing it */
  previewStyle?: { ref: Ref; style: Record<string, string> | null }
  /** reveal (scroll to) an element the host just selected from the Layers tab */
  reveal?: { ref: Ref }
}

/** `file:line:col` → `{file, line, col}`. Tolerates a `Name|` prefix. */
export function parseLoc(loc: string | null | undefined): { file: string; line: number; col: number } | null {
  if (!loc) return null
  const bare = loc.includes('|') ? loc.slice(loc.indexOf('|') + 1) : loc
  const m = /^(.*):(\d+):(\d+)$/.exec(bare)
  if (!m) return null
  return { file: m[1], line: Number(m[2]), col: Number(m[3]) }
}

/** The `Name` of a `Name|file:line:col` ref, or null. */
export function refName(ref: string | null | undefined): string | null {
  if (!ref || !ref.includes('|')) return null
  return ref.slice(0, ref.indexOf('|'))
}

/** `file:line:col` → `file`, dropping the numbers. */
export function refFile(ref: string | null | undefined): string | null {
  const loc = parseLoc(ref)
  return loc ? loc.file : null
}

/** Narrow an unknown `MessageEvent.data` to a frame→host message. */
export function isBridgeMessage(data: unknown): data is FrameMessage {
  if (!data || typeof data !== 'object') return false
  const d = data as { __surface?: unknown; t?: unknown }
  return d.__surface === true && typeof d.t === 'string'
}

/** Narrow an unknown `MessageEvent.data` to a host→frame command. */
export function isHostCommand(data: unknown): data is HostCommand {
  if (!data || typeof data !== 'object') return false
  const d = data as { __surface?: unknown }
  return d.__surface === true
}

/** Every frame→host message carries its frame id; this builds the envelope. */
function envelope(
  frame: string,
  message: { t: BridgeMessageKind } & Record<string, unknown>
): FrameMessage {
  return { ...message, __surface: true, frame } as FrameMessage
}

/**
 * The frame side. `emit` never throws: a page that has been torn down mid-frame
 * must not take the host's message loop with it.
 */
export interface FrameBus {
  /** this frame's id */
  readonly frame: string
  /** send to the host. Never throws. */
  emit<K extends BridgeMessageKind>(
    message: Pick<Extract<BridgeMessage, { t: K }>, 't'> & Record<string, unknown>
  ): void
  /** host→frame commands, already filtered on `source === window.parent` */
  onCommand(handler: (command: HostCommand) => void): () => void
}

/** Creates the bus inside an iframe. `post` is injected so this is testable. */
export function createFrameBus(
  frame: string,
  hostWindow: Window,
  selfWindow: Window,
  post: (data: FrameMessage, targetOrigin: string) => void = (data) =>
    hostWindow.postMessage(data, '*')
): FrameBus {
  const handlers = new Set<(command: HostCommand) => void>()
  selfWindow.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== hostWindow) return
    if (!isHostCommand(event.data)) return
    const command = event.data as HostCommand
    if (command.frame !== undefined && command.frame !== frame) return
    for (const handler of [...handlers]) {
      try {
        handler(command)
      } catch (error) {
        reportFrameError('error', error)
      }
    }
  })

  return {
    frame,
    emit(message) {
      try {
        post(envelope(frame, message), '*')
      } catch (error) {
        reportFrameError('error', error)
      }
    },
    onCommand(handler) {
      handlers.add(handler)
      return () => handlers.delete(handler)
    }
  }
}

/**
 * The host side. One bus per iframe; `on` filters out every message that isn't
 * for this frame, so a stale frame can never drive a live one.
 */
export interface HostBus {
  readonly frame: string
  /** send a command into the frame. Never throws. */
  send(command: Omit<HostCommand, '__surface' | 'frame'>): void
  /** frame→host messages addressed to this frame */
  on(handler: (message: FrameMessage) => void): () => void
}

export function createHostBus(frame: string, contentWindow: Window | null): HostBus {
  const handlers = new Set<(message: FrameMessage) => void>()

  const onMessage = (event: MessageEvent) => {
    if (!isBridgeMessage(event.data)) return
    if (event.data.frame !== frame) return
    for (const handler of [...handlers]) {
      try {
        handler(event.data)
      } catch {
        /* the host must not die because a panel threw */
      }
    }
  }
  window.addEventListener('message', onMessage)

  return {
    frame,
    send(command) {
      try {
        contentWindow?.postMessage({ ...command, __surface: true, frame }, '*')
      } catch {
        /* the frame navigated away; nothing to do */
      }
    },
    on(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
        onMessage && window.removeEventListener('message', onMessage)
        if (handlers.size === 0) window.removeEventListener('message', onMessage)
      }
    }
  }
}

/**
 * The bridge runs inside somebody else's page. A throw there would surface as a
 * mystery console error in the user's project, so every failure is reported to
 * the host as a `log` message and swallowed.
 */
export function reportFrameError(level: 'info' | 'warn' | 'error', error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  try {
    window.parent.postMessage({ __surface: true, t: 'log', level, message, frame: '' }, '*')
  } catch {
    /* nothing left to do */
  }
}