// OP-06 и OP-07. Тесты.
// Спецификация: docs/01-product/features/M12-import.md; CONTENT-PLAN §3.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  titleKey,
  matchSeries,
  completeness,
  applyIncoming,
  runImport,
  YEAR_TOLERANCE,
} from '../src/services/import/pipeline.js';

const imdb = (title, year) => ({ tconst: 'tt1', title, year });
const tmdb = (title, year, extra = {}) => ({ id: 1, title, year, ...extra });

// ─── Ключ названия ────────────────────────────────────────────────────────────

test('ключ не зависит от регистра, пунктуации и артикля', () => {
  assert.equal(titleKey('The Office'), titleKey('Office'));
  assert.equal(titleKey('Breaking Bad!'), titleKey('breaking  bad'));
});

test('ключ приводит ё к е', () => {
  assert.equal(titleKey('Ёлки'), titleKey('Ёлки'.replace('Ё', 'Е')));
});

test('похожие названия не склеиваются', () => {
  assert.notEqual(titleKey('Office'), titleKey('Officer'));
});

// ─── OP-06. Сопоставление ─────────────────────────────────────────────────────

test('точное совпадение по названию и году', () => {
  const r = matchSeries(imdb('Breaking Bad', 2008), [tmdb('Breaking Bad', 2008)]);
  assert.equal(r.match.id, 1);
  assert.equal(r.reason, 'ok');
});

test('разница в годе в пределах допуска считается совпадением', () => {
  // Источники округляют по-разному; единица года — нормальная погрешность.
  const r = matchSeries(imdb('Breaking Bad', 2008), [tmdb('Breaking Bad', 2008 + YEAR_TOLERANCE)]);
  assert.ok(r.match, 'ожидалось совпадение в пределах допуска');
});

test('разница в годе сверх допуска — не совпадение', () => {
  const r = matchSeries(imdb('Breaking Bad', 2008), [tmdb('Breaking Bad', 2015)]);
  assert.equal(r.match, null);
  assert.equal(r.reason, 'год-не-совпал');
});

test('оригинальное название тоже сверяется', () => {
  // У TMDB название переведено, оригинал совпадает.
  const r = matchSeries(imdb('Breaking Bad', 2008), [tmdb('Во все тяжкие', 2008, { originalTitle: 'Breaking Bad' })]);
  assert.ok(r.match);
});

test('два кандидата одного года и названия дают пропуск, а не выбор', () => {
  // Год здесь не различает, а выбрать «более похожий» — значит угадать.
  // Ложное совпадение склеит два разных сериала и разнесёт по карточке
  // чужие отзывы; пропуск чинится руками.
  const r = matchSeries(imdb('The Office', 2005), [
    tmdb('The Office', 2005), { ...tmdb('The Office', 2005), id: 2 },
  ]);
  assert.equal(r.match, null);
  assert.equal(r.ambiguous, true);
  assert.equal(r.reason, 'неоднозначно');
});

test('неоднозначность разрешается годом', () => {
  const r = matchSeries(imdb('The Office', 2005), [tmdb('The Office', 2005), tmdb('The Office', 2013)]);
  assert.ok(r.match);
  assert.equal(r.match.year, 2005);
});

test('неизвестный год помечается как сомнительное сопоставление', () => {
  // Не повод отказывать: повод поставить в очередь админа (CONTENT-PLAN §3).
  const r = matchSeries(imdb('Some Show', null), [tmdb('Some Show', 1999)]);
  assert.ok(r.match);
  assert.equal(r.reason, 'сомнительное-сопоставление');
});

test('отсутствие кандидатов и пустое название дают пропуск, а не исключение', () => {
  assert.equal(matchSeries(imdb('X', 2000), []).match, null);
  assert.equal(matchSeries(imdb('', 2000), [tmdb('X', 2000)]).reason, 'пустое-название');
  assert.equal(matchSeries(null, [tmdb('X', 2000)]).match, null);
});

// ─── OP-07. Полнота ───────────────────────────────────────────────────────────

const fullCard = {
  title: 'Сериал', year_start: 2019, status: 'ended', genres: ['drama'],
  poster: 'id1', description_ru: 'Описание', backdrop: 'id2', backdrop_width: 1920,
  description_en: 'Description', people: ['p1'], description: 'Описание',
  schedule_complete: true,
};

