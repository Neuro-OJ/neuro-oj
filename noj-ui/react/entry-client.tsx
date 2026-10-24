/** @jsxImportSource react */
/** @jsxRuntime automatic */
import { createRoot, hydrateRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App.tsx';
import type { Bootstrap } from './types.ts';

export function mountReact(container: HTMLElement, bootstrap: Bootstrap) {
  const app = (
    <BrowserRouter basename='/react'>
      <App bootstrap={bootstrap} />
    </BrowserRouter>
  );
  const hydrate = container.hasChildNodes();
  const root = hydrate
    ? hydrateRoot(container, app, { identifierPrefix: 'noj-react-' })
    : createRoot(container, { identifierPrefix: 'noj-react-' });
  if (!hydrate) root.render(app);
  return () => root.unmount();
}
