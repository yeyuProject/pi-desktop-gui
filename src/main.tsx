import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { TitleBar } from './components/TitleBar';
import { AppDialogs } from './components/AppDialogs';
// The native theme override also drives prefers-color-scheme before bootstrap finishes.
document.documentElement.dataset.theme = 'system';
document.documentElement.dataset.accent = 'mono';
document.documentElement.dataset.platform = window.desktop.platform;
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <div className="desktop-shell">
      <TitleBar />
      <div className="desktop-content">
        <App />
      </div>
      <AppDialogs />
    </div>
  </React.StrictMode>,
);
