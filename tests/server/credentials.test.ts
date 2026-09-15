import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { newTransferJob, TransferFile } from '../../src/server/rebalanceJob';
import { fixture, gate, HOST, makeTestApp, TEST_KEY, TEST_SECRET } from './helpers/gate-nock';

describe('GET /api/credentials', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  it('reports a masked key and never leaks the secret', async () => {
    app = makeTestApp(); // sets GATE_API_KEY/GATE_API_SECRET deterministically

    const res = await app.inject({ method: 'GET', url: '/api/credentials', headers: HOST });

    expect(res.statusCode).toBe(200);
    const { data } = res.json();
    expect(data.configured).toBe(true);
    expect(data.keyMasked).toBe('test…5678'); // first 4 + … + last 4 of testkey12345678

    expect(res.body).not.toContain(TEST_SECRET);
    expect(res.body).not.toContain(TEST_KEY); // full key never appears either
  });
});

describe('PUT /api/credentials with a transfer', () => {
  let app: FastifyInstance;
  afterEach(async () => {
    await app?.close();
  });

  const setup = async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'credentials-'));
    const envPath = path.join(dir, '.env');
    writeFileSync(envPath, `GATE_API_KEY=${TEST_KEY}\nGATE_API_SECRET=${TEST_SECRET}\n`);
    const transfers = new TransferFile(dir);
    app = makeTestApp({
      credentials: { envPath, setClients: () => undefined },
      transfer: { jobs: transfers, sleep: () => new Promise<void>(() => undefined) },
    });
    await app.ready();
    const moving = (userId: string | null) =>
      transfers.write(newTransferJob({ coin: 'USDT', from: 'CROSSEX', to: 'SPOT', amount: 5, userId }, Date.now()));
    const keyCheck = () => gate().get('/api/v4/crossex/accounts').query(true).reply(200, fixture('account.json'));
    const put = () =>
      app.inject({
        method: 'PUT',
        url: '/api/credentials',
        headers: HOST,
        payload: { key: 'newkey876543210', secret: 'newsecret' },
      });
    return { envPath, transfers, moving, keyCheck, put };
  };

  it('refuses while a transfer moves', async () => {
    const { envPath, moving, keyCheck, put } = await setup();
    moving('999');
    keyCheck();

    const res = await put();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('A transfer is still moving.');
    expect(readFileSync(envPath, 'utf8')).toContain(`GATE_API_KEY=${TEST_KEY}`);
  });

  it('refuses while a transfer with no account id moves', async () => {
    const { envPath, moving, keyCheck, put } = await setup();
    moving(null);
    keyCheck();

    const res = await put();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('A transfer is still moving.');
    expect(readFileSync(envPath, 'utf8')).toContain(`GATE_API_KEY=${TEST_KEY}`);
  });

  it('accepts a new key on the same account while a transfer moves', async () => {
    const { envPath, transfers, moving, keyCheck, put } = await setup();
    moving('1234567');
    keyCheck();

    const res = await put();

    expect(res.statusCode).toBe(200);
    expect(readFileSync(envPath, 'utf8')).toContain('GATE_API_KEY=newkey876543210');
    expect(transfers.read()?.status).toBe('moving');
  });

  it('refuses when a transfer starts during the key check', async () => {
    const { envPath, moving, put } = await setup();
    gate()
      .get('/api/v4/crossex/accounts')
      .query(true)
      .reply(200, () => {
        moving('999');
        return fixture('account.json');
      });

    const res = await put();

    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toBe('A transfer is still moving.');
    expect(readFileSync(envPath, 'utf8')).toContain(`GATE_API_KEY=${TEST_KEY}`);
  });
});
