// Каталог сообщений интерфейса (R-I18N-01, R-I18N-02).
//
// Требования, которые здесь действуют:
//  · строк в коде и разметке нет — только ключи;
//  · для каждого ключа есть ru и en, резерва нет;
//  · сообщения не склеиваются из кусков;
//  · ключ на��ивается как `экран.компонент.элемент`.
//
// Отсутствие ключа бросает исключение, а не печатает «[ключ]»: на странице
// это выглядело бы как недоделка, а при сборке — как ошибка в CI, где её и
// надо ловить.

const MESSAGES = {
  ru: {
    'app.title': 'SigmaSeries',
    'app.skipToContent': 'Перейти к содержимому',
    'app.theme.toggle': 'Сменить тему',
    'app.locale.current': 'Русский',
    'app.locale.other': 'English',
    'app.locale.switchTo': 'Перейти на {language}',
    'nav.catalog': 'Каталог',
    'nav.calendar': 'Календарь',
    'nav.search': 'Поиск',
    'nav.signIn': 'Войти',

    'home.title': 'Сериалы: что выходит и что смотреть',
    'home.banners.heading': 'Баннеры',
    'home.banners.reason.new': 'Новинка',
    'home.banners.reason.classic': 'Классика',
    'home.banners.reason.editorial': 'Выбор редакции',
    'home.banners.rating': 'IMDb {rating}',
    'home.banners.empty': 'Каталог пока пуст: баннеры появятся после первой загрузки.',

    'home.fresh.heading': 'Новинки',
    'home.fresh.empty': 'Пока пусто: недавно вышедших сериалов нет.',
    'home.fresh.itemLabel': '{title}, {year}',

    'home.collections.heading': 'Подборки',
    'home.collections.empty': 'Подборок пока нет.',
    'home.collections.itemLabel': 'Подборка «{title}», {count} сериалов',
    'home.collections.more': 'Ещё подборки',

    'home.genres.heading': 'Жанры',
    'home.genres.empty': 'Жанров пока нет.',
    'home.genres.itemLabel': 'Жанр {title}',

    'error.notFound.title': 'Страница не найдена',
    'error.notFound.text': 'Такого адреса нет. Проверьте ссылку или вернитесь на главную.',
    'error.notFound.home': 'На главную',
    'error.generic.title': 'Что-то пошло не так',
    'error.generic.text': 'Страница не загрузилась. Попробуйте обновить её или вернитесь позже.',
    'error.generic.retry': 'Обновить',

    'signin.title': 'Вход',
    'signin.heading': 'Вход в аккаунт',
    'signin.email': 'Email',
    'signin.email.type': 'text',
    'signin.email.autocomplete': 'email',
    'signin.password': 'Пароль',
    'signin.password.autocomplete': 'current-password',
    'signin.submit': 'Войти',
    'signin.submit.pending': 'Проверяем…',
    'signin.forgot': 'Забыли пароль?',
    
    'signin.noAccount': 'Нет аккаунта',
    'signin.register': 'Зарегистрироваться',
    'signin.error.required': 'Заполните это поле',
    'signin.error.email': 'Проверьте адрес: похоже на опечатку',
    'signin.error.credentials': 'Неверный email или пароль',
    'signin.error.tooMany': 'Слишком много попыток. Попробуйте через {seconds} с',
    'signin.error.csrf': 'Форма устарела. Обновите страницу.',
    'signin.error.blocked': 'Аккаунт заблокирован. {reason}',
    'signin.error.deletePending': 'Вы запросили удаление аккаунта.',
    'signin.error.deleteCancel': 'Отменить удаление',
    'signin.error.tooLong': 'Пароль слишком длинный',
    'signin.state.confirmEmail': 'Подтвердите email, чтобы продолжить',
    'signin.pow': 'Проверка…',
    'signout.submit': 'Выйти',

    'register.title': 'Регистрация',
    'register.heading': 'Регистрация',
    'register.progress': 'Шаги регистрации',
    'register.stepLabel': 'Шаг {n}',
    'register.stepOf': 'Шаг {n} из {total}',
    'register.email': 'Email',
    'register.nickname': 'Ник',
    'register.nickname.hint': '3–24 символа: латиница, кириллица, цифры, «_» и «-»',
    'register.password': 'Пароль',
    'register.password.hint': 'Не короче {min} символов',
    'register.consent': 'Я принимаю правила и политику обработки данных',
    'register.submit': 'Создать аккаунт',
    'register.haveAccount': 'Уже есть аккаунт',
    'register.signIn': 'Войти',
    'register.step2.title': 'Проверьте почту',
    'register.step2.lead': 'Мы отправили письмо на {email}. Откройте ссылку в нём, чтобы продолжить.',
    'register.step2.sent': 'Письмо отправлено повторно',
    'register.step2.spam': 'Письма попадают в спам — проверьте эту папку, если ссылки нет через пару минут.',
    'register.step2.resend': 'Отправить ещё раз',
    'register.step2.change': 'Изменить email',
    'register.step3.title': 'Выберите любимые',
    'register.step3.skip': 'Пропустить',

    'register.error.csrf': 'Форма устарела. Обновите страницу.',
    'register.error.tooMany': 'Слишком много регистраций с этого адреса. Попробуйте через час.',
    'register.error.consent': 'Без согласия с правилами аккаунт создать нельзя',
    'register.error.consent_required': 'Отметьте согласие с правилами и политикой',
    'register.error.fields': 'Проверьте отмеченные поля',
    'register.error.cooldown': 'Письмо уже отправлялось. Повторите через {seconds} с',
    'register.error.nick_ask': 'Проверяем ник…',
    'register.error.nick_free': 'Ник свободен',
    'register.error.nick_lookup': 'Не удалось проверить ник. Попробуйте ещё раз.',

    'register.error.email_required': 'Укажите email',
    'register.error.email_invalid': 'Проверьте адрес: похоже на опечатку',
    'register.error.email_too_long': 'Адрес слишком длинный',
    'register.error.nick_required': 'Придумайте ник',
    'register.error.nick_too_short': 'Ник короче 3 символов',
    'register.error.nick_too_long': 'Ник длиннее 24 символов',
    'register.error.nick_charset': 'Допустимы только латиница, кириллица, цифры, «_» и «-»',
    'register.error.nick_edges': 'Ник не начинается и не кончается на «_» или «-»',
    'register.error.nick_reserved': 'Этот ник зарезервирован',
    'register.error.nick_blocked': 'Этот ник не проходит проверку. Выберите другой',
    'register.error.nick_taken': 'Ник уже занят',
    'register.error.nick_is_email': 'Ник не должен совпадать с адресом',
    'register.error.nick_is_password': 'Ник не должен совпадать с паролем',
    'register.error.password_too_short': 'Пароль короче {min} символов',
    'register.error.password_too_long': 'Пароль длиннее {max} символов',
    'register.error.password_common': 'Это один из самых распространённых паролей',
    'register.error.password_one_char': 'Пароль из одного повторяющегося символа',
    'register.error.password_triple_char': 'Символ повторяется трижды подряд',
    'register.error.timezone_invalid': 'Не удалось определить часовой пояс',

    'verify.title': 'Подтверждение email',
    'verify.text': 'Подтвердите адрес, чтобы открыть права зрителя.',
    'verify.submit': 'Подтвердить email',
    'verify.stale.title': 'Ссылка устарела',
    'verify.stale.text': 'Ссылка больше не работает: она одноразовая и живёт 30 минут.',
    'verify.stale.back': 'Зарегистрироваться заново',
    'verify.already.title': 'Email уже подтверждён',
    'verify.already.text': 'Этот адрес уже подтверждён. Можно войти.',
    'verify.already.login': 'Войти',

    'reset.title': 'Восстановление пароля',
    'reset.heading': 'Восстановление пароля',
    'reset.lead': 'Укажите адрес аккаунта — пришлём ссылку для смены пароля.',
    'reset.email': 'Email',
    'reset.submit': 'Отправить ссылку',
    // Ответ одинаков для занятого и свободного адреса (R-SEC-06): он не
    // подтверждает и не отрицает существование аккаунта.
    'reset.sent.title': 'Письмо отправлено',
    'reset.sent.text': 'Если такой аккаунт есть, мы отправили письмо со ссылкой. Проверьте почту, в том числе папку «Спам».',
    'reset.form.heading': 'Новый пароль',
    'reset.password': 'Новый пароль',
    'reset.password.hint': 'Не короче {min} символов. Пробелы и любые знаки разрешены',
    'reset.change': 'Сменить пароль',
    'reset.reveal': 'Показать',
    'reset.reveal.hide': 'Скрыть',
    'reset.stale.title': 'Ссылка устарела',
    'reset.stale.text': 'Ссылка больше не работает: она одноразовая и живёт 30 минут. Запросите новую.',
    'reset.stale.submit': 'Прислать новую',
    'reset.done.title': 'Пароль изменён',
    'reset.done.text': 'Пароль обновлён, все сессии отозваны. Войдите с новым паролем.',
    'reset.login': 'Войти',
    'reset.error.csrf': 'Форма устарела. Обновите страницу.',
    'reset.error.email': 'Проверьте адрес: похоже на опечатку',
    'reset.error.tooMany': 'Слишком много заявок. Попробуйте через {seconds} с',
    'reset.error.password_too_short': 'Пароль короче {min} символов',
    'reset.error.password_too_long': 'Пароль длиннее {max} символов',
    'reset.error.password_common': 'Это один из самых распространённых паролей',
    'reset.error.password_one_char': 'Пароль из одного повторяющегося символа',
    'reset.error.password_triple_char': 'Символ повторяется трижды подряд',

    // ─── Двухфакторная проверка (F-01-05) ──────────────────────────────────
    'twoFactor.title': 'Двухфакторная проверка',
    'twoFactor.lead': 'Введите код из приложения-аутентификатора. Если код не подошёл, проверьте время на устройстве.',
    'twoFactor.code': 'Код подтверждения',
    'twoFactor.submit': 'Подтвердить',
    'twoFactor.useBackup': 'Использовать резервный код',
    'twoFactor.backupCode': 'Резервный код',
    'twoFactor.backupHint': 'Десять символов, один раз. Каждый код работает только один раз.',
    'twoFactor.backupSubmit': 'Войти по резервному коду',
    'twoFactor.codesFew': 'Осталось резервных кодов: {count}. Стоит завести новые.',

    'twoFactor.setup.title': 'Настройка двухфакторной проверки',
    'twoFactor.setup.lead': 'Отсканируйте код приложением-аутентификатором или введите ключ вручную, затем подтвердите шестизначным кодом.',
    'twoFactor.setup.scan': 'Наведите камеру телефона на код',
    'twoFactor.setup.secret': 'Ключ вручную',
    'twoFactor.setup.code': 'Код из приложения',
    'twoFactor.setup.submit': 'Включить проверку',

    'twoFactor.backup.title': 'Резервные коды',
    'twoFactor.backup.lead': 'Если телефон потерян, один из этих кодов вернёт доступ в аккаунт.',
    'twoFactor.backup.once': 'Коды показываются один раз. Сохраните их сейчас — потом их нельзя увидеть снова.',
    'twoFactor.backup.download': 'Скачать',
    'twoFactor.backup.print': 'Распечатать',
    'twoFactor.backup.done': 'Продолжить',

    'twoFactor.error.code': 'Код не подошёл. Проверьте время на устройстве.',
    'twoFactor.error.replayed': 'Этот код уже использован. Дождитесь следующего.',
    'twoFactor.error.backup': 'Резервный код не подошёл',
    'twoFactor.error.setup': 'Код не совпал с тем, что ожидает приложение',
    'twoFactor.error.tooMany': 'Слишком много попыток. Повторите через {seconds} с',
    'twoFactor.error.csrf': 'Форма устарела. Обновите страницу.',

    // ─── Настройки (F-01-06) ────────────────────────────────────────────────
    'settings.title': 'Настройки',
    'settings.lead': 'Оформление, язык и приватность аккаунта.',
    'settings.sections': 'Разделы настроек',
    'settings.saved': 'Сохранено',
    'settings.guestNote': 'Гостевая сессия: тема и язык сохраняются в этом браузере, вход не требуется.',
    'settings.apply': 'Сохранить',
    'settings.theme': 'Вид',
    'settings.theme.light': 'Светлая',
    'settings.theme.dark': 'Тёмная',
    'settings.theme.system': 'Как в системе',
    'settings.language': 'Язык интерфейса',
    'settings.language.hint': 'Для этой страницы язык в адресе важнее: /ru/… и /en/… остаются отдельными страницами.',
    'settings.timezone': 'Часовой пояс',

    'settings.appearance.title': 'Язык и вид',
    'settings.profile.title': 'Профиль',
    'settings.notifications.title': 'Уведомления',
    'settings.security.title': 'Безопасность',

    'settings.profile.nickname': 'Ник',
    'settings.profile.history': 'Прежние ники',
    'settings.profile.changedAt': 'Ник уже менялся. Новый будет доступен через 30 дней.',
    // Ключи повторяют коды `checkNickname` без префикса: ключ строится как
// `settings.profile.error.<код>`, и расхождение в названии означало бы
// «нет ключа для языка ru» вместо понятного человеку текста.
'settings.profile.error.nick_required': 'Введите ник',
    'settings.profile.error.nick_too_short': 'Слишком короткий ник',
    'settings.profile.error.nick_too_long': 'Слишком длинный ник',
    'settings.profile.error.nick_charset': 'В нике только буквы, цифры и знаки',
    'settings.profile.error.nick_edges': 'Ник не может начинаться или кончиться знаком',
    'settings.profile.error.nick_reserved': 'Это имя зарезервировано',
    'settings.profile.error.nick_blocked': 'Это имя недопустимо',
    'settings.profile.error.nick_taken': 'Этот ник уже занят',
    'settings.profile.error.nick_is_email': 'Ник не может совпадать с адресом',
    'settings.profile.error.nick_is_password': 'Ник не может совпадать с паролем',
    'settings.profile.error.rate': 'Ник можно менять раз в 30 дней. Следующая смена через {days} дн.',

    'settings.notifications.legend': 'Письма и напоминания',
    'settings.notifications.all': 'Присылать уведомления',
    'settings.notifications.all.hint': 'О выходах серий, ответах и проверках. По умолчанию включено.',
    'settings.notifications.quiet': 'Тихие часы',
    'settings.notifications.quiet.hint': 'Не беспокоить ночью. Интервал задаёт M3.',
    'settings.notifications.categoriesHint': 'Состав категорий и каналов определяет M3; здесь сохраняются общие переключатели.',

    'settings.security.password': 'Пароль',
    'settings.security.current': 'Текущий пароль',
    'settings.security.new': 'Новый пароль',
    'settings.security.new.hint': 'Не короче {min} символов. Пробелы и любые знаки разрешены.',
    'settings.security.change': 'Сменить пароль',
    'settings.security.twoFactor': 'Двухфакторная проверка',
    'settings.security.twoFactor.on': 'Включена',
    'settings.security.twoFactor.off': 'Не настроена',
    'settings.security.confirm': 'Подтвердите паролем',
    'settings.security.regenerate': 'Новые резервные коды',
    'settings.security.disable': 'Отключить',
    'settings.security.enable': 'Настроить',
    'settings.security.required': 'Служебной роли 2FA отключить нельзя',
    'settings.security.backupLeft': 'Резервных кодов осталось: {count}.',
    'settings.security.devices': 'Устройства',
    'settings.security.devicesEmpty': 'Других устройств не залогинено',
    'settings.security.device': 'Устройство',
    'settings.security.revoke': 'Выйти',
    'settings.security.error.current': 'Текущий пароль неверен',
    // Коды `checkPasswordStrength` без префикса — ключ строится как
    // `settings.security.error.<код>`.
    'settings.security.error.password_too_short': 'Пароль короче {min} символов',
    'settings.security.error.password_too_long': 'Пароль длиннее {max} символов',
    'settings.security.error.password_common': 'Это один из самых распространённых паролей',
    'settings.security.error.password_one_char': 'Пароль из одного повторяющегося символа',
    'settings.security.error.password_triple_char': 'Символ повторяется трижды подряд',
    'settings.security.error.required': 'Служебной роли 2FA отключить нельзя',
    'settings.security.error.notEnabled': '2FA не настроена',
    'settings.security.error.device': 'Устройство не найдено или уже отозвано',
    'settings.security.error.action': 'Неизвестное действие',
    'settings.privacy.title': 'Приватность',
    'settings.privacy.legend': 'Что видно другим',
    'settings.privacy.stats': 'Показывать статистику в профиле',
    'settings.privacy.stats.hint': 'Сколько сериалов отмечено, оценок и отзывов. По умолчанию скрыто.',
    'settings.privacy.profile': 'Показывать профиль целиком',
    'settings.privacy.profile.hint': 'Список отмеченных и закладок. По умолчанию скрыто.',
    'settings.privacy.recs': 'Персональные рекомендации',
    'settings.privacy.recs.hint': 'Главная подбирает сериалы под ваши отметки. Включено по умолчанию.',
    'settings.error.csrf': 'Форма устарела. Обновите страницу.',
    'settings.error.theme': 'Такого вида нет',
    'settings.error.locale': 'Такого языка нет',
    'settings.error.timezone': 'Такого часового пояса нет',

    'common.back': 'Назад',
    'common.more': 'Ещё',
    'common.loading': 'Загрузка',
  },
  en: {
    'app.title': 'SigmaSeries',
    'app.skipToContent': 'Skip to content',
    'app.theme.toggle': 'Toggle theme',
    'app.locale.current': 'English',
    'app.locale.other': 'Русский',
    'app.locale.switchTo': 'Switch to {language}',
    'nav.catalog': 'Catalogue',
    'nav.calendar': 'Calendar',
    'nav.search': 'Search',
    'nav.signIn': 'Sign in',

    'home.title': 'TV series: what airs and what to watch',
    'home.banners.heading': 'Featured',
    'home.banners.reason.new': 'New release',
    'home.banners.reason.classic': 'Classic',
    'home.banners.reason.editorial': 'Editor’s pick',
    'home.banners.rating': 'IMDb {rating}',
    'home.banners.empty': 'The catalogue is empty: banners appear after the first import.',

    'home.fresh.heading': 'Fresh releases',
    'home.fresh.empty': 'Nothing here yet: no series aired recently.',
    'home.fresh.itemLabel': '{title}, {year}',

    'home.collections.heading': 'Collections',
    'home.collections.empty': 'No collections yet.',
    'home.collections.itemLabel': 'Collection “{title}”, {count} series',
    'home.collections.more': 'More collections',

    'home.genres.heading': 'Genres',
    'home.genres.empty': 'No genres yet.',
    'home.genres.itemLabel': 'Genre {title}',

    'error.notFound.title': 'Page not found',
    'error.notFound.text': 'There is no such address. Check the link or go back home.',
    'error.notFound.home': 'Go home',
    'error.generic.title': 'Something went wrong',
    'error.generic.text': 'The page could not be loaded. Try refreshing it, or come back later.',
    'error.generic.retry': 'Refresh',

    'signin.title': 'Sign in',
    'signin.heading': 'Sign in to your account',
    'signin.email': 'Email',
    'signin.email.type': 'text',
    'signin.email.autocomplete': 'email',
    'signin.password': 'Password',
    'signin.password.autocomplete': 'current-password',
    'signin.submit': 'Sign in',
    'signin.submit.pending': 'Checking…',
    'signin.forgot': 'Forgot password?',
    
    'signin.noAccount': 'No account yet',
    'signin.register': 'Sign up',
    'signin.error.required': 'This field is required',
    'signin.error.email': 'Check the address: it looks like a typo',
    'signin.error.credentials': 'Wrong email or password',
    'signin.error.tooMany': 'Too many attempts. Try again in {seconds} s',
    'signin.error.csrf': 'The form has expired. Reload the page.',
    'signin.error.blocked': 'Account is blocked. {reason}',
    'signin.error.deletePending': 'You requested account deletion.',
    'signin.error.deleteCancel': 'Cancel the deletion',
    'signin.error.tooLong': 'Password is too long',
    'signin.state.confirmEmail': 'Confirm your email to continue',
    'signin.pow': 'Checking…',
    'signout.submit': 'Sign out',

    'register.title': 'Sign up',
    'register.heading': 'Sign up',
    'register.progress': 'Sign-up steps',
    'register.stepLabel': 'Step {n}',
    'register.stepOf': 'Step {n} of {total}',
    'register.email': 'Email',
    'register.nickname': 'Nickname',
    'register.nickname.hint': '3–24 characters: Latin, Cyrillic, digits, “_” and “-”',
    'register.password': 'Password',
    'register.password.hint': 'At least {min} characters',
    'register.consent': 'I accept the rules and the data processing policy',
    'register.submit': 'Create account',
    'register.haveAccount': 'Already have an account',
    'register.signIn': 'Sign in',
    'register.step2.title': 'Check your inbox',
    'register.step2.lead': 'We sent a message to {email}. Open the link in it to continue.',
    'register.step2.sent': 'The message has been sent again',
    'register.step2.spam': 'Messages end up in spam — check that folder if the link does not arrive within a couple of minutes.',
    'register.step2.resend': 'Send again',
    'register.step2.change': 'Change the email',
    'register.step3.title': 'Pick your favourites',
    'register.step3.skip': 'Skip',

    'register.error.csrf': 'The form has expired. Reload the page.',
    'register.error.tooMany': 'Too many sign-ups from this address. Try again in an hour.',
    'register.error.consent': 'The account cannot be created without accepting the rules',
    'register.error.consent_required': 'Tick the box to accept the rules and the policy',
    'register.error.fields': 'Check the marked fields',
    'register.error.cooldown': 'The message was already sent. Repeat in {seconds} s',
    'register.error.nick_ask': 'Checking the nickname…',
    'register.error.nick_free': 'The nickname is free',
    'register.error.nick_lookup': 'Could not check the nickname. Try again.',

    'register.error.email_required': 'Enter your email',
    'register.error.email_invalid': 'Check the address: it looks like a typo',
    'register.error.email_too_long': 'The address is too long',
    'register.error.nick_required': 'Pick a nickname',
    'register.error.nick_too_short': 'The nickname is shorter than 3 characters',
    'register.error.nick_too_long': 'The nickname is longer than 24 characters',
    'register.error.nick_charset': 'Only Latin, Cyrillic, digits, “_” and “-” are allowed',
    'register.error.nick_edges': 'A nickname cannot start or end with “_” or “-”',
    'register.error.nick_reserved': 'This nickname is reserved',
    'register.error.nick_blocked': 'This nickname does not pass moderation. Pick another',
    'register.error.nick_taken': 'The nickname is already taken',
    'register.error.nick_is_email': 'A nickname cannot match the email address',
    'register.error.nick_is_password': 'A nickname cannot match the password',
    'register.error.password_too_short': 'The password is shorter than {min} characters',
    'register.error.password_too_long': 'The password is longer than {max} characters',
    'register.error.password_common': 'This is one of the most common passwords',
    'register.error.password_one_char': 'A password of a single repeated character',
    'register.error.password_triple_char': 'A character repeats three times in a row',
    'register.error.timezone_invalid': 'Could not determine the time zone',

    'verify.title': 'Email confirmation',
    'verify.text': 'Confirm the address to unlock viewer rights.',
    'verify.submit': 'Confirm email',
    'verify.stale.title': 'The link has expired',
    'verify.stale.text': 'This link no longer works: it is single-use and lives for 30 minutes.',
    'verify.stale.back': 'Sign up again',
    'verify.already.title': 'Email already confirmed',
    'verify.already.text': 'This address is already confirmed. You can sign in.',
    'verify.already.login': 'Sign in',

    'reset.title': 'Password recovery',
    'reset.heading': 'Password recovery',
    'reset.lead': 'Enter your account address and we will send a link to change the password.',
    'reset.email': 'Email',
    'reset.submit': 'Send the link',
    // The same answer for a taken and a free address (R-SEC-06): it neither
    // confirms nor denies that the account exists.
    'reset.sent.title': 'The message has been sent',
    'reset.sent.text': 'If such an account exists, we have sent a message with a link. Check your inbox, including the spam folder.',
    'reset.form.heading': 'New password',
    'reset.password': 'New password',
    'reset.password.hint': 'At least {min} characters. Spaces and any symbols are allowed',
    'reset.change': 'Change the password',
    'reset.reveal': 'Show',
    'reset.reveal.hide': 'Hide',
    'reset.stale.title': 'The link has expired',
    'reset.stale.text': 'This link no longer works: it is single-use and lives for 30 minutes. Request a new one.',
    'reset.stale.submit': 'Send a new one',
    'reset.done.title': 'The password has been changed',
    'reset.done.text': 'The password is updated and all sessions are revoked. Sign in with the new password.',
    'reset.login': 'Sign in',
    'reset.error.csrf': 'The form has expired. Reload the page.',
    'reset.error.email': 'Check the address: it looks like a typo',
    'reset.error.tooMany': 'Too many requests. Try again in {seconds} s',
    'reset.error.password_too_short': 'The password is shorter than {min} characters',
    'reset.error.password_too_long': 'The password is longer than {max} characters',
    'reset.error.password_common': 'This is one of the most common passwords',
    'reset.error.password_one_char': 'A password of a single repeated character',
    'reset.error.password_triple_char': 'A character repeats three times in a row',

    // ─── Two-factor verification (F-01-05) ─────────────────────────────────
    'twoFactor.title': 'Two-factor verification',
    'twoFactor.lead': 'Enter the code from your authenticator app. If it does not work, check the time on the device.',
    'twoFactor.code': 'Verification code',
    'twoFactor.submit': 'Confirm',
    'twoFactor.useBackup': 'Use a backup code',
    'twoFactor.backupCode': 'Backup code',
    'twoFactor.backupHint': 'Ten characters, one time only. Each code works exactly once.',
    'twoFactor.backupSubmit': 'Sign in with a backup code',
    'twoFactor.codesFew': 'Backup codes left: {count}. Consider generating new ones.',

    'twoFactor.setup.title': 'Set up two-factor verification',
    'twoFactor.setup.lead': 'Scan the code with an authenticator app or enter the key by hand, then confirm with a six-digit code.',
    'twoFactor.setup.scan': 'Point your phone camera at the code',
    'twoFactor.setup.secret': 'Key to enter by hand',
    'twoFactor.setup.code': 'Code from the app',
    'twoFactor.setup.submit': 'Turn on verification',

    'twoFactor.backup.title': 'Backup codes',
    'twoFactor.backup.lead': 'If you lose your phone, one of these codes restores access to the account.',
    'twoFactor.backup.once': 'Codes are shown once. Save them now — they cannot be seen again.',
    'twoFactor.backup.download': 'Download',
    'twoFactor.backup.print': 'Print',
    'twoFactor.backup.done': 'Continue',

    'twoFactor.error.code': 'The code did not match. Check the time on the device.',
    'twoFactor.error.replayed': 'This code has already been used. Wait for the next one.',
    'twoFactor.error.backup': 'The backup code did not match',
    'twoFactor.error.setup': 'The code does not match what the app expects',
    'twoFactor.error.tooMany': 'Too many attempts. Try again in {seconds} s',
    'twoFactor.error.csrf': 'The form has expired. Reload the page.',

    // ─── Settings (F-01-06) ────────────────────────────────────────────────
    'settings.title': 'Settings',
    'settings.lead': 'Appearance, language and account privacy.',
    'settings.sections': 'Settings sections',
    'settings.saved': 'Saved',
    'settings.guestNote': 'Guest session: the theme and language are kept in this browser; signing in is not required.',
    'settings.apply': 'Save',
    'settings.theme': 'Appearance',
    'settings.theme.light': 'Light',
    'settings.theme.dark': 'Dark',
    'settings.theme.system': 'Follow the system',
    'settings.language': 'Interface language',
    'settings.language.hint': 'For this page the language in the address wins: /ru/… and /en/… stay separate pages.',
    'settings.timezone': 'Time zone',

    'settings.appearance.title': 'Language and appearance',
    'settings.profile.title': 'Profile',
    'settings.notifications.title': 'Notifications',
    'settings.security.title': 'Security',

    'settings.profile.nickname': 'Nickname',
    'settings.profile.history': 'Earlier nicknames',
    'settings.profile.changedAt': 'The nickname has already been changed. A new one is available in 30 days.',
    // Ключи повторяют коды `checkNickname` без префикса: ключ строится как
// `settings.profile.error.<код>`, и расхождение в названии означало бы
// «нет ключа для языка en» вместо понятного человеку текста.
'settings.profile.error.nick_required': 'Enter a nickname',
    'settings.profile.error.nick_too_short': 'The nickname is too short',
    'settings.profile.error.nick_too_long': 'The nickname is too long',
    'settings.profile.error.nick_charset': 'A nickname may contain letters, digits and marks only',
    'settings.profile.error.nick_edges': 'A nickname may not start or end with a mark',
    'settings.profile.error.nick_reserved': 'This name is reserved',
    'settings.profile.error.nick_blocked': 'This name is not allowed',
    'settings.profile.error.nick_taken': 'This nickname is taken',
    'settings.profile.error.nick_is_email': 'A nickname may not match the address',
    'settings.profile.error.nick_is_password': 'A nickname may not match the password',
    'settings.profile.error.rate': 'The nickname can be changed once every 30 days. The next one in {days} d.',

    'settings.notifications.legend': 'Messages and reminders',
    'settings.notifications.all': 'Send notifications',
    'settings.notifications.all.hint': 'About series releases, replies and reviews. On by default.',
    'settings.notifications.quiet': 'Quiet hours',
    'settings.notifications.quiet.hint': 'Do not disturb at night. The interval is set by M3.',
    'settings.notifications.categoriesHint': 'The set of categories and channels is defined by M3; only the general switches are stored here.',

    'settings.security.password': 'Password',
    'settings.security.current': 'Current password',
    'settings.security.new': 'New password',
    'settings.security.new.hint': 'At least {min} characters. Spaces and any symbols are allowed.',
    'settings.security.change': 'Change the password',
    'settings.security.twoFactor': 'Two-factor verification',
    'settings.security.twoFactor.on': 'Enabled',
    'settings.security.twoFactor.off': 'Not set up',
    'settings.security.confirm': 'Confirm with your password',
    'settings.security.regenerate': 'New backup codes',
    'settings.security.disable': 'Turn off',
    'settings.security.enable': 'Set up',
    'settings.security.required': 'A staff role cannot turn 2FA off',
    'settings.security.backupLeft': 'Backup codes left: {count}.',
    'settings.security.devices': 'Devices',
    'settings.security.devicesEmpty': 'No other devices are signed in',
    'settings.security.device': 'Device',
    'settings.security.revoke': 'Sign out',
    'settings.security.error.current': 'The current password is wrong',
    // Коды `checkPasswordStrength` без префикса — ключ строится как
    // `settings.security.error.<код>`.
    'settings.security.error.password_too_short': 'The password is shorter than {min} characters',
    'settings.security.error.password_too_long': 'The password is longer than {max} characters',
    'settings.security.error.password_common': 'This is one of the most common passwords',
    'settings.security.error.password_one_char': 'A password of a single repeated character',
    'settings.security.error.password_triple_char': 'A character repeats three times in a row',
    'settings.security.error.required': 'A staff role cannot turn 2FA off',
    'settings.security.error.notEnabled': '2FA is not set up',
    'settings.security.error.device': 'The device is not found or already revoked',
    'settings.security.error.action': 'Unknown action',
    'settings.privacy.title': 'Privacy',
    'settings.privacy.legend': 'What others can see',
    'settings.privacy.stats': 'Show statistics on the profile',
    'settings.privacy.stats.hint': 'How many series are marked, rated, reviewed. Hidden by default.',
    'settings.privacy.profile': 'Show the full profile',
    'settings.privacy.profile.hint': 'List of marked series and bookmarks. Hidden by default.',
    'settings.privacy.recs': 'Personal recommendations',
    'settings.privacy.recs.hint': 'The home page picks series based on your marks. On by default.',
    'settings.error.csrf': 'The form has expired. Reload the page.',
    'settings.error.theme': 'No such appearance',
    'settings.error.locale': 'No such language',
    'settings.error.timezone': 'No such time zone',

    'common.back': 'Back',
    'common.more': 'More',
    'common.loading': 'Loading',
  },
};

