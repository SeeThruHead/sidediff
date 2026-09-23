import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles.css';
import { registerThemes } from './themes';

registerThemes();

const root = document.getElementById('root');

if (root !== null)
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
