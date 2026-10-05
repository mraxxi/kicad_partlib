import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ImportLcsc } from './ImportLcsc';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ImportLcsc />
  </StrictMode>,
);
