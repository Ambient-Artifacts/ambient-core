// "brain-index v1": the search index schema shared by the phone (GRDB) and the
// server (better-sqlite3). Text columns ending in _f hold foldText() output so
// "Müller" and "Mueller" match the same rows; display columns stay original.
export const INDEX_SCHEMA_VERSION = 1;

export const INDEX_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pages (
  rowid INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,          -- wiki-relative, with .md
  type TEXT NOT NULL,                 -- note | person | org | project | topic | decision | other
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL,                -- personal | team
  team_id TEXT,
  sort_date TEXT NOT NULL DEFAULT '', -- recorded_at for notes, updated otherwise
  updated TEXT NOT NULL DEFAULT '',
  frontmatter_json TEXT NOT NULL,
  body TEXT NOT NULL,
  title_f TEXT NOT NULL,
  summary_f TEXT NOT NULL,
  body_f TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title_f, summary_f, body_f,
  content='pages', content_rowid='rowid',
  tokenize="unicode61 remove_diacritics 2"
);
CREATE VIRTUAL TABLE IF NOT EXISTS pages_tri USING fts5(
  title_f, body_f,
  content='pages', content_rowid='rowid',
  tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title_f, summary_f, body_f) VALUES (new.rowid, new.title_f, new.summary_f, new.body_f);
  INSERT INTO pages_tri(rowid, title_f, body_f) VALUES (new.rowid, new.title_f, new.body_f);
END;
CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title_f, summary_f, body_f) VALUES ('delete', old.rowid, old.title_f, old.summary_f, old.body_f);
  INSERT INTO pages_tri(pages_tri, rowid, title_f, body_f) VALUES ('delete', old.rowid, old.title_f, old.body_f);
END;
CREATE TABLE IF NOT EXISTS aliases (
  alias_f TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (alias_f, path)
);
CREATE TABLE IF NOT EXISTS links (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  rel TEXT NOT NULL,
  PRIMARY KEY (src, dst, rel)
);
CREATE INDEX IF NOT EXISTS links_dst ON links(dst);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;
