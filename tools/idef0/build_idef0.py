#!/usr/bin/env python3
"""IDEF0 A-0 poster for the SigmaSeries coursework.

A4 landscape (297 x 210 mm) with a GOST-like coordinate grid and no title
block: the stamp is added by the author in Word. All labels are in Russian.

The four blocks sit on a descending staircase, so every inter-block flow can
leave the bottom or right edge of its source and enter the top or left edge of
its target without meeting another flow. Where a control or a mechanism arrow
still crosses a horizontal flow, the horizontal is drawn with a small break
(bridge), as on a drafting sheet.

Run:
    uv run --with matplotlib python tools/idef0/build_idef0.py
"""

from __future__ import annotations

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, Rectangle

PAGE_W, PAGE_H = 297.0, 210.0
OUT = Path(__file__).resolve().parents[2] / "docs/07-kp/pz/figures/png/idef0-a0.png"

plt.rcParams["font.family"] = "DejaVu Sans"
plt.rcParams["font.size"] = 8

# Orthogonal segments are collected first and drawn in three passes, so that a
# white patch can cut the horizontal line under every vertical crossing.
VERTICALS: list[tuple[float, float, float, float]] = []
HORIZONTALS: list[tuple[float, float, float, float]] = []
HEADS: list[tuple[tuple[float, float], tuple[float, float]]] = []


def _register(points, width):
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if abs(x0 - x1) < 1e-9:
            VERTICALS.append((x0, min(y0, y1), max(y0, y1), width))
        elif abs(y0 - y1) < 1e-9:
            HORIZONTALS.append((y0, min(x0, x1), max(x0, x1), width))
        else:
            raise ValueError(f"non-orthogonal segment: {(x0, y0)} -> {(x1, y1)}")


def arrow(ax, points, width=0.8):
    """Register a polyline and put a filled head on its last segment."""
    _register(points, width)
    HEADS.append((points[-2], points[-1]))
    return points[-1]


def horizontal(ax, y, x0, x1, width=0.8):
    _register([(x0, y), (x1, y)], width)


def vertical(ax, x, y0, y1, width=0.8):
    _register([(x, y0), (x, y1)], width)


def draw_segments(ax):
    """Verticals, then horizontals with drafting bridges at crossings."""
    for x, y0, y1, w in VERTICALS:
        ax.plot([x, x], [y0, y1], color="black", lw=w, zorder=2,
                solid_capstyle="butt")

    for y, x0, x1, w in HORIZONTALS:
        # A vertical ending exactly on this horizontal is a T-junction and must
        # stay connected, so the bounds are strict.
        crossing_x = sorted(
            x for x, y0, y1, _ in VERTICALS
            if x0 + 0.9 < x < x1 - 0.9 and y0 + 0.9 < y < y1 - 0.9
        )
        cuts: list[list[float]] = []
        for x in crossing_x:
            if cuts and x - cuts[-1][1] < 0.6:
                cuts[-1][1] = x + 0.9
            else:
                cuts.append([x - 0.9, x + 0.9])

        pos = x0
        for a, b in cuts:
            if a > pos:
                ax.plot([pos, a], [y, y], color="black", lw=w, zorder=2,
                        solid_capstyle="butt")
            pos = b
        if pos < x1:
            ax.plot([pos, x1], [y, y], color="black", lw=w, zorder=2,
                    solid_capstyle="butt")

    for (x0, y0), (x1, y1) in HEADS:
        ax.add_patch(FancyArrowPatch(
            (x0, y0), (x1, y1), arrowstyle="-|>", mutation_scale=7,
            linewidth=0.8, color="black", shrinkA=0, shrinkB=0, zorder=4,
        ))


def label(ax, x, y, text, size=7, ha="center", va="center", weight="normal"):
    ax.text(x, y, text, fontsize=size, ha=ha, va=va, weight=weight, zorder=5,
            linespacing=1.1,
            bbox=dict(facecolor="white", edgecolor="none", pad=0.25))


def block(ax, x, y, w, h, code, name, size=7.8):
    ax.add_patch(Rectangle((x, y), w, h, facecolor="white", edgecolor="black",
                           linewidth=1.2, zorder=4))
    ax.text(x + 1.6, y + h - 2.2, code, fontsize=8, weight="bold",
            ha="left", va="center", zorder=5)
    ax.text(x + w / 2, y + h / 2 - 1.4, name, fontsize=size,
            ha="center", va="center", zorder=5, linespacing=1.2)


def frame(ax):
    ax.add_patch(Rectangle((5, 5), 287, 200, fill=False, lw=1.2, zorder=1))
    ax.add_patch(Rectangle((20, 12), 265, 186, fill=False, lw=0.9, zorder=1))

    x0, x1, y0, y1 = 20.0, 285.0, 12.0, 198.0
    cols, rows = 12, 14
    cw, rh = (x1 - x0) / cols, (y1 - y0) / rows

    for i in range(cols + 1):
        x = x0 + i * cw
        ax.plot([x, x], [y1, 205], color="black", lw=0.35, zorder=1)
        ax.plot([x, x], [5, y0], color="black", lw=0.35, zorder=1)
    for i in range(rows + 1):
        y = y0 + i * rh
        ax.plot([5, x0], [y, y], color="black", lw=0.35, zorder=1)
        ax.plot([x1, 292], [y, y], color="black", lw=0.35, zorder=1)

    for i in range(cols):
        x = x0 + (i + 0.5) * cw
        ax.text(x, 201.5, f"{i + 1:02d}", fontsize=6.2, ha="center", va="center")
        ax.text(x, 8.5, f"{i + 1:02d}", fontsize=6.2, ha="center", va="center")
    for i in range(rows):
        y = y0 + (i + 0.5) * rh
        letter = chr(ord("A") + i)
        ax.text(12.5, y, letter, fontsize=6.2, ha="center", va="center")
        ax.text(288.5, y, letter, fontsize=6.2, ha="center", va="center")


