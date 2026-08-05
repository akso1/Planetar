/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        chatBg: 'var(--color-bg)',
        chatSidebar: 'var(--color-sidebar)',
        chatSurface: 'var(--color-surface)',
        chatSurfaceIn: 'var(--color-surface-in)',
        chatText: 'var(--color-text)',
        chatMuted: 'var(--color-text-muted)',
        chatAccent: 'var(--color-accent)',
        app: 'var(--color-bg)',
        surface: {
          DEFAULT: 'var(--color-sidebar)',
          elevated: 'var(--color-surface-in)',
          glass: 'var(--surface-glass)',
          inset: 'var(--surface-inset)',
        },
        accent: {
          DEFAULT: 'var(--color-accent)',
          hover: 'var(--accent-hover)',
          pressed: 'var(--accent-pressed)',
          soft: 'var(--accent-soft)',
          fg: 'var(--accent-fg)',
        },
        ink: {
          DEFAULT: 'var(--color-text)',
          muted: 'var(--color-text-muted)',
          faint: 'var(--text-faint)',
        },
        hairline: {
          DEFAULT: 'var(--hairline)',
          strong: 'var(--hairline-strong)',
        },
      },
      borderRadius: {
        bubble: 'var(--radius-bubble)',
        panel: 'var(--radius-panel)',
        control: 'var(--radius-control)',
      },
      transitionDuration: {
        ui: '150ms',
      },
      boxShadow: {
        panel: 'var(--panel-shadow)',
      },
    },
  },
  plugins: [],
}
