import { useEffect, useRef } from 'react';
import abcjs from 'abcjs';
import type { ChordEvent } from '@chord-ai/engine';
import { parseChord } from '@chord-ai/engine';

/** Basic ABC lead sheet from chord timeline (MVP; Basic Pitch optional later). */
export function StaffView({
  chords,
  keySig,
  bpm,
}: {
  chords: ChordEvent[];
  keySig: string;
  bpm: number;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const abc = chordsToAbc(chords, keySig, bpm);
    ref.current.innerHTML = '';
    abcjs.renderAbc(ref.current, abc, {
      responsive: 'resize',
      staffwidth: Math.min(720, window.innerWidth - 64),
    });
  }, [chords, keySig, bpm]);

  return (
    <div className="staff" ref={ref} aria-label="五線譜預覽" />
  );
}

function chordsToAbc(chords: ChordEvent[], keySig: string, bpm: number): string {
  const key = keySig.replace('m', 'm');
  const lines = [
    'X:1',
    'T:Chord AI',
    `M:4/4`,
    `Q:1/4=${Math.round(bpm)}`,
    `K:${key || 'C'}`,
  ];
  let body = '';
  for (const c of chords.slice(0, 32)) {
    const p = parseChord(c.chord);
    const note = p ? rootToAbc(p.root, keySig.includes('m') ? false : preferFlat(keySig)) : 'z';
    body += `"${c.chord}"${note}4 `;
  }
  lines.push(body.trim() || 'z4');
  return lines.join('\n');
}

function preferFlat(key: string) {
  return ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Dm', 'Gm', 'Cm', 'Fm'].includes(key);
}

function rootToAbc(pc: number, flats: boolean): string {
  const sharp = ['C', '^C', 'D', '^D', 'E', 'F', '^F', 'G', '^G', 'A', '^A', 'B'];
  const flat = ['C', '_D', 'D', '_E', 'E', 'F', '_G', 'G', '_A', 'A', '_B', 'B'];
  return (flats ? flat : sharp)[pc] || 'C';
}
