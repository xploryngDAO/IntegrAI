/**
 * Tailwind is used for LAYOUT utilities only.
 *
 * The visual language comes from the Convergência design system
 * (`@xploryng/convergencia`): colors, type, radii, shadows and component styles
 * are the DS semantic tokens exposed as CSS variables inside `.cv-root`.
 * Mapping them here keeps utility classes (bg-panel, text-primary…) aligned with
 * the DS instead of duplicating hex values in the product.
 */
/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: 'var(--cv-color-background)',
        panel: 'var(--cv-color-surface)',
        elevated: 'var(--cv-color-surface-subtle)',
        raised: 'var(--cv-color-surface-raised)',
        subtle: 'var(--cv-color-border)',
        strong: 'var(--cv-color-border-strong)',
        primary: 'var(--cv-color-text)',
        secondary: 'var(--cv-color-text-muted)',
        muted: 'var(--cv-color-text-muted)',
        brand: 'var(--cv-color-accent)',
        accent: 'var(--cv-color-accent)',
        'accent-soft': 'var(--cv-color-accent-soft)',
        'accent-text': 'var(--cv-color-accent-text)',
        ok: 'var(--cv-color-success)',
        warn: 'var(--cv-color-warning)',
        danger: 'var(--cv-color-danger)',
        rose: 'var(--cv-color-rose)',
      },
      fontFamily: {
        sans: ['var(--cv-font-family)'],
        mono: ['var(--cv-font-mono)'],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '14px' }],
        micro: ['var(--cv-font-micro)', { lineHeight: '14px' }],
        meta: ['var(--cv-font-meta)', { lineHeight: '18px' }],
        control: ['var(--cv-font-control)', { lineHeight: '18px' }],
        body: ['var(--cv-font-body)', { lineHeight: 'var(--cv-font-line-body)' }],
        lead: ['var(--cv-font-lead)', { lineHeight: '24px' }],
        section: ['var(--cv-font-section)', { lineHeight: 'var(--cv-font-line-heading)' }],
        page: ['var(--cv-font-page)', { lineHeight: 'var(--cv-font-line-heading)' }],
      },
      borderRadius: {
        small: 'var(--cv-radius-small)',
        tab: 'var(--cv-radius-tab)',
        control: 'var(--cv-radius-control)',
        field: 'var(--cv-radius-field)',
        panel: 'var(--cv-radius-panel)',
        hero: 'var(--cv-radius-hero)',
        pill: 'var(--cv-radius-pill)',
      },
      boxShadow: {
        card: 'var(--cv-shadow-card)',
        floating: 'var(--cv-shadow-floating)',
      },
      spacing: {
        topbar: '64px',
        rail: 'var(--cv-layout-rail-compact)',
        inspector: 'var(--cv-layout-inspector)',
        queue: '320px',
      },
      transitionDuration: {
        fast: 'var(--cv-motion-fast)',
        normal: 'var(--cv-motion-normal)',
      },
      keyframes: {
        'sla-pulse': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'translateY(4px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'sla-pulse': 'sla-pulse 1.8s ease-in-out infinite',
        'fade-in': 'fade-in var(--cv-motion-normal) var(--cv-motion-ease)',
      },
    },
  },
  plugins: [],
};
