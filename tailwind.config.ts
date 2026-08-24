import type { Config } from 'tailwindcss'

/** Tailwind color that tracks a CSS `--name-rgb` channel token so
 *  opacity modifiers (`bg-paper/60`) and `html.dark` remaps both work. */
const rgb = (token: string) => `rgb(var(${token}) / <alpha-value>)`

const config: Config = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        skype: {
          DEFAULT: rgb('--skype-rgb'),
          deep: rgb('--skype-deep-rgb'),
          ink: rgb('--skype-ink-rgb'),
        },
        sky2: {
          50: rgb('--sky-50-rgb'),
          100: rgb('--sky-100-rgb'),
          200: rgb('--sky-200-rgb'),
          300: rgb('--sky-300-rgb'),
          glow: rgb('--sky-glow-rgb'),
        },
        coral: {
          DEFAULT: rgb('--coral-rgb'),
          soft: rgb('--coral-soft-rgb'),
          deep: rgb('--coral-deep-rgb'),
        },
        gold: {
          DEFAULT: rgb('--gold-rgb'),
          deep: rgb('--gold-deep-rgb'),
        },
        whisper: {
          DEFAULT: rgb('--whisper-rgb'),
          deep: rgb('--whisper-deep-rgb'),
          50: rgb('--whisper-50-rgb'),
          100: rgb('--whisper-100-rgb'),
          200: rgb('--whisper-200-rgb'),
        },
        ink: {
          900: rgb('--ink-900-rgb'),
          700: rgb('--ink-700-rgb'),
          500: rgb('--ink-500-rgb'),
          300: rgb('--ink-300-rgb'),
          200: rgb('--ink-200-rgb'),
          100: rgb('--ink-100-rgb'),
        },
        cloud: rgb('--cloud-rgb'),
        paper: rgb('--paper-rgb'),
        avail: rgb('--avail-rgb'),
        working: rgb('--working-rgb'),
        thinking: rgb('--thinking-rgb'),
        waiting: rgb('--waiting-rgb'),
        resting: rgb('--resting-rgb'),
      },
      fontFamily: {
        display: ['Manrope', 'system-ui', '-apple-system', 'sans-serif'],
        body: ['Manrope', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      boxShadow: {
        window: '0 50px 100px -20px rgba(10, 30, 60, 0.25), 0 30px 60px -30px rgba(10, 30, 60, 0.3), 0 0 0 1px rgba(0, 80, 140, 0.06)',
        pop: '0 12px 28px -8px rgba(0, 80, 140, 0.18), 0 0 0 1px rgba(0, 80, 140, 0.06)',
        soft: '0 2px 8px -2px rgba(10, 30, 60, 0.08)',
      },
      animation: {
        'pulse-soft': 'pulse-soft 1.5s ease-in-out infinite',
        'rise': 'rise 0.5s cubic-bezier(0.2, 0.8, 0.2, 1) backwards',
        'drift': 'drift 40s ease-in-out infinite',
        'bounce-dot': 'bounce-dot 1.2s ease-in-out infinite',
        'shine': 'shine 2s linear infinite',
        'fade-in': 'fade-in 200ms ease-out',
        'slide-in-right': 'slide-in-right 220ms cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
      keyframes: {
        'pulse-soft': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.4', transform: 'scale(0.7)' },
        },
        'rise': {
          'from': { opacity: '0', transform: 'translateY(8px)' },
          'to': { opacity: '1', transform: 'translateY(0)' },
        },
        'drift': {
          '0%, 100%': { transform: 'translate(0, 0)' },
          '50%': { transform: 'translate(60px, 30px)' },
        },
        'bounce-dot': {
          '0%, 60%, 100%': { transform: 'translateY(0)', opacity: '0.5' },
          '30%': { transform: 'translateY(-4px)', opacity: '1' },
        },
        'shine': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        'fade-in': {
          'from': { opacity: '0' },
          'to':   { opacity: '1' },
        },
        'slide-in-right': {
          'from': { transform: 'translateX(100%)' },
          'to':   { transform: 'translateX(0)' },
        },
      },
    },
  },
  plugins: [],
}

export default config
