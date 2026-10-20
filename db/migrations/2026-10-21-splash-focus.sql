-- Точка кадрирования у кадра заставки (F-10-09 §4, F-10-04).
--
-- Своя точка у кадра, а не у картинки: одна и та же картинка может стоять в
-- двух кадрах, и кадрируются они по-разному. Значения те же, что у картинки:
-- доли от края (0 — край, 0.5 — центр).

ALTER TABLE e_splash_frame
  ADD COLUMN IF NOT EXISTS focal_x REAL NOT NULL DEFAULT 0.5,
  ADD COLUMN IF NOT EXISTS focal_y REAL NOT NULL DEFAULT 0.5;
