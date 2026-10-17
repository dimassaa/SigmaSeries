-- Этот файл НЕ ПРАВИТСЯ РУКАМИ.
-- Источник: docs/04-data/DATABASE.md, разделы 2 и 2.1.
-- Генерируется: python3 tools/schema/extract.py
-- Проверка:     npm run db:check
--
-- Правка в DATABASE.md, затем эта команда. Правка здесь будет потеряна.
--
-- Запуск:
--   createdb serial_tracker
--   psql -U <user> -d serial_tracker -f db/schema.sql

-- ─── Блок 1 из DATABASE.md ───
-- ============================================================
-- Генерация схемы курсового проекта.
-- Запуск: psql -U <user> -d <db> -f database.sql
-- Идемпотентна: повторный запуск на чистой базе даёт тот же
-- результат; на непустой падает на CREATE TABLE без IF NOT EXISTS.
-- Версия схемы фиксируется в _meta.
-- ============================================================

CREATE TABLE _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO _meta (key, value) VALUES ('schema_version', '1.0');

-- ---------- Пользователь и доступ ----------

CREATE TABLE e_user (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email_hash      BYTEA,                     -- шифр для хранения; после обезличивания NULL
  email_blind_idx BYTEA,                     -- HMAC для поиска: ищем, не зная значения
  email_enc       BYTEA,                     -- шифр, из которого восстанавливается при входе
  password_hash   TEXT   NOT NULL,           -- argon2id; наружу не отдаётся никогда
  nickname        TEXT   NOT NULL,
  avatar_image_id BIGINT,
  status          TEXT   NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','muted','banned','deleting','deleted')),
  email_confirmed BOOLEAN NOT NULL DEFAULT FALSE,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_active_at  TIMESTAMPTZ,
  timezone        TEXT   NOT NULL DEFAULT 'Europe/Minsk',
  locale          TEXT   NOT NULL DEFAULT 'ru' CHECK (locale IN ('ru','en')),
  theme           TEXT   NOT NULL DEFAULT 'system' CHECK (theme IN ('light','dark','system')),
  recs_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  profile_public  BOOLEAN NOT NULL DEFAULT FALSE,   -- приватность закрыта по умолчанию
  stats_public    BOOLEAN NOT NULL DEFAULT FALSE,
  -- Уведомления (F-01-06 §4). Состав категорий и каналов определяет M3,
  -- и когда он появится, рядом появится таблица категорий; пока её нет,
  -- человек не может даже прекратить писать ему письма.
  quiet_hours     BOOLEAN NOT NULL DEFAULT FALSE,
  -- Границы тихих часов (F-03-10 §4): по локальному времени человека,
  -- поэтому хранятся как время без часового пояса. Умолчания — из спецификации
  -- модуля; действуют только для почты и push, которых пока нет.
  quiet_hours_from TIME NOT NULL DEFAULT '23:00',
  quiet_hours_to   TIME NOT NULL DEFAULT '08:00',
  deleted_at      TIMESTAMPTZ,
  -- Удаление аккаунта (F-01-10 §4, OP-16). Запись не удаляется физически:
  -- на неё ссылаются материалы и оценки, а `R-SQL-02` запрещает `DELETE`
  -- из e_user вовсе. Через 14 дней обезличивается, адрес и ник освобождаются.
  --
  -- Срок хранится готовой датой, а не вычисляется из `delete_requested_at`:
  -- дата названа человеку в письме, и пересчёт изменил бы обещание.
  delete_requested_at TIMESTAMPTZ,
  anonymize_after     TIMESTAMPTZ,
  -- Отметка «удалить также мои отзывы и руководства» (H-61). Без неё
  -- материалы остаются обезличенными.
  delete_materials    BOOLEAN NOT NULL DEFAULT FALSE,
  anonymized_at       TIMESTAMPTZ,
  -- Уникальность ника задаётся индексом ниже, а не ограничением: ник
  -- уникален БЕЗ учёта регистра (EC-A5, M1 §8(а)), а `UNIQUE (nickname)`
  -- сравнивал бы строки как есть и пропустил пару `Anna` / `anna`.
  -- Проверка занятости в приложении остаётся — чтобы сообщение о занятости
  -- было понятным человеку; гарантию даёт индекс.
);
CREATE UNIQUE INDEX uq_user_nick ON e_user (lower(nickname));
-- После обезличивания адреса в e_user не остаётся: ни шифра, ни слепого
-- индекса. Поиск идёт по непустым значениям, а `uq_user_email_blind` и не
-- смотрит на удалённые записи, поэтому NULL ни с чем не конфликтует.
--
-- Значение обязательным быть не может именно из-за этого: обезличенная запись
-- без адреса — норма, а не повреждение.
--
-- Обратное ограничение тоже важно: непустой адрес у записи, которая не
-- удалена, — единственное состояние, при котором человек может войти.
-- Поиск по email идёт по слепому индексу, а не по шифру: иначе поиск
-- был бы невозможен, а сравнение шифров — ложные совпадения.
CREATE UNIQUE INDEX uq_user_email_blind ON e_user (email_blind_idx) WHERE deleted_at IS NULL;
CREATE INDEX ix_user_status_reg  ON e_user (status, registered_at DESC);
CREATE INDEX ix_user_last_active ON e_user (last_active_at DESC NULLS LAST);

