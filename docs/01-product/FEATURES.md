# FEATURES — реестр фич

> Генерируется скриптом `tools/docs-build/build_registries.py` из `features/M*.md`. Описаны модули: M0, M1, M2, M3, M4, M5, M6, M7, M8, M9, M10, M11, M12. Остальные — следующими партиями. Уровень: P0 — нужно для защиты, P1 — ценность, P2 — полировка (`PLAN` §8).

| Модуль | Фич | P0 | P1 | P2 |
|---|---|---|---|---|
| M0 Каркас оболочки | 8 | 7 | 1 | 0 |
| M1 Идентичность и роли | 12 | 11 | 1 | 0 |
| M2 Каталог | 11 | 10 | 1 | 0 |
| M3 Трекинг, календарь, уведомления | 12 | 10 | 1 | 1 |
| M4 Оценки и отзывы | 9 | 8 | 1 | 0 |
| M5 UGC и модерация | 9 | 7 | 2 | 0 |
| M6 Главная | 6 | 5 | 1 | 0 |
| M7 Итоги | 3 | 0 | 3 | 0 |
| M8 Аналитика и дашборды | 5 | 0 | 5 | 0 |
| M9 Администрирование | 7 | 6 | 1 | 0 |
| M10 Контент-студия | 11 | 8 | 3 | 0 |
| M11 Рекомендации | 3 | 0 | 3 | 0 |
| M12 Импорт данных | 10 | 10 | 0 | 0 |
| **Итого** | **106** | **82** | **23** | **1** |

