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

    'common.back': 'Back',
    'common.more': 'More',
    'common.loading': 'Loading',
  },
};

/** Языки, для которых обязаны существовать все ключи. */
export const LOCALES = ['ru', 'en'];

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