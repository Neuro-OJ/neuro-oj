import typography from '@tailwindcss/typography';
import type { Config } from 'tailwindcss';

export default <Config> {
  content: [
    './app.vue',
    './pages/**/*.vue',
    './layouts/**/*.vue',
    './components/**/*.vue',
  ],

  theme: {
    extend: {
      // 映射 layouts/default.vue 中定义的 --c-* CSS 变量，保留主题化能力
      colors: {
        primary: {
          DEFAULT: 'var(--c-primary)',
          dark: 'var(--c-primary-dark)',
          light: 'var(--c-primary-light)',
          bg: 'var(--c-primary-bg)',
          hover: 'var(--c-primary-hover-bg)',
          active: 'var(--c-primary-active-bg)',
          text: 'var(--c-primary-text)',
        },
        text: {
          DEFAULT: 'var(--c-text)',
          secondary: 'var(--c-text-secondary)',
          muted: 'var(--c-text-muted)',
        },
        border: 'var(--c-border)',
        white: 'var(--c-white)',
        'bg-page': 'var(--c-bg-page)',
        'bg-dark': 'var(--c-bg-dark)',
        'bg-dark-2': 'var(--c-bg-dark-2)',
        'bg-dark-3': 'var(--c-bg-dark-3)',
      },

      // 现有 @keyframes spin 速度 0.8s，与自定义 spin 一致
      animation: {
        'spin-slow': 'spin 0.8s linear infinite',
      },

      borderRadius: {
        sm: '4px',
        DEFAULT: '6px',
        md: '8px',
        lg: '12px',
        xl: '16px',
      },

      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)',
        dropdown: '0 4px 12px rgba(0,0,0,0.1)',
        modal: '0 20px 60px rgba(0,0,0,0.15)',
      },

      transitionDuration: {
        fast: '150ms',
        DEFAULT: '200ms',
        slow: '300ms',
      },

      // 代码字体
      fontFamily: {
        mono: ['"SF Mono"', '"Fira Code"', '"Consolas"', 'monospace'],
      },

      // 排版插件自定义主题
      typography: ({ theme }: { theme: (path: string) => string }) => ({
        neuro: {
          css: {
            // 行内代码
            'code::before': { content: '""' },
            'code::after': { content: '""' },
            'code:not(pre code)': {
              background: '#f1f5f9',
              padding: '2px 6px',
              borderRadius: '4px',
              fontFamily: '"SF Mono", "Fira Code", monospace',
              fontSize: '0.88em',
              color: '#be123c',
            },

            // 加粗（用于「输入」「输出」标签）
            strong: {
              fontWeight: '600',
              color: '#0f172a',
            },

            // 代码块（输入/输出示例）— 增强区分度
            pre: {
              background: '#0d1117',
              borderRadius: '8px',
              padding: '12px 14px',
              overflowX: 'auto',
              margin: '0.4em 0 0.8em 0',
              borderLeft: '3px solid #22c55e',
            },
            'pre code': {
              fontFamily: '"SF Mono", "Fira Code", "Consolas", monospace',
              fontSize: '13px',
              lineHeight: '1.5',
              padding: '0',
              background: 'transparent',
              color: '#e6edf3',
            },

            // Blockquote
            blockquote: {
              borderLeft: `3px solid ${theme('colors.primary.DEFAULT')}`,
              padding: '0.5em 1em',
              margin: '0.8em 0',
              background: 'var(--c-primary-bg)',
              color: 'var(--c-text-secondary)',
              borderRadius: '0 6px 6px 0',
              fontWeight: '400',
            },
            'blockquote p:first-of-type': {
              marginTop: '0',
            },
            'blockquote p:last-of-type': {
              marginBottom: '0',
            },

            // 表格
            table: {
              borderCollapse: 'collapse',
              margin: '0.8em 0',
              width: '100%',
              fontSize: '14px',
            },
            'thead th': {
              background: '#f8fafc',
              fontWeight: '600',
              padding: '8px 12px',
              border: `1px solid var(--c-border)`,
              textAlign: 'left',
            },
            'tbody td': {
              padding: '8px 12px',
              border: `1px solid var(--c-border)`,
            },

            // 链接
            a: {
              color: 'var(--c-primary)',
              textDecoration: 'none',
            },
            'a:hover': {
              textDecoration: 'underline',
            },

            // 列表
            'ul > li::marker': {
              color: 'var(--c-text-muted)',
            },
            'ol > li::marker': {
              color: 'var(--c-text-muted)',
            },

            // 标题
            h1: { fontWeight: '700' },
            h2: { fontWeight: '700' },
            h3: { fontWeight: '600' },
            h4: { fontWeight: '600' },
          },
        },
      }),
    },
  },

  plugins: [
    typography,
  ],
};
