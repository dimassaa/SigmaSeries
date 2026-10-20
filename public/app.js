// Клиентские скрипты формы.
//
// Здесь четыре вещи, без которых формы и календарь работают не так, как задумано:
//
//  1. Невидимая проверка (R-SEC-34). Пока решение не подставлено, форма
//     после трёх неудач становится непроходимой — это не «защита», а отказ
//     человеку. Сложность задаёт сервер: она приходит в data-zeros,
//     иначе клиент и сервер считают разные задачи.
//  2. Переключатель темы. Ранний скрипт в <head> только читает тему,
//     записать её должен этот.
//  3. Проверка занятости ника и опрос подтверждения на шаге 2 (EC-A2).
//  4. Форма отзыва (F-04-04): счётчик знаков, черновик при потере сети и
//     модальное открытие. Без скрипта форма открывается якорем и работает
//     целиком — скрипт добавляет только то, чего сервер не может.
//
// Зависимостей нет: файл отдаётся как есть и не собирается.

(function () {
  'use strict';

  // ─── SHA-256 ───────────────────────────────────────────────────────────────
  //
  // crypto.subtle доступен только в защищённом контексте: на http://localhost
  // работает, на http://192.168.x.x — нет. Второй вариант нужен, потому что
  // демонстрацию обычно открывают с другого компьютера, а без решения задачи
  // форма входа после трёх неудач непроходима.

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function utf8Bytes(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    // Запасной путь для старых браузеров: кодовые точки заменяются на
    // UTF-8 вручную. Криптографией это не занимается — задача считается
    // по ASCII-сообщению, но искажение байтов сломало бы совпадение.
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  }

  function sha256Sync(bytes) {
    var h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    var bitLen = bytes.length * 8;
    var padded = new Uint8Array(((bytes.length + 9 + 63) & ~63));
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    // Длина пишется 64 битами; сообщения здесь короткие, старшие 4 байта нули.
    var dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 4, bitLen >>> 0, false);
    dv.setUint32(padded.length - 8, Math.floor(bitLen / 4294967296), false);

    var w = new Int32Array(64);
    for (var off = 0; off < padded.length; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4, false);
      for (i = 16; i < 64; i++) {
        var x = w[i - 15];
        var y = w[i - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }

      var a = h[0], b = h[1], c = h[2], d = h[3];
      var e = h[4], f = h[5], g = h[6], hh = h[7];

      for (i = 0; i < 64; i++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }

      h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0;
      h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
      h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0;
      h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }

    var hex = '';
    for (var j = 0; j < 8; j++) hex += ('00000000' + (h[j] >>> 0).toString(16)).slice(-8);
    return hex;
  }

  async function sha256Hex(str) {
    if (window.crypto && window.crypto.subtle && window.TextEncoder) {
      var buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
      var view = new Uint8Array(buf);
      var hex = '';
      for (var i = 0; i < view.length; i++) hex += ('0' + view[i].toString(16)).slice(-2);
      return hex;
    }
    return sha256Sync(utf8Bytes(str));
  }

  function leadingZeros(hex) {
    var n = 0;
    for (var i = 0; i < hex.length && hex[i] === '0'; i++) n++;
    return n;
  }

  /**
   * Подбирает решение задачи.
   *
   * Разбивает поиск на порции по времени: иначе страница перестаёт отвечать
   * на несколько секунд, и человек решает, что он повесил браузер.
   */
  async function solveProofOfWork(challenge, zeros, onDone) {
    if (!challenge) return onDone('');
    var nonce = 0;
    var deadline = Date.now() + 40;
    while (Date.now() < deadline) {
      for (var i = 0; i < 400; i++, nonce++) {
        var hex = await sha256Hex(challenge + nonce);
        if (leadingZeros(hex) >= zeros) return onDone(String(nonce));
      }
    }
    setTimeout(function () { solveProofOfWork(challenge, zeros, onDone); }, 0);
    return undefined;
  }

  // ─── Тело запроса ───────────────────────────────────────────────────────────

  // Формы отправляются urlencoded, а не multipart: сервер разбирает только
  // `application/x-www-form-urlencoded`, и multipart-тело приходило ему пустым
  // — голос «Полезно» отвечал «Неизвестная цель голоса», а жалоба — «Нет
  // причины». Собираем строку вручную: `URLSearchParams` из `FormData`
  // зависит от версии браузера, а здесь это одна строка.
  function urlencoded(form, extra) {
    var data = new FormData(form);
    if (extra) data.append(extra[0], extra[1]);
    var pairs = [];
    data.forEach(function (value, key) {
      pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    });
    return pairs.join('&');
  }

  // ─── Невидимая проверка на страницах входа и регистрации ───────────────────

  function initProofOfWork() {
    var input = document.getElementById('pow');
    if (!input) return;
    var challenge = input.getAttribute('data-challenge');
    var zeros = parseInt(input.getAttribute('data-zeros') || '3', 10);

    // Автоотправки здесь нет намеренно: решение считается за доли секунды,
    // и отправлять форму раньше, чем человек дописал адрес и пароль,
    // значит отправлять её пустой.
    solveProofOfWork(challenge, zeros, function (nonce) {
      input.value = nonce;
      input.form?.removeAttribute('aria-busy');
    });
  }

  // ─── Переключатель темы ────────────────────────────────────────────────────

  function initTheme() {
    var button = document.querySelector('[data-theme-toggle]');
    if (!button) return;
    button.addEventListener('click', function () {
      var root = document.documentElement;
      var next = root.dataset.theme === 'light' ? 'dark' : 'light';
      root.dataset.theme = next;
      try { localStorage.setItem('theme', next); } catch (e) { /* приватный режим */ }
      // Выбор уходит в профиль: тема человека должна действовать на всех
      // страницах и на других устройствах, а не только в этом браузере
      // (F-01-06 §8). Токен есть только у вошедшего — гостю сохранять нечего.
      var csrf = button.getAttribute('data-theme-csrf');
      if (!csrf) return;
      var locale = (location.pathname.split('/')[1] || 'ru');
      fetch('/' + locale + '/theme', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'csrf=' + encodeURIComponent(csrf) + '&theme=' + encodeURIComponent(next),
      }).catch(function () { /* выбор уже применён локально */ });
    });
  }

  // ─── Переключатель языка: адрес с состоянием и полоса прокрутки ───────────

  function initLocaleLinks() {
    var links = document.querySelectorAll('a.topbar__lang');
    var i;
    for (i = 0; i < links.length; i += 1) {
      links[i].addEventListener('click', function () {
        var href = this.getAttribute('href');
        // Фильтры и страница списка живут в запросе, а не в пути (F-04-05):
        // без дописывания переключение сбрасывало бы вид на первый экран.
        if (location.search && href.indexOf('?') === -1) {
          href += location.search;
          this.setAttribute('href', href);
        }
        // Вернуть прокрутку может только следующий переход, поэтому позиция
        // уезжает в хранилище вместе с адресом назначения: восстановление
        // сверяет адрес и не срабатывает, если страница оказалась другой.
        try {
          sessionStorage.setItem('locale-scroll', href + '\n' + String(window.scrollY));
        } catch (e) { /* приватный режим — переключение вернёт к началу */ }
      });
    }
    try {
      var saved = sessionStorage.getItem('locale-scroll');
      sessionStorage.removeItem('locale-scroll');
      var sep = saved === null ? -1 : saved.indexOf('\n');
      var y = sep === -1 ? NaN : parseInt(saved.slice(sep + 1), 10);
      if (sep !== -1 && saved.slice(0, sep) === location.pathname + location.search && y > 0) {
        requestAnimationFrame(function () { window.scrollTo(0, y); });
      }
    } catch (e) { /* приватный режим */ }
  }

  // ─── Проверка занятости ника ───────────────────────────────────────────────

  function initNicknameCheck() {
    var input = document.getElementById('nickname');
    var status = document.getElementById('nickname-status');
    if (!input || !status) return;
    var locale = document.documentElement.lang;
    // Текст подсказки приходит из словаря сообщений разметкой, а не
    // пишется здесь строкой: иначе английская форма осталась бы русской.
    var freeText = status.getAttribute('data-free-text') || '';
    var timer = null;

    input.addEventListener('input', function () {
      clearTimeout(timer);
      status.textContent = '';
      status.removeAttribute('data-state');
    });

    input.addEventListener('blur', function () {
      var nick = input.value.trim();
      if (!nick) return;
      timer = setTimeout(function () {
        fetch('/' + locale + '/register/nick?nick=' + encodeURIComponent(nick), {
          headers: { Accept: 'application/json' },
        })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            if (!data) return;
            status.dataset.state = data.free ? 'free' : 'taken';
            // Про занятый ник не говорится: ошибка всё равно придёт при
            // отправке, и подсказка на лету ничего не решает.
            status.textContent = data.free ? freeText : '';
          })
          .catch(function () { /* сеть недоступна — проверим при отправке */ });
      }, 350);
    });
  }

  // ─── Опрос подтверждения email (EC-A2) ────────────────────────────────────

  function initPolling() {
    var script = document.querySelector('[data-poll-status]');
    if (!script) return;
    var url = script.getAttribute('data-poll-status');
    var next = script.getAttribute('data-poll-next');
    var output = document.getElementById('verify-poll');

    function tick() {
      fetch(url, { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data && data.confirmed) {
            location.href = next || '/';
            return;
          }
          if (output) output.textContent = '';
          setTimeout(tick, 5000);
        })
        .catch(function () { setTimeout(tick, 15000); });
    }
    setTimeout(tick, 5000);
  }

  // ─── Поиск в верхней панели (F-02-06, UI-09) ───────────────────────────────
  //
  // Поле работает и без скриптов: это обычная форма GET, Enter уводит на S-17.
  // Здесь появляются подсказки и навигация стрелками — улучшение, а не условие
  // работы. Задержка и число подсказок приходят из настроек модуля
  // (`search.suggest_debounce_ms`, `search.suggest_max`), поэтому спецификация
  // меняется без правки этого файла.
  function initSearch() {
    var form = document.querySelector('[data-search]');
    if (!form) return;
    var input = form.querySelector('[data-search-input]');
    var status = document.querySelector('[data-search-status]');
    if (!input) return;

    var locale = (location.pathname.split('/')[1] || 'ru');
    var debounce = Number(form.getAttribute('data-debounce')) || 200;
    var timer = null;
    var controller = null;
    var items = [];
    var active = -1;
    var layer = null;

    var closeLayer = function () {
      if (layer) layer.remove();
      layer = null;
      items = [];
      active = -1;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    };

    var highlight = function (next) {
      if (!items.length) return;
      active = (next + items.length) % items.length;
      for (var i = 0; i < items.length; i += 1) {
        var on = i === active;
        items[i].setAttribute('aria-selected', on ? 'true' : 'false');
        if (on) {
          input.setAttribute('aria-activedescendant', items[i].id);
          items[i].scrollIntoView({ block: 'nearest' });
        }
      }
    };

    var render = function (groups) {
      var flat = [];
      groups.forEach(function (group) {
        group.items.forEach(function (item) { flat.push(item); });
      });
      if (!flat.length) {
        closeLayer();
        if (status) status.textContent = '';
        return;
      }

      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'search__suggestions';
        layer.id = 'search-suggestions';
        layer.setAttribute('role', 'listbox');
        form.appendChild(layer);
      }
      layer.textContent = '';
      items = [];
      flat.forEach(function (item, index) {
        var row = document.createElement('a');
        row.className = 'search__suggestion';
        row.id = 'search-suggestion-' + index;
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', 'false');
        row.href = item.href;
        row.textContent = item.title;
        layer.appendChild(row);
        items.push(row);
      });
      input.setAttribute('aria-expanded', 'true');
      // Число найденного объявляется: иначе подсказки появились «молча»
      // (F-02-06 §8).
      if (status) status.textContent = String(flat.length);
    };

    var request = function () {
      var query = input.value.trim();
      if (controller) controller.abort();
      if (query.length < 2) {
        closeLayer();
        return;
      }
      controller = typeof AbortController === 'function' ? new AbortController() : null;
      fetch('/' + locale + '/search/suggest?q=' + encodeURIComponent(query), {
        headers: { Accept: 'application/json' },
        signal: controller ? controller.signal : undefined,
      })
        .then(function (response) { return response.ok ? response.json() : null; })
        .then(function (data) {
          if (!data) return;
          var href = function (path) { return '/' + locale + path; };
          render([
            {
              items: (data.series || []).map(function (item) {
                return { title: item.title, href: href('/series/' + item.slug) };
              }),
            },
            {
              items: (data.people || []).map(function (item) {
                return { title: item.name, href: href('/people/' + item.slug) };
              }),
            },
            {
              items: (data.collections || []).map(function (item) {
                return { title: item.title, href: href('/collections/' + item.slug) };
              }),
            },
          ]);
        })
        .catch(function () {
          // Прерванный запрос или нет сети — не ошибка: подсказки просто не
          // появятся, а страница поиска по Enter продолжит работать (§6).
        });
    };

    input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(request, debounce);
    });

    // Esc закрывает слой и оставляет набранное (R-A11Y-05).
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { closeLayer(); return; }
      if (!items.length) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); highlight(active + 1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); highlight(active - 1); }
      else if (event.key === 'Enter' && active >= 0) {
        event.preventDefault();
        location.href = items[active].href;
      }
    });

    input.addEventListener('blur', function () { setTimeout(closeLayer, 120); });
  }

  // ─── «Показать» у поля пароля (F-01-04) ───────────────────────────────────

  // Своя кнопка, а не встроенный «глаз» браузера: у того нет доступного
  // имени и он появляется не во всех браузерах. Переключение `type` —
  // единственный способ показать пароль, не переписывая его в разметку
  // вторым полем: второй экземпляр значения читали бы и менеджеры паролей.
  function initPasswordReveal() {
    var buttons = document.querySelectorAll('[data-password-toggle]');
    Array.prototype.forEach.call(buttons, function (button) {
      var input = document.getElementById(button.getAttribute('data-password-toggle'));
      if (!input) return;
      var showText = button.getAttribute('data-show-text') || '';
      var hideText = button.getAttribute('data-hide-text') || showText;
      button.addEventListener('click', function () {
        var revealing = input.type === 'password';
        input.type = revealing ? 'text' : 'password';
        button.textContent = revealing ? hideText : showText;
      });
    });
  }

  // ─── Часовой пояс и вид календаря ─────────────────────────────────────────

  // Пояс посетителя без этого скрипта всегда был бы Europe/Minsk (H-72), а
  // «сегодня» у человека в Лос-Анджелесе отличалось бы от серверного на сутки.
  // Cookie без `httpOnly`: её читает только сервер и только этот скрипт.
  function initTimezone() {
    try {
      var zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      if (!zone) return;
      document.cookie = 'tz=' + encodeURIComponent(zone) + '; path=/; max-age=31536000; samesite=lax';
    } catch (e) { /* браузер без Intl — остаётся пояс проекта */ }
  }

  // Вид по умолчанию зависит от ширины экрана (F-03-05 §4: на телефоне —
  // список), а сервер ширину не знает. Скрипт только уточняет вид: без него
  // страница открывается месяцем и остаётся рабочей.
  function initCalendarDefaultView() {
    var form = document.querySelector('[data-calendar-default-view]');
    if (!form || form.getAttribute('data-view-chosen') === 'true') return;
    if (window.matchMedia('(min-width: 640px)').matches) return;
    // Фокус сюда не переносится: страница открылась, человек читает её, и
    // перехват фокуса при загрузке сбивает чтение с клавиатуры.
    var list = form.querySelector('button[name="view"][value="list"]');
    if (list) list.click();   // один переход на список, дальше вид выбирает человек
  }

  // Окно отмены массовой отметки (F-03-02 §4): кнопка исчезает сама, потому
  // что человек занят своей жизнью и не обязан помнить про десять секунд.
  function initUndoWindow() {
    document.querySelectorAll('[data-undo-window]').forEach(function (form) {
      var seconds = Number(form.getAttribute('data-undo-window')) || 10;
      setTimeout(function () { form.remove(); }, seconds * 1000);
    });
  }

  // Счётчик непрочитанных (F-03-09 §8а, UI-11).
  //
  // Опрос идёт только пока вкладка видима: в фоне человек ничего не видит, а
  // запросы в это время всё равно уходят. Возврат на вкладку опрашивает сразу,
  // иначе после часа в соседнем окне точка осталась бы старой до следующего
  // периода.
  function initUnreadPoll() {
    var menu = document.querySelector('[data-account-menu]');
    if (!menu) return;

    var seconds = Number(menu.getAttribute('data-notify-poll')) || 0;
    var locale = document.documentElement.lang || 'ru';
    var url = '/' + locale + '/notifications/count';
    var timer = null;

    var dot = menu.querySelector('[data-unread-dot]');
    var counter = menu.querySelector('[data-unread-count]');
    var label = menu.querySelector('.account__link');

    function apply(unread) {
      var shown = unread > 99 ? '99+' : String(unread);
      if (unread > 0) {
        if (!dot) {
          dot = document.createElement('span');
          dot.className = 'account__dot';
          dot.setAttribute('data-unread-dot', '');
          dot.setAttribute('aria-hidden', 'true');
          menu.querySelector('.account__avatar').appendChild(dot);
        }
        if (label && label.textContent.indexOf(' · ') === -1) {
          label.textContent = label.textContent + ' · ' + shown;
        }
        if (counter) counter.textContent = shown;
      } else if (dot) {
        dot.remove();
        if (label) {
          label.textContent = label.textContent.split(' · ')[0];
        }
      }
    }

    function once() {
      fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) { if (data) apply(Number(data.unread) || 0); })
        .catch(function () { /* счётчик не критичен: молчание лучше ошибки в углу */ });
    }

    function start() {
      if (timer || seconds <= 0) return;
      timer = setInterval(once, seconds * 1000);
    }

    function stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        once();
        start();
      } else {
        stop();
      }
    });

    if (document.visibilityState !== 'hidden') start();
  }

  // ─── Резервные коды: «Скачать» и «Печать» (F-01-05 §4, §19) ──────────────

  // Коды читаются из разметки, а не кладутся в обработчик: второй экземпляр
  // тех же значений в скрипте означал бы, что они лежат в исходнике страницы и
  // переживают перезагрузку, а в базе их уже нет (в базе только хеши).
  function initBackupCodes() {
    var list = document.querySelector('.codes');
    var print = document.querySelector('[data-print-codes]');
    if (print) {
      print.addEventListener('click', function () { window.print(); });
    }

    var download = document.querySelector('[data-download-codes]');
    if (!download || !list) return;
    download.addEventListener('click', function () {
      var codes = Array.prototype.map.call(
        list.querySelectorAll('code'),
        function (node) { return node.textContent.trim(); },
      ).filter(Boolean);
      if (!codes.length) return;

      // Файл собирается на клиенте: отправлять коды на сервер второй раз
      // незачем, а в базе их и нет. `Blob` вместо адреса страницы — длинный
      // список в адресе осел бы в истории и в журналах браузера.
      var lines = [list.getAttribute('data-title') || ''].concat(codes).filter(Boolean);
      var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = list.getAttribute('data-file') || 'codes.txt';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      // Ссылка снимается сразу: иначе она держит файл в памяти до перезагрузки.
      URL.revokeObjectURL(url);
    });
  }

  // ─── Отзыв (F-04-04) ───────────────────────────────────────────────────────
  //
  // Сервер решает всё: права, длину, проверку текста. Скрипт добавляет то,
  // чего сервер не может, — счётчик знаков, черновик при потере сети и
  // модальное открытие формы. Без скрипта страница работает: форма
  // открывается якорем `#review-dialog` (стиль `:target`).

  // Панель фильтров списка отзывов (F-04-05, S-09). Сервер рисует панель
  // раскрытой: ширину экрана он не знает (H-72). Скрипт сворачивает её на
  // телефоне и держит раскрытой на широком экране, где строка-кнопка спрятана
  // стилем. Без скрипта панель остаётся раскрытой — это рабочее состояние,
  // а не поломка.
  function initReviewFilters() {
    var wide = window.matchMedia('(min-width: 1024px)');
    document.querySelectorAll('details.reviews__filters').forEach(function (panel) {
      var sync = function () { panel.open = wide.matches; };
      if (typeof wide.addEventListener === 'function') {
        wide.addEventListener('change', sync);
      } else if (typeof wide.addListener === 'function') {
        wide.addListener(sync); // Safari 13.1: старый слушатель вместо change.
      }
      sync();
    });
  }

  /**
   * Голос «Полезно» (F-04-06): отправка без перезагрузки страницы.
   *
   * Форма работает и без скрипта — обычный POST с возвратом на страницу.
   * Скрипт добавляет то самое состояние «сохраняется» (кнопка гаснет на
   * время запроса) и обновляет кнопку сразу. Любой отказ возвращает
   * управление браузеру: строки ошибок рисует сервер, а не скрипт.
   */
  function initReviewVotes() {
    document.querySelectorAll('form[data-review-vote]').forEach(function (form) {
      var button = form.querySelector('button');
      if (!button) return;

      form.addEventListener('submit', function (event) {
        if (button.disabled) return event.preventDefault();
        event.preventDefault();
        button.disabled = true;
        button.setAttribute('aria-busy', 'true');
        var text = button.textContent;
        // Кнопка в FormData не попадает (вкатывается только submitter), а
        // её имя и значение — сама цель (`to`): добавляю вручную.
        fetch(form.action, {
          method: 'POST',
          body: urlencoded(form, ['to', button.value]),
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
        })
          .then(function (res) {
            // Ответ, но не JSON (устаревшая сессия, 429): скрипт не поладил —
            // обычная отправка покажет причину страницей.
            if (!res.ok) fail(form, button, text);
            return res.ok ? res.json() : null;
          })
          .then(function (data) {
            if (!data) return;
            apply(button, data);
          })
          .catch(function () { fail(form, button, text); });
      });
    });

    function apply(button, data) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.setAttribute('aria-pressed', data.voted ? 'true' : 'false');
      // Цель следующего клика объявляет сам сервер: реверс кнопки не угадывается.
      button.setAttribute('value', data.voted ? 'unset' : 'set');
      button.classList.toggle('reviews__vote-button--on', Boolean(data.voted));
      var num = button.querySelector('.reviews__vote-num');
      if (num) num.textContent = '· ' + data.count;
    }

    function fail(form, button, text, why) {
      // Обычная отправка: страница ответит или своим текстом ошибки, или
      // обновлённым состоянием кнопки. Значение уже в разметке формы.
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.textContent = text;
      form.submit();
    }
  }

  /**
   * Жалоба на отзыв (F-04-07).
   *
   * Работает поверх серверного сценария: без скрипта диалог открывается
   * состоянием адреса и отправляется обычным POST. Со скриптом пункт меню
   * открывает нативный диалог на месте, отправка идёт fetch-ом, и ответы
   * («отправлено», «уже подано», ошибка поля) рисуются внутри диалога.
   * Ответы прочих статусов (403, 404, 429) не переводятся скриптом —
   * обычная отправка покажет страницу с причиной, как у голоса.
   */
  function initReviewReports() {
    var dialog = document.getElementById('review-report');
    var form = dialog ? dialog.querySelector('form[data-review-report]') : null;
    if (!dialog || !form) return;

    document.querySelectorAll('a[data-report-open]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        event.preventDefault();
        // Адрес действия подставляет пункт меню: диалог один, отзывов много.
        var action = link.getAttribute('data-report-action');
        if (action) form.setAttribute('action', action);
        // Прошлые вводы не чужой сессии: каждое открытие начинается с чистой.
        form.reset();
        if (!dialog.open) dialog.showModal();
      });
    });

    document.querySelectorAll('[data-review-close]').forEach(function (button) {
      button.addEventListener('click', function () { dialog.close(); });
    });

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      fetch(form.getAttribute('action') || form.action, {
        method: 'POST',
        body: urlencoded(form),
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
      })
        .then(function (res) {
          if (res.status === 200) { showDone(dialog.dataset.sentText); return null; }
          if (res.status === 409) { showDone(dialog.dataset.alreadyText); return null; }
          if (res.status === 400) return res.json();
          throw new Error('not-expected:' + res.status);
        })
        .then(function (data) {
          if (!data) return;
          // Ошибка поля названа текстом от сервера: строки для клиента
          // собирает разметка, скрипт ничего не переводит сам.
          var why = data.error === 'comment'
            ? form.getAttribute('data-error-comment')
            : form.getAttribute('data-error-reason');
          showError(why);
        })
        .catch(function () { form.submit(); });
    });

    function showResult(text, kind) {
      var body = dialog.querySelector('.reviews__report-body');
      if (!body) { dialog.close(); return; }
      var label = document.createElement('p');
      label.className = kind;
      label.textContent = text;
      var actions = document.createElement('p');
      actions.className = 'reviews__report-actions';
      var close = document.createElement('button');
      close.type = 'button';
      close.className = 'button button--quiet';
      close.setAttribute('data-review-close', '');
      close.textContent = dialog.dataset.closeLabel;
      close.addEventListener('click', function () { dialog.close(); });
      actions.appendChild(close);
      body.replaceChildren(label, actions);
      // Фокус на результат: чтение ответа не требует обхода вкладкой заново.
      label.setAttribute('tabindex', '-1');
      label.focus();
    }

    function showDone(text) { showResult(text, 'reviews__report-done'); }

    function showError(text) {
      var old = document.getElementById('review-report-err');
      if (old) old.remove();
      var label = document.createElement('p');
      label.className = 'reviews__report-err';
      label.id = 'review-report-err';
      label.setAttribute('role', 'alert');
      label.textContent = text;
      form.setAttribute('aria-describedby', 'review-report-err');
      form.insertBefore(label, form.firstChild);
    }
  }

  /** Письменность текста: кириллицы не меньше латиницы — русский (R-I18N-08). */
  function scriptLang(text) {
    var cyrillic = 0;
    var latin = 0;
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if ((c >= 0x0400 && c <= 0x04ff) || (c >= 0x0500 && c <= 0x052f)) cyrillic++;
      else if ((c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a)) latin++;
    }
    return cyrillic >= latin ? 'ru' : 'en';
  }

  function initReviews() {
    var dialog = document.getElementById('review-dialog');
    if (!dialog) return;
    var form = dialog.querySelector('[data-review-form]');
    if (!form) return;

    // Открытие и закрытие. Ссылки остаются рабочими без скрипта: переход по
    // якорю отменяется только тогда, когда диалог умеет показаться сам.
    var canModal = typeof dialog.showModal === 'function';
    document.querySelectorAll('[data-review-open]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        if (!canModal) return;
        event.preventDefault();
        if (!dialog.open) dialog.showModal();
      });
    });
    form.querySelectorAll('[data-review-close]').forEach(function (link) {
      link.addEventListener('click', function (event) {
        if (!canModal || !dialog.open) return;
        event.preventDefault();
        dialog.close();
      });
    });

    var area = form.querySelector('[data-review-body]');
    var count = form.querySelector('[data-review-count-text]');
    var template = form.querySelector('[data-review-counter-template]');
    var lang = form.querySelector('[data-review-lang]');
    if (!area) return;

    // Черновик живёт под ключом страницы и переживает потерю сети. Серверный
    // текст — точка отсчёта: совпал с ней — черновик уже отправлен и не
    // нужен; разошёлся — в нём неотправленное, и его надо вернуть в поле.
    var key = 'review:' + (dialog.getAttribute('data-review-key') || location.pathname);
    var baseline = area.value;
    var langTouched = false;
    var timer = null;

    function store(value) {
      try {
        if (value) localStorage.setItem(key, value);
        else localStorage.removeItem(key);
      } catch (e) { /* приватный режим: черновика не будет, форма работает */ }
    }

    try {
      var draft = localStorage.getItem(key);
      if (draft === baseline) store(null);
      else if (draft !== null) area.value = draft;
    } catch (e) { /* см. store */ }

    function recount() {
      if (!count) return;
      var text = template ? template.textContent : '{count}';
      count.textContent = text.replace('{count}', String(area.value.length));
    }

    recount();
    area.addEventListener('input', function () {
      recount();
      // Язык — по письменности, пока человек не поправил его сам (R-I18N-08).
      if (lang && !langTouched) lang.value = scriptLang(area.value);
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        timer = null;
        store(area.value === baseline ? null : area.value);
      }, 500);
    });
    if (lang) lang.addEventListener('change', function () { langTouched = true; });
  }

  /**
   * Подтверждение необратимого действия.
   *
   * Текст и решение о подтверждении задаёт серверная разметка (`data-confirm`),
   * а `preventDefault` до отправки формы оставляет данные в целости, пока
   * человек не согласился.
   */
  function initConfirmations() {
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var node = target.closest('[data-confirm]');
      if (!node) return;
      if (!window.confirm(node.getAttribute('data-confirm'))) event.preventDefault();
    }, true);
  }

  function boot() {
    var path = location.pathname;
    initTimezone();
    initTheme();
    initLocaleLinks();
    initPasswordReveal();
    initBackupCodes();
    initSearch();
    initCalendarDefaultView();
    initUndoWindow();
    initUnreadPoll();
    initReviews();
    initReviewFilters();
    initReviewVotes();
    initReviewReports();
    initConfirmations();
    if (path.indexOf('/register/confirm') !== -1) initPolling();
    else {
      initProofOfWork();
      initNicknameCheck();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
