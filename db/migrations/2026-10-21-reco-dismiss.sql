-- Скрытые рекомендации (M11, F-11-03).
--
-- Человек нажал «Не интересно»: сериал не показывается в «для вас» и в
-- «похожих» в течение `reco.dismiss_days` дней. Причина не хранится —
-- хранится только факт.

CREATE TABLE IF NOT EXISTS e_reco_dismiss (
  user_id    BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  series_id  BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, series_id)
);
CREATE INDEX IF NOT EXISTS ix_reco_dismiss_recent ON e_reco_dismiss (user_id, created_at DESC);
