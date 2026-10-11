// Шифрование адреса и слепой индекс.
//
// R-SEC-26 требует раздельные ключи для сессий, шифрования и HMAC: общий
// секрет связывает подсистемы, и его ротация ломает всё сразу. Раньше
// `blindIndex` брал SESSION_SECRET, то есть правило не выполнялось.
//
// Формат хранения проверяется здесь, потому что расшифровать старое значение
// иначе нечем: сменится формат — данные придётся восстанавливать вручную.

import test from 'node:test';
import assert from 'node:assert/strict';

import { blindIndex, encryptValue, decryptValue, VERSION } from '../src/services/auth/crypto.js';

/** Ключи на время прогона: тесты не должны зависеть от окружения машины. */
const HMAC_KEY = 'hmac-secret-for-tests';
const DATA_KEY = 'data-secret-for-tests';

function withKeys(run) {
  const saved = { ...process.env };
  process.env.BLIND_INDEX_SECRET = HMAC_KEY;
  process.env.ADDRESS_SECRET = DATA_KEY;
  try {
    return run();
  } finally {
    process.env = saved;
  }
}

// ─── Слепой индекс ────────────────────────────────────────────────────────────

test('слепой индекс одинаков для одного адреса и различен для разных', () => {
  withKeys(() => {
    const a = blindIndex('user@example.com');
    const b = blindIndex('USER@Example.com');
    const other = blindIndex('other@example.com');

    assert.equal(a.length, 32, 'HMAC-SHA256 даёт 32 байта');
    assert.deepEqual(a, b, 'регистр адреса не влияет: адрес нормализуется до поиска');
    assert.notDeepEqual(a, other);
  });
});

test('без ключа HMAC слепой индекс не вычисляется', () => {
  withKeys(() => {
    delete process.env.BLIND_INDEX_SECRET;
    assert.throws(() => blindIndex('a@b.c'), /BLIND_INDEX_SECRET/);
  });
});

// ─── Шифрование ──────────────────────────────────────────────────────────────

test('зашифрованное значение расшифровывается обратно', () => {
  withKeys(() => {
    const stored = encryptValue('адрес@example.com', 'email');
    assert.ok(Buffer.isBuffer(stored), 'в колонку BYTEA кладётся Buffer');
    assert.equal(decryptValue(stored, 'email'), 'адрес@example.com');
  });
});

test('два шифрования одного значения дают разные байты', () => {
  withKeys(() => {
    // Одинаковый шифротекст выдал бы равенство шифротекстов, а значит —
    // возможность отличать пользователей с одинаковым адресом в дампе базы.
    const a = encryptValue('same@example.com', 'email');
    const b = encryptValue('same@example.com', 'email');
    assert.notDeepEqual(a, b, 'IV случаен для каждого шифрования');
    assert.deepEqual(decryptValue(a, 'email'), decryptValue(b, 'email'));
  });
});

test('версия формата записана в первом байте', () => {
  withKeys(() => {
    const stored = encryptValue('a@b.c', 'email');
    assert.equal(stored[0], VERSION, 'по версии значение читается и переносится');
  });
});

test('чужим ключом значение не расшифровывается', () => {
  withKeys(() => {
    const stored = encryptValue('a@b.c', 'email');
    process.env.ADDRESS_SECRET = 'другой-секрет';
    assert.throws(() => decryptValue(stored, 'email'), /ADDRESS_SECRET|расшифров/);
  });
});

test('подмена байта шифротекста ломает расшифровку', () => {
  withKeys(() => {
    const stored = encryptValue('a@b.c', 'email');
    const tampered = Buffer.from(stored);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(() => decryptValue(tampered, 'email'), /расшифров/);
  });
});

test('значение, зашифрованное для другой цели, не читается', () => {
  withKeys(() => {
    // Секрет 2FA и адрес лежат под одним ключом шифрования, и разводить их
    // должна метка, иначе шифротекст можно было бы подставить из одного поля
    // в другое.
    const stored = encryptValue('JBSWY3DPEHPK3PXP', 'totp');
    assert.throws(() => decryptValue(stored, 'email'), /расшифров/);
  });
});

test('неизвестная версия формата не читается как обычное значение', () => {
  withKeys(() => {
    const stored = encryptValue('a@b.c', 'email');
    stored[0] = VERSION + 1;
    assert.throws(() => decryptValue(stored, 'email'), /верси|версия/);
  });
});

test('без ключа шифрования значение не шифруется', () => {
  withKeys(() => {
    delete process.env.ADDRESS_SECRET;
    assert.throws(() => encryptValue('a@b.c', 'email'), /ADDRESS_SECRET/);
  });
});

test('пустая колонка читается как отсутствие значения, а не как ошибка', () => {
  withKeys(() => {
    // Пользователи, заведённые до появления шифрования, имеют NULL. Их
    // адрес не восстановить, но и падать на этом нельзя.
    assert.equal(decryptValue(null, 'email'), null);
  });
});