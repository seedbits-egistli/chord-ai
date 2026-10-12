import type { ChordEvent } from '@chord-ai/engine';
import { resolveChordMidi, type PlayInstrument } from './chordVoicing';
import { getChordSynth, type StrumMode } from './chordSynth';

export interface ProgressionPlayOptions {
  instrument: PlayInstrument;
  strum: StrumMode;
  volume: number;
  /** Speed multiplier (1 = original timeline timing). */
  rate?: number;
  onIndex?: (index: number | null) => void;
  onDone?: () => void;
}

export interface ProgressionHandle {
  stop: () => void;
  readonly playing: boolean;
}

/**
 * Play the full chord timeline in time. Audio is scheduled on AudioContext;
 * UI highlight uses wall-clock timeouts aligned to the same start.
 */
export async function playProgression(
  chords: ChordEvent[],
  options: ProgressionPlayOptions,
): Promise<ProgressionHandle> {
  const synth = getChordSynth();
  const ctx = await synth.ensureContext();
  synth.stopAll();

  if (!chords.length) {
    options.onDone?.();
    return { stop: () => undefined, playing: false };
  }

  const rate = options.rate && options.rate > 0 ? options.rate : 1;
  const t0Ms = chords[0]!.tMs;
  const audioStart = ctx.currentTime + 0.06;
  const wallStart = performance.now();
  const timeouts: number[] = [];
  let stopped = false;
  let playing = true;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    playing = false;
    for (const id of timeouts) window.clearTimeout(id);
    synth.stopAll();
    options.onIndex?.(null);
  };

  for (let i = 0; i < chords.length; i++) {
    const c = chords[i]!;
    const offsetSec = ((c.tMs - t0Ms) / 1000) / rate;
    const nextT = chords[i + 1]?.tMs ?? c.endMs;
    const durSec = Math.max(0.25, ((nextT - c.tMs) / 1000) / rate);
    const midi = resolveChordMidi(c.chord, options.instrument);
    const when = audioStart + offsetSec;

    void synth.playChord(midi, {
      instrument: options.instrument,
      strum: options.strum,
      volume: options.volume,
      durationSec: Math.min(durSec * 0.95, durSec),
      when,
    });

    const highlightDelay = Math.max(0, offsetSec * 1000 - (performance.now() - wallStart));
    timeouts.push(
      window.setTimeout(() => {
        if (!stopped) options.onIndex?.(i);
      }, highlightDelay),
    );
  }

  const totalSec =
    ((chords[chords.length - 1]!.endMs - t0Ms) / 1000) / rate + 0.15;
  timeouts.push(
    window.setTimeout(() => {
      if (stopped) return;
      playing = false;
      options.onIndex?.(null);
      options.onDone?.();
    }, totalSec * 1000),
  );

  return {
    stop,
    get playing() {
      return playing && !stopped;
    },
  };
}

/** Play a single chord (user gesture → resumes AudioContext). */
export async function playSingleChord(
  chord: string,
  options: {
    instrument: PlayInstrument;
    strum: StrumMode;
    volume: number;
    durationSec?: number;
  },
): Promise<void> {
  const synth = getChordSynth();
  await synth.ensureContext();
  const midi = resolveChordMidi(chord, options.instrument);
  await synth.playChord(midi, {
    instrument: options.instrument,
    strum: options.strum,
    volume: options.volume,
    durationSec: options.durationSec ?? 1.4,
  });
}
