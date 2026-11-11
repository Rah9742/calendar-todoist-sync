CREATE TABLE notification_health (
 id TEXT PRIMARY KEY,
 condition TEXT NOT NULL CHECK(condition IN ('healthy','problem')),
 since INTEGER NOT NULL,
 last_problem_at INTEGER
);
