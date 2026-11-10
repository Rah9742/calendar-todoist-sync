ALTER TABLE links ADD COLUMN ical_uid TEXT;
CREATE INDEX links_ical_identity ON links(ical_uid);
UPDATE links SET ical_uid=json_extract(initial_payload,'$.iCalUID') WHERE json_valid(initial_payload) AND json_extract(initial_payload,'$.iCalUID') IS NOT NULL;
ALTER TABLE links ADD COLUMN google_payload TEXT;
UPDATE links SET google_payload=initial_payload WHERE json_valid(initial_payload) AND json_extract(initial_payload,'$.start') IS NOT NULL;
