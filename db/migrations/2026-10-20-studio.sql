-- Студия: поля и таблицы, которых не было до 2026-10-20.
--
-- Схема из docs/04-data/DATABASE.md менялась после того, как рабочая база
-- была создана. Этот файл приводит существующую базу к новой схеме; на чистой
-- установке всё создаёт db/schema.sql.
--
-- Применение: psql -d <база> -f db/migrations/2026-10-20-studio.sql

BEGIN;

-- ---------- Сериал ----------

-- Когда меняли карточку и откуда она: правка в студии и импорт.
ALTER TABLE e_series
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'tmdb';
ALTER TABLE e_series DROP CONSTRAINT IF EXISTS ck_series_source_origin;
ALTER TABLE e_series ADD CONSTRAINT ck_series_source_origin
  CHECK (source IN ('tmdb','manual'));
-- До этой правки «обновлено» негде было, и датой изменения считалась дата
-- добавления.
UPDATE e_series SET updated_at = added_at;

CREATE OR REPLACE FUNCTION t_series_touch() RETURNS trigger AS $fn$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_series_touch ON e_series;
CREATE TRIGGER trg_series_touch BEFORE UPDATE ON e_series
  FOR EACH ROW EXECUTE FUNCTION t_series_touch();

-- ---------- Подборки ----------

-- Название и описание на двух языках.
ALTER TABLE e_collection RENAME COLUMN title TO title_ru;
ALTER TABLE e_collection RENAME COLUMN description TO description_ru;
ALTER TABLE e_collection
  ADD COLUMN IF NOT EXISTS title_en TEXT,
  ADD COLUMN IF NOT EXISTS description_en TEXT;

-- ---------- Материалы ----------

-- Заголовок темы или статьи, её адрес и признак закреплённого поста.
ALTER TABLE e_material
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS slug TEXT,
  ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
DROP INDEX IF EXISTS uq_material_slug;
CREATE UNIQUE INDEX uq_material_slug ON e_material (kind, slug) WHERE slug IS NOT NULL;
-- Заголовки и адреса, которые раньше лежали в sections, переносятся в поля.
UPDATE e_material
   SET title = sections->>'title',
       slug = sections->>'slug'
 WHERE kind IN ('topic','guide') AND sections ? 'title';

-- ---------- Справочник жанров ----------

-- Сырой жанр импорта помечается признаком, а не префиксом в коде.
ALTER TABLE e_genre ADD COLUMN IF NOT EXISTS is_raw BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE e_genre SET is_raw = TRUE WHERE code LIKE 'imdb:%';

-- ---------- Изображения ----------

-- Заранее размытая копия кадра: заставка показывает кадры размытыми, и
-- фильтр на большой картинке стоит дорого (R-PERF-13).
ALTER TABLE e_image_variant
  ADD COLUMN IF NOT EXISTS blurred BOOLEAN NOT NULL DEFAULT FALSE;

-- ---------- Версии карточки ----------

CREATE TABLE IF NOT EXISTS e_catalog_version (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id  BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  author_id  BIGINT REFERENCES e_user(id) ON DELETE SET NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  source     TEXT NOT NULL CHECK (source IN ('manual','import')),
  diff       JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT uq_catalog_version UNIQUE (series_id, version)
);
CREATE INDEX IF NOT EXISTS ix_catalog_version_series ON e_catalog_version (series_id, at DESC);

-- ---------- Задания массовых операций ----------

CREATE TABLE IF NOT EXISTS e_bulk_job (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action      TEXT NOT NULL,
  actor_id    BIGINT REFERENCES e_user(id) ON DELETE SET NULL,
  total       INTEGER NOT NULL DEFAULT 0,
  done        INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'running'
              CHECK (state IN ('running','done','partial','failed')),
  params      JSONB NOT NULL DEFAULT '{}',
  result      JSONB NOT NULL DEFAULT '[]',
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_bulk_job_at ON e_bulk_job (at DESC);

COMMIT;
