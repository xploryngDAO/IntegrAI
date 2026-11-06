import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
// Convergência design system: styles first so product utilities can override.
import '@xploryng/convergencia/styles.css';
import App from './App';
import { applyRuntimeApiBase } from './lib/api';
import { loadRuntimeConfig } from './lib/runtimeConfig';
import { ThemeRoot } from './lib/theme';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('SAC Hub: root element #root was not found in index.html');
}
// Narrowed once at module level: the async bootstrap below is a closure, so TS
// does not carry the null check into it.
const container: HTMLElement = rootElement;

/**
 * Boots the SPA.
 *
 * The API host is resolved at runtime (Cloudflare tunnel, see
 * `lib/runtimeConfig.ts`) before the first render: doing it here means no
 * request of the boot sequence can race the configuration. The fetch is capped
 * at 2 s and never rejects, so a slow/unreachable config source only adds the
 * timeout to the initial paint — never a failed boot.
 */
async function bootstrap(): Promise<void> {
  await loadRuntimeConfig();
  applyRuntimeApiBase();

  // GitHub Pages serves the SPA under `/IntegrAI/`; Vite exposes that as
  // BASE_URL, so the router must strip it before matching routes.
  const basename = import.meta.env.BASE_URL.replace(/\/+$/, '') || '/';

  ReactDOM.createRoot(container).render(
    <React.StrictMode>
      <BrowserRouter basename={basename}>
        <ThemeRoot>
          <App />
        </ThemeRoot>
      </BrowserRouter>
    </React.StrictMode>,
  );
}

void bootstrap();
