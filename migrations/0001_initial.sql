CREATE TABLE links (
 mapping TEXT NOT NULL, event_id TEXT NOT NULL, task_id TEXT,
 request_id TEXT NOT NULL, initial_payload TEXT, google_snapshot TEXT, todoist_snapshot TEXT,
 state TEXT NOT NULL DEFAULT 'active', reason TEXT, updated_at INTEGER NOT NULL,
 PRIMARY KEY(mapping,event_id), UNIQUE(task_id)
);
CREATE TABLE cursors (mapping TEXT PRIMARY KEY, sync_token TEXT);
CREATE TABLE channels (id TEXT PRIMARY KEY, mapping TEXT NOT NULL, resource_id TEXT, expires INTEGER NOT NULL);
CREATE INDEX channels_mapping ON channels(mapping,expires);
CREATE TABLE deliveries (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
