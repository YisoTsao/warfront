import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { installErrorReporting } from './app/errorReporting';
import './app/app.css';

installErrorReporting();

const root = document.getElementById('root');
if (!root) {
  throw new Error('找不到 #root 元素');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
