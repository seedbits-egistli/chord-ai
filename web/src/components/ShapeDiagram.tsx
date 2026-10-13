import type { GuitarVoicing } from '@chord-ai/engine';

/** Minimal SVG guitar chord box (own implementation, no external chord data). */
export function ShapeDiagram({ voicing, sounding }: { voicing: GuitarVoicing; sounding?: string }) {
  const W = 92;
  const H = 112;
  const left = 14;
  const top = 26;
  const sGap = 13;
  const fGap = 16;
  const nFrets = 4;
  const fretted = voicing.frets.filter((f) => f > 0);
  const minF = fretted.length ? Math.min(...fretted) : 1;
  const maxF = fretted.length ? Math.max(...fretted) : 1;
  const base = maxF <= 4 ? 1 : minF;
  const x = (s: number) => left + s * sGap;
  const y = (f: number) => top + (f - base + 0.5) * fGap;
  return (
    <figure className="shape-card">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${voicing.name} 和弦圖`}>
        {base === 1 ? (
          <rect x={left - 1} y={top - 3} width={5 * sGap + 2} height={3} fill="currentColor" />
        ) : (
          <text x={left + 5 * sGap + 4} y={top + fGap * 0.7} fontSize="9" fill="currentColor">
            {base}fr
          </text>
        )}
        {Array.from({ length: nFrets + 1 }, (_, i) => (
          <line key={`f${i}`} x1={left} x2={left + 5 * sGap} y1={top + i * fGap} y2={top + i * fGap} stroke="currentColor" strokeWidth="1" opacity="0.6" />
        ))}
        {Array.from({ length: 6 }, (_, s) => (
          <line key={`s${s}`} x1={x(s)} x2={x(s)} y1={top} y2={top + nFrets * fGap} stroke="currentColor" strokeWidth="1" opacity="0.8" />
        ))}
        {voicing.barreFret && voicing.barreFret >= base && (
          <rect
            x={x(voicing.frets.findIndex((f) => f === voicing.barreFret)) - 5}
            y={y(voicing.barreFret) - 5}
            width={x(5) - x(voicing.frets.findIndex((f) => f === voicing.barreFret)) + 10}
            height={10}
            rx={5}
            fill="currentColor"
          />
        )}
        {voicing.frets.map((f, s) =>
          f < 0 ? (
            <text key={s} x={x(s)} y={top - 8} fontSize="10" textAnchor="middle" fill="currentColor">×</text>
          ) : f === 0 ? (
            <circle key={s} cx={x(s)} cy={top - 11} r={3.5} fill="none" stroke="currentColor" />
          ) : (
            <circle key={s} cx={x(s)} cy={y(f)} r={5} fill="currentColor" />
          ),
        )}
      </svg>
      <figcaption>
        <strong>{voicing.name}</strong>
        {sounding && sounding !== voicing.name && <span className="t">（實際 {sounding}）</span>}
      </figcaption>
    </figure>
  );
}
