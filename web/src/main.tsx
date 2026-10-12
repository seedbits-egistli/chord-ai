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
import { playProgression, playSingleChord } from './lib/progressionPlayer';
import { buildMidiFile } from './lib/midiExport';
import { resolveChordMidi } from './lib/chordVoicing';
import { getChordSynth } from './lib/chordSynth';
import './styles/global.css';

/** Test / debug harness (used by scripts/verify-*.mjs). */
declare global {
  interface Window {
    __chordAi?: {
      prefetchModels: typeof prefetchModels;
      getModelCacheStatus: typeof getModelCacheStatus;
      clearModelCache: typeof clearModelCache;
      separateInWorker: typeof separateInWorker;
      getSeparateWorker: typeof getSeparateWorker;
      playSingleChord: typeof playSingleChord;
      playProgression: typeof playProgression;
      buildMidiFile: typeof buildMidiFile;
      resolveChordMidi: typeof resolveChordMidi;
      getChordSynth: typeof getChordSynth;
    };
  }
}
window.__chordAi = {
  prefetchModels,
  getModelCacheStatus,
  clearModelCache,
  separateInWorker,
  getSeparateWorker,
  playSingleChord,
  playProgression,
  buildMidiFile,
  resolveChordMidi,
  getChordSynth,
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
