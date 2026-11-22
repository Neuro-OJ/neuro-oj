export default defineAppConfig({
  ui: {
    card: {
      slots: {
        root: 'bg-white dark:bg-bg-panel ring-1 ring-border shadow-card rounded-lg overflow-hidden',
        header: 'p-4 sm:px-6 border-b border-border bg-white dark:bg-bg-panel',
        body: 'p-4 sm:p-6',
        footer: 'p-4 sm:px-6 border-t border-border bg-bg-sunken/40 dark:bg-bg-dark/40',
      },
      variants: {
        variant: {
          outline: {
            root: 'bg-white dark:bg-bg-panel ring-1 ring-border shadow-card divide-y divide-border',
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
  },
});
