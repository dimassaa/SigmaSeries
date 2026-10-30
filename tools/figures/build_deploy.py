#!/usr/bin/env python3
"""Схема развёртывания для раздела 4.2.3 (рис. 4.11).

Пять узлов: рабочая станция, сервер приложения, сервер СУБД, почтовый
сервер и внешний источник данных. Связи подписаны протоколом и портом —
именно они, а не имена узлов, отвечают на вопрос «что где выполняется».

Запуск:
    uv run --with matplotlib python tools/figures/build_deploy.py
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from diagram import arrow, box, canvas, database, device, label  # noqa: E402

OUT = (Path(__file__).resolve().parents[2]
       / "docs/07-kp/pz/figures/png/deploy.png")


def node_title(ax, cx, top, stereotype, name, subtitle):
    """Stereotype, node name and platform line inside a deployment node."""
    label(ax, cx, top, stereotype, size=6.4, ha="center")
    label(ax, cx, top - 5.2, name, size=7.6, ha="center", weight="bold")
    label(ax, cx, top - 10.2, subtitle, size=6.4, ha="center")


def main():
    fig, ax = canvas(300, 124, out_width=180)

    device(ax, 6, 46, 62, 52)
    node_title(ax, 37, 92, "«device»", "Рабочая станция",
               "Windows 10+, браузер")
    box(ax, 11, 54, 52, 20, "HTML, CSS, JS\nбез сборщика", size=6.4)

    device(ax, 96, 16, 96, 92)
    node_title(ax, 144, 101, "«device»", "Сервер приложения",
               "Windows 10+ · Node.js 22 LTS")
    box(ax, 98, 68, 42, 16, "server.js\nточка входа", size=6.4)
    box(ax, 146, 68, 42, 16, "src/services\nбизнес-логика", size=6.4)
    box(ax, 98, 48, 42, 16, "src/view\nшаблоны, SSR", size=6.4)
    box(ax, 146, 48, 42, 16, "public/css\nсобранные таблицы", size=6.4)
    box(ax, 98, 28, 42, 16, "node-cron\nрасписание", size=6.4)
    box(ax, 146, 28, 42, 16, "public/js\nповедение страницы", size=6.4)

    device(ax, 222, 90, 72, 30)
    node_title(ax, 258, 113, "«external»", "Источники данных", "IMDb, TMDB")

    device(ax, 222, 44, 72, 40)
    node_title(ax, 258, 77, "«device»", "Сервер СУБД", "PostgreSQL 16")
    database(ax, 230, 46, 56, 18, "sigma\n71 таблица", size=6.6)

    device(ax, 222, 8, 72, 32)
    node_title(ax, 258, 33, "«device»", "Почтовый сервер", "SMTP")

    arrow(ax, [(72, 70), (96, 70)])
    label(ax, 84, 73, "HTTPS :443", ha="center")

    arrow(ax, [(196, 101), (222, 101)])
    label(ax, 209, 104, "HTTPS", ha="center")

    arrow(ax, [(196, 64), (222, 64)])
    label(ax, 209, 67, "TCP :5432", ha="center")

    arrow(ax, [(196, 24), (222, 24)])
    label(ax, 209, 27, "SMTP :25/587", ha="center")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT, dpi=220, facecolor="white")
    print(OUT)


if __name__ == "__main__":
    main()
