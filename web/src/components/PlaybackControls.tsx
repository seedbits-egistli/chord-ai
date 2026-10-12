import type { ChordEvent } from '@chord-ai/engine';
import type { PlayInstrument } from '../lib/chordVoicing';
import type { StrumMode } from '../lib/chordSynth';

export interface PlaybackControlsProps {
  playInstrument: PlayInstrument;
  onPlayInstrument: (v: PlayInstrument) => void;
  strum: StrumMode;
  onStrum: (v: StrumMode) => void;
  volume: number;
  onVolume: (v: number) => void;
  playing: boolean;
  onPlayProgression: () => void;
  onStop: () => void;
  onExportMidi: () => void;
  disabled?: boolean;
  /** Hide guitar/uke-only strum hint when piano */
  showStrum?: boolean;
}

export function PlaybackControls({
  playInstrument,
  onPlayInstrument,
  strum,
  onStrum,
  volume,
  onVolume,
  playing,
  onPlayProgression,
  onStop,
  onExportMidi,
  disabled,
  showStrum = true,
}: PlaybackControlsProps) {
  return (
    <div className="controls playback-controls" data-testid="playback-controls">
      <label>
        播放樂器
        <select
          value={playInstrument}
          disabled={disabled || playing}
          onChange={(e) => onPlayInstrument(e.target.value as PlayInstrument)}
        >
          <option value="piano">鋼琴</option>
          <option value="guitar">吉他（按法聲部）</option>
          <option value="ukulele">烏克麗麗（按法聲部）</option>
        </select>
      </label>
      {showStrum && playInstrument !== 'piano' && (
        <label>
          彈法
          <select
            value={strum}
            disabled={disabled || playing}
            onChange={(e) => onStrum(e.target.value as StrumMode)}
          >
            <option value="strum">掃弦（琶音）</option>
            <option value="block">同時發聲</option>
          </select>
        </label>
      )}
      {playInstrument === 'piano' && (
        <label>
          彈法
          <select value="block" disabled>
            <option value="block">和弦塊（鋼琴）</option>
          </select>
        </label>
      )}
      <label>
        音量
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          disabled={disabled}
          onChange={(e) => onVolume(Number(e.target.value))}
          aria-label="播放音量"
        />
      </label>
      {!playing ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={disabled}
          data-testid="play-progression"
          onClick={onPlayProgression}
        >
          播放進行
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-secondary"
          data-testid="stop-progression"
          onClick={onStop}
        >
          停止
        </button>
      )}
      <button
        type="button"
        className="btn btn-secondary"
        disabled={disabled || playing}
        data-testid="export-midi"
        onClick={onExportMidi}
      >
        匯出 MIDI
      </button>
    </div>
  );
}

/** Shared hook-like helpers kept as plain functions for pages. */
export function chordsHaveDuration(chords: ChordEvent[]): boolean {
  return chords.length > 0 && chords.some((c) => c.endMs > c.tMs);
}