CREATE TABLE e_session (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  device_label  TEXT   NOT NULL,
  -- Хеш идентификатора сессии (F-01-03 §4). Сам идентификатор входить
  -- позволяет, поэтому он в таблице не лежит: по хешу находится живая
  -- сессия для отзыва и определяется «это устройство». Для строк, созданных
  -- до появления столбца, значение NULL — отозвать их нельзя, и это честнее,
  -- чем пустой хеш, который совпал бы с чем-то не тем.
  sid_hash      TEXT,
  -- Усечённый адрес сети (F-01-03 §4): /24 для IPv4 и /48 для IPv6 — самый
  -- мелкий блок, который выдают операторы, поэтому восстановить адрес из
  -- показанного нельзя. NULL, если адрес неизвестен.
  ip_prefix     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  -- Сессия принадлежит пользователю и без него бессмысленна:
  -- здесь каскад допустим.
  CONSTRAINT ck_session_alive CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX ix_session_user ON e_session (user_id) WHERE revoked_at IS NULL;
-- Поиск «моя ли это сессия» идёт по хешу идентификатора, а не по идентификатору.
CREATE UNIQUE INDEX uq_session_sid_hash ON e_session (sid_hash) WHERE sid_hash IS NOT NULL;

CREATE TABLE e_role_assignment (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES e_user(id) ON DELETE RESTRICT,
  role       TEXT   NOT NULL CHECK (role IN ('editor','analyst','admin')),
  granted_by BIGINT REFERENCES e_user(id) ON DELETE RESTRICT,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,          -- NULL = бессрочно
  note       TEXT
);
-- Одна роль на пару «пользователь-роль» на момент действия
CREATE UNIQUE INDEX uq_role_active ON e_role_assignment (user_id, role) WHERE expires_at IS NULL;
CREATE INDEX ix_role_expiring ON e_role_assignment (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE e_restriction (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES e_user(id) ON DELETE RESTRICT,
  kind         TEXT   NOT NULL CHECK (kind IN ('mute','ban')),
  kind_max_h   INTEGER,           -- только для mutes
  reason       TEXT   NOT NULL,
  hide_materials BOOLEAN NOT NULL DEFAULT FALSE,
  set_by       BIGINT NOT NULL REFERENCES e_user(id) ON DELETE RESTRICT,
  set_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  revoked_by   BIGINT REFERENCES e_user(id) ON DELETE RESTRICT
);
-- Не больше одного действующего ограничения каждого вида
CREATE UNIQUE INDEX uq_restriction_active
  ON e_restriction (user_id, kind) WHERE revoked_at IS NULL;
CREATE INDEX ix_restriction_expiring ON e_restriction (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE e_audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    BIGINT REFERENCES e_user(id) ON DELETE SET NULL,  -- актёр может исчезнуть
  action      TEXT   NOT NULL,
  object_type TEXT   NOT NULL,
  object_id   BIGINT,
  result      TEXT   NOT NULL CHECK (result IN ('ok','denied','error')),
  reason      TEXT,
  before_data JSONB,               -- секреты сюда не пишутся никогда (R-SEC-33)
  after_data  JSONB
);
CREATE INDEX ix_audit_at     ON e_audit_log (at DESC);
CREATE INDEX ix_audit_actor  ON e_audit_log (actor_id, at DESC);
CREATE INDEX ix_audit_object ON e_audit_log (object_type, object_id, at DESC);
-- R-SQL-01: доступ к журналу только на чтение — см. §4

-- ---------- Каталог ----------

-- Картинка хранится в базе (PLAN C-04, требование Бланка 3.3.1), но байты
-- лежат в `e_image_variant`: по форме F-12-05 §7 у E-Image есть «роль,
-- источник, исходный путь, размеры, хэш, фокальная точка, признак “без
-- текста”», а сами варианты — отдельная сущность со своей шириной и форматом.
-- Поэтому `file` здесь пуст: дубль самого большого варианта в каждой строке
-- стоил бы примерно трети бюджета база на картинки.
CREATE TABLE e_image (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role      TEXT   NOT NULL CHECK (role IN ('poster','backdrop','banner','splash')),
  source    TEXT   NOT NULL DEFAULT 'tmdb' CHECK (source IN ('tmdb','manual')),
  source_path TEXT,                 -- путь в источнике: «что перекачивать в следующий раз»
  checksum  TEXT,                   -- хэш содержимого исходника: тот же файл не грузим заново
  file      BYTEA,                  -- необязателен: байты лежат в вариантах
  mime      TEXT   NOT NULL,
  width     INTEGER NOT NULL,
  height    INTEGER NOT NULL,
  focal_x   NUMERIC(4,3) NOT NULL DEFAULT 0.667,   -- точка кадрирования по умолчанию
  focal_y   NUMERIC(4,3) NOT NULL DEFAULT 0.333,
  alt       TEXT,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_image_focal CHECK (focal_x BETWEEN 0 AND 1 AND focal_y BETWEEN 0 AND 1)
);
CREATE TABLE e_series (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  imdb_key      TEXT,               -- tconst; NULL для сериалов только из TMDB
  tmdb_id       INTEGER,
  slug          TEXT NOT NULL UNIQUE,
  title_ru      TEXT, title_en TEXT, title_original TEXT NOT NULL,
  year_start    INTEGER, year_end INTEGER,
  description_ru TEXT, description_en TEXT,
  exit_state    TEXT NOT NULL DEFAULT 'announced'
                CHECK (exit_state IN ('announced','airing','waiting','ended','cancelled')),
  archived_at   TIMESTAMPTZ,
  -- Состояние публикации (F-12-06 §6): «Импортирован» — записан, но не
  -- показывается; «Опубликован» — есть минимум (название, год, жанр,
  -- состояние выхода); «В архиве» — скрыт вручную или из-за снятия с
  -- публикации (EC-C1). Это НЕ exit_state: сериал может быть опубликован и
  -- при этом «Ждём сезон».
  publication_state TEXT NOT NULL DEFAULT 'imported'
                CHECK (publication_state IN ('imported','published','archived')),
  -- Коды причин неполноты и уровень карточки (F-12-06 §8). Хранятся рядом с
  -- сериалом, а не в отдельной таблице: фильтр в S-74 и бейджи на карточке —
  -- это один запрос, и «без фона и без людей» не требует соединения.
  reasons TEXT[] NOT NULL DEFAULT '{}',
  level   TEXT NOT NULL DEFAULT 'minimum'
          CHECK (level IN ('full','displayable','minimum')),
  added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  version       INTEGER NOT NULL DEFAULT 1,   -- оптимистичная блокировка (EC-R2)
  -- Либо IMDb-ключ, либо TMDB-идентификатор: без одного из них
  -- сопоставление не считается состоявшимся
  CONSTRAINT ck_series_source CHECK (imdb_key IS NOT NULL OR tmdb_id IS NOT NULL)
);
CREATE INDEX ix_series_exit  ON e_series (exit_state) WHERE archived_at IS NULL;
CREATE INDEX ix_series_year   ON e_series (year_start);
CREATE INDEX ix_series_added  ON e_series (added_at DESC);
-- Поиск по названиям ru/en/original одним запросом.
--
-- Конфигурация `russian` — это стеммер Snowball: «человеком» находит «людей»,
-- а не только точное слово. Выражение обязано совпадать с запросом в
-- `src/services/search/service.js` дословно, иначе PostgreSQL перестаёт
-- пользоваться индексом и ищет по всей таблице (F-02-06 §3).
CREATE INDEX ix_series_search ON e_series
  USING gin (to_tsvector('russian', coalesce(title_ru,'') || ' ' || coalesce(title_original,'') || ' ' || coalesce(title_en,'')));

-- Изображения объявлены раньше сериалов, поэтому связь добавляется здесь.
-- Без неё постер и фон не принадлежат ни к чему и в каталог не попадают:
-- это нашлось при первом же запросе к живой базе (октябрь 2026).
ALTER TABLE e_image
  ADD COLUMN series_id BIGINT REFERENCES e_series(id) ON DELETE CASCADE;
CREATE INDEX ix_image_series ON e_image (series_id, role);

CREATE TABLE e_season (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id   BIGINT NOT NULL REFERENCES e_series(id) ON DELETE RESTRICT,
  number      INTEGER NOT NULL,      -- 0 = спецвыпуски
  title_ru TEXT, title_en TEXT,
  description_ru TEXT, description_en TEXT,
  CONSTRAINT uq_season UNIQUE (series_id, number)
);

CREATE TABLE e_episode (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season_id     BIGINT NOT NULL REFERENCES e_season(id) ON DELETE CASCADE,
  number        INTEGER NOT NULL,
  title_ru TEXT, title_en TEXT,
  description_ru TEXT, description_en TEXT,
  runtime_min   INTEGER,
  CONSTRAINT uq_episode UNIQUE (season_id, number)
);

-- Выход — это серия или группа серий с одной датой.
CREATE TABLE e_release (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  season_id     BIGINT NOT NULL REFERENCES e_season(id) ON DELETE CASCADE,
  episode_id    BIGINT REFERENCES e_episode(id) ON DELETE CASCADE,
  covers_season BOOLEAN NOT NULL DEFAULT FALSE,   -- выход относится к сезону целиком
  release_date  DATE   NOT NULL,
  release_time  TIME,
  precision     TEXT   NOT NULL DEFAULT 'date' CHECK (precision IN ('date','exact')),
  input_tz      TEXT,                 -- пояс, в котором админ ввёл время; хранится как введено
  state         TEXT   NOT NULL DEFAULT 'scheduled'
                CHECK (state IN ('tba','scheduled','aired','delayed','cancelled')),
  locked        BOOLEAN NOT NULL DEFAULT FALSE   -- ручная правка защищена от импорта
);
-- Состав выхода задаёт `e_release_episode`: одна связь — одна серия, несколько —
-- группа серий с одной датой (EC-D11), ни одной — никакого состава. Отдельный
-- случай «вышел весь сезон» помечен `covers_season`: угадывать его по связям
-- нельзя, сезон с одной датированной серией неотличим от выхода одной серии,
-- а календарь обязан сказать «весь сезон» (EC-T6). `episode_id` для этого не
-- годился: импорт его не пишет, и NULL у всех строк не значил ничего.
CREATE INDEX ix_release_date ON e_release (release_date);
CREATE INDEX ix_release_season ON e_release (season_id);
-- Один выход на дату в сезоне: серии одного дня схлопываются в один (EC-D11),
-- и импорт обновляет выход по этой паре, а не удаляет и вставляет заново —
-- иначе каждая ночь меняла бы идентификаторы и обнуляла состояние (DEC-061).
CREATE UNIQUE INDEX uq_release_season_date ON e_release (season_id, release_date);
-- Дата выхода — источник истины для состояния сериала; ради него
-- есть индекс: календарь спрашивает по дате, а не по сериалу.

-- Серии одного сезона с одной датой образуют ОДИН выход (EC-D11): в календаре
-- это «3 серии выходят 12 октября», а не три одинаковых точки. Поэтому состав
-- выхода — связь многие-ко-многим, а не колонка в e_release: у выхода может быть
-- и одна серия, и несколько, и ни одной.
CREATE TABLE e_release_episode (
  release_id BIGINT NOT NULL REFERENCES e_release(id) ON DELETE CASCADE,
  episode_id BIGINT NOT NULL REFERENCES e_episode(id) ON DELETE CASCADE,
  PRIMARY KEY (release_id, episode_id)
);
CREATE INDEX ix_release_episode_episode ON e_release_episode (episode_id);

CREATE TABLE e_genre (
  code    TEXT PRIMARY KEY,
  name_ru TEXT NOT NULL,
  name_en TEXT NOT NULL,
  active  BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE e_series_genre (
  series_id BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  genre_code TEXT  NOT NULL REFERENCES e_genre(code) ON DELETE RESTRICT,
  PRIMARY KEY (series_id, genre_code)
);
-- Человек опознаётся по `imdb_key`, а не по имени: у IMDb десятки тёзок, и
-- склеив их, мы получили бы одну биографию и одну фильмографию на двоих.
-- `slug` при этом остаётся адресом страницы и может совпасть у разных людей
-- только через суффикс — как у сериалов (H-32).
CREATE TABLE e_person (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  imdb_key  TEXT UNIQUE,
  slug      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL CHECK (kind IN ('actor','director','creator')),
  birth_year INTEGER
);
CREATE TABLE e_series_person (
  series_id BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  person_id BIGINT NOT NULL REFERENCES e_person(id) ON DELETE RESTRICT,
  role      TEXT   NOT NULL,
  ordinal   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (series_id, person_id, role)
);
CREATE TABLE e_external_rating (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  platform  TEXT   NOT NULL,          -- справочник платформ (DEC-006), не перечисление
  value     NUMERIC(3,1),
  scale_max NUMERIC(4,1) NOT NULL DEFAULT 10,
  votes     INTEGER,
  measured_on DATE NOT NULL,
  CONSTRAINT uq_rating_platform UNIQUE (series_id, platform)
);
CREATE TABLE e_collection (
  id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug     TEXT NOT NULL UNIQUE,
  title    TEXT NOT NULL,
  description TEXT,
  banner_image_id BIGINT REFERENCES e_image(id) ON DELETE SET NULL,
  weight   NUMERIC(5,2) NOT NULL DEFAULT 0,
  active   BOOLEAN NOT NULL DEFAULT TRUE,
  is_demo  BOOLEAN NOT NULL DEFAULT FALSE
);
-- archived_at у подборок нет и не нужен: скрытая подборка это active = false,
-- а удаление теряет смысла, потому что на неё ссылаются позиции каталога.
CREATE TABLE e_collection_item (
  collection_id BIGINT NOT NULL REFERENCES e_collection(id) ON DELETE CASCADE,
  series_id     BIGINT NOT NULL REFERENCES e_series(id) ON DELETE RESTRICT,
  ordinal       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection_id, series_id)
);
CREATE TABLE e_banner (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       TEXT   NOT NULL CHECK (kind IN ('new','classic','editorial')),
  series_id  BIGINT NOT NULL REFERENCES e_series(id) ON DELETE RESTRICT,
  show_on    DATE   NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT TRUE,
  CONSTRAINT uq_banner_kind_day UNIQUE (kind, show_on)
);
CREATE TABLE e_editorial_pick (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id  BIGINT NOT NULL REFERENCES e_series(id) ON DELETE RESTRICT,
  set_by     BIGINT NOT NULL REFERENCES e_user(id) ON DELETE RESTRICT,
  set_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  active_from DATE NOT NULL DEFAULT CURRENT_DATE,
  active_until DATE,
  note       TEXT
);

-- ---------- Пользовательские данные ----------

CREATE TABLE e_watch_status (
  user_id    BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  series_id  BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  status     TEXT   NOT NULL
             CHECK (status IN ('watching','planned','watched','dropped','on_hold')),
  -- Кто поставил статус: человек или правило (`F-03-01` §8а, H-69).
  --
  -- Без этой пометки отмена массовой отметки не отличила бы «человек сам
  -- выбрал Просмотрено» от «переход в Просмотрено случился по отметкам»: первое
  -- откатывать нельзя, второе — нужно.
  source     TEXT   NOT NULL DEFAULT 'manual'
             CHECK (source IN ('manual','auto')),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, series_id)
);
CREATE TABLE e_watch_mark (
  user_id    BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  episode_id BIGINT NOT NULL REFERENCES e_episode(id) ON DELETE CASCADE,
  marked_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  precision  TEXT   NOT NULL CHECK (precision IN ('exact','retro')),
  -- ретро-отметка помечена, чтобы прогресс и Wrapped её игнорировали
  batch_id   BIGINT REFERENCES e_mark_batch(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, episode_id)
);
CREATE INDEX ix_mark_exact ON e_watch_mark (user_id, episode_id) WHERE precision = 'exact';
CREATE INDEX ix_mark_batch ON e_watch_mark (user_id, batch_id) WHERE batch_id IS NOT NULL;

-- Пакет массовой отметки — только ради отмены.
--
-- Отмена «Отметить сезон» обязана вернуть именно то, что было до неё, поэтому
-- помнить не «что отметили», а «отметили одним действием»: отмена удаляет
-- отметки этого пакета и ничего больше. Строка остаётся после отмены —
-- иначе повторная отмена того же номера была бы неотличима от новой отметки.
CREATE TABLE e_mark_batch (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  undone_at  TIMESTAMPTZ
);
CREATE INDEX ix_batch_user ON e_mark_batch (user_id, created_at DESC);

-- Кэш прогресса (OP-10, F-03-03).
--
-- Держит всё, что нужно карточке закладки: прогресс, «продолжить», дату
-- ожидания и пропуски. Именно поэтому список закладок читает кэш, а не считает
-- заново на каждой строке.
--
-- Пересчитывается при каждой отметке; при чтении число вышедших серий
-- сравнивается с кэшем, и расхождение пересчитывает строку — иначе новая
-- серия, вышедшая после импорта, годами показывала бы старый процент. Кэш можно
-- удалить целиком и построить заново: это не источник правды, отметки в
-- `e_watch_mark` — источник.
CREATE TABLE e_progress (
  user_id      BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  series_id    BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  marked       INTEGER NOT NULL DEFAULT 0,   -- отмечено видимых вышедших серий
  aired        INTEGER NOT NULL DEFAULT 0,   -- всего вышедших видимых серий
  last_season  INTEGER,
  last_episode INTEGER,                      -- последняя отмеченная по порядку (сезон, номер)
  next_season  INTEGER,                      -- «продолжить»: первая вышедшая неотмеченная
  next_episode INTEGER,                      --            после последней отмеченной (OP-10б)
  next_date    DATE,                         -- дата её выхода
  awaiting_date DATE,                        -- когда выйдет следующая, если всё отмечено
  skipped      INTEGER NOT NULL DEFAULT 0,   -- неотмеченные серии до последней отмеченной (EC-T11)
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, series_id),
  CONSTRAINT ck_progress_counts CHECK (marked >= 0 AND aired >= 0 AND marked <= aired AND skipped >= 0)
);
CREATE INDEX ix_progress_updated ON e_progress (user_id, updated_at);
CREATE TABLE e_subscription (
  user_id    BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  series_id  BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  kind       TEXT   NOT NULL CHECK (kind IN ('release','announce')),
  source     TEXT   NOT NULL CHECK (source IN ('auto','manual')),
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (user_id, series_id, kind)
);
CREATE TABLE e_notification (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  kind       TEXT   NOT NULL,        -- тип, а не готовый текст
  category   TEXT   NOT NULL,
  params     JSONB  NOT NULL,        -- параметры; текст собирается при чтении (R-I18N-04)
  dedup_key  TEXT   NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at    TIMESTAMPTZ,
  CONSTRAINT uq_notification_dedup UNIQUE (user_id, dedup_key)
);
CREATE INDEX ix_notif_unread ON e_notification (user_id, created_at DESC) WHERE read_at IS NULL;
CREATE TABLE e_notification_preference (
  user_id    BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  category   TEXT   NOT NULL CHECK (category IN ('release','moderation','reply','service')),
  channel    TEXT   NOT NULL CHECK (channel IN ('in_service','email','push')),
  enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category, channel),
  -- `moderation` выключить нельзя (R-MOD-19): человек должен знать судьбу
  -- своего материала. Ограничение держит база, а не только экран — иначе
  -- запись могла бы появиться из кода в обход правила.
  CONSTRAINT ck_notif_pref_moderation CHECK (category <> 'moderation' OR enabled)
);

