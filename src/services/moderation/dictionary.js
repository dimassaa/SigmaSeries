// Словарь модерации (OP-01): чтение `e_dictionary_word` для проверки текста.
//
// Словарь читается на каждую отправку, а не кэшируется на процесс: редактор
// добавляет слово, и оно должно начать действовать без перезапуска сервера.
// Запрос идёт по небольшой таблице и индексированному признаку `active`.
//
// Сбой чтения возвращает `available: false`, а не пустой словарь: пустой
// словарь означает «всё можно», и упавшая база превратилась бы в обход
// модерации (F-05-02 правило (а)).

/**
 * Источник словаря.
 *
 * @param {any} pool настоящий Pool или тестовый двойник с `query`
 * @param {{onError?: (error: Error) => void}} [options]
 */
export function pgDictionary(pool, { onError = () => {} } = {}) {
  return {
    /**
     * Читает действующие слова обоих списков.
     *
     * @returns {Promise<{block: {word:string, category:string|null}[],
     *   allow: {word:string, category:string|null}[], available: boolean}>}
     */
    async load() {
      try {
        const { rows } = await pool.query(
          `SELECT word, list, category FROM e_dictionary_word WHERE active ORDER BY word`,
        );
        const block = [];
        const allow = [];
        for (const row of rows) {
          const item = { word: row.word, category: row.category ?? null };
          if (row.list === 'block') block.push(item);
          else if (row.list === 'allow') allow.push(item);
        }
        return { block, allow, available: true };
      } catch (error) {
        onError(error);
        return { block: [], allow: [], available: false };
      }
    },
  };
}
