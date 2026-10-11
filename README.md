# Svelte Surface

<img src="./public/red.png" alt="redfracta" height="128px; width: 128px"/>

One shared design→code surface for **SvelteKit pages and components**: point Svelte Surface to your Sveltekit project, watch the page and components load live - edit, code, and design in the same workbench. The design *is* the running dev server.

```
code ──marks──▶ DOM ──bridge──▶ host ──ref──▶ edit-engine ──bytes──▶ code ──HMR──▶ DOM
```

| Module | What it does |
| --- | --- |
| `src/marks` | Vite plugin, placed first. Parses each `.svelte` with the **project's own** `svelte/compiler` (Svelte 5 modern AST, Svelte 4 legacy AST) and injects, in memory only: `data-fs="file:line:col"` on every element, `data-fsi="Name\|file:line:col"` on every component instance, `data-fsu="Ref1 Ref2 …"` (usage chain, outermost first) on the top elements of a component. Same-line insertions only, so line numbers stay true; unparsable files get no marks; `<svelte:head/window/body/document/options>` are left alone. |
| `src/bridge` | In-iframe overlay (`<surface-overlay>` shadow DOM): hover/select boxes, click → resolve mark → `postMessage` per `reference/bridge-protocol.ts` (`ready/hover/select/dblclick/layers/route`, host commands `setHover/select/setTool/setZoom/reveal/navigate/init`). Also page scripts for the main process: `SNAPSHOT_SCRIPT`, `stampScript(root)` (retro-stamps late elements from Svelte's dev `__svelte_meta`), `WATCH_SCRIPT()` (MutationObserver, 120 ms debounce). |
| `src/edit` | Byte-range edits with magic-string over the AST: `setText`, `setClasses` (static `Text` parts only; `{expr}` refused with "comes from a variable"), `setAttr`, `setProp`, `setTag`, `insert` (+imports), `move`, `duplicate`, `remove`, `listProps`, `findAt(line,col)`. The result is re-parsed; if it would not parse nothing is written. |
| `src/edit/component.ts` | Component authoring. **Variants**: `addVariantProp` writes a `variant` prop with its default (`$props()` destructure, `export let`, typed in TS), `data-variant={variant}` and `group/variant` on each top element; `setVariantDefault`, `removeVariantProp`, `listVariants`. **States**: `setStateClasses` (`hover:`/`active:`/`focus-visible:`…), `setVariantClasses` (`data-[variant=x]:…`), `listStates`. |
| `src/orchestrator` | `detectProject` (`@sveltejs/kit` → SvelteKit; else `vite`+`svelte`), `listPages` (`src/routes/**/+page.*`, `(groups)` dropped, `[slug]` dynamic), `scaffoldPage`, `startDevServer` (project's own `vite dev` + wrapper config that loads the project's config with its own Vite and prepends one plugin), `importClosure` (3-deep), `findUsages`, `watchSources`. |
| `src/surface.ts` | `Surface`: the single object a host uses. |

## Use

```ts
import { createSurface } from '@fractaldesign/svelte-surface'

const s = createSurface('/path/to/project')
s.info                         // { kind: 'sveltekit', staticDir: 'static', versions, … }
await s.pages()                // [{ route: '/about', file: 'src/routes/about/+page.svelte', dynamic: false }]
await s.newPage('/blog/[slug]')
const dev = await s.startDev() // vite dev with marks; dev.url
// a click in the canvas frame arrives as a Ref (`select` message). Edit what it points at:
await s.edit(ref, { op: 'setText', text: 'Our best work', expect: ref.text })
await s.edit(ref, { op: 'setClasses', add: ['text-6xl'], remove: ['text-5xl'] })
// `{title}` is an expression → refused. Edit it where it is used (ref.fsi = 'Card|src/routes/+page.svelte:9:3'):
await s.edit(ref.fsi!, { op: 'setProp', name: 'title', value: 'FAQ' })
await s.stopDev()
```

Pure functions (no disk): `applyEdit(source, svelteCompiler, {line, col}, edit)`, `markSvelteSource(source, relFile, svelteCompiler)`.
Host side of the bridge: speak the protocol in `reference/bridge-protocol.ts` (see `HostCommand` / `BridgeMessage` in `src/contract.ts`); the frame side is `installBridge()` here.

Edits: `setText | setClasses | setAttr | setProp | setTag | patchStyle | setPrefixedClasses | setStateClasses | setVariantClasses | insert | move | duplicate | remove`; whole-component edits (`ComponentEdit`): `addVariantProp | setVariantDefault | removeVariantProp` (see `src/edit/types.ts`).

### Style gestures (resize / rotate / panel → source)
The bridge shows 8 resize handles + a rotate handle on a single selection (`setHandles {w,h,style}` controls which). Dragging emits `live` patches (the frame previews inline and restores on release) and one `commit` patch `{ref, props: {width: '130px'}, label}`. `surface.onBridgeMessage(msg)` / `surface.applyPatch(patch)` write it with `patchStyle`: Tailwind arbitrary classes where the property maps (`width → w-[130px]`, replacing the old `w-*`; also height, min/max sizes, opacity, rotate, gap, padding, margin, radius, colors, font-size) when the project has Tailwind, otherwise the static inline `style` attribute (other declarations untouched; dynamic `style={…}` is refused). `previewStyle` applies props without writing. **Pins**: `pin` command draws numbered/resolved/active/draft pins; with the comment tool a click emits `select` then `pin {id,fx,fy}`; `fx/fy` are fractions of the *document* (the protocol's `PinSpec` carries no ref), Esc cancels the draft.

### Standalone
This package is fully standalone: it has its own lockfile and `node_modules`; `npm install`, `npm run typecheck` and `npm test` all run from this folder.
Errors are `EditError` with `code`: `dynamic | mismatch | not-found | unsupported | no-parse | invalid`.

### How the bridge gets into the page
- **Vite + Svelte**: `transformIndexHtml` adds `<script type=module src="/@surface/bridge.js">`.
- **SvelteKit** has no `transformIndexHtml`: entry components (`+layout/+page/+error.svelte`, `App.svelte`) get a module-level `import 'virtual:surface-bridge'` (also in memory only). The bridge no-ops outside an iframe unless `always`.

### Usage chain
Passed content counts too: the root elements of component children and of `{#snippet}` bodies get the chain of the component they are written in. A component's top elements read `data-fsi` / `data-fsc` from their props: `$props()` destructure (the two names are added to the pattern), `let props = $props()`, or `$$props` (legacy / Svelte 4). A component that is itself a top element of another component forwards `data-fsc`, so `data-fsu` reads `Outer|page:7:3 Inner|Outer:3:1`.

## CLI

```
surface-svelte detect|pages|new-page <route>|mark <file>|usages <component>|dev [--port N]
surface-svelte edit <file:line:col> '<json>' [--dry]     # e.g. '{"op":"setText","text":"Hi"}'
   --root <dir>   project root (default cwd)
```
`npm run build` first (`dist/cli.js`). The dev server child needs the compiled plugin in `dist/`.

## Develop

```
npm install
npm run typecheck
npm test            # builds, then vitest: unit + jsdom bridge + real dev-server end-to-end
```
Fixtures `fixtures/sveltekit-app` and `fixtures/vite-svelte-app` have no `node_modules`; they resolve svelte/vite/kit from this package. `fixtures/svelte4-app` (Svelte 4.2 + Vite 5 + vite-plugin-svelte 3, `lang="ts"`, `export let`, `$$props`) has its own: run `npm run fixtures:install` once, otherwise its live test is skipped. Legacy `$$props` on a live SvelteKit server is covered by `fixtures/sveltekit-app/src/routes/legacy`. Tests copy a fixture to `fixtures/.run-*` before editing it.

## Svelte 4 + TypeScript
Svelte 4 cannot parse `<script lang="ts">` bodies, and the plugin runs before preprocessing. Those bodies are blanked (spaces, newlines kept, same length) for the parse only: template offsets stay exact, marks use `$$props` and need nothing from the script, and the script text is never rewritten. `listProps` and variant edits read `export let` from the script text in that case.

## Known gaps
- Svelte 4 + `lang="ts"`: props are read from the script text (regex), not an AST, so exotic declarations (`export let a, b`) are missed.
- `mid:` CSS, Site settings, CMS and Variables are out of scope here.
- Bridge: no free-canvas move/drag, no `previewStyle` for class-based (non-inline) diffs; pins are placed by document fraction, not element-relative (the protocol has no ref on `PinSpec`).
- Variants are written with Tailwind's `data-[variant=x]:` classes; plain-CSS variants are not authored.
- `patchStyle` Tailwind mapping covers the properties listed above; others go inline.

## App

The standalone editor app (`npm run app:native` for the macOS app, `npm run app` for the browser fallback) has: start screen, built-in folder browser, recent projects, install prompt, git safe-edit warning, the visual editor, and a CodeMirror code editor. All edits are in-memory drafts served to the dev server through a Vite overlay (`surfaceMarks({ overlay })`, `Surface({ io })`); files change only on Save. `npm run app:bundle` builds a legacy script launcher. See [DEMO.md](./DEMO.md).


## Native macOS app (WKWebView shell)

`npm run app:native` builds `dist-app/Surface.app` (+ `.dmg`): a Swift/AppKit shell around this app's Svelte UI — no Electron, no Chrome.
Native window and menu bar (⌘O open folder, ⌘S save, ⌘Z/⇧⌘Z draft undo/redo, ⌘Q quit with an unsaved-drafts prompt), a real
`NSOpenPanel` folder picker bridged to the page (`webkit.messageHandlers.surface`), folder drag & drop, and the Node server as a
child process on a free port that is stopped on quit (and exits by itself if the shell dies). The bundle contains the built package,
the server and an official Node binary (`--no-node` to skip; otherwise Node 18+ is looked up on the machine), so it can be moved anywhere.
Log: `~/Library/Logs/surface.log`. The bundled example installs its dependencies on first use (prompted).

### App source layout (Svelte 5 + TypeScript)

```
app/ui/            Svelte 5 (runes) UI, built by Vite into app-dist/public
  styles/tokens.css   ← design tokens (colors, type, radii, spacing, panel widths): restyle here
  styles/base.css     shared element styles + utility classes (read the tokens)
  components/*.svelte start, flow, folder browser, top bar, layers, file tree, code pane, canvas, inspector, dialogs (scoped styles)
  lib/*.svelte.ts     state + actions: surface (canvas/inspector/history), code (tabs/drafts/diff), project (start/open flow)
  lib/editor.ts       CodeMirror 6 wrapper
app/server/*.ts    app server (main.ts), projects.ts (recents/browse/git/install), drafts.ts (virtual buffers); esbuild → app-dist/server.mjs
app/vite.config.ts, scripts/*.ts   build config and packaging (run with `node file.ts`, Node ≥ 22.18)
native-shell/      Swift/AppKit WKWebView shell (unchanged)
```

`npm run build:app` builds the library (tsc), the UI and the server bundle. `npm run typecheck` runs `tsc` and `svelte-check`. The `app`, `app:headless`, `app:bundle` and `app:native` scripts all build first. To retheme, edit `app/ui/styles/tokens.css` and rebuild.
