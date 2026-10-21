-- Похожие сериалы (F-02-08).
--
-- Вес — сходство по признакам с поправкой на редкость (IDF): чем признак
-- встречается реже, тем сильнее он говорит о сходстве. Пары считаются после
-- импорта и лежат в базе: страница сериала читает готовые веса, а тяжёлый
-- расчёт не идёт в веб-запрос (R-PERF-09).

CREATE TABLE IF NOT EXISTS e_series_similar (
  series_id   BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  similar_id  BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  weight      NUMERIC(10,4) NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (series_id, similar_id),
  CONSTRAINT ck_series_similar_distinct CHECK (series_id <> similar_id)
);