def main():
    fig = plt.figure(figsize=(PAGE_W / 25.4, PAGE_H / 25.4), dpi=300)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, PAGE_W)
    ax.set_ylim(0, PAGE_H)
    ax.set_aspect("equal")
    ax.axis("off")
    frame(ax)

    # A1..A4, 44 x 24 mm, 8 mm horizontal and 12 mm vertical gaps.
    a1 = (58, 146, 44, 24)
    a2 = (110, 110, 44, 24)
    a3 = (162, 74, 44, 24)
    a4 = (214, 38, 44, 24)
    block(ax, *a1, "A1", "Вести каталог\nсериалов")
    block(ax, *a2, "A2", "Вести учёт\nпросмотра")
    block(ax, *a3, "A3", "Формировать календарь\nи уведомления", size=7.4)
    block(ax, *a4, "A4", "Формировать аналитику\nи рекомендации", size=7.4)

    # Inputs: left edge of A1 and A2.
    arrow(ax, [(22, 162), (58, 162)])
    label(ax, 22, 163.6, "Данные IMDb и TMDB", size=6.6, ha="left", va="bottom")
    arrow(ax, [(22, 153), (58, 153)])
    label(ax, 22, 154.6, "Правки администратора", size=6.6, ha="left", va="bottom")

    arrow(ax, [(22, 122), (110, 122)])
    label(ax, 22, 123.6, "Отметки, оценки, отзывы зрителя", size=6.6,
          ha="left", va="bottom")
    arrow(ax, [(22, 114), (110, 114)])
    label(ax, 22, 115.6, "Запросы и подписки", size=6.6, ha="left", va="bottom")

    # Controls: top edge.
    for x, top, text in [
        (80, 170, "Правила импорта\nи полноты карточки"),
        (132, 134, "Правила учёта\nи приватности"),
        (190, 98, "Правила календаря\nи уведомлений"),
        (240, 62, "Методика аналитики\nи рекомендаций"),
    ]:
        arrow(ax, [(x, 198), (x, top)])
        label(ax, x, 193.4, text, size=6.4)

    # Mechanisms: short arrows under each block with a foot tick.
    for x, bottom, text, ly in [
        (84, 146, "Администратор,\nредактор", 131.0),
        (124, 110, "Зритель\n(веб-клиент)", 97.0),
        (172, 74, "Планировщик\nnode-cron", 63.0),        (236, 38, "Аналитик,\nредактор", 25.0),
    ]:
        arrow(ax, [(x, bottom - 8), (x, bottom)])
        horizontal(ax, bottom - 8, x - 2.5, x + 2.5, width=1.0)
        label(ax, x, ly, text, size=6.2)

    # Inter-block flows.
    arrow(ax, [(94, 146), (94, 140), (118, 140), (118, 134)])
    label(ax, 96, 141.5, "Карточки, сезоны, серии", size=6.0, ha="left",
          va="bottom")

    arrow(ax, [(66, 146), (66, 82), (162, 82)])
    label(ax, 110, 83.6, "Даты выхода серий", size=6.2, va="bottom")

    arrow(ax, [(154, 118), (158, 118), (158, 92), (162, 92)])
    label(ax, 160, 103.5, "Подписки,\nотметки", size=6.0)

    arrow(ax, [(148, 110), (148, 58), (214, 58)])
    label(ax, 165, 56.4, "Оценки и отзывы", size=6.2, va="top")

    arrow(ax, [(200, 74), (200, 40), (214, 40)])
    label(ax, 196, 44, "События\nкалендаря", size=6.2, ha="right",
          va="bottom")

    # Outputs: right edge.
    arrow(ax, [(154, 132), (285, 132)])
    label(ax, 157, 136, "Личная библиотека\nи прогресс", size=6.4,
          ha="left", va="bottom")

    arrow(ax, [(206, 92), (285, 92)])
    label(ax, 262, 93.6, "Календарь выходов", size=6.4, va="bottom")
    arrow(ax, [(206, 84), (285, 84)])
    label(ax, 262, 85.6, "Уведомления", size=6.4, va="bottom")

    arrow(ax, [(258, 53), (285, 53)])
    label(ax, 271, 54.6, "Отчёты", size=6.4, va="bottom")
    arrow(ax, [(258, 45), (285, 45)])
    label(ax, 270, 46.6, "Рекомендации", size=6.4, va="bottom")

    draw_segments(ax)

    # A-0 context node in the free top-left corner.
    ax.text(22, 189, "А-0", fontsize=11, weight="bold", ha="left", va="center")
    ax.text(22, 183, "Управлять жизненным циклом\nсериала в сервисе учёта\nи отслеживания",
            fontsize=7.4, ha="left", va="top", linespacing=1.25)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT, dpi=300, facecolor="white")
    print(OUT)


if __name__ == "__main__":
    main()
