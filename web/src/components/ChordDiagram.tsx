import { useEffect, useRef } from 'react';
import { SVGuitarChord } from 'svguitar';
import { lookupFingering } from '../lib/fingerings';

export function ChordDiagram({
  chord,
  instrument = 'guitar',
}: {
  chord: string;
  instrument?: 'guitar' | 'ukulele';
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = '';
    const shape = lookupFingering(chord, instrument);
    if (!shape) {
      el.textContent = '無按法';
      return;
    }
    const chart = new SVGuitarChord(el);
    const fingers: Array<[number, number | 'x' | 0, string?]> = [];
    for (let i = 0; i < shape.frets.length; i++) {
      const fret = shape.frets[i]!;
      const stringNum = shape.strings - i;
      if (fret === -1) fingers.push([stringNum, 'x']);
      else if (fret === 0) fingers.push([stringNum, 0]);
      else fingers.push([stringNum, fret, String(shape.fingers[i] || '')]);
    }
    chart
      .configure({
        strings: shape.strings,
        frets: 5,
        position: shape.baseFret,
        tuning: [],
      })
      .chord({
        fingers,
        barres: shape.barres.map((b) => ({
          fromString: b.fromString,
          toString: b.toString,
          fret: b.fret,
        })),
      })
      .draw();
  }, [chord, instrument]);

  return (
    <div className="fingering-card">
      <div className="name">{chord}</div>
      <div ref={ref} />
    </div>
  );
}
