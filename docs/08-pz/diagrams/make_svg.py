import os, math

OUT = 'docs/08-pz/diagrams'
FONT = 'DejaVu Sans'
os.makedirs(OUT, exist_ok=True)

class SVG:
    def __init__(self, w, h, bg='#ffffff'):
        self.w, self.h, self.parts = w, h, []
        self.parts.append(f'<rect width="{w}" height="{h}" fill="{bg}"/>')
    def add(self, s): self.parts.append(s)
    def text(self, x, y, s, size=14, anchor='middle', weight='normal', fill='#111111'):
        s = s.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')
        self.add(f'<text x="{x}" y="{y}" font-family="{FONT}" font-size="{size}" '
                 f'text-anchor="{anchor}" font-weight="{weight}" fill="{fill}">{s}</text>')
    def lines(self, x, y, rows, size=14, lh=None, anchor='middle', weight='normal'):
        lh = lh or size + 5
        for i, row in enumerate(rows):
            self.text(x, y + i*lh, row, size, anchor, weight)
    def rect(self, x, y, w, h, fill='#f7f7f7', stroke='#333333', sw=1.5, dash=None):
        d = f' stroke-dasharray="{dash}"' if dash else ''
        self.add(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" '
                 f'stroke="{stroke}" stroke-width="{sw}"{d}/>')
    def ellipse(self, cx, cy, rx, ry, fill='#ffffff', stroke='#333333', sw=1.5):
        self.add(f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="{fill}" '
                 f'stroke="{stroke}" stroke-width="{sw}"/>')
    def poly(self, pts, arrow=True, sw=1.6, dash=None):
        d = ' stroke-dasharray="%s"' % dash if dash else ''
        p = ' '.join(f'{x},{y}' for x, y in pts)
        self.add(f'<polyline points="{p}" fill="none" stroke="#111111" stroke-width="{sw}"{d}/>')
        if arrow:
            (x1, y1), (x2, y2) = pts[-2], pts[-1]
            ang = math.atan2(y2 - y1, x2 - x1)
            L, W = 12, 5
            ax1 = x2 - L*math.cos(ang) + W*math.sin(ang)
            ay1 = y2 - L*math.sin(ang) - W*math.cos(ang)
            ax2 = x2 - L*math.cos(ang) - W*math.sin(ang)
            ay2 = y2 - L*math.sin(ang) + W*math.cos(ang)
            self.add(f'<polygon points="{x2},{y2} {ax1},{ay1} {ax2},{ay2}" fill="#111111"/>')
    def actor(self, x, y, label):
        self.add(f'<circle cx="{x}" cy="{y-58}" r="14" fill="#ffffff" stroke="#111111" stroke-width="1.8"/>')
        self.add(f'<line x1="{x}" y1="{y-44}" x2="{x}" y2="{y-8}" stroke="#111111" stroke-width="1.8"/>')
        self.add(f'<line x1="{x-22}" y1="{y-34}" x2="{x+22}" y2="{y-34}" stroke="#111111" stroke-width="1.8"/>')
        self.add(f'<line x1="{x}" y1="{y-8}" x2="{x-16}" y2="{y+16}" stroke="#111111" stroke-width="1.8"/>')
        self.add(f'<line x1="{x}" y1="{y-8}" x2="{x+16}" y2="{y+16}" stroke="#111111" stroke-width="1.8"/>')
        self.text(x, y + 40, label, 15, weight='bold')
    def save(self, name):
        path = os.path.join(OUT, name)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(f'<svg xmlns="http://www.w3.org/2000/svg" width="{self.w}" height="{self.h}" '
                    f'viewBox="0 0 {self.w} {self.h}">')
            f.write('\n'.join(self.parts))
            f.write('</svg>')
        print('saved', path)

