// 精致现代：Nuxt UI 组件默认收紧到工具型密度，圆角与阴影跟随 main.css 的 token。
// 页面里显式传入的 size / class 仍然优先，这里只改默认值。
export default defineAppConfig({
  ui: {
    button: {
      defaultVariants: { size: 'sm' },
      slots: { base: 'font-medium' },
    },
    input: { defaultVariants: { size: 'sm' } },
    inputNumber: { defaultVariants: { size: 'sm' } },
    select: { defaultVariants: { size: 'sm' } },
    selectMenu: { defaultVariants: { size: 'sm' } },
    textarea: { defaultVariants: { size: 'sm' } },
    checkbox: { defaultVariants: { size: 'sm' } },
    switch: { defaultVariants: { size: 'sm' } },
    badge: {
      defaultVariants: { size: 'sm' },
      slots: { base: 'font-medium rounded-[4px]' },
    },
    tabs: { defaultVariants: { size: 'sm' } },
    table: {
      slots: {
        root: 'relative overflow-auto',
        base: 'min-w-full',
        thead: 'bg-bg-sunken/60',
        th: 'px-3 py-2 text-left text-xs font-medium text-text-muted whitespace-nowrap',
        td: 'px-3 py-2 text-[13px] text-text whitespace-nowrap',
        tr: 'data-[selected=true]:bg-primary-bg',
        separator: 'bg-border',
        empty: 'py-8 text-center text-sm text-text-muted',
      },
    },
    card: {
      slots: {
        root: 'bg-bg-panel dark:bg-bg-panel ring-1 ring-border shadow-card rounded-lg overflow-hidden',
        header: 'px-4 py-2.5 border-b border-border bg-bg-panel dark:bg-bg-panel',
        body: 'p-4',
        footer: 'px-4 py-2.5 border-t border-border bg-bg-sunken/50 dark:bg-bg-dark/40',
      },
      variants: {
        variant: {
          outline: {
            root: 'bg-bg-panel dark:bg-bg-panel ring-1 ring-border shadow-none divide-y divide-border',
          },
          subtle: {
            root: 'bg-bg-sunken/60 ring-1 ring-border divide-y divide-border',
          },
          soft: {
            root: 'bg-bg-sunken/60 divide-y divide-border',
          },
        },
      },
    },
    modal: {
      slots: { content: 'rounded-xl shadow-modal ring-0' },
    },
    dropdownMenu: {
      slots: { content: 'rounded-lg shadow-dropdown ring-0', item: 'text-[13px]' },
    },
  },
});
