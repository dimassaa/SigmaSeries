// Структурированные данные списковых страниц (R-SEO-12, таблица SEO §2).
//
// Разметка описывает только то, что видно на странице (R-SEO-18): порядок
// элементов совпадает с порядком выдачи, названия — с подписями карточек.
// Адреса относительные, как и у разметки карточки сериала: их разрешает
// поисковик, а абсолютный адрес в данных пришлось бы собирать из `baseUrl`,
// которого у вида нет.

/**
 * Главная — `WebSite`.
 *
 * @param {{name: string, locale: string}} args
 * @returns {Record<string, any>}
 */
export function websiteJsonLd({ name, locale }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name,
    url: `/${locale}/`,
    inLanguage: locale,
  };
}

/**
 * Список страниц каталога или жанра — `ItemList`.
 *
 * @param {{locale: string, items: Array<{slug: string, title: string}>}} args
 * @returns {Record<string, any>|null} `null`, если показывать нечего
 */
export function itemListJsonLd({ locale, items }) {
  if (!items || items.length === 0) return null;
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    numberOfItems: items.length,
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      url: `/${locale}/series/${item.slug}`,
      name: item.title,
    })),
  };
}

/**
 * Хлебные крошки — `BreadcrumbList`.
 *
 * @param {{trail: Array<{name: string, path?: string}>}} args последняя крошка
 *   без `path`: она и есть текущая страница
 * @returns {Record<string, any>}
 */
export function breadcrumbJsonLd({ trail }) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: trail.map((crumb, index) => {
      const node = {
        '@type': 'ListItem',
        position: index + 1,
        name: crumb.name,
      };
      if (crumb.path) node.item = crumb.path;
      return node;
    }),
  };
}

/**
 * Несколько сущностей в одном блоке: страница может обещать и список, и
 * крошки, а `<script type="application/ld+json">` в оболочке один.
 *
 * @param {object[]} parts
 * @returns {Record<string, any>}
 */
export function jsonLdGraph(parts) {
  return {
    '@context': 'https://schema.org',
    '@graph': parts.filter(Boolean).map((part) => {
      const copy = { ...part };
      delete copy['@context'];
      return copy;
    }),
  };
}
