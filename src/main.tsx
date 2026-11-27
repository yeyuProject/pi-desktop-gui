import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { TitleBar } from './components/TitleBar';
import { AppDialogs } from './components/AppDialogs';
import { pauseGlassForResize } from './lib/glass';
// The native theme override also drives prefers-color-scheme before bootstrap finishes.
document.documentElement.dataset.theme = 'system';
document.documentElement.dataset.style = 'classic';
document.documentElement.dataset.platform = window.desktop.platform;
window.addEventListener('resize', pauseGlassForResize);
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="desktop-shell">
      <div className="app-backdrop" hidden aria-hidden="true" />
      <TitleBar />
      <div className="desktop-content">
        <App />
      </div>
      <AppDialogs />
    </div>
  </React.StrictMode>,
);
