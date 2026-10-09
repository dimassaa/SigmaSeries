#!/usr/bin/env python3
"""Извлекает DDL из docs/04-data/DATABASE.md в db/schema.sql.

Зачем это нужно. DATABASE.md §2 и §2.1 — источник истины: это обязательное
приложение к пояснительной записке, листинг скрипта генерации базы. Коду нужен
исполняемый файл. Держать два независимых описания схемы — значит однажды
забыть синхронизировать, и Бланк 3.3.1 окажется нарушен без следа.

Поэтому второй файл не пишется руками, а генерируется из первого. `--check`
сравнивает результат с тем, что лежит в db/schema.sql, и завершается с ошибкой,
если они разошлись. Проверка запускается в `npm run db:check` до тестов.

Запуск:
    python3 tools/schema/extract.py           # перезаписать db/schema.sql
    python3 tools/schema/extract.py --check   # только проверить, ничего не писать
"""

import io
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE = os.path.join(ROOT, 'docs', '04-data', 'DATABASE.md')
TARGET = os.path.join(ROOT, 'db', 'schema.sql')

HEADER = """\
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

"""


def extract() -> str:
    """Собирает DDL из всех блоков ```sql документа в порядке следования."""
    if not os.path.exists(SOURCE):
        sys.exit(f'Не найден источник схемы: {SOURCE}')

    text = io.open(SOURCE, encoding='utf-8').read()
    blocks = re.findall(r'```sql\n(.*?)```', text, re.S)
    if not blocks:
        sys.exit(f'В {SOURCE} нет ни одного блока ```sql — схема потеряна?')

    # Блоки идут в порядке следования в документе, поэтому блок прав (REVOKE,
    # CREATE RULE) попадает после таблиц, как и требуется. Отбрасывать его
    # нельзя: это единственное место, где реализованы R-SQL-01…03, и без него
    # схема молча перестаёт защищать то, что DATABASE.md обещает.
    parts = []
    for i, block in enumerate(blocks, 1):
        parts.append(f'-- ─── Блок {i} из DATABASE.md ───\n{block.rstrip()}\n')

    return HEADER + '\n'.join(parts)


def main() -> int:
    sql = extract()

    if '--check' in sys.argv:
        if not os.path.exists(TARGET):
            print('db/schema.sql отсутствует. Создай: python3 tools/schema/extract.py')
            return 1
        current = io.open(TARGET, encoding='utf-8').read()
        if current != sql:
            print('РАСХОЖДЕНИЕ: db/schema.sql не совпадает с DATABASE.md.')
            print('Правь DATABASE.md, затем: python3 tools/schema/extract.py')
            return 1
        print(f'Схема синхронна ({len(sql.splitlines())} строк).')
        return 0

    os.makedirs(os.path.dirname(TARGET), exist_ok=True)
    io.open(TARGET, 'w', encoding='utf-8').write(sql)
    print(f'Записано db/schema.sql: {len(sql.splitlines())} строк.')
    return 0


if __name__ == '__main__':
    sys.exit(main())