import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
// Convergência design system: styles first so product utilities can override.
import '@xploryng/convergencia/styles.css';
import App from './App';
import { ThemeRoot } from './lib/theme';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('SAC Hub: root element #root was not found in index.html');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <ThemeRoot>
        <App />
      </ThemeRoot>
    </BrowserRouter>
  </React.StrictMode>,
);
