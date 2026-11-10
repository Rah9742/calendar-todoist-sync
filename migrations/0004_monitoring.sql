CREATE TABLE job_status (
 mapping TEXT NOT NULL, kind TEXT NOT NULL,
 last_success INTEGER NOT NULL, last_completed INTEGER,
 PRIMARY KEY(mapping,kind)
);
CREATE TABLE job_failures (
 message_id TEXT PRIMARY KEY, mapping TEXT NOT NULL, kind TEXT NOT NULL,
 code TEXT NOT NULL, attempts INTEGER NOT NULL,
 first_failed INTEGER NOT NULL, last_failed INTEGER NOT NULL,
 retry_at INTEGER NOT NULL
);
CREATE INDEX job_failures_age ON job_failures(last_failed);
