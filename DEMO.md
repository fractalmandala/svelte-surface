# Svelte Surface

A design-to-code app for SvelteKit and Vite + Svelte projects. UI is Svelte 5 + TypeScript served by a small Node server, shown either in a native macOS window (WKWebView shell, `npm run app:native`) or, as a fallback, in a Chrome/Edge/Brave app window (`npm run app`).
You pick a project folder; the app starts that project's own `vite dev` with the marks plugin and bridge, shows it in a canvas, and keeps every edit as an in-memory draft that you preview live, and writes your files only when you Save.

## Launch

### Native macOS app (recommended)

```sh
npm install                     # first time only
npm run app:native:open         # builds the UI + server, the Swift shell and the bundle, then opens it
npm run app:native              # same without opening; writes dist-app/Surface.app and .dmg
```

Native window, menu bar (⌘O, ⌘S, ⌘Z, ⌘Q), a real folder picker, folder drag & drop. The bundle contains the server and a Node binary, so it can be moved anywhere. Log: `~/Library/Logs/surface.log`.

### Browser fallback (any OS)

```sh
npm run app                     # builds, starts the server, opens an app window (http://localhost:4320/)
```

- Closing the window quits the app and stops the project's dev server. Ctrl-C does the same.
- The browser fallback needs Chrome, Edge, Brave or Chromium for the app window (`CHROME_PATH` overrides); otherwise it opens your default browser. It uses the in-UI folder browser instead of the native picker.
- `npm run app:headless` starts the server without a window, then open the printed URL yourself.
- `npm run surface:app` and `npm run demo` are aliases of `npm run app`.

### Legacy launcher (macOS)

`npm run app:bundle` writes a small script-based `dist-app/Surface.app` that runs this checkout's server and opens the Chrome app window. It only works while the checkout stays where it is; prefer the native app above.

## Using it

1. **Start screen**: *Open folder…*, *Open the bundled example*, and **Recent projects** (stored in `~/Library/Application Support/surface/recents.json`; × removes an entry).
2. **Folder browser** (browser fallback; the native app uses the macOS folder panel): shortcuts (Home, Desktop, Documents, …), clickable breadcrumbs, a path box (paste a path + Enter), "show hidden". Folders that contain a SvelteKit or Vite + Svelte project are marked **●** (bold, with a badge). Click selects, double-click enters a folder or opens a marked project.
3. **Open flow**: the app detects the project, then
   - not a supported project → a clear message saying what was missing;
   - `node_modules` missing → a prompt with a *Run npm/pnpm/yarn/bun install* button and live output; then it re-checks;
   - not a git repo, or uncommitted changes → a **safe-edit warning** (Save writes straight into your files) you must tick before *Open project* enables (the server refuses to open without that acknowledgement too);
   - dev server fails to start → an error screen with the actual log and *Try again*.
   A clean project with dependencies opens straight away.
4. **Editor (Design)**: page picker, width presets, tools (Select / Comment / Preview), Layers tree, and the property panel: text, classes, state classes (`hover:` …), attributes, style (`patchStyle`), component variants, Insert / Duplicate / Remove / Move up / Move down, resize + rotate handles in the canvas.
5. **Drafts: nothing touches disk until you Save.** Every edit, from the canvas *and* typed code, goes into an in-memory draft of the file. The project's dev server reads the drafts through a Vite plugin overlay (HMR fires on each draft change), so the canvas previews the draft while your files stay as they are.
   - **Save**: `⌘S` (or `Ctrl+S`) saves the open file; *Save all* in the top bar saves everything. Saving is one write of exactly the draft text.
   - **Unsaved changes** (top bar button) lists the drafted files with *Diff* (disk on the left, draft on the right), *Save* and *Revert*; *Discard all* drops every draft.
   - **Undo / Redo** (top bar, or `⌘Z` / `⇧⌘Z` outside inputs) walk one history over all drafted files. In the code editor `⌘Z` is the same draft undo; typing in one burst is one step.
   - **Conflicts**: if a file changed on disk after you started its draft, Save is refused ("changed on disk since you opened it", nothing is written) and you choose *Reload from disk* (drop my draft), *Keep my draft* (it will replace the disk version on save) or *Overwrite disk*, after looking at the *Diff*.
   - Closing or switching to another project with unsaved drafts asks: *Cancel*, *Discard drafts* or *Save all and continue* (the server enforces it). Reloading the window warns too. Drafts are in memory only: quitting the app loses unsaved ones.
6. **Code** a CodeMirror 6 editor with line numbers, folding, bracket matching, find/replace (`⌘F`), `Tab` indent, and colours for Svelte/HTML, TypeScript/JavaScript, CSS, JSON and Markdown.
   - **Open code** (button in the property panel): the element's file opens beside the preview with the cursor on the element's line; clicking another element in the preview jumps to its code, in whatever file. `Esc` or ✕ returns to Design.
   - **Code mode** (Design | Code in the top bar): file tree on the left (dirty ● markers, `node_modules`/`.git`/build folders left out, dotfiles dimmed), tabs with a dot for unsaved drafts (middle-click closes), and **▶ Preview** to put the page beside the code.
   - Marks stay true on drafts: line:col in `data-fs` are computed from the draft text, so clicking after a code edit resolves to the right element.
7. **Projects** (top bar) returns to the start screen while the project keeps running (*Back to editor* resumes it; the row shows its unsaved count). **Close project** stops its dev server.

The bundled example is a copy in `fixtures/.demo-run` (in the native app: `~/Library/Application Support/surface/example`) (fresh each time; *Reset example* restores it). Your own projects are edited in place, but only when you Save.

## Limits (known gaps)

- Drafts cover files that already exist. *New page* still creates its `+page.svelte` on disk immediately; no new-file / rename / delete in the tree.
- *Keep my draft* does not merge: after an outside change your draft replaces the disk version when saved (use *Diff* first). No three-way merge.
- Drafts are lost when the app quits. The editor has no completion, linting or type checking, and no terminal. Files over 2 MB and binary files are not opened.
- The Vite overlay covers plain module files in the project (not `?query` ids, not `node_modules`); a draft of a config file such as `vite.config.js` is only picked up after a dev-server restart.

## Verified

`test/drafts.test.ts` unit-tests the draft store. `test/app.test.ts` starts the app server and drives it in real Chrome (Playwright): start screen, folder browser (breadcrumbs, shortcuts, ● highlighting, missing-path error), unsupported-folder error, missing-deps prompt, git warnings (non-git and dirty; acknowledgement enforced by the API), clean git project, dev-server failure screen, recents on disk surviving an app restart, switch / close (dev server really stops), drafts and the code editor (preview without touching disk, Open code cursor line, typed code, ⌘S, per-file revert, undo/redo, diff view, disk-change conflicts with reload / keep / overwrite, code mode tree/tabs/find/preview, unsaved-draft prompts on close and switch), and the full editor (select inside the iframe, text/class/state/attr/style edits, a real resize drag, insert/move/undo/duplicate/remove, variants, page picker, reset) checking both the files on disk and the hot-reloaded canvas. `APP_TEST_INSTALL=1 npm test` also runs a real `npm install` through the UI. The native `.app` (launch, folder picker path, quit stops the server) was checked by hand on macOS.
