/**
 * @fractaldesign/svelte-surface — the single shared design→code surface for SvelteKit
 * pages and components.
 */
export * from './contract.js'
export { Surface, createSurface, type Locator } from './surface.js'
export { loadSvelte, parseSvelte, walk, LineIndex, type Doc, type SNode, type SAttr, type SvelteCompiler } from './svelte/ast.js'
export { surfaceMarks, markFile, BRIDGE_URL, type SurfaceMarksOptions } from './marks/plugin.js'
export { markSvelteSource, type MarkOptions, type MarkResult } from './marks/transform.js'
export { installBridge, installBridgeOnce, refOfElement, buildLayers, snapshotDom, stampLate, watchMarks, type BridgeOptions, type BridgeHandle } from './bridge/browser.js'
export { bridgeSource, SNAPSHOT_SCRIPT, stampScript, WATCH_SCRIPT } from './bridge/source.js'
export * from './edit/index.js'
export * from './orchestrator/index.js'
