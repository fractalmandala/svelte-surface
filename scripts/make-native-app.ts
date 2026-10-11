// Builds the native macOS app (AppKit + WKWebView; no Electron, no Chrome):
//   dist-app/Surface.app   and, when hdiutil works,   dist-app/Surface.dmg
// The bundle is self-contained: built package + server + magic-string in Contents/Resources/server and (unless
// --no-node) an official Node binary in Contents/Resources/node. It does not depend on this checkout.
//   node scripts/make-native-app.ts [--no-node] [--no-dmg] [--node-version 22.12.0]
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'

const pkg = path.resolve(import.meta.dirname, '..')
const argv = process.argv.slice(2)
const has = (f: string): boolean => argv.includes(f)
const val = (f: string, d: string): string => (argv.includes(f) ? (argv[argv.indexOf(f) + 1] ?? d) : d)
if (process.platform !== 'darwin') { console.error('macOS only'); process.exit(1) }
const run = (cmd: string, args: string[], opts: Record<string, unknown> = {}): void => { execFileSync(cmd, args, { stdio: 'inherit', ...opts }) }

if (!existsSync(path.join(pkg, 'dist', 'index.js')) || !existsSync(path.join(pkg, 'app-dist/server.mjs'))) {
  console.log('building package + UI first…')
  run('npm', ['run', 'build:app'], { cwd: pkg })
}

const name = 'Surface'
const out = path.join(pkg, 'dist-app')
const app = path.join(out, `${name}.app`)
const res = path.join(app, 'Contents', 'Resources')
rmSync(app, { recursive: true, force: true })
mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true })
mkdirSync(res, { recursive: true })

// 1. executable (universal when the x86_64 slice builds too)
const exe = path.join(app, 'Contents', 'MacOS', 'Surface')
const sw = path.join(pkg, 'native-shell', 'main.swift')
const tmp = path.join(out, 'tmp'); mkdirSync(tmp, { recursive: true })
run('swiftc', ['-O', '-o', path.join(tmp, 'arm64'), '-target', 'arm64-apple-macos11', sw])
try {
  run('swiftc', ['-O', '-o', path.join(tmp, 'x86_64'), '-target', 'x86_64-apple-macos11', sw], { stdio: 'ignore' })
  run('lipo', ['-create', path.join(tmp, 'arm64'), path.join(tmp, 'x86_64'), '-output', exe])
} catch { cpSync(path.join(tmp, 'arm64'), exe); console.log('(arm64 only)') }
chmodSync(exe, 0o755)

// 2. server payload
const srv = path.join(res, 'server')
mkdirSync(srv, { recursive: true })
for (const d of ['dist', 'app-dist']) cpSync(path.join(pkg, d), path.join(srv, d), { recursive: true, filter: (s: string) => !/\.DS_Store$/.test(s) })
writeFileSync(path.join(srv, 'package.json'), JSON.stringify({ name: 'surface-server', private: true, type: 'module' }))
for (const m of ['magic-string', '@jridgewell/sourcemap-codec']) {
  const from = ['node_modules', path.join('..', '..', 'node_modules')].map((b) => path.join(pkg, b, m)).find((p) => existsSync(p))
  if (!from) throw new Error(`dependency ${m} not installed`)
  cpSync(from, path.join(srv, 'node_modules', m), { recursive: true })
}
if (existsSync(path.join(pkg, 'fixtures', 'sveltekit-app'))) {
  cpSync(path.join(pkg, 'fixtures', 'sveltekit-app'), path.join(srv, 'fixtures', 'sveltekit-app'), { recursive: true, filter: (s: string) => !/node_modules|\.svelte-kit/.test(s) })
}

// 3. node
if (!has('--no-node')) {
  const v = val('--node-version', '22.12.0')
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const cache = path.join(out, `node-v${v}-darwin-${arch}.tar.gz`)
  try {
    if (!existsSync(cache)) run('curl', ['-fsSL', '--max-time', '300', '-o', cache, `https://nodejs.org/dist/v${v}/node-v${v}-darwin-${arch}.tar.gz`])
    mkdirSync(path.join(res, 'node', 'bin'), { recursive: true })
    run('tar', ['-xzf', cache, '-C', tmp, `node-v${v}-darwin-${arch}/bin/node`])
    cpSync(path.join(tmp, `node-v${v}-darwin-${arch}`, 'bin', 'node'), path.join(res, 'node', 'bin', 'node'))
    chmodSync(path.join(res, 'node', 'bin', 'node'), 0o755)
    console.log(`bundled node ${v} (${arch})`)
  } catch (e) { console.log(`could not bundle node (${(e as Error).message}); the app will look for an installed Node 18+`) }
}

// 4. icon + plist
try {
  run('swift', [path.join(pkg, 'native-shell', 'icon.swift'), path.join(tmp, 'icon.iconset')])
  run('iconutil', ['-c', 'icns', path.join(tmp, 'icon.iconset'), '-o', path.join(res, 'AppIcon.icns')])
} catch { console.log('(no icon)') }
const version = JSON.parse(readFileSync(path.join(pkg, 'package.json'), 'utf8')).version ?? '0.1.0'
writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>${name}</string>
  <key>CFBundleDisplayName</key><string>${name}</string>
  <key>CFBundleIdentifier</key><string>com.fractaldesign.surface</string>
  <key>CFBundleExecutable</key><string>Surface</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticGraphicsSwitching</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>CFBundleDocumentTypes</key><array><dict>
    <key>CFBundleTypeName</key><string>Folder</string>
    <key>CFBundleTypeRole</key><string>Editor</string>
    <key>LSItemContentTypes</key><array><string>public.folder</string></array>
  </dict></array>
</dict></plist>
`)
try { run('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'ignore' }) } catch { console.log('(unsigned)') }
rmSync(tmp, { recursive: true, force: true })
console.log(`built: ${app}`)

// 5. dmg
if (!has('--no-dmg')) {
  const dmg = path.join(out, `${name}.dmg`)
  const stage = path.join(out, 'dmg-stage')
  try {
    rmSync(stage, { recursive: true, force: true }); rmSync(dmg, { force: true })
    mkdirSync(stage, { recursive: true })
    cpSync(app, path.join(stage, `${name}.app`), { recursive: true, verbatimSymlinks: true })
    run('ln', ['-s', '/Applications', path.join(stage, 'Applications')])
    run('hdiutil', ['create', '-volname', name, '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg], { stdio: 'ignore' })
    console.log(`built: ${dmg}`)
  } catch (e) { console.log(`dmg skipped: ${(e as Error).message}`) } finally { rmSync(stage, { recursive: true, force: true }) }
}
