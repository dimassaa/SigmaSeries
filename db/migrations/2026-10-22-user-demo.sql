-- Демо-аккаунты (M8, R-AN-11).
--
-- Демо-население должно быть отличимо от живого по самой строке: иначе
-- метрика по аккаунтам считала бы и синтетику.

ALTER TABLE e_user ADD COLUMN IF NOT EXISTS is_demo BOOLEAN NOT NULL DEFAULT FALSE;
