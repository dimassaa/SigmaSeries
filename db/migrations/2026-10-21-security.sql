-- Безопасность писем, счётчики прогона импорта и история адресов.
--
-- Схема из docs/04-data/DATABASE.md менялась после того, как рабочая база
-- была создана. Этот файл приводит существующую базу к новой схеме; на чистой
-- установке всё создаёт db/schema.sql.
--
-- Применение: psql -d <база> -f db/migrations/2026-10-21-security.sql

BEGIN;

-- ---------- Письма ----------

-- Токен из письма — в отдельной зашифрованной колонке: в базе действующего
-- токена быть не должно (№47).
ALTER TABLE e_mail ADD COLUMN IF NOT EXISTS token_enc BYTEA;

-- Новый вид письма: неудачная выгрузка.
ALTER TABLE e_mail DROP CONSTRAINT IF EXISTS e_mail_kind_check;
ALTER TABLE e_mail ADD CONSTRAINT e_mail_kind_check CHECK (kind IN (
  'email_verify','email_taken','password_reset','password_changed',
  'email_change','email_change_requested','email_changed',
  'two_factor_enabled','deletion_requested','data_export_ready','data_export_failed'
));

-- Токены писем, которые уже стоят в очереди, в колонку не переносятся:
-- формат шифра в приложении свой, и SQL его не напишет. Такие письма
-- уйдут как есть — очередь живёт недолго, а письмо без токена в теле
-- отправляется ровно тем же текстом, что и раньше.

-- ---------- Прогон импорта ----------

ALTER TABLE e_import_run
  ADD COLUMN IF NOT EXISTS params JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS counters JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS skip_reason TEXT,
  ADD COLUMN IF NOT EXISTS checkpoint JSONB NOT NULL DEFAULT '{}';

-- ---------- История адресов сериала ----------

CREATE TABLE IF NOT EXISTS e_series_slug (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id  BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by BIGINT REFERENCES e_user(id) ON DELETE SET NULL,
  CONSTRAINT uq_series_slug UNIQUE (slug)
);
CREATE INDEX IF NOT EXISTS ix_series_slug_series ON e_series_slug (series_id, changed_at DESC);

-- Текущие адреса — в историю: старый адрес серии должен вести на новую, а
-- история до этого не существовала (№84).
INSERT INTO e_series_slug (series_id, slug, changed_at)
SELECT id, slug, added_at FROM e_series
ON CONFLICT (slug) DO NOTHING;

COMMIT;
