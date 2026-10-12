/**
 * Minimal Standard MIDI File (Type 0) exporter for chord timelines.
 * No external dependency — pure bytes.
 */

import type { ChordEvent } from '@chord-ai/engine';
import { resolveChordMidi, type PlayInstrument } from './chordVoicing';

const PPQ = 480;

function writeVarLen(n: number): number[] {
  const bytes: number[] = [];
  let value = n >>> 0;
  bytes.unshift(value & 0x7f);
  value >>= 7;
  while (value > 0) {
    bytes.unshift((value & 0x7f) | 0x80);
    value >>= 7;
  }
  return bytes;
}

function u16(n: number): number[] {
  return [(n >> 8) & 0xff, n & 0xff];
}

function u32(n: number): number[] {
  return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function strBytes(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

interface MidiNoteEvent {
  tick: number;
  type: 'on' | 'off';
  note: number;
  vel: number;
}

/**
 * Build a Type-0 .mid ArrayBuffer for the chord timeline.
 * Uses piano/guitar/uke voicings; block chords (no strum microtiming in MIDI).
 */
export function buildMidiFile(
  chords: ChordEvent[],
  options: { bpm: number; instrument: PlayInstrument; title?: string },
): ArrayBuffer {
  const bpm = options.bpm > 0 ? options.bpm : 120;
  const usPerBeat = Math.round(60_000_000 / bpm);
  // ticks per ms: PPQ beats/min → ticks/ms = PPQ * bpm / 60000
  const ticksPerMs = (PPQ * bpm) / 60_000;

  const events: MidiNoteEvent[] = [];
  const t0 = chords[0]?.tMs ?? 0;

  for (let i = 0; i < chords.length; i++) {
    const c = chords[i]!;
    const startTick = Math.max(0, Math.round((c.tMs - t0) * ticksPerMs));
    const endMs = chords[i + 1]?.tMs ?? c.endMs;
    const endTick = Math.max(
      startTick + Math.round(0.2 * ticksPerMs * 1000),
      Math.round((endMs - t0) * ticksPerMs) - 1,
    );
    const notes = resolveChordMidi(c.chord, options.instrument);
    for (const n of notes) {
      const note = Math.min(127, Math.max(0, Math.round(n)));
      events.push({ tick: startTick, type: 'on', note, vel: 90 });
      events.push({ tick: endTick, type: 'off', note, vel: 0 });
    }
  }

  events.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));

  const track: number[] = [];
  // Track name
  const name = options.title || 'Chord AI';
  track.push(...writeVarLen(0), 0xff, 0x03, name.length, ...strBytes(name));
  // Tempo
  track.push(
    ...writeVarLen(0),
    0xff,
    0x51,
    0x03,
    (usPerBeat >> 16) & 0xff,
    (usPerBeat >> 8) & 0xff,
    usPerBeat & 0xff,
  );
  // Program change: acoustic grand (0) or nylon guitar (24) / uke≈steel? use 24/25
  const program =
    options.instrument === 'piano' ? 0 : options.instrument === 'guitar' ? 24 : 28;
  track.push(...writeVarLen(0), 0xc0, program);

  let lastTick = 0;
  for (const ev of events) {
    const delta = ev.tick - lastTick;
    lastTick = ev.tick;
    if (ev.type === 'on') {
      track.push(...writeVarLen(delta), 0x90, ev.note, ev.vel);
    } else {
      track.push(...writeVarLen(delta), 0x80, ev.note, 0x40);
    }
  }
  // End of track
  track.push(...writeVarLen(0), 0xff, 0x2f, 0x00);

  const header = [
    ...strBytes('MThd'),
    ...u32(6),
    ...u16(0), // type 0
    ...u16(1), // one track
    ...u16(PPQ),
  ];
  const trackChunk = [...strBytes('MTrk'), ...u32(track.length), ...track];
  const bytes = new Uint8Array([...header, ...trackChunk]);
  return bytes.buffer;
}

export function downloadMidi(
  chords: ChordEvent[],
  options: { bpm: number; instrument: PlayInstrument; title?: string; filename?: string },
): void {
  const buf = buildMidiFile(chords, options);
  const blob = new Blob([new Uint8Array(buf)], { type: 'audio/midi' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = options.filename || `${(options.title || 'chords').replace(/\s+/g, '_')}.mid`;
  a.click();
  URL.revokeObjectURL(url);
}
