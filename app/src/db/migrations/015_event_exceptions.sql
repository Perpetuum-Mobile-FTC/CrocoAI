-- Dates of a recurring event that were cancelled or detached (moved) for one meeting: the series
-- regeneration (events.generateRecurrenceSessions) must not recreate them.
CREATE TABLE event_exceptions (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  PRIMARY KEY (event_id, date)
);
