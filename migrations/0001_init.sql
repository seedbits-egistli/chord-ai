-- Chord AI MVP schema (anonymous publish, FTS5 search)

CREATE TABLE songs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  artist TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE sheets (
  id TEXT PRIMARY KEY,
  song_id TEXT NOT NULL REFERENCES songs(id),
  edit_token_hash TEXT NOT NULL,
  ip_hash TEXT,
  key_sig TEXT,
  default_transpose INTEGER NOT NULL DEFAULT 0,
  bpm REAL,
  time_sig TEXT DEFAULT '4/4',
  capo INTEGER DEFAULT 0,
  instrument TEXT DEFAULT 'guitar',
  mode TEXT DEFAULT 'detect',
  chords_json TEXT,
  notation TEXT,
  lyrics_removed INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'public',
  report_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_sheets_status ON sheets(status);
CREATE INDEX idx_sheets_song ON sheets(song_id);
CREATE INDEX idx_sheets_created ON sheets(created_at DESC);

CREATE TABLE lyric_lines (
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  line_idx INTEGER NOT NULL,
  text TEXT NOT NULL,
  start_ms INTEGER,
  end_ms INTEGER,
  words_json TEXT,
  PRIMARY KEY (sheet_id, line_idx)
);

CREATE TABLE chord_events (
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  t_ms INTEGER NOT NULL,
  beat INTEGER,
  chord TEXT NOT NULL,
  line_idx INTEGER,
  char_offset INTEGER,
  strum TEXT,
  PRIMARY KEY (sheet_id, seq)
);

CREATE INDEX idx_chord_events_sheet ON chord_events(sheet_id, t_ms);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  sheet_id TEXT NOT NULL REFERENCES sheets(id),
  reason TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  ip_hash TEXT,
  created_at INTEGER NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_reports_sheet ON reports(sheet_id);

CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- Chinese-friendly partial match via trigram tokenizer
CREATE VIRTUAL TABLE sheets_fts USING fts5(
  title,
  artist,
  lyrics,
  chords_text,
  content='',
  tokenize='trigram'
);
