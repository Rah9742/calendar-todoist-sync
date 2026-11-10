ALTER TABLE links ADD COLUMN completion_cursor TEXT;
UPDATE links SET completion_cursor=strftime('%Y-%m-%dT%H:%M:%fZ',updated_at/1000.0,'unixepoch') WHERE kind='rolling';
