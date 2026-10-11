// Клиентские скрипты формы.
//
// Здесь три вещи, без которых формы не работают:
//
//  1. Невидимая проверка (R-SEC-34). Пока решение не подставлено, форма
//     после трёх неудач становится непроходимой — это не «защита», а отказ
//     человеку. Сложность задаёт сервер: она приходит в data-zeros,
//     иначе клиент и сервер считают разные задачи.
//  2. Переключатель темы. Ранний скрипт в <head> только читает тему,
//     записать её должен этот.
//  3. Проверка занятости ника и опрос подтверждения на шаге 2 (EC-A2).
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
    });
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

  function boot() {
    var path = location.pathname;
    initTheme();
    initPasswordReveal();
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
