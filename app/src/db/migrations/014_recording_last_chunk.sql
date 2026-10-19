-- Lets the UI tell an abandoned recording from one still being recorded on another device.
ALTER TABLE meeting_recordings ADD COLUMN last_chunk_at TEXT;
