import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initTheme } from '@/shared/lib/theme'
import { installRendererErrorReporting } from '@/shared/lib/errorLog'

// Crash-proof renderer: wire window/promise/main-IPC → Settings → Errors BEFORE React
installRendererErrorReporting()
initTheme()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