# ───────── IDEF0 A-0 ─────────
s = SVG(1500, 900)
s.text(30, 40, 'A-0', 20, anchor='start', weight='bold')
s.text(30, 66, 'Контекстная диаграмма', 14, anchor='start')
s.rect(500, 330, 500, 170)
s.lines(750, 395, ['Сервис оценки и отслеживания', 'сериалов с календарём выхода серий'], 16)
s.text(985, 490, 'A0', 14, anchor='end')

inputs = [
    ('Сведения о сериалах', 'IMDb, TMDB', 370),
    ('Действия зрителя', '', 420),
    ('Пользовательские', 'материалы и жалобы', 470),
]
for a, b, y in inputs:
    row = [a] + ([b] if b else [])
    s.text(380, y - 3, row[0], 13, anchor='end')
    if b: s.text(380, y + 13, b, 13, anchor='end')
    s.poly([(390, y), (500, y)])

controls = [('Правила модерации', 540, 150), ('Роли и права', 650, 185),
            ('Настройки модулей', 760, 150), ('Требования к полноте', 880, 185)]
for label, x, y in controls:
    s.text(x, y, label, 12)
    s.poly([(x, y + 12), (x, 330)])

mechs = [('Сервер Node.js', 575), ('СУБД PostgreSQL', 750), ('Браузер зрителя', 925)]
for label, x in mechs:
    s.poly([(x, 700), (x, 500)])
    s.text(x, 730, label, 12)

outs = [('Каталог и карточки', 355), ('Календарь выходов', 405),
        ('Рекомендации', 445), ('Уведомления', 490)]
for label, y in outs:
    s.poly([(1000, y), (1108, y)])
    s.text(1120, y + 4, label, 12, anchor='start')
s.save('idef0-context.svg')

# ───────── IDEF0 A0 ─────────
s = SVG(2300, 1120)
s.text(30, 40, 'A0', 20, anchor='start', weight='bold')
s.text(30, 66, 'Декомпозиция функциональной модели', 14, anchor='start')

boxes = {
    'A1': (80, 200, 'Импорт и ведение', 'каталога'),
    'A2': (700, 200, 'Публикация и', 'модерация'),
    'A3': (1320, 200, 'Каталог и карточка', 'сериала'),
    'A4': (80, 720, 'Оценки, отзывы и', 'отслеживание'),
    'A5': (700, 720, 'Календарь и', 'уведомления'),
    'A6': (1320, 720, 'Аналитика и', 'администрирование'),
}
for code, (x, y, a, b) in boxes.items():
    s.rect(x, y, 380, 120)
    s.lines(x + 190, y + 45, [a, b], 14)
    s.text(x + 365, y + 110, code, 12, anchor='end')

s.text(70, 235, 'Данные IMDb и TMDB', 12, anchor='end')
s.poly([(0, 250), (80, 250)])
s.poly([(460, 250), (700, 250)])
s.text(580, 235, 'черновики каталога', 12)
s.poly([(1080, 250), (1320, 250)])
s.text(1200, 235, 'опубликованные карточки', 12)

s.text(70, 755, 'Действия зрителя', 12, anchor='end')
s.poly([(0, 770), (80, 770)])
s.poly([(460, 770), (700, 770)])
s.text(580, 755, 'подписки и отметки', 12)
s.poly([(1080, 770), (1320, 770)])
s.text(1200, 755, 'события', 12)

s.poly([(270, 320), (270, 720)])
s.text(255, 520, 'опубликованный каталог', 12, anchor='end')

s.poly([(460, 290), (560, 290), (560, 640), (780, 640), (780, 720)])
s.text(570, 628, 'даты выходов', 12, anchor='start')

for label, x in [('Требования к полноте', 200), ('Правила сообщества и роли', 820),
                 ('Настройки и регламенты', 1450)]:
    s.text(x, 175, label, 12)
    s.poly([(x, 185), (x, 200)])

s.poly([(380, 680), (380, 320)])
s.text(392, 660, 'Сервер Node.js', 12, anchor='start')
s.poly([(950, 680), (950, 320)])
s.text(962, 660, 'СУБД PostgreSQL', 12, anchor='start')

s.poly([(1700, 250), (1790, 250)])
s.text(1710, 235, 'страницы каталога', 12, anchor='start')
s.poly([(270, 840), (270, 930)])
s.text(282, 900, 'библиотека и прогресс', 12, anchor='start')
s.poly([(890, 840), (890, 930)])
s.text(902, 900, 'уведомления', 12, anchor='start')
s.poly([(1700, 770), (1790, 770)])
s.text(1710, 755, 'отчёты и копии', 12, anchor='start')
# Содержимое сдвинуто: слева место под подписи входов, справа — под выходы.
s.parts[1:] = ['<g transform="translate(200,0)">'] + s.parts[1:] + ['</g>']
s.save('idef0-a0.svg')

# ───────── Use case ─────────
s = SVG(1250, 1520)
s.rect(360, 60, 840, 1380)
s.text(780, 95, 'SigmaSeries', 18, weight='bold')

uc = [
    ('Просмотр каталога', 140, 'guest'),
    ('Поиск', 220, 'guest'),
    ('Карточка сериала', 300, 'guest'),
    ('Календарь выходов', 380, 'guest'),
    ('Оценка сериала', 460, 'viewer'),
    ('Отзыв', 540, 'viewer'),
    ('Отметка просмотра', 620, 'viewer'),
    ('Библиотека', 700, 'viewer'),
    ('Рекомендации', 780, 'viewer'),
    ('Итоги года', 860, 'viewer'),
    ('Модерация', 960, 'editor'),
    ('Аналитика', 1040, 'analyst'),
    ('Ведение каталога', 1130, 'admin'),
    ('Импорт каталога', 1210, 'admin'),
]
for label, y, actor in uc:
    s.ellipse(780, y, 150, 30)
    s.text(780, y + 5, label, 14)
    ax = {'guest': 255, 'viewer': 660, 'editor': 880, 'analyst': 1030, 'admin': 1180}[actor]
    s.poly([(185, ax), (630, y)], sw=1.3)

s.actor(120, 255, 'Гость')
s.actor(120, 660, 'Зритель')
s.actor(120, 880, 'Редактор')
s.actor(120, 1030, 'Аналитик')
s.actor(120, 1180, 'Администратор')
s.text(360, 1475, 'Зритель, редактор, аналитик и администратор наследуют возможности', 11, anchor='start')
s.text(360, 1492, 'предыдущей роли; на схеме показаны собственные варианты использования.', 11, anchor='start')
s.save('usecase.svg')


# ───────── Классы: каталог ─────────
s = SVG(1450, 900)
boxes = {
    'series': (80, 350, 300, ['Сериал', 'slug : text', 'titleRu : text', 'titleEn : text', 'publicationState : text']),
    'genre': (560, 80, 300, ['Жанр', 'code : text', 'nameRu : text', 'nameEn : text']),
    'person': (560, 230, 300, ['Персона', 'slug : text', 'name : text']),
    'coll': (560, 360, 300, ['Подборка', 'slug : text', 'titleRu : text', 'active : boolean']),
    'season': (560, 510, 300, ['Сезон', 'number : smallint']),
    'image': (560, 640, 300, ['Изображение', 'role : text', 'focalX : numeric', 'focalY : numeric']),
    'episode': (1030, 510, 300, ['Серия', 'number : smallint', 'titleRu : text']),
    'release': (1030, 650, 300, ['Выход', 'date : date', 'state : text']),
    'variant': (1030, 790, 300, ['Вариант', 'width : int', 'height : int']),
}
for key, (x, y, w, rows) in boxes.items():
    h = 34 + (len(rows) - 1) * 22 + 12
    s.rect(x, y, w, h, fill='#ffffff')
    s.add(f'<line x1="{x}" y1="{y+34}" x2="{x+w}" y2="{y+34}" stroke="#333333" stroke-width="1"/>')
    s.text(x + w/2, y + 22, rows[0], 15, weight='bold')
    for i, row in enumerate(rows[1:]):
        s.text(x + 12, y + 54 + i*22, row, 12, anchor='start')

def mid(key):
    x, y, w, rows = boxes[key]
    h = 34 + (len(rows) - 1) * 22 + 12
    return x, y, w, h

def edge(a, b, ma='', mb=''):
    ax, ay, aw, ah = mid(a); bx, by, bw, bh = mid(b)
    p1 = (ax + aw, ay + ah/2)
    p2 = (bx, by + bh/2)
    s.poly([p1, p2], sw=1.3)
    def at(t):
        return (p1[0] + (p2[0]-p1[0])*t, p1[1] + (p2[1]-p1[1])*t)
    if ma:
        q = at(0.18); s.text(q[0] + 4, q[1] - 6, ma, 12, anchor='start')
    if mb:
        q = at(0.82); s.text(q[0] - 4, q[1] - 6, mb, 12, anchor='end')

edge('series', 'genre', '1', '*')
edge('series', 'person', '1', '*')
edge('series', 'coll', '1', '*')
edge('series', 'season', '1', '1..*')
edge('series', 'image', '1', '0..*')
edge('season', 'episode', '1', '0..*')
edge('season', 'release', '1', '0..*')
edge('image', 'variant', '1', '1..*')
s.save('class-catalog.svg')

# ───────── Классы: зритель ─────────
s = SVG(1250, 820)
boxes = {
    'user': (80, 330, 300, ['Пользователь', 'id : bigint', 'nickname : text', 'passwordHash : text']),
    'role': (620, 80, 320, ['Роль', 'role : text', 'expiresAt : timestamptz']),
    'rating': (620, 220, 320, ['Оценка', 'value : smallint', 'counted : boolean']),
    'review': (620, 360, 320, ['Отзыв', 'text : text', 'state : text']),
    'mark': (620, 500, 320, ['Отметка', 'precision : text']),
    'status': (620, 620, 320, ['Статус', 'value : text']),
}
for key, (x, y, w, rows) in boxes.items():
    h = 34 + (len(rows) - 1) * 22 + 12
    s.rect(x, y, w, h, fill='#ffffff')
    s.add(f'<line x1="{x}" y1="{y+34}" x2="{x+w}" y2="{y+34}" stroke="#333333" stroke-width="1"/>')
    s.text(x + w/2, y + 22, rows[0], 15, weight='bold')
    for i, row in enumerate(rows[1:]):
        s.text(x + 12, y + 54 + i*22, row, 12, anchor='start')

def mid2(key):
    x, y, w, rows = boxes[key]
    h = 34 + (len(rows) - 1) * 22 + 12
    return x, y, w, h

ux, uy, uw, uh = mid2('user')
p1 = (ux + uw, uy + uh/2)
for key in ('role', 'rating', 'review', 'mark', 'status'):
    bx, by, bw, bh = mid2(key)
    p2 = (bx, by + bh/2)
    s.poly([p1, p2], sw=1.3)
    s.text(p1[0] + (p2[0]-p1[0])*0.18 + 4, p1[1] + (p2[1]-p1[1])*0.18 - 6, '1', 12, anchor='start')
    s.text(p1[0] + (p2[0]-p1[0])*0.82 - 4, p1[1] + (p2[1]-p1[1])*0.82 - 6, '0..*', 12, anchor='end')
# Отзыв связан с оценкой.
rx, ry, rw, rh = mid2('rating'); vx, vy, vw, vh = mid2('review')
s.poly([(rx + rw/2, ry + rh), (vx + vw/2, vy)], sw=1.2)
s.text(rx + rw/2 + 8, ry + rh + 18, '1', 12, anchor='start')
s.text(vx + vw/2 + 8, vy - 6, '0..1', 12, anchor='start')
s.save('class-viewer.svg')
