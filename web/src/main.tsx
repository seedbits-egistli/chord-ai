import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import {
  clearModelCache,
  getModelCacheStatus,
  getSeparateWorker,
  prefetchModels,
  separateInWorker,
} from './lib/audio';
import './styles/global.css';

/** Test / debug harness (used by scripts/verify-model-cache.mjs). */
declare global {
  interface Window {
    __chordAi?: {
      prefetchModels: typeof prefetchModels;
      getModelCacheStatus: typeof getModelCacheStatus;
      clearModelCache: typeof clearModelCache;
      separateInWorker: typeof separateInWorker;
      getSeparateWorker: typeof getSeparateWorker;
    };
  }
}
window.__chordAi = {
  prefetchModels,
  getModelCacheStatus,
  clearModelCache,
  separateInWorker,
  getSeparateWorker,
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
