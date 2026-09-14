import type { FastifyInstance } from 'fastify';
import type { SpotAccount } from 'gate-api';
import { classifyGateError, CoreError } from '../../core/errors';
import { pathRule, transferPaths, type SpotBalance, type TransferCoin, type TransferPath } from '../../core/rebalance/plan';
import type { AppDeps } from '../app';
import { TTL } from '../cache';
import { DISCLAIMER_NOT_ACCEPTED, isDisclaimerAccepted } from '../disclaimer';
import { formatMoney, LOCK_TEXT, newTransferJob, type TransferFile, type TransferJob } from '../rebalanceJob';
import { runTransfer } from '../rebalanceRunner';
import { conflict, moneyLockNow, sleep, STALE_TEXT } from './rebalance';

const SPOT_COINS: readonly TransferCoin[] = ['USDT', 'USDC'];

const minimumText = (path: TransferPath): string =>
  `Minimum ${path.min.toLocaleString('en-US', { maximumFractionDigits: 8 })} ${path.coin}.`;

const overMaxText = (path: TransferPath, max: number): string =>
  path.from === 'SPOT'
    ? `Max ${formatMoney(max)} ${path.coin}. That is your Gate spot balance.`
    : `Max ${formatMoney(max)} ${path.coin}. The rest is margin for open positions.`;

const spotBalances = (rows: SpotAccount[]): SpotBalance[] =>
  SPOT_COINS.map((coin) => {
    const row = rows.find((r) => r.currency === coin);
    return { coin, available: Number(row?.available ?? 0) || 0, locked: Number(row?.locked ?? 0) || 0 };
  });

const viewOf = ({ id, coin, from, to, amount, status, received, failText, createdAt, doneAt }: TransferJob) => ({
  id,
  coin,
  from,
  to,
  amount,
  status,
  received,
  failText,
  createdAt,
  doneAt,
});

export function transferRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    const transfers = deps.transfer?.jobs ?? null;
    const now = (): number => deps.engine!.clock.now();
    let runningId: string | null = null;

    const requireTransfers = (): TransferFile => {
      if (!transfers) throw new CoreError('transfer store not configured', 'not-configured');
      return transfers;
    };

    const start = (store: TransferFile, transfer: TransferJob): void => {
      if (runningId === transfer.id) return;
      runningId = transfer.id;
      runTransfer({
        clients: () => deps.getClients(),
        transfers: store,
        cache: deps.cache,
        now,
        sleep: deps.transfer?.sleep ?? sleep,
      })
        .catch((err: unknown) => console.error(`transfer ${transfer.id} stopped: ${classifyGateError(err).message}`))
        .finally(() => {
          if (runningId === transfer.id) runningId = null;
        });
    };

    const booted = transfers?.read() ?? null;
    if (transfers && booted?.status === 'moving') start(transfers, booted);

    const lockText = (): string | null => {
      const lock = moneyLockNow(deps);
      return lock === null ? null : LOCK_TEXT[lock.kind];
    };

    const readSpot = (fresh: boolean) =>
      deps.cache.get(
        'spot:accounts',
        TTL.live,
        async (): Promise<SpotBalance[] | null> => {
          try {
            return spotBalances((await deps.getClients().spot.listSpotAccounts()).body ?? []);
          } catch (err) {
            if (classifyGateError(err).httpStatus === 403) return null;
            throw err;
          }
        },
        { fresh },
      );

    const loadInputs = async (fresh: boolean) => {
      const crossEx = () => deps.getClients().crossEx;
      const [account, coins, spot] = await Promise.all([
        deps.cache.get('account', TTL.live, async () => (await crossEx().getCrossexAccount()).body, { fresh }),
        deps.cache.get('transfer:coins', TTL.static, async () => (await crossEx().listCrossexTransferCoins()).body),
        readSpot(fresh),
      ]);
      return {
        spot: spot.value,
        paths: transferPaths({ account: account.value, spot: spot.value, coins: coins.value }),
        userId: account.value.userId ? String(account.value.userId) : null,
        stale: [account, coins, spot].some((read) => read.stale),
        accountStale: account.stale,
        spotStale: spot.stale,
      };
    };

    app.get('/transfer', async (_req, reply) => {
      const { spot, paths, stale } = await loadInputs(false);
      const transfer = transfers?.read() ?? null;
      const lock = moneyLockNow(deps);
      const transferLock = lock === null || lock.kind === 'moving' ? null : lock.kind;
      return reply.ok({ spot, paths, lock: transferLock, transfer: transfer && viewOf(transfer) }, { stale });
    });

    app.post('/transfer', async (req, reply) => {
      const envPath = deps.credentials?.envPath;
      if (envPath && !isDisclaimerAccepted(envPath)) return reply.code(403).send(DISCLAIMER_NOT_ACCEPTED);
      const store = requireTransfers();
      const body = (req.body ?? {}) as { coin?: unknown; from?: unknown; to?: unknown; amount?: unknown };
      const rule = pathRule(String(body.coin), String(body.from), String(body.to));
      if (!rule) throw new CoreError('Unknown transfer path.');
      const amount = typeof body.amount === 'string' || typeof body.amount === 'number' ? Number(body.amount) : NaN;
      if (!Number.isFinite(amount) || amount <= 0) throw new CoreError('Amount must be a number above 0.');
      const locked = lockText();
      if (locked) return conflict(reply, locked);
      const { paths, userId, accountStale, spotStale } = await loadInputs(true);
      if (accountStale || (rule.from === 'SPOT' && spotStale)) return conflict(reply, STALE_TEXT);
      const path = paths.find((p) => p.coin === rule.coin && p.from === rule.from && p.to === rule.to)!;
      if (amount < path.min) return conflict(reply, minimumText(path));
      if (path.max !== null && amount > path.max) return conflict(reply, overMaxText(path, path.max));
      const again = lockText();
      if (again) return conflict(reply, again);
      const transfer = newTransferJob({ coin: rule.coin, from: rule.from, to: rule.to, amount, userId }, now());
      store.write(transfer);
      start(store, transfer);
      return reply.code(202).ok({ id: transfer.id });
    });
  };
}
