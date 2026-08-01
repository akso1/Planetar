import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
) as { version?: string }

// https://vite.dev/config/
export default defineConfig({
  // Relative base so Electron file:// / loadFile can resolve assets
  base: './',
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version || '0.0.0'),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  plugins: [
    tailwindcss(),
    react(),
    electron([
      {
        // Main-Process entry file of the Electron App.
        entry: 'electron/main.ts',
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) {
          // Notify the Renderer-Process to reload the page when the Preload-Scripts build is complete,
          // instead of restarting the entire Electron App.
          options.reload()
        },
        vite: {
          build: {
            rollupOptions: {
              output: {
                format: 'cjs',
              },
            },
          },
        },
      },
    ]),
    renderer({
      resolve: {
        events: () => ({ default: 'events' }),
        buffer: () => ({ default: 'buffer' }),
      },
    }),
  ],
  optimizeDeps: {
    include: ['matrix-js-sdk', 'events', 'buffer'],
    // Let Vite handle the WASM package itself (needed for initRustCrypto)
    exclude: ['@matrix-org/matrix-sdk-crypto-wasm'],
  },
  assetsInclude: ['**/*.wasm'],
})
