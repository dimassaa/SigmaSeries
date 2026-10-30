#!/usr/bin/env python3
"""Use case diagram for the SigmaSeries explanatory note, section 4.1.5.

PlantUML places every use case of a star-shaped graph in one rank, so the
diagram either becomes a 4096-pixel strip or a two-metre column. Here the two
columns are fixed by hand: the visitor's scenarios on the left, the staff
scenarios on the right, with each actor next to its own band. That keeps the
association lines inside their corridor and needs no crossings.

Run:
    uv run --with matplotlib python tools/figures/build_usecase.py
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Ellipse, Rectangle

OUT = (Path(__file__).resolve().parents[2]
       / "docs/07-kp/pz/figures/png/usecase.png")

W, H = 250.0, 170.0
plt.rcParams["font.family"] = "DejaVu Sans"


def actor(ax, x, y, name):
    """Stick figure with the role name under it."""
    ax.add_patch(plt.Circle((x, y + 7.0), 2.8, fill=False, lw=1.1))
    ax.plot([x, x], [y + 4.2, y - 2.0], color="black", lw=1.1)
    ax.plot([x - 5, x + 5], [y + 1.0, y + 1.0], color="black", lw=1.1)
    ax.plot([x, x - 4.0], [y - 2.0, y - 8.0], color="black", lw=1.1)
    ax.plot([x, x + 4.0], [y - 2.0, y - 8.0], color="black", lw=1.1)
    ax.text(x, y - 11.5, name, fontsize=7.4, ha="center", va="top",
            linespacing=1.15)


def usecase(ax, cx, cy, text):
    ax.add_patch(Ellipse((cx, cy), 56, 14.4, facecolor="white",
                         edgecolor="black", lw=1.0, zorder=3))
    ax.text(cx, cy, text, fontsize=6.9, ha="center", va="center",
            zorder=4, linespacing=1.12)


def edge_point(cx, cy, rx, ry, tx, ty):
    """Point where the segment from the ellipse centre to (tx, ty) leaves it."""
    dx, dy = tx - cx, ty - cy
    scale = 1.0 / ((dx / rx) ** 2 + (dy / ry) ** 2) ** 0.5
    return cx + dx * scale, cy + dy * scale


def main():
    fig = plt.figure(figsize=(W / 25.4, H / 25.4), dpi=220)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, W)
    ax.set_ylim(0, H)
    ax.set_aspect("equal")
    ax.axis("off")

    ax.add_patch(Rectangle((58, 8), 146, 154, fill=False, lw=1.1, zorder=1))
    ax.text(131, 158.5, "Сервис SigmaSeries", fontsize=8.2, weight="bold",
            ha="center", va="center")

    left_x, right_x = 93, 169
    left_rows = [147, 130, 113, 96, 79, 62, 45, 28]
    right_rows = [147, 128, 109, 90, 71, 45]

    left = [
        ("Просмотреть\nкаталог", "guest"),
        ("Найти сериал\nпо фильтрам", "guest"),
        ("Открыть карточку\nсериала", "guest"),
        ("Посмотреть календарь\nвыходов", "guest"),
        ("Отметить серию\nпросмотренной", "viewer"),
        ("Задать статус\nсериала", "viewer"),
        ("Подписаться\nна выходы", "viewer"),
        ("Оценить сериал\nи обсудить его", "viewer"),
    ]
    right = [
        ("Проверить материал\nпо словарю", "editor"),
        ("Принять решение\nпо материалу", "editor"),
        ("Управлять словарём\nпроверки", "admin"),
        ("Заблокировать\nпользователя", "admin"),
        ("Запустить импорт\nкаталога", "admin"),
        ("Посмотреть отчёты\nи статистику", "analyst"),
    ]

    actors = {
        "guest": (29, 132),
        "viewer": (29, 62),
        "editor": (233, 132),
        "admin": (233, 80),
        "analyst": (233, 30),
    }

    points = {}
    for (text, who), y in zip(left, left_rows):
        usecase(ax, left_x, y, text)
        points[(text, who)] = (left_x, y)
    for (text, who), y in zip(right, right_rows):
        usecase(ax, right_x, y, text)
        points[(text, who)] = (right_x, y)

    for who, (ax_x, ax_y) in actors.items():
        actor(ax, ax_x, ax_y, {
            "guest": "Гость", "viewer": "Зритель", "editor": "Редактор",
            "admin": "Администратор", "analyst": "Аналитик"}[who])

    for (text, who), (cx, cy) in points.items():
        ax_x, ax_y = actors[who]
        sx, sy = edge_point(cx, cy, 28, 7.2, ax_x, ax_y)
        # The line starts on the actor's silhouette, not at its centre.
        dx, dy = sx - ax_x, sy - ax_y
        norm = max((dx ** 2 + dy ** 2) ** 0.5, 1e-6)
        start = (ax_x + dx / norm * 4.5, ax_y + 1.0 + dy / norm * 4.5)
        ax.plot([start[0], sx], [start[1], sy], color="black", lw=0.7,
                zorder=2)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT, dpi=220, facecolor="white")
    print(OUT)


if __name__ == "__main__":
    main()
