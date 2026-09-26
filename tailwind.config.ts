import type { Config } from 'tailwindcss';

/**
 * Trench Trials design tokens. Deep black canvas, cream type, burgundy used deliberately.
 * Green is not a brand color: `gain` exists only for literal positive returns and
 * verified success; `loss` only for negative returns.
 */
const config: Config = {
  content: ['./src/app/**/*.{ts,tsx}', './src/components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: '#050505',
        raised: '#0B0B0D',
        'raised-2': '#111114',
        line: '#28252A',

        cream: '#F3EFE7',
        secondary: '#AAA6A0',
        // Mandated muted tone — decoration only (underlines, separators). It is 4.0–4.3:1 on the
        // dark surfaces, below WCAG AA for small text, so readable small text uses `subtle`.
        muted: '#77736E',
        // Same hue, lifted to ≥ 5.4:1 on every dark surface (#050505, #0B0B0D, #111114, #28000E).
        subtle: '#8E8A84',

        burgundy: '#64001F',
        'burgundy-strong': '#7E0B32',
        'burgundy-hover': '#941642',
        'burgundy-surface': '#28000E',

        gain: '#6DBB8F',
        loss: '#E0726E',
      },
      fontFamily: {
        sans: ['"Manrope Variable"', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        panel: '28px',
        card: '20px',
        control: '14px',
      },
      maxWidth: {
        page: '1200px',
      },
      transitionTimingFunction: {
        reveal: 'cubic-bezier(0.2, 0.8, 0.2, 1)',
      },
      keyframes: {
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'grow-x': {
          from: { transform: 'scaleX(0)' },
          to: { transform: 'scaleX(1)' },
        },
        'reveal-mask': {
          from: { clipPath: 'inset(0 0 100% 0)' },
          to: { clipPath: 'inset(0 0 0 0)' },
        },
      },
      animation: {
        'rise-in': 'rise-in 280ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'grow-x': 'grow-x 300ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
        'reveal-mask': 'reveal-mask 260ms cubic-bezier(0.2, 0.8, 0.2, 1) both',
      },
    },
  },
  plugins: [],
};

export default config;
