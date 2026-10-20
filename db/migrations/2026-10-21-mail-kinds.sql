-- Виды писем о двухфакторной проверке.
--
-- `two_factor_disabled` — человек выключил проверку сам (F-01-05 §17): вид
-- письма был в коде, но не в ограничении базы, и отключение падало с 500.
-- `two_factor_reset` — проверку сбросил администратор (F-01-05 §4): человек
-- должен узнать, что второй фактор сняли не он.

ALTER TABLE e_mail DROP CONSTRAINT IF EXISTS e_mail_kind_check;
ALTER TABLE e_mail ADD CONSTRAINT e_mail_kind_check CHECK (kind IN (
  'email_verify','email_taken','password_reset','password_changed',
  'email_change','email_change_requested','email_changed',
  'two_factor_enabled','two_factor_disabled','two_factor_reset',
  'deletion_requested','data_export_ready','data_export_failed'
));
