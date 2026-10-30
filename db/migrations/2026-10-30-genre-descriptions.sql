-- Жанры: описание, порядок и флаг меню (F-02-04 S-03, F-10-10).
--
-- Поля уже описаны в F-10-10 §4 и §8, таблицу они не ломают: всё, что было,
-- остаётся рабочим. DEFAULT для show_in_menu покрывает сид и импорт: жанры
-- до этой миграции продолжают показываться в меню, как и раньше.

ALTER TABLE e_genre ADD COLUMN IF NOT EXISTS description_ru TEXT;
ALTER TABLE e_genre ADD COLUMN IF NOT EXISTS description_en TEXT;
ALTER TABLE e_genre ADD COLUMN IF NOT EXISTS display_order INTEGER;
ALTER TABLE e_genre ADD COLUMN IF NOT EXISTS show_in_menu BOOLEAN NOT NULL DEFAULT TRUE;
