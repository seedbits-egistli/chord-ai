/** Pitch class 0=C … 11=B */
export type PitchClass = number;

export type ChordQuality =
  | 'maj'
  | 'min'
  | '7'
  | 'maj7'
  | 'min7'
  | 'dim'
  | 'dim7'
  | 'm7b5'
  | 'aug'
  | 'sus2'
  | 'sus4'
  | '6'
  | 'min6'
  | '9'
  | 'maj9'
  | 'min9'
  | 'add9'
  | '11'
  | '13'
  | '7sus4';

export interface ChordLabel {
  root: PitchClass;
  quality: ChordQuality;
  bass?: PitchClass;
}

export interface ChordEvent {
  tMs: number;
  endMs: number;
  chord: string;
  beat?: number;
  confidence?: number;
  lineIdx?: number;
  charOffset?: number;
  strum?: string;
}

export interface DetectionResult {
  chords: ChordEvent[];
  key: string;
  bpm: number;
  timeSig: string;
  beats: number[];
  simplifyLevel: number;
  /** Precise-mode: estimated downbeat phase (beats[i] is downbeat when i%4===phase). */
  downbeatPhase?: number;
  /** Precise-mode: per-beat metric position 0..3 (0 = downbeat). */
  beatInBar?: number[];
}

export interface DetectOptions {
  /** 0 = richest labels, 1 = force maj/min */
  simplifyLevel?: number;
  sampleRate?: number;
  hopSize?: number;
  frameSize?: number;
  /** Optional tempo prior */
  bpmHint?: number;
  /** Subtract running-mean chroma to reduce guitar-drone bias */
  suppressDrone?: boolean;
  /**
   * Optional mono bass stem (same length/rate as `samples`) used for
   * bass-chroma / root emphasis after source separation.
   */
  bassSamples?: Float32Array;
}

export interface ReferenceSegment {
  chord: string;
  startBeat: number;
  endBeat: number;
}

export interface SongFixture {
  id: string;
  title: string;
  artist: string;
  key: string;
  bpm: number;
  timeSig: string;
  source: string;
  segments: ReferenceSegment[];
}
