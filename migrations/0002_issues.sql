CREATE TABLE issues (
 mapping TEXT NOT NULL, source TEXT NOT NULL, source_id TEXT NOT NULL,
 reason TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(mapping,source,source_id)
);
