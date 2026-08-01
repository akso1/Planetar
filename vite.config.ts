import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import { nodePolyfills } from 'vite-plugin-node-polyfills'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
) as { version?: string }

/** Vite 8 emits ESM even with format:cjs — ship a hand-written CJS preload instead. */
function copyElectronPreload(): Plugin {
  const src = path.resolve(__dirname, 'electron/preload.cjs')
  const dest = path.resolve(__dirname, 'dist-electron/preload.cjs')
  const copy = () => {
    mkdirSync(path.dirname(dest), { recursive: true })
    copyFileSync(src, dest)
  }
  return {
    name: 'copy-electron-preload-cjs',
    buildStart() {
      copy()
    },
    configureServer() {
      copy()
    },
    closeBundle() {
      copy()
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  // Relative base so Electron file:// / loadFile can resolve assets
  base: './',
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version || '0.0.0'),
    global: 'globalThis',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      // Force browser build of EventEmitter (avoids bare Node `require` in renderer)
      events: path.resolve(__dirname, 'node_modules/events/events.js'),
    },
  },
  plugins: [
    // Browser polyfills — required with nodeIntegration: false / contextIsolation
    nodePolyfills({
      include: ['buffer', 'process', 'events', 'util', 'stream', 'crypto'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
      protocolImports: true,
    }),
    tailwindcss(),
    react(),
    copyElectronPreload(),
    electron([
      {
        // Main-Process entry file of the Electron App.
        entry: 'electron/main.ts',
        vite: {
          plugins: [copyElectronPreload()],
        },
      },
      // Preload is electron/preload.cjs (copied to dist-electron) — do not Vite-bundle it.
    ]),
    // NOTE: vite-plugin-electron-renderer removed — it injected Node `require()` into
    // the renderer (events.mjs), which breaks with contextIsolation / no nodeIntegration.
  ],
  optimizeDeps: {
    include: ['matrix-js-sdk', 'events', 'buffer'],
    // Let Vite handle the WASM package itself (needed for initRustCrypto)
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
  assetsInclude: ['**/*.wasm'],
})