/** Языки, для которых обязаны существовать все ключи. */
export const LOCALES = ['ru', 'en'];

/**
 * Названия языков для выбора.
 *
 * Живут здесь, а не в шаблоне: список языков нужен не только переключателю
 * в шапке, но и форме настроек (F-01-06), и в двух местах он обязан
 * совпадать.
 */
export const LOCALE_NAMES = { ru: 'Русский', en: 'English' };

/** Язык по умолчанию. Всегда русский, независимо от заголовков запроса (ADR-003). */
export const DEFAULT_LOCALE = 'ru';

export function isLocale(value) {
  return LOCALES.includes(value);
}

/**
 * Перевод по ключу.
 *
 * @param {string} locale ru | en
 * @param {string} key экран.компонент.элемент
 * @param {Record<string, string|number>} [params]
 * @returns {string}
 * @throws если ключа нет — это ошибка сборки, а не пустое место на странице
 */
export function t(locale, key, params = {}) {
  const dict = MESSAGES[locale] ?? MESSAGES[DEFAULT_LOCALE];
  const msg = dict[key];
  if (msg == null) {
    throw new Error(`Нет ключа «${key}» для языка «${locale}»`);
  }
  return msg.replace(/\{(\w+)\}/g, (m, name) => (name in params ? String(params[name]) : m));
}

/** Проверка полноты каталога: у каждого ключа есть все языки. */
export function missingKeys() {
  const base = Object.keys(MESSAGES[DEFAULT_LOCALE]);
  const bad = [];
  for (const locale of LOCALES) {
    for (const key of base) {
      if (MESSAGES[locale][key] == null) bad.push(`${locale}:${key}`);
    }
  }
  return bad;
}