test('полная карточка определяется как полная', () => {
  const r = completeness({ ...fullCard, status: 'ended' });
  assert.equal(r.level, 'full', `ожидался full, не хватало: ${r.missing.join(', ')}`);
});

test('без постера и описания карточка пригодна к показу, но не полна', () => {
  const r = completeness({ ...fullCard, poster: null, backdrop: null, description_ru: null });
  assert.equal(r.level, 'displayable');
  assert.ok(r.missing.includes('poster'));
});

test('без жанра карточка не проходит минимум', () => {
  const r = completeness({ ...fullCard, genres: [] });
  assert.equal(r.level, 'minimum');
  assert.ok(r.missing.includes('genres'));
});

test('фоном 16:9 считается фон шириной не меньше 1920', () => {
  // Недостаточный фон отправляет карточку на уровень ниже, но не в «минимум»:
  // постер и описание на месте, значит она по-прежнему показывается в списках.
  assert.equal(completeness({ ...fullCard, backdrop_width: 1280 }).level, 'displayable');
  assert.equal(completeness({ ...fullCard, backdrop_width: 1920 }).level, 'full');
});

test('график серий обязателен только для выходящего сериала', () => {
  // У завершённого сериала расписания может не быть вовсе, и требовать его
  // значит держать в очереди весь каталог.
  assert.equal(completeness({ ...fullCard, status: 'ended', schedule_complete: false }).level, 'full');
  assert.equal(completeness({ ...fullCard, status: 'airing', schedule_complete: false }).level, 'displayable');
});

test('«Ждём сезон» не считается дефектом', () => {
  const r = completeness({ ...fullCard, status: 'waiting', schedule_complete: false });
  assert.equal(r.level, 'full');
});

test('описание на любом языке допустимо для показа, но не для полноты', () => {
  assert.equal(completeness({ ...fullCard, description_ru: null }).level, 'displayable');
});

// ─── Ручные правки ────────────────────────────────────────────────────────────

test('зафиксированное вручную поле импорт не перезаписывает', () => {
  // EC-R8: иначе работа студии теряется при каждой синхронизации.
  const { applied, skipped } = applyIncoming({ title_ru: 'из источника', year_start: 2019 }, ['title_ru']);
  assert.deepEqual(skipped, ['title_ru']);
  assert.equal(applied.title_ru, undefined);
  assert.equal(applied.year_start, 2019);
});

test('без фиксации импорт перезаписывает всё', () => {
  const { applied, skipped } = applyIncoming({ title_ru: 'из источника' }, []);
  assert.equal(applied.title_ru, 'из источника');
  assert.deepEqual(skipped, []);
});

// ─── Прогон импорта ───────────────────────────────────────────────────────────

test('пробный прогон ничего не пишет', async () => {
  let persisted = false;
  const r = await runImport({
    dryRun: true,
    fetchSource: async () => [{ id: 1 }, { id: 2 }],
    persist: async () => { persisted = true; return { written: 0, skipped: 0 }; },
  });
  assert.equal(persisted, false, 'dry_run не должен доходить до записи');
  assert.equal(r.dryRun, true);
  assert.equal(r.count, 2);
});

test('сбой источника не оставляет каталог изменённым', async () => {
  // persist не вызывается вовсе: применяется только то, что удалось собрать.
  let persisted = false;
  const r = await runImport({
    fetchSource: async () => { throw new Error('TMDB недоступен'); },
    persist: async () => { persisted = true; return { written: 5, skipped: 0 }; },
  });
  assert.equal(persisted, false);
  assert.equal(r.ok, false);
  assert.match(r.error, /TMDB/);
});

test('успешный прогон сообщает число записей', async () => {
  const r = await runImport({
    fetchSource: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
    persist: async (rows) => ({ written: rows.length, skipped: 0 }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.written, 3);
});

test('сбой фиксируется событием, а не теряется', async () => {
  const events = [];
  await runImport({
    fetchSource: async () => { throw new Error('сеть'); },
    persist: async () => ({ written: 0, skipped: 0 }),
    onEvent: async (e) => events.push(e),
  });
  assert.equal(events.at(-1).type, 'import.failed');
});