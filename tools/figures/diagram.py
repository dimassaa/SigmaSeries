#!/usr/bin/env python3
"""Примитивы для рисунков ПЗ, разложенных вручную.

PlantUML расставляет узлы сам, и на двух рисунках уровня процесса это дало
подписи связей поверх рамок пакета, а названия пакетов — поверх содержимого.
Рисунки небольшие, поэтому явные координаты дешевле борьбы с чужим
алгоритмом и дают ту же толщину линий и шрифт DejaVu Sans, что и остальные
рисунки комплекта.

Единица координат — миллиметр: canvas(290, 170) — лист 290 × 170 мм.
"""

from __future__ import annotations

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Ellipse, FancyArrowPatch, Polygon, Rectangle

FONT = "DejaVu Sans"


def canvas(width: float, height: float, dpi: int = 220,
           out_width: float | None = None):
    """Figure whose axes are measured in millimetres, origin at bottom left.

    ``out_width`` sets the physical width of the saved image independently of
    the coordinate grid. A diagram laid out on a 290-unit grid but saved
    180 mm wide keeps its 7 pt labels when the page scales it to text width;
    saving it 290 mm wide would shrink them to 4 pt in print.
    """
    plt.rcParams["font.family"] = FONT
    if out_width is None:
        out_width = width
    height_mm = out_width * height / width
    fig = plt.figure(figsize=(out_width / 25.4, height_mm / 25.4), dpi=dpi)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, width)
    ax.set_ylim(0, height)
    ax.set_aspect("equal")
    ax.axis("off")
    return fig, ax


def frame(ax, x, y, w, h, title, size=7.6):
    """Package frame with a tab in the top-left corner, as PlantUML draws it.

    The tab is measured from the rendered title, not estimated from the
    character count: the canvas is saved narrower than its coordinate grid,
    so a character is wider in grid units than its point size suggests.
    """
    ax.add_patch(Rectangle((x, y), w, h, facecolor="white", edgecolor="black",
                           lw=1.0, zorder=1))
    probe = ax.text(x + 3, y + h + 3.5, title, fontsize=size, weight="bold",
                    ha="left", va="center", zorder=3)
    fig = ax.figure
    bbox = probe.get_window_extent(renderer=fig.canvas.get_renderer())
    right = ax.transData.inverted().transform((bbox.x1, 0))[0]
    tab = right - x + 3
    ax.add_patch(Polygon([(x, y + h), (x + tab, y + h),
                          (x + tab + 3, y + h + 7), (x, y + h + 7)],
                         closed=True, facecolor="white", edgecolor="black",
                         lw=1.0, zorder=2))


def box(ax, x, y, w, h, text, size=7.0, weight="normal", lw=1.0):
    """Plain component/artifact rectangle with centred caption."""
    ax.add_patch(Rectangle((x, y), w, h, facecolor="white", edgecolor="black",
                           lw=lw, zorder=3))
    ax.text(x + w / 2, y + h / 2, text, fontsize=size, weight=weight,
            ha="center", va="center", linespacing=1.25, zorder=4)


def device(ax, x, y, w, h, dx=4.0, dy=4.0):
    """UML node: front face plus the top and right edges of a 3D box."""
    ax.add_patch(Polygon([(x, y + h), (x + dx, y + h + dy),
                          (x + w + dx, y + h + dy), (x + w, y + h)],
                         closed=True, facecolor="white", edgecolor="black",
                         lw=1.0, zorder=1))
    ax.add_patch(Polygon([(x + w, y), (x + w + dx, y + dy),
                          (x + w + dx, y + h + dy), (x + w, y + h)],
                         closed=True, facecolor="white", edgecolor="black",
                         lw=1.0, zorder=1))
    ax.add_patch(Rectangle((x, y), w, h, facecolor="white", edgecolor="black",
                           lw=1.0, zorder=2))


def database(ax, x, y, w, h, text, size=7.0):
    """Cylinder: node contents for a DBMS deployment node or a data store."""
    lip = 4.0
    ax.add_patch(Rectangle((x, y + lip / 2), w, h - lip, facecolor="white",
                           edgecolor="none", zorder=3))
    ax.add_patch(Ellipse((x + w / 2, y + lip / 2), w, lip, facecolor="white",
                         edgecolor="black", lw=1.0, zorder=2))
    ax.add_patch(Ellipse((x + w / 2, y + h - lip / 2), w, lip,
                         facecolor="white", edgecolor="black", lw=1.0,
                         zorder=4))
    ax.plot([x, x], [y + lip / 2, y + h - lip / 2], color="black", lw=1.0,
            zorder=3)
    ax.plot([x + w, x + w], [y + lip / 2, y + h - lip / 2], color="black",
            lw=1.0, zorder=3)
    ax.text(x + w / 2, y + h / 2, text, fontsize=size, ha="center",
            va="center", linespacing=1.25, zorder=5)


def arrow(ax, points, lw=0.9, head=9):
    """Orthogonal (or straight) polyline ending in a filled arrowhead.

    The caller passes every bend explicitly; nothing is routed automatically,
    so two arrows never share a corridor by accident.
    """
    for start, end in zip(points[:-2], points[1:-1]):
        ax.plot([start[0], end[0]], [start[1], end[1]], color="black", lw=lw,
                zorder=2, solid_capstyle="butt")
    ax.add_patch(FancyArrowPatch(points[-2], points[-1], arrowstyle="-|>",
                                 mutation_scale=head, lw=lw, color="black",
                                 shrinkA=0, shrinkB=0, zorder=2))


def label(ax, x, y, text, size=6.4, ha="left", va="center", weight="normal"):
    ax.text(x, y, text, fontsize=size, ha=ha, va=va, weight=weight, zorder=5)
