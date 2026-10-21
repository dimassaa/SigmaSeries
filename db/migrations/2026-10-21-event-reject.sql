-- Отказы приёма событий (M8, F-08-01).
--
-- Само отброшенное событие не хранится: оно отброшено именно потому, что не
-- соответствует правилам. Хранится счётчик — по нему видна доля
-- отбракованных на обзоре.

CREATE TABLE IF NOT EXISTS e_event_reject (
  name    TEXT NOT NULL,
  reason  TEXT NOT NULL,
  day     DATE NOT NULL DEFAULT current_date,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (name, reason, day)
);