-- ---------- Оценки и материалы ----------

CREATE TABLE e_rating (
  user_id     BIGINT NOT NULL REFERENCES e_user(id) ON DELETE RESTRICT,
  object_type TEXT   NOT NULL CHECK (object_type IN ('series','episode')),
  series_id   BIGINT NOT NULL REFERENCES e_series(id) ON DELETE RESTRICT,
  -- У оценки сериала серии нет, поэтому столбец пуст. Из-за этого первичным
  -- ключом он быть не может: NULL в ключе означает, что одинаковые строки
  -- считаются различными, и «один человек — одна оценка» перестало бы быть
  -- гарантией. Уникальность задают два индекса ниже, по одному на вид.
  episode_id  BIGINT REFERENCES e_episode(id) ON DELETE RESTRICT,
  value       SMALLINT NOT NULL CHECK (value BETWEEN 1 AND 10),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  counted     BOOLEAN NOT NULL DEFAULT TRUE,   -- исключённые не удаляются, а помечаются
  is_demo     BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX uq_rating_series  ON e_rating (user_id, series_id)  WHERE object_type = 'series';
CREATE UNIQUE INDEX uq_rating_episode ON e_rating (user_id, episode_id) WHERE object_type = 'episode';
CREATE INDEX ix_rating_series ON e_rating (series_id) WHERE counted;
CREATE TABLE e_series_rating_stat (
  series_id BIGINT PRIMARY KEY REFERENCES e_series(id) ON DELETE CASCADE,
  sum_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  votes     INTEGER NOT NULL DEFAULT 0,
  prior_weight NUMERIC(4,1) NOT NULL DEFAULT 10,
  prior_mean   NUMERIC(3,1) NOT NULL DEFAULT 7.0,
  recalculated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE e_material (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  author_id    BIGINT NOT NULL REFERENCES e_user(id) ON DELETE RESTRICT,
  kind         TEXT   NOT NULL CHECK (kind IN ('review','comment','guide','topic','post')),
  series_id    BIGINT REFERENCES e_series(id) ON DELETE RESTRICT,
  episode_id   BIGINT REFERENCES e_episode(id) ON DELETE RESTRICT,
  parent_id    BIGINT REFERENCES e_material(id) ON DELETE RESTRICT,
  body         TEXT   NOT NULL,
  sections     JSONB,                -- разделы руководства; текст, не HTML (R-SEC-11)
  spoiler      BOOLEAN NOT NULL DEFAULT FALSE,
  state        TEXT   NOT NULL DEFAULT 'draft'
               CHECK (state IN ('draft','checking','published','flagged','approved',
                                'rejected','hidden','deleted')),
  version      INTEGER NOT NULL DEFAULT 1,
  decided_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Отзыв — единственный вид, где нужна оценка; тема — тоже сериальная
  CONSTRAINT ck_material_target CHECK (
    (kind IN ('review','guide','topic')  AND series_id IS NOT NULL AND episode_id IS NULL) OR
    (kind = 'comment'  AND (series_id IS NOT NULL OR episode_id IS NOT NULL)) OR
    (kind = 'post'     AND parent_id IS NOT NULL))
);
CREATE INDEX ix_material_author ON e_material (author_id, created_at DESC);
CREATE INDEX ix_material_queue ON e_material (state, created_at) WHERE state IN ('flagged','checking');
CREATE INDEX ix_material_pub   ON e_material (series_id, created_at DESC) WHERE state = 'published';
-- Поиск по телу материала для модерации и для поиска
CREATE INDEX ix_material_search ON e_material USING gin (to_tsvector('russian', body));
CREATE TABLE e_dictionary_word (
  word     TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('ru','en')),
  list     TEXT NOT NULL CHECK (list IN ('block','allow')),
  added_by BIGINT REFERENCES e_user(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  active   BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (word, language)
);
CREATE TABLE e_moderation_cluster (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signature  TEXT NOT NULL,
  decision   TEXT CHECK (decision IN ('approved','rejected')),
  decided_by BIGINT REFERENCES e_user(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  applied    BOOLEAN NOT NULL DEFAULT FALSE,  -- решение распространено на новые материалы
  CONSTRAINT uq_cluster_sig UNIQUE (signature)
);
CREATE TABLE e_editor_decision (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  material_id   BIGINT NOT NULL REFERENCES e_material(id) ON DELETE RESTRICT,
  editor_id     BIGINT NOT NULL REFERENCES e_user(id) ON DELETE RESTRICT,
  decision      TEXT   NOT NULL CHECK (decision IN ('approved','rejected')),
  reason        TEXT   NOT NULL,
  matched_word  TEXT,
  cluster_id    BIGINT REFERENCES e_moderation_cluster(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at  TIMESTAMPTZ,
  CONSTRAINT ck_decision_not_cancelled CHECK (cancelled_at IS NULL OR cancelled_at >= decided_at)
);

-- ---------- Импорт, система, аналитика ----------

CREATE TABLE e_import_run (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind       TEXT   NOT NULL
             CHECK (kind IN ('schedule_sync','discover_sync','ratings_sync','full_run')),
  dry_run    BOOLEAN NOT NULL DEFAULT FALSE,   -- флаг, а не отдельный вид (F-12-07)
  -- У запланированного запуска здесь время, НА КОТОРОЕ он назначен; у идущего
  -- и завершённого — фактическое начало. Отдельной колонки «когда запускать»
  -- нет: без неё перезапуск процесса не знал бы, какую строку уже пора
  -- начать, а план без времени — не план (F-12-07 §6).
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  -- `planned` — назначен, но ещё не начат; `skipped` — подошёл срок, а
  -- запустить нельзя: держал другой прогон (F-12-07 §5, §18);
  -- `resumed` — прогон, продолжающийся после обрыва (F-12-09).
  status     TEXT   NOT NULL DEFAULT 'planned'
             CHECK (status IN ('planned','running','success','partial','error','skipped','resumed'))
);
-- Не больше одного запланированного запуска каждого вида: два плана на одну
-- ночь означали бы либо двойную работу, либо вечный пропуск одного из них.
CREATE UNIQUE INDEX ux_import_run_planned ON e_import_run (kind) WHERE status = 'planned';
-- Что стало с каждой позицией запуска. Ключ пара (запуск, tconst) — это и
-- результат, и контрольная точка возобновления: повторный запуск после сбоя
-- пропускает то, что уже доведено до своей стадии (F-12-09).
--
-- Причины и коды ответов — списки в одной строке, а не справочные таблицы:
-- это диагностика конкретного запуска, которая показывается в списке с
-- фильтром (F-12-08) и через месяц не нужна ни каталогу, ни отчёту.
CREATE TABLE e_import_item_result (
  run_id     BIGINT    NOT NULL REFERENCES e_import_run(id) ON DELETE CASCADE,
  tconst     TEXT      NOT NULL,                 -- идентификатор IMDb: tt1234567
  tmdb_id    INTEGER,                            -- известен с F-12-02
  stage      TEXT      NOT NULL                  -- до какой стадии дошла позиция
             CHECK (stage IN ('candidates','matched','enriched','discovered','imaged','written')),
  outcome    TEXT      NOT NULL
             CHECK (outcome IN ('ok','no_tmdb','pair_doubt','write_failed','skipped','error')),
  reasons    TEXT[]    NOT NULL DEFAULT '{}',    -- коды причин: no_poster, schedule_gap …
  http_codes INTEGER[] NOT NULL DEFAULT '{}',     -- коды ответов TMDB по попыткам
  attempts   INTEGER   NOT NULL DEFAULT 0,       -- попыток на этой позиции (F-12-09)
  -- Отбор по популярности (F-12-01 §4). Ранг и голоса хранятся вместе с
  -- результатом, иначе «тысячу самых популярных» нельзя было бы показать в
  -- отчёте и нельзя было бы доказать, что порядок не нарушен.
  popularity_rank INTEGER,
  num_votes       INTEGER,
  average_rating  NUMERIC(3,1),
  -- Год начала по IMDb. Без него проверку пары (F-12-02 §4, H-28) нечем
  -- было бы подтвердить: год пришлось бы каждый раз искать в датасете.
  start_year      SMALLINT,
  -- Сырой слой источников (F-12-03 §4(4), `M12` §0): то, что пришло от
  -- TMDB и IMDb, до записи в каталог. Он лежит здесь потому, что повторная
  -- обработка не должна требовать новых запросов к API — а срок жизни ключа
  -- и доступность источника от серии к серии не гарантированы.
  -- Переводы всех языков и список картинок сюда НЕ кладутся: это сотни
  -- килобайт на сериал, которые никто не читает (#73).
  raw            JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, tconst)
);
CREATE TABLE e_backup_job (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'running'
               CHECK (status IN ('running','created','verified','error')),
  size_bytes   BIGINT,
  checksum     TEXT,
  -- Где лежит дамп. Без пути журнал отвечает на вопрос «была ли копия», но не
  -- на «где она»: на защите это разница между страховкой и её отсутствием.
  file_path    TEXT,
  -- Проверена означает фактически выполненное восстановление (M9 F-09-04),
  -- а не запись в лог об окончании дампа.
  verified_at  TIMESTAMPTZ
);
CREATE TABLE e_online_sample (
  hour          TIMESTAMPTZ PRIMARY KEY,     -- начало часа
  registered    INTEGER NOT NULL DEFAULT 0,
  guests        INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE e_event (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id     UUID NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  ts_client    TIMESTAMPTZ,
  ts_server    TIMESTAMPTZ NOT NULL DEFAULT now(),
  anon_id      TEXT,
  user_pseudo_id TEXT,          -- никогда не идентификатор пользователя
  props        JSONB NOT NULL DEFAULT '{}',  -- без PII (R-AN-04)
  is_demo      BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX ix_event_name_time ON e_event (name, ts_server DESC);
-- Партиционирование по месяцу — сырые события живут 90 дней (R-AN-10)

-- ─── Блок 2 из DATABASE.md ───
-- ---------- Страны и платформы ----------

CREATE TABLE e_country (
  code TEXT PRIMARY KEY,          -- ISO 3166-1
  name_ru TEXT NOT NULL,
  name_en TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE e_series_country (
  series_id   BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  country_code TEXT  NOT NULL REFERENCES e_country(code) ON DELETE RESTRICT,
  PRIMARY KEY (series_id, country_code)
);
-- Канал или платформа сериала (фильтр S-02, F-02-03).
--
-- Источник — `networks` карточки TMDB: там лежат и вещательные сети (AMC, HBO),
-- и стриминговые платформы (Netflix, Apple TV+), а «канал или платформа» в
-- спецификации — это один фильтр. Производственные компании сюда не пишутся:
-- это студия, её дело M10 (F-10-03).
--
-- Идентификатор — число TMDB, а не слаг: переименование сети не должно
-- разрывать связь с уже записанными сериалами.
CREATE TABLE e_network (
  id           INTEGER PRIMARY KEY,        -- идентификатор TMDB
  name         TEXT NOT NULL,
  country_code TEXT REFERENCES e_country(code) ON DELETE SET NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE e_series_network (
  series_id  BIGINT  NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  network_id INTEGER NOT NULL REFERENCES e_network(id) ON DELETE RESTRICT,
  PRIMARY KEY (series_id, network_id)
);
CREATE INDEX ix_network_name ON e_network (name);
CREATE TABLE e_rating_platform (
  code      TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  scale_max NUMERIC(4,1) NOT NULL DEFAULT 10,
  priority  SMALLINT NOT NULL DEFAULT 100,   -- порядок показа после IMDb/TMDB/сайта
  active    BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------- Ключевые слова ----------

CREATE TABLE e_keyword (
  id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  value  TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE e_series_keyword (
  series_id  BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  keyword_id BIGINT NOT NULL REFERENCES e_keyword(id) ON DELETE CASCADE,
  PRIMARY KEY (series_id, keyword_id)
);

-- ---------- Справочник ролей ----------
-- Роли как CHECK-констрейнт в e_role_assignment не хранятся:
-- добавление роли требовало бы миграции схемы.

CREATE TABLE e_role (
  code        TEXT PRIMARY KEY CHECK (code IN ('editor','analyst','admin')),
  title       TEXT NOT NULL,
  description TEXT
);

-- ---------- Варианты изображения ----------
-- e_image хранит оригинал; варианты по ширине — отдельно.
-- Отдача идёт первым попаданием по запросу, не по выбору клиента (ADR-005).

CREATE TABLE e_image_variant (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  image_id   BIGINT NOT NULL REFERENCES e_image(id) ON DELETE CASCADE,
  width      INTEGER NOT NULL,
  height     INTEGER NOT NULL,
  file       BYTEA  NOT NULL,
  mime       TEXT   NOT NULL,
  bytes      INTEGER NOT NULL,
  -- Имя файла содержит хеш содержимого, поэтому кэш immutable корректен
  checksum   TEXT   NOT NULL,
  CONSTRAINT uq_variant UNIQUE (image_id, width)
);
CREATE INDEX ix_variant_pick ON e_image_variant (image_id, width);

-- ---------- Голос «Полезно» ----------

CREATE TABLE e_helpful_vote (
  user_id     BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  material_id BIGINT NOT NULL REFERENCES e_material(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, material_id)
);
CREATE INDEX ix_helpful_material ON e_helpful_vote (material_id);

-- ---------- Сессии ----------
-- Таблица для connect-pg-simple. Схема Store, а не наша: менять её нельзя,
-- пока установлена эта библиотека, иначе сессии перестанут читаться.
-- Сессия в БД, а не в памяти (R-SEC-02): перезапуск процесса не должен
-- выкидывать человека из аккаунта посреди работы.

CREATE TABLE session (
  sid     varchar NOT NULL COLLATE "default",
  sess    json    NOT NULL,
  expire  timestamp(6) NOT NULL,
  -- Без «NOT NULL» в ограничении: публичная схема connect-pg-simple его
  -- содержит, а PostgreSQL 18 такое уже не принимает. Первичный ключ и так
  -- запрещает пустое значение.
  CONSTRAINT session_pkey PRIMARY KEY (sid)
);
CREATE INDEX session_expire_idx ON session (expire);

-- ---------- Токены входа ----------
-- Три сущности (подтверждение email, восстановление пароля, вход) сведены в
-- одну таблицу с типом: они отличаются только сроком и целью. Четвёртая,
-- E-TwoFactor, осталась своей таблицей — см. e_two_factor ниже.

CREATE TABLE e_auth_token (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  kind       TEXT   NOT NULL
             CHECK (kind IN ('email_verify','password_reset','two_factor','login')),
  token_hash BYTEA  NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  CONSTRAINT uq_auth_token UNIQUE (token_hash)
);
CREATE INDEX ix_auth_token_user ON e_auth_token (user_id, kind) WHERE used_at IS NULL;

-- ---------- Двухфакторная проверка ----------
-- Секрет TOTP не ложится в e_auth_token, хотя раньше E-TwoFactor считалась
-- одной из четырёх сущностей, сведённых в e_auth_token. Там лежит то, что
-- гасится после использования и живёт 30 минут, а здесь — то, что живёт
-- месяцами: секрет, дата включения и последний принятый шаг времени.
-- Правило «код одного шага принимается один раз» (F-01-05 §8) без последнего
-- шага невыполнимо: чтобы отклонить повтор, нужно помнить, какой уже был.
--
-- Отсутствие строки означает «2FA не настроена», а не выключенную 2FA:
-- служебным ролям отключение запрещено (F-01-05 §8), поэтому третье
-- состояние было бы лишним и только путало.

CREATE TABLE e_two_factor (
  user_id            BIGINT PRIMARY KEY REFERENCES e_user(id) ON DELETE CASCADE,
  secret_enc         BYTEA  NOT NULL,   -- шифротекст секрета, ключ шифрования данных
  enabled_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accepted_step BIGINT            -- шаг времени по RFC 6238, шаг 30 с
);

-- Резервные коды: десять на аккаунт, одноразовые. Хранится не пароль и не
-- открытый код, а HMAC под ключом HMAC с доменом `backup-code:` — по нему
-- код находится одним запросом, а перебор в 10 знаков бессмыслен.
-- argon2 здесь не нужен и был бы хуже: иначе проверка перебирала бы все десять
-- строк на каждой попытке входа.

CREATE TABLE e_two_factor_code (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id   BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  code_hash BYTEA  NOT NULL,
  used_at   TIMESTAMPTZ,
  CONSTRAINT uq_two_factor_code UNIQUE (user_id, code_hash)
);
CREATE INDEX ix_two_factor_code_user ON e_two_factor_code (user_id) WHERE used_at IS NULL;

-- ---------- Письма в очереди (F-01-12) ----------
-- Письмо уходит не из обработчика запроса, а из очереди: отправка занимает
-- секунды, а человек не должен ждать её (F-01-04 §8, R-SEC-06). Заодно
-- письмо переживает перезапуск сервера — напечатанное в консоль ссылку
-- приходилось бы искать заново.
--
-- Токен лежит только в теле письма и больше нигде в открытом виде: в
-- отдельную колонку он не вынесен, чтобы его нельзя было вынуть из письма.

CREATE TABLE e_mail (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind            TEXT   NOT NULL
                  CHECK (kind IN ('email_verify','email_taken','password_reset','password_changed',
                                  'email_change','email_change_requested','email_changed',
                                  'two_factor_enabled','deletion_requested','data_export_ready')),
  -- Адрес получателя шифруется тем же ключом, что и в e_user: открытым он
  -- не лежит ни в одной таблице проекта.
  recipient_enc   BYTEA  NOT NULL,
  locale          TEXT   NOT NULL DEFAULT 'ru' CHECK (locale IN ('ru','en')),
  subject         TEXT   NOT NULL,
  body            TEXT   NOT NULL,
  status          TEXT   NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','sending','sent','failed')),
  attempts        SMALLINT NOT NULL DEFAULT 0,
  -- Отметка браузера, заказавшего письмо (H-51). Хеш: подписанная cookie
  -- живёт недолго, и по её значению в базе искать письма нельзя. NULL у писем,
  -- которые браузер не заказывал (служебные, по смене адреса).
  browser_id      BYTEA,
  -- Письмо забирает один работник, и повтор должен случиться не раньше
  -- следующей попытки: время следующей попытки и есть признак «занято».
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);
-- Выборка идёт по времени следующей попытки и только по неотправленным:
-- отправленные письма в индексе не должны мешали.
CREATE INDEX ix_mail_pending ON e_mail (next_attempt_at) WHERE status IN ('queued','sending');
-- Демо-помощник ищет письмо своего браузера (H-51), чистка — письма старше
-- семи дней (F-01-12 §8(в)). Оба идут по времени, а не по номеру.
CREATE INDEX ix_mail_browser ON e_mail (browser_id, created_at DESC) WHERE browser_id IS NOT NULL;
CREATE INDEX ix_mail_created ON e_mail (created_at);

-- ---------- История ника ----------
-- Нельзя молча переименовать: старые ссылки на профиль должны остаться
-- рабочими, а ник может быть занят повторно после освобождения.

CREATE TABLE e_nickname_history (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  nickname   TEXT   NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to   TIMESTAMPTZ
);
CREATE INDEX ix_nick_history ON e_nickname_history (nickname);

-- ---------- Смена адреса (F-01-06 §4) ----------
-- Заявка на смену: новый адрес лежит отдельно от e_user и не действует до
-- подтверждения. Пока человек не доказал владение новым адресом, аккаунт
-- остаётся на старом — иначе подтверждение чужого адреса отнимало бы вход.
--
-- Заявка на пользователя одна: новая отменяет предыдущую. Две одновременные
-- смены означали бы, что подтверждение старой применяет адрес, который
-- человек уже передумал.
--
-- Адрес зашифрован тем же ключом, что и в e_user: открытым он не лежит нигде.

CREATE TABLE e_email_change (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  email_enc    BYTEA  NOT NULL,        -- зашифрованный новый адрес
  token_hash   BYTEA  NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_email_change_token UNIQUE (token_hash),
  CONSTRAINT uq_email_change_user UNIQUE (user_id)
);
CREATE INDEX ix_email_change_expires ON e_email_change (expires_at);

-- ---------- Экспорт данных (F-01-10 §4) ----------
-- Выгрузка целиком: профиль, настройки, статусы, отметки, оценки, материалы,
-- уведомления, устройства. Чужие данные и служебные заметки модерации в файл
-- не попадают — это проверяется сборкой, а не договорённостью.
--
-- Сам файл лежит в базе, а не в файловой системе: проект запрещает хранить
-- пользовательские данные на диске приложения, а требование 3.3.1 Бланка
-- говорит о хранении данных в БД. Рядом — sha256 файла: по нему видно, что
-- отдали ровно то, что собрали, и файл не подменили на диске.
--
-- Ссылка одноразовая по сроку: токен в открытом виде не хранится, только его
-- хеш, как у остальных ссылок проекта (R-SEC-07).

CREATE TABLE e_export_job (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES e_user(id) ON DELETE CASCADE,
  status       TEXT   NOT NULL DEFAULT 'queued'
               CHECK (status IN ('queued','building','ready','failed')),
  payload      TEXT,                       -- собранный JSON; NULL, пока не готов
  size_bytes   BIGINT,
  sha256       BYTEA,                     -- хеш файла: что отдали — то, что собрали
  -- Токен ссылки появляется вместе с готовым файлом: до сборки его не
  -- существует, и выдумывать его заранее незачем. У готового файла он
  -- обязателен — иначе ссылка была бы неоткрываемой.
  token_hash   BYTEA,
  -- Язык письма со ссылкой фиксируется на момент заказа: к моменту сборки
  -- человек мог сменить язык, и письмо пришло бы не на том (F-01-10 §17).
  locale       TEXT   NOT NULL DEFAULT 'ru' CHECK (locale IN ('ru','en')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,               -- ссылка живёт 24 часа после готовности
  ready_at     TIMESTAMPTZ,
  failed_at    TIMESTAMPTZ,
  CONSTRAINT uq_export_token UNIQUE (token_hash),
  -- Готовый файл обязан иметь срок и токен: ссылка без срока живёт вечно, а
  -- это уже не выгрузка, а постоянный доступ к архиву чужих данных.
  CONSTRAINT ck_export_ready CHECK (
    status <> 'ready' OR (expires_at IS NOT NULL AND token_hash IS NOT NULL)
  )
);
-- Пауза 24 часа между выгрузками (EC-A21) считается по последней заявке, а
-- не по последней готовой: иначе два запроса подряд, пока первый собирается,
-- обошли бы паузу.
CREATE INDEX ix_export_user ON e_export_job (user_id, requested_at DESC);
CREATE INDEX ix_export_queue ON e_export_job (status, requested_at) WHERE status IN ('queued','building');

-- ---------- Блокировка поля от перезаписи импортом ----------
-- Механизм EC-R8 и F-10-03(а): ручное значение помечено происхождением.

CREATE TABLE e_field_lock (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id  BIGINT NOT NULL REFERENCES e_series(id) ON DELETE CASCADE,
  field      TEXT   NOT NULL,
  set_by     BIGINT REFERENCES e_user(id) ON DELETE SET NULL,
  set_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_value BYTEA,        -- последнее значение от импорта, для «сбросить к импорту»
  CONSTRAINT uq_field_lock UNIQUE (series_id, field)
);

-- ---------- Кадры заставки ----------

CREATE TABLE e_splash_frame (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  series_id   BIGINT REFERENCES e_series(id) ON DELETE SET NULL,
  image_id    BIGINT NOT NULL REFERENCES e_image(id) ON DELETE RESTRICT,
  ordinal     SMALLINT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE
);
-- Порядковый номер уникален только среди активных кадров: снятый кадр
-- не должен мешать поставить другой на его место. Частичная уникальность
-- в PostgreSQL — это индекс, а не ограничение (UNIQUE ... WHERE не парсится).
CREATE UNIQUE INDEX uq_splash_ordinal ON e_splash_frame (ordinal) WHERE active;

-- ---------- Согласие на cookies ----------

CREATE TABLE e_consent (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  anon_id    TEXT,                       -- гость
  user_id    BIGINT REFERENCES e_user(id) ON DELETE CASCADE,
  category   TEXT NOT NULL CHECK (category IN ('necessary','analytics')),
  granted    BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_consent_user ON e_consent (user_id, category) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_consent_anon ON e_consent (anon_id, category) WHERE anon_id IS NOT NULL;

-- ---------- Настройки системы и правила подборок ----------

CREATE TABLE e_system_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  changed_by BIGINT REFERENCES e_user(id) ON DELETE SET NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE e_collection_rule (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  collection_id BIGINT REFERENCES e_collection(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('manual','by_genre','by_year','by_rating','by_platform')),
  params        JSONB NOT NULL,
  active        BOOLEAN NOT NULL DEFAULT TRUE
);

-- ─── Блок 3 из DATABASE.md ───
-- ─── Роль приложения ────────────────────────────────────────────────────────
-- Владельцем таблиц остаётся миграционная роль. Это не формальность:
-- REVOKE ... FROM PUBLIC не отнимает права у владельца, поэтому защита
-- R-SQL-01 держится только тогда, когда приложение подключается НЕ владельцем.
-- Проверено на PostgreSQL 18.6: под владельцем INSERT в e_audit_log проходит
-- после REVOKE, под ролью st_app — нет.

-- Роль принадлежит кластеру, а не базе, поэтому на второй базе того же
-- сервера обычный CREATE ROLE упал бы с «role already exists». Отсюда DO-блок:
-- он идемпотентен и на второй базе только выдаёт права.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'st_app') THEN
    CREATE ROLE st_app LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO st_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO st_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO st_app;

-- R-SQL-01: журнал аудита — только чтение для роли приложения.
REVOKE INSERT, UPDATE, DELETE ON e_audit_log FROM st_app;

-- R-SQL-03: оценка не удаляется строкой — исключение помечается counted = false.
REVOKE DELETE ON e_rating FROM st_app;

-- R-SQL-02: запрет удаления действует для всех, включая владельца,
-- потому что это правило таблицы, а не привилегия.
CREATE RULE no_delete_user AS ON DELETE TO e_user DO INSTEAD NOTHING;
