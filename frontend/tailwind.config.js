/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans:    ['Figtree', 'system-ui', 'sans-serif'],
        mono:    ['IBM Plex Mono', 'Fira Code', 'monospace'],
        display: ['Figtree', 'system-ui', 'sans-serif'],
      },
      colors: {
        // Dark backgrounds
        'ci-bg':    '#080a0f',
        'ci-bg1':   '#0d1117',
        'ci-bg2':   '#111620',
        'ci-bg3':   '#161c2c',
        // Text
        'ci-text':  '#e8eaf0',
        'ci-text2': '#8892a4',
        'ci-text3': '#545f72',
        // Brand
        'ci-accent':  '#00d4ff',
        'ci-accent2': '#0099cc',
        'ci-green':   '#00e5a0',
        'ci-orange':  '#ff6b2b',
        'ci-red':     '#ff4455',
        'ci-yellow':  '#f5c542',
        'ci-purple':  '#a078ff',
      },
      borderColor: {
        DEFAULT: 'rgba(255,255,255,0.07)',
        'ci-line':  'rgba(255,255,255,0.07)',
        'ci-line2': 'rgba(255,255,255,0.12)',
      },
      backgroundImage: {
        'ci-grid': `linear-gradient(rgba(255,255,255,0.07) 1px, transparent 1px),
                    linear-gradient(90deg, rgba(255,255,255,0.07) 1px, transparent 1px)`,
      },
      backgroundSize: {
        'ci-grid': '64px 64px',
      },
      boxShadow: {
        'ci-glow':  '0 0 20px rgba(0,212,255,0.25)',
        'ci-glow2': '0 0 40px rgba(0,212,255,0.15)',
        'ci-card':  '0 4px 24px rgba(0,0,0,0.4)',
      },
      animation: {
        'fade-in':      'fade-in 0.2s ease-out',
        'status-pulse': 'status-pulse 1.5s ease-in-out infinite',
        'blink':        'blink 2s ease-in-out infinite',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        'status-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.25' },
        },
        'blink': {
          '0%, 100%': { opacity: '1' },
          '50%':      { opacity: '0.3' },
        },
      },
      borderRadius: {
        'ci': '10px',
      },
    },
  },
  plugins: [],
}