| ID | Фича | Модуль | Уровень | Экраны | Операции | Спека |
|---|---|---|---|---|---|---|
| F-00-01 | Каркас страницы, левый rail и второе меню (UI-01, UI-03) | M0 | P0 | — | — | `features/M0-shell.md` |
| F-00-02 | Верхняя панель, тема и язык (UI-02, UI-08) | M0 | P0 | — | — | `features/M0-shell.md` |
| F-00-03 | Мобильная навигация (UI-05) | M0 | P0 | — | — | `features/M0-shell.md` |
| F-00-04 | Скелетоны загрузки (UI-07) | M0 | P0 | — | — | `features/M0-shell.md` |
| F-00-05 | Служебные страницы: «О проекте и данных», приватность, ошибки | M0 | P0 | S-40, S-42, S-43 | — | `features/M0-shell.md` |
| F-00-06 | Заставка (UI-06) | M0 | P1 | — | — | `features/M0-shell.md` |
| F-00-07 | Раскладка и адаптив | M0 | P0 | — | — | `features/M0-shell.md` |
| F-00-08 | Доступность с клавиатуры и на касании | M0 | P0 | — | — | `features/M0-shell.md` |
| F-01-01 | Регистрация | M1 | P0 | S-20 | — | `features/M1-identity.md` |
| F-01-02 | Подтверждение email | M1 | P0 | S-21 | — | `features/M1-identity.md` |
| F-01-03 | Вход, выход, сессии | M1 | P0 | S-19, S-32 | — | `features/M1-identity.md` |
| F-01-04 | Сброс пароля | M1 | P0 | S-22 | — | `features/M1-identity.md` |
| F-01-05 | Двухфакторная проверка | M1 | P0 | S-23 | — | `features/M1-identity.md` |
| F-01-06 | Профиль и настройки | M1 | P0 | S-32 | — | `features/M1-identity.md` |
| F-01-07 | Публичный профиль | M1 | P1 | S-18 | — | `features/M1-identity.md` |
| F-01-08 | Роли и проверка прав | M1 | P0 | — | — | `features/M1-identity.md` |
| F-01-09 | Ограничения: мьют и бан (применение) | M1 | P0 | — | — | `features/M1-identity.md` |
| F-01-10 | Удаление аккаунта и экспорт данных (OP-16) | M1 | P0 | — | OP-16 | `features/M1-identity.md` |
| F-01-11 | Защита входа и регистрации от перебора и спама | M1 | P0 | — | — | `features/M1-identity.md` |
| F-01-12 | Почтовый шлюз и «почтовый ящик разработчика» | M1 | P0 | S-84 | — | `features/M1-identity.md` |
| F-02-01 | Страница сериала | M2 | P0 | S-06 | — | `features/M2-catalog.md` |
| F-02-02 | Сезон и серия | M2 | P0 | S-07, S-08 | — | `features/M2-catalog.md` |
| F-02-03 | Каталог с фильтрами | M2 | P0 | S-02 | — | `features/M2-catalog.md` |
| F-02-04 | Жанры | M2 | P0 | S-03 | — | `features/M2-catalog.md` |
| F-02-05 | Подборки: страницы | M2 | P0 (S-04 — P1; правила OP-18 — P1) | S-04, S-05 | OP-18 | `features/M2-catalog.md` |
| F-02-06 | Поиск (UI-09, S-17) | M2 | P0 | S-17 | — | `features/M2-catalog.md` |
| F-02-07 | Подробная карточка постера (UI-10) | M2 | P0 | — | — | `features/M2-catalog.md` |
| F-02-08 | «Похожие» (базовые) | M2 | P0 | — | — | `features/M2-catalog.md` |
| F-02-09 | Персона | M2 | P1 | S-15 | — | `features/M2-catalog.md` |
| F-02-10 | Рейтинги: показ и нормализация | M2 | P0 | — | — | `features/M2-catalog.md` |
| F-02-11 | Карта сайта, robots, адреса | M2 | P0 | — | — | `features/M2-catalog.md` |
| F-03-01 | Статус просмотра | M3 | P0 | — | — | `features/M3-tracking.md` |
| F-03-02 | Отметки серий | M3 | P0 | — | — | `features/M3-tracking.md` |
| F-03-03 | Прогресс и «следующая серия» | M3 | P0 | — | OP-10 | `features/M3-tracking.md` |
| F-03-04 | Закладки | M3 | P0 | S-30 | — | `features/M3-tracking.md` |
| F-03-05 | Календарь | M3 | P0 (подписка ICS — F-03-12, P2) | S-16 | OP-08 | `features/M3-tracking.md` |
| F-03-06 | Правая панель «Предстоящие» (UI-04) | M3 | P0 | — | — | `features/M3-tracking.md` |
| F-03-07 | Подписки на выходы | M3 | P0 (подписка «объявят дату» — P1) | — | — | `features/M3-tracking.md` |
| F-03-08 | Уведомления о выходах: создание и доставка (OP-09) | M3 | P0 | — | OP-09 | `features/M3-tracking.md` |
| F-03-09 | Центр уведомлений и страница (UI-11, S-31) | M3 | P0 | S-31 | — | `features/M3-tracking.md` |
| F-03-10 | Настройки уведомлений (вкладка S-32) | M3 | P0 (email — P1, push — P2) | S-32 | — | `features/M3-tracking.md` |
| F-03-11 | Скрытие описаний непросмотренных серий | M3 | P1 | — | — | `features/M3-tracking.md` |
| F-03-12 | Календарь в приложения (ICS) | M3 | P2 | — | — | `features/M3-tracking.md` |
| F-04-01 | Оценка сериала | M4 | P0 | — | — | `features/M4-reviews.md` |
| F-04-02 | Оценка серии | M4 | P0 | — | — | `features/M4-reviews.md` |
| F-04-03 | Рейтинг сайта и гистограмма (OP-03) | M4 | P0 | — | OP-03 | `features/M4-reviews.md` |
| F-04-04 | Отзыв: форма и публикация | M4 | P0 | — | — | `features/M4-reviews.md` |
| F-04-05 | Список отзывов: группы, сортировки, спойлеры (OP-04) | M4 | P0 | S-09 | OP-04 | `features/M4-reviews.md` |
| F-04-06 | Голос «Полезно» | M4 | P0 | — | — | `features/M4-reviews.md` |
| F-04-07 | Жалоба на отзыв | M4 | P0 | — | — | `features/M4-reviews.md` |
| F-04-08 | Защита от накрутки | M4 | P0 базовая, P1 обнаружение аномалий | — | — | `features/M4-reviews.md` |
| F-04-09 | Страница отзыва | M4 | P1 | S-10 | — | `features/M4-reviews.md` |
| F-05-01 | Отзыв (M4 передаёт оценку и расчёт рейтинга) | M5 | P0 | — | OP-03, OP-04 | `features/M5-ugc-moderation.md` |
| F-05-02 | Проверка материала: нормализация, словарь, решение (OP-01) | M5 | P0 | — | OP-01 | `features/M5-ugc-moderation.md` |
| F-05-03 | Антиспам: бюджеты, кластеры, приоритизация очереди (OP-02) | M5 | P0 | — | OP-02 | `features/M5-ugc-moderation.md` |
| F-05-04 | Очередь модерации: решения редактора | M5 | P0 | — | — | `features/M5-ugc-moderation.md` |
| F-05-05 | Жалобы на материал (EC-U-общий) | M5 | P0 | — | — | `features/M5-ugc-moderation.md` |
| F-05-06 | Руководства: список, статья, редактор | M5 | P1 | — | — | `features/M5-ugc-moderation.md` |
| F-05-07 | Обсуждения: темы, посты, закрепление | M5 | P1 | — | — | `features/M5-ugc-moderation.md` |
| F-05-08 | Мьют и бан со стороны редактора | M5 | P0 | — | — | `features/M5-ugc-moderation.md` |
| F-05-09 | «Мои материалы» | M5 | P0 | S-35 | — | `features/M5-ugc-moderation.md` |
| F-06-01 | Три баннера дня (OP-05) | M6 | P0 | — | OP-05 | `features/M6-home.md` |
| F-06-02 | Отбор и запасные правила баннеров (OP-05) | M6 | P0 | — | OP-05 | `features/M6-home.md` |
| F-06-03 | Новинки | M6 | P0 | — | — | `features/M6-home.md` |
| F-06-04 | Бегущая строка подборок | M6 | P0 | — | — | `features/M6-home.md` |
| F-06-05 | Жанры внизу страницы | M6 | P0 | — | — | `features/M6-home.md` |
| F-06-06 | Строка «Для вас» и персонализация | M6 | P1 | — | — | `features/M6-home.md` |
| F-07-01 | Формирование итогов (OP-12) | M7 | P1 | — | OP-12 | `features/M7-insights.md` |
| F-07-02 | Просмотр, листание, автопереход | M7 | P1 | S-33 | — | `features/M7-insights.md` |
| F-07-03 | Шеринг-картинка | M7 | P1 | — | — | `features/M7-insights.md` |
| F-08-01 | Приём событий и таксономия (OP-15) | M8 | P1 | — | OP-15 | `features/M8-analytics.md` |
| F-08-02 | Словарь метрик | M8 | P1 | — | — | `features/M8-analytics.md` |
| F-08-03 | Обзор | M8 | P1 | — | — | `features/M8-analytics.md` |
| F-08-04 | Разрезы и пути | M8 | P1 | — | — | `features/M8-analytics.md` |
| F-08-05 | Качество модерации и поиска | M8 | P1 | — | — | `features/M8-analytics.md` |
| F-09-01 | Список пользователей и фильтры | M9 | P0 | S-71 | — | `features/M9-admin.md` |
| F-09-02 | Карточка пользователя: роли, ограничения, удаление | M9 | P0 | S-72 | — | `features/M9-admin.md` |
| F-09-03 | Журнал аудита | M9 | P0 | S-83 | — | `features/M9-admin.md` |
| F-09-04 | Резервные копии и проверка восстановления (OP-17) | M9 | P0 | — | OP-17 | `features/M9-admin.md` |
| F-09-05 | Онлайн: сейчас, среднее, пик (OP-14) | M9 | P0 | — | OP-14 | `features/M9-admin.md` |
| F-09-06 | Здоровье системы | M9 | P1 | S-82 | — | `features/M9-admin.md` |
| F-09-07 | Роли: выдача и снятие | M9 | P0 | — | — | `features/M9-admin.md` |
| F-10-01 | Список сериалов | M10 | P0 | S-73 | — | `features/M10-studio.md` |
| F-10-02 | Очередь неполных карточек и сомнительных пар | M10 | P0 | S-74 | — | `features/M10-studio.md` |
| F-10-03 | Правка карточки | M10 | P0 | S-75 | — | `features/M10-studio.md` |
| F-10-04 | Изображения и фокальная точка | M10 | P0 | — | — | `features/M10-studio.md` |
| F-10-05 | График серий | M10 | P0 | — | OP-09 | `features/M10-studio.md` |
| F-10-06 | Публикация, архив, удаление, история | M10 | P0 | — | — | `features/M10-studio.md` |
| F-10-07 | Подборки вручную | M10 | P0 | S-77 | OP-18 | `features/M10-studio.md` |
| F-10-08 | «Выбор редакции» и предпросмотр баннеров | M10 | P1 | S-78 | OP-05 | `features/M10-studio.md` |
| F-10-09 | Кадры заставки | M10 | P1 | S-79 | — | `features/M10-studio.md` |
| F-10-10 | Справочники | M10 | P0 сид, P1 редактор | S-80 | — | `features/M10-studio.md` |
| F-10-11 | Массовые операции | M10 | P1 | — | — | `features/M10-studio.md` |
| F-11-01 | Персональные рекомендации (OP-11) | M11 | P1 | — | OP-11 | `features/M11-recommendations.md` |
| F-11-02 | «Похожие»: базовый алгоритм (OP-11) | M11 | P1 | — | OP-11 | `features/M11-recommendations.md` |
| F-11-03 | Отключение и управление рекомендациями | M11 | P1 | — | — | `features/M11-recommendations.md` |
| F-12-01 | Отбор кандидатов из датасетов IMDb | M12 | P0 | — | OP-06 | `features/M12-import.md` |
| F-12-02 | Сопоставление с TMDB | M12 | P0 | — | OP-06 | `features/M12-import.md` |
| F-12-03 | Обогащение из TMDB | M12 | P0 | — | OP-06 | `features/M12-import.md` |
| F-12-04 | «Новинки и идущие» через TMDB | M12 | P0 | — | OP-06 | `features/M12-import.md` |
| F-12-05 | Загрузка и подготовка изображений | M12 | P0 | — | OP-06 | `features/M12-import.md` |
| F-12-06 | Запись в каталог, состояние выхода, полнота | M12 | P0 | — | OP-07, OP-09 | `features/M12-import.md` |
| F-12-07 | Расписание запусков | M12 | P0 | — | — | `features/M12-import.md` |
| F-12-08 | Отчёты и экран «Импорт» | M12 | P0 | S-76 | — | `features/M12-import.md` |
| F-12-09 | Надёжность запуска | M12 | P0 | — | — | `features/M12-import.md` |
| F-12-10 | Режим защиты: снимок данных | M12 | P0 | — | OP-17 | `features/M12-import.md` |
