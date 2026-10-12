export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  IP_HASH_SALT: string;
  PUBLISH_RATE_LIMIT: string;
  PUBLISH_RATE_WINDOW_SEC: string;
  AUTO_HIDE_REPORT_THRESHOLD: string;
  SKIP_TURNSTILE?: string;
}

export interface ChordEventInput {
  tMs: number;
  endMs?: number;
  beat?: number;
  chord: string;
  lineIdx?: number | null;
  charOffset?: number | null;
  strum?: string | null;
}

export interface LyricLineInput {
  lineIdx: number;
  text: string;
  startMs?: number | null;
  endMs?: number | null;
  wordsJson?: string | null;
}

export interface PublishBody {
  title: string;
  artist?: string;
  key?: string;
  transpose?: number;
  bpm?: number;
  timeSig?: string;
  capo?: number;
  instrument?: 'guitar' | 'ukulele';
  mode?: string;
  notation?: string;
  chords: ChordEventInput[];
  lyrics?: LyricLineInput[];
  turnstileToken?: string;
}

export interface ReportBody {
  reason: 'copyright_lyrics' | 'copyright' | 'spam' | 'abuse';
  action: 'remove_lyrics' | 'remove_sheet';
  detail?: string;
  turnstileToken?: string;
}
