ALTER TABLE links ADD COLUMN series_id TEXT;
ALTER TABLE links ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE links ADD COLUMN task_due_rule TEXT;
CREATE INDEX links_series ON links(mapping,series_id);
CREATE TABLE series (
 mapping TEXT NOT NULL, event_id TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'ready', lower_bound TEXT,
 conversion_task_id TEXT, conversion_original TEXT, conversion_event TEXT,
 updated_at INTEGER NOT NULL, PRIMARY KEY(mapping,event_id)
);
CREATE TABLE operations (
 mapping TEXT NOT NULL, event_id TEXT NOT NULL, kind TEXT NOT NULL,
 target_mapping TEXT, request_id TEXT NOT NULL, state TEXT NOT NULL,
 updated_at INTEGER NOT NULL, PRIMARY KEY(mapping,event_id)
);
CREATE TABLE notifications (
 id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL,
 attempted_at INTEGER NOT NULL, sent_at INTEGER, message_id TEXT
);
ALTER TABLE links ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE operations ADD COLUMN payload TEXT;
CREATE TABLE rolling_advances (
 mapping TEXT NOT NULL, task_id TEXT NOT NULL, completion_key TEXT NOT NULL,
 from_event_id TEXT NOT NULL, to_event_id TEXT NOT NULL, payload TEXT NOT NULL,
 state TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(mapping,task_id,completion_key)
);
