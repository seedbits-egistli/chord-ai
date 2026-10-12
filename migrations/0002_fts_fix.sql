-- Rebuild FTS without external-content mode so inserts store column values.
DROP TABLE IF EXISTS sheets_fts;

CREATE VIRTUAL TABLE sheets_fts USING fts5(
  sheet_id UNINDEXED,
  title,
  artist,
  lyrics,
  chords_text,
  tokenize='trigram'
);
