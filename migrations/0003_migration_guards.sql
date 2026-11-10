CREATE TABLE migration_guards (
 mapping TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('google','todoist')),
 source_id TEXT NOT NULL, reason TEXT NOT NULL, updated_at INTEGER NOT NULL,
 PRIMARY KEY(mapping,source,source_id)
);
