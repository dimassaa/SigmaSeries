#!/usr/bin/env python3
"""Компонентная схема для раздела 4.2.3 (рис. 4.10).

Слои процесса заданы явно: браузер сверху, внутри процесса Node.js —
маршруты, сервисы и доступ к данным одной вертикалью, шаблоны и планировщик
слева, внешние системы справа. Вертикаль запроса не пересекается с левым
коридором шаблонов, поэтому ни одна линия не проходит через чужой блок.

Запуск:
    uv run --with matplotlib python tools/figures/build_component.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from diagram import arrow, box, canvas, database, frame, label  # noqa: E402

OUT = (Path(__file__).resolve().parents[2]
       / "docs/07-kp/pz/figures/png/component.png")


def main():
    fig, ax = canvas(290, 168, out_width=180)

    frame(ax, 18, 128, 132, 30, "Браузер")
    box(ax, 24, 133, 58, 18,
        "Клиентский JS\nrail, карусель,\nмодальные окна", size=6.6)
    box(ax, 88, 133, 56, 18, "Серверный HTML\nразметка страницы", size=6.6)

    frame(ax, 10, 36, 160, 82, "Процесс Node.js (Express)")
    box(ax, 72, 94, 58, 15, "Маршруты\nразбор, проверка прав")
    box(ax, 72, 68, 58, 15, "Сервисы\nOP-01…OP-17")
    box(ax, 72, 42, 58, 15, "Доступ к данным\nSQL, маппинг строк")
    box(ax, 14, 86, 50, 15, "Шаблоны\nSSR, локализация")
    box(ax, 14, 56, 50, 15, "node-cron\nпять задач")

    database(ax, 76, 6, 50, 26, "PostgreSQL 16\n71 таблица")

    box(ax, 210, 100, 72, 16, "IMDb datasets\nархивы TSV")
    box(ax, 210, 72, 72, 16, "TMDB API\nHTTP и JSON")
    box(ax, 210, 44, 72, 16, "SMTP-сервер\nписьма")
    label(ax, 246, 122, "Внешние системы", size=7.6, ha="center",
          weight="bold")

    # Запрос идёт вниз в маршруты, готовая разметка — вверх в браузер.
    arrow(ax, [(58, 133), (58, 112), (80, 112), (80, 109)])
    label(ax, 62, 116.4, "HTTP-запрос")
    arrow(ax, [(115, 109), (115, 133)])
    label(ax, 117, 121, "HTML-ответ")

    arrow(ax, [(101, 94), (101, 83)])
    arrow(ax, [(101, 68), (101, 57)])
    arrow(ax, [(101, 42), (101, 32)])

    # Шаблоны получают данные от сервисов и отдают разметку маршрутам.
    arrow(ax, [(72, 78), (66, 78), (66, 88), (64, 88)])
    arrow(ax, [(64, 99), (72, 99)])
    arrow(ax, [(64, 70), (72, 70)])

    # Три вызова внешних систем расходятся по своим коридорам.
    arrow(ax, [(130, 82), (162, 82), (162, 108), (210, 108)])
    label(ax, 164, 96, "импорт")
    arrow(ax, [(130, 76), (168, 76), (168, 80), (210, 80)])
    label(ax, 172, 82, "импорт")
    arrow(ax, [(130, 70), (156, 70), (156, 52), (210, 52)])
    label(ax, 158, 60, "письма")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT, dpi=220, facecolor="white")
    print(OUT)


if __name__ == "__main__":
    main()
