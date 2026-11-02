import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST, makeTestApp } from './helpers/gate-nock';

const BOOK_A = `0x${'a'.repeat(40)}|abcd…wxyz`;
const BOOK_B = `none|none`;
const EMPTY = { sinceByAsset: {}, exclusions: {}, legSince: {} };

let app: FastifyInstance | undefined;
let extra: FastifyInstance | undefined;
let dataDir = '';

afterEach(async () => {
  await app?.close();
  await extra?.close();
  app = undefined;
  extra = undefined;
  if (dataDir) {
    fs.chmodSync(dataDir, 0o700);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  dataDir = '';
});

function start(): FastifyInstance {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asset-prefs-'));
  app = makeTestApp({ dataDir });
  return app;
}

const url = (book: string) => `/api/asset-prefs/${encodeURIComponent(book)}`;
const file = () => path.join(dataDir, 'asset-prefs.json');
const get = (book: string, a = app!) => a.inject({ method: 'GET', url: url(book), headers: HOST });
const patch = (book: string, payload: unknown, a = app!) =>
  a.inject({ method: 'PATCH', url: url(book), headers: HOST, payload: payload as object });
const importAll = (payload: unknown) =>
  app!.inject({ method: 'POST', url: '/api/asset-prefs/import', headers: HOST, payload: payload as object });

describe('asset prefs', () => {
  it('empty book', async () => {
    start();
    const res = await get(BOOK_A);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual(EMPTY);
  });

  it('patch saves one key', async () => {
    start();
    const res = await patch(BOOK_A, { exclusions: { 'boros:59': 'all' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ...EMPTY, exclusions: { 'boros:59': 'all' } });
    expect((await get(BOOK_A)).json().data.exclusions).toEqual({ 'boros:59': 'all' });
  });

  it('null removes a key', async () => {
    start();
    await patch(BOOK_A, { exclusions: { 'boros:59': 'all', 'boros:60': 2 } });
    await patch(BOOK_A, { exclusions: { 'boros:59': null } });
    expect((await get(BOOK_A)).json().data.exclusions).toEqual({ 'boros:60': 2 });
  });

  it('drops perp exclusions', async () => {
    start();
    const res = await patch(BOOK_A, { exclusions: { 'perp:ETHUSDT': 'all', 'boros:1': { qty: 3, at: -0.01 } } });
    expect(res.json().data.exclusions).toEqual({ 'boros:1': { qty: 3, at: -0.01 } });
  });

  it('since dates validated as today', async () => {
    start();
    const res = await patch(BOOK_A, { sinceByAsset: { eth: 1760000000, btc: -1, sol: 0 } });
    expect(res.json().data.sinceByAsset).toEqual({ ETH: 1760000000, SOL: 0 });
  });

  it('rejects a bad book key', async () => {
    start();
    for (const book of ['bad', `0x${'A'.repeat(40)}|k`, `none|${'x'.repeat(41)}`, 'none|']) {
      const res = await patch(book, { exclusions: { 'boros:59': 'all' } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.category).toBe('validation');
      expect((await get(book)).statusCode).toBe(400);
    }
    expect(fs.existsSync(file())).toBe(false);
  });

  it('rejects a bad body', async () => {
    start();
    for (const payload of [{ exclusions: 5 }, { sinceByAsset: [] }, { legSince: 'x' }]) {
      const res = await patch(BOOK_A, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.category).toBe('validation');
    }
    expect(fs.existsSync(file())).toBe(false);
  });

  it('unknown fields are dropped', async () => {
    start();
    const res = await patch(BOOK_A, { foo: 1, legSince: { 'boros:5': 1760000000 } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ...EMPTY, legSince: { 'boros:5': 1760000000 } });
    expect(JSON.stringify(JSON.parse(fs.readFileSync(file(), 'utf8')))).not.toContain('foo');
  });

  it('survives a restart', async () => {
    start();
    await patch(BOOK_A, { exclusions: { 'boros:59': 'all' } });
    extra = makeTestApp({ dataDir });
    const res = await get(BOOK_A, extra);
    expect(res.json().data.exclusions).toEqual({ 'boros:59': 'all' });
  });

  it('books stay apart', async () => {
    start();
    await patch(BOOK_A, { exclusions: { 'boros:59': 'all' } });
    await patch(BOOK_B, { exclusions: { 'boros:60': 'all' } });
    expect((await get(BOOK_A)).json().data.exclusions).toEqual({ 'boros:59': 'all' });
    expect((await get(BOOK_B)).json().data.exclusions).toEqual({ 'boros:60': 'all' });
  });

  it('needs the token', async () => {
    start();
    const res = await app!.inject({ method: 'GET', url: url(BOOK_A), headers: { host: HOST.host } });
    expect(res.statusCode).toBe(401);
  });

  it('import fills every empty book', async () => {
    start();
    const res = await importAll({
      [BOOK_A]: { exclusions: { 'boros:1': 'all', 'perp:X': 'all' }, sinceByAsset: { eth: 5 } },
      [BOOK_B]: { legSince: { 'boros:2': 9 } },
      'bad key': { exclusions: { 'boros:3': 'all' } },
    });
    expect(res.statusCode).toBe(200);
    expect((await get(BOOK_A)).json().data).toEqual({ ...EMPTY, exclusions: { 'boros:1': 'all' }, sinceByAsset: { ETH: 5 } });
    expect((await get(BOOK_B)).json().data).toEqual({ ...EMPTY, legSince: { 'boros:2': 9 } });
    expect(Object.keys(JSON.parse(fs.readFileSync(file(), 'utf8')))).toEqual([BOOK_A, BOOK_B]);
  });

  it('import never overwrites', async () => {
    start();
    await patch(BOOK_A, { exclusions: { 'boros:59': 'all' } });
    const res = await importAll({
      [BOOK_A]: { exclusions: { 'boros:59': 3, 'boros:61': 'all' } },
      [BOOK_B]: { exclusions: { 'boros:2': 'all' } },
    });
    expect(res.statusCode).toBe(200);
    expect((await get(BOOK_A)).json().data).toEqual({ ...EMPTY, exclusions: { 'boros:59': 'all', 'boros:61': 'all' } });
    expect((await get(BOOK_B)).json().data.exclusions).toEqual({ 'boros:2': 'all' });
  });

  it('E15 a restored key stays out of a later import', async () => {
    start();
    await patch(BOOK_A, { exclusions: { 'boros:59': 'all', 'boros:60': 2 } });
    await patch(BOOK_A, { exclusions: { 'boros:59': null } });
    await importAll({ [BOOK_A]: { exclusions: { 'boros:59': 'all', 'boros:62': 1.5 } } });
    expect((await get(BOOK_A)).json().data).toEqual({ ...EMPTY, exclusions: { 'boros:60': 2, 'boros:62': 1.5 } });
  });

  it('E15 a reset date stays out of a later import', async () => {
    start();
    await patch(BOOK_A, { sinceByAsset: { eth: 5 }, legSince: { 'boros:5': 9 } });
    await patch(BOOK_A, { sinceByAsset: { eth: null }, legSince: { 'boros:5': null } });
    await importAll({ [BOOK_A]: { sinceByAsset: { eth: 7 }, legSince: { 'boros:5': 8 } } });
    expect((await get(BOOK_A)).json().data).toEqual(EMPTY);
  });

  it('E15 exclude after restore, then restore again', async () => {
    start();
    await patch(BOOK_A, { exclusions: { 'boros:59': 'all' } });
    await patch(BOOK_A, { exclusions: { 'boros:59': null } });
    await patch(BOOK_A, { exclusions: { 'boros:59': 2 } });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))[BOOK_A].restored.exclusions).toEqual([]);
    await importAll({ [BOOK_A]: { exclusions: { 'boros:59': 'all' } } });
    expect((await get(BOOK_A)).json().data.exclusions).toEqual({ 'boros:59': 2 });
    await patch(BOOK_A, { exclusions: { 'boros:59': null } });
    await importAll({ [BOOK_A]: { exclusions: { 'boros:59': 'all' } } });
    expect((await get(BOOK_A)).json().data.exclusions).toEqual({});
  });

  it('E15 restored keys survive a restart and stay per book', async () => {
    start();
    await patch(BOOK_A, { exclusions: { 'boros:59': 'all' } });
    await patch(BOOK_A, { exclusions: { 'boros:59': null } });
    extra = makeTestApp({ dataDir });
    await extra.inject({
      method: 'POST',
      url: '/api/asset-prefs/import',
      headers: HOST,
      payload: { [BOOK_A]: { exclusions: { 'boros:59': 'all' } }, [BOOK_B]: { exclusions: { 'boros:59': 'all' } } },
    });
    expect((await get(BOOK_A, extra)).json().data.exclusions).toEqual({});
    expect((await get(BOOK_B, extra)).json().data.exclusions).toEqual({ 'boros:59': 'all' });
  });

  it('E15 a file with no restored list loads', async () => {
    start();
    fs.writeFileSync(file(), JSON.stringify({ [BOOK_A]: { ...EMPTY, exclusions: { 'boros:59': 'all' } } }));
    expect((await get(BOOK_A)).json().data).toEqual({ ...EMPTY, exclusions: { 'boros:59': 'all' } });
    await importAll({ [BOOK_A]: { exclusions: { 'boros:59': 3, 'boros:61': 'all' } } });
    expect((await get(BOOK_A)).json().data.exclusions).toEqual({ 'boros:59': 'all', 'boros:61': 'all' });
    await patch(BOOK_A, { exclusions: { 'boros:59': null } });
    expect((await get(BOOK_A)).json().data).toEqual({ ...EMPTY, exclusions: { 'boros:61': 'all' } });
  });

  it('bad file is kept aside', async () => {
    start();
    fs.writeFileSync(file(), '{not json');
    const res = await get(BOOK_A);
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ ...EMPTY, unreadable: true });
    expect(fs.readFileSync(`${file()}.bad`, 'utf8')).toBe('{not json');
    expect(fs.existsSync(file())).toBe(false);
    await patch(BOOK_A, { exclusions: { 'boros:59': 'all' } });
    expect((await get(BOOK_A)).json().data.exclusions).toEqual({ 'boros:59': 'all' });
  });

  it('N2 the unreadable line survives a restart until the next save', async () => {
    start();
    fs.writeFileSync(file(), '{not json');
    await get(BOOK_A);
    extra = makeTestApp({ dataDir });
    expect((await get(BOOK_B, extra)).json().data.unreadable).toBe(true);
    await patch(BOOK_A, { exclusions: { 'boros:59': 'all' } }, extra);
    expect((await get(BOOK_B, extra)).json().data).toEqual(EMPTY);
  });

  it('N9 an import after a bad file keeps the unreadable line until the next save, across a restart', async () => {
    start();
    fs.writeFileSync(file(), '{not json');
    await importAll({ [BOOK_A]: { exclusions: { 'boros:59': 'all' } } });
    expect(fs.existsSync(file())).toBe(true);
    expect((await get(BOOK_A)).json().data.unreadable).toBe(true);
    extra = makeTestApp({ dataDir });
    expect((await get(BOOK_A, extra)).json().data.unreadable).toBe(true);
    await patch(BOOK_A, { sinceByAsset: { BTC: 1 } }, extra);
    expect((await get(BOOK_A, extra)).json().data.unreadable).toBeUndefined();
  });

  it('F10 a second bad file keeps the first .bad copy', async () => {
    start();
    fs.writeFileSync(file(), '{first');
    await get(BOOK_A);
    fs.writeFileSync(file(), '{second');
    const res = await get(BOOK_A);
    expect(res.json().data.unreadable).toBe(true);
    expect(fs.readFileSync(`${file()}.bad`, 'utf8')).toBe('{first');
    expect(fs.readFileSync(`${file()}.bad.1`, 'utf8')).toBe('{second');
  });

  it('F11 rejects non-number quantities', async () => {
    start();
    const res = await patch(BOOK_A, {
      exclusions: {
        'boros:1': true,
        'boros:2': [5],
        'boros:3': '1e3',
        'boros:4': { qty: '5' },
        'boros:5': 2.5,
        'boros:6': { qty: 3, at: 1760000000 },
        'boros:7': 'all',
        'boros:8': 0,
      },
    });
    expect(res.json().data.exclusions).toEqual({ 'boros:5': 2.5, 'boros:6': { qty: 3, at: 1760000000 }, 'boros:7': 'all' });
  });

  it('M2 import merges keys a book does not have', async () => {
    start();
    await patch(BOOK_A, { exclusions: { 'boros:59': 'all' } });
    await importAll({ [BOOK_A]: { exclusions: { 'boros:59': 4, 'boros:1': 2 }, legSince: { 'boros:5': 9 } } });
    const data = (await get(BOOK_A)).json().data;
    expect(data.exclusions).toEqual({ 'boros:59': 'all', 'boros:1': 2 });
    expect(data.legSince).toEqual({ 'boros:5': 9 });
  });

  it('parallel patches both land', async () => {
    start();
    await Promise.all([
      patch(BOOK_A, { exclusions: { 'boros:59': 'all' } }),
      patch(BOOK_A, { exclusions: { 'boros:60': 'all' } }),
    ]);
    expect((await get(BOOK_A)).json().data.exclusions).toEqual({ 'boros:59': 'all', 'boros:60': 'all' });
  });

  it('failed write says so', async () => {
    start();
    await patch(BOOK_A, { exclusions: { 'boros:59': 'all' } });
    const before = fs.readFileSync(file(), 'utf8');
    fs.chmodSync(dataDir, 0o500);
    const res = await patch(BOOK_A, { exclusions: { 'boros:60': 'all' } });
    fs.chmodSync(dataDir, 0o700);
    expect(res.statusCode).toBe(500);
    expect(res.json().error.category).toBe('unknown');
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
  });
});
