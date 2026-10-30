/**
 * Live deal view: mode strip + legs/fill summary + orders + standing alerts +
 * the user's levers (Convert now / Re-peg / Stop / Resume). The engine runs
 * server-side — closing this modal never affects the deal.
 */
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { useAckAlert, useAlerts, useDealCommand, useDealView } from '../api/queries';
import type { DealOrder, DealPair, DealReport, Side } from '../api/types';
import { Modal } from '../components/Modal';
import { Spinner } from '../components/Spinner';
import { fmtPct, parseSymbol, prettyVenue, sig, signedClass } from '../lib/fmt';
import { formatRestPrice } from '../lib/ticks';
import { useNow } from '../lib/useNow';
import { DealBookImpact } from './PriceImpactGraph';
import { localizeServerText } from '../i18n/serverMessages';

const MODE_TONE: Record<DealPair['mode'], string> = {
  OPENING: 'border-cyan-500/50 bg-cyan-500/10 text-cyan-300',
  CONVERTING: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
  STOPPING: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
  HALTED: 'border-rose-500/60 bg-rose-500/15 text-rose-300',
  DONE: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300',
};

/** The venue's reason arrives as its raw JSON ({"label":…,"message":…}) or as
 * plain text. Show the human half; a rejection the user cannot read is a
 * support ticket. */
function venueReasonText(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as { label?: unknown; message?: unknown };
    const label = typeof j.label === 'string' ? j.label : '';
    const message = typeof j.message === 'string' ? j.message : '';
    const text = [label, message].filter(Boolean).join(' — ');
    return text || raw;
  } catch {
    return raw;
  }
}

/** Server reasons are lowercase so they can follow a "—"; the report shows one alone. */
function upperFirst(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ORDER_STATE_TONE: Record<DealOrder['state'], string> = {
  PENDING: 'text-amber-300',
  OPEN: 'text-cyan-300',
  CLOSED: 'text-ink-300',
  DEAD: 'text-ink-500',
};

function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

/** target − done as a positive plain-decimal string, else null — the size of
 * the market order that would complete a leg right now. residualA cannot size
 * these: an OPEN maker order reserves its FULL qty, so residualA reads 0 the
 * whole time the maker rests — exactly when the graph is shown. */
function remainderQty(target: string, done: string): string | null {
  const t = Number(target);
  const d = Number(done);
  if (!Number.isFinite(t) || !Number.isFinite(d)) return null;
  const r = t - d;
  return r > 0 ? String(+r.toFixed(10)) : null;
}

interface DealSlippage {
  takerAvg: number;
  limitAvg: number;
  /** Signed price basis (sell-leg avg − buy-leg avg): + = the pair entered
   * favorably (the hedge sold higher than the maker bought). */
  diff: number;
  /** diff as a fraction of the mid of the two fills (feed to fmtPct). */
  ratio: number;
}

/** One leg's realized fill: role · direction (long/short, color-coded) · venue ·
 * @ average price · tif note — so it reads at a glance which price is the long
 * side and which is the short. */
function LegFillLine({
  role,
  side,
  contract,
  price,
  note,
}: {
  role: string;
  side: Side;
  contract: string;
  price: number;
  note: string;
}) {
  const { t } = useTranslation();
  const long = side === 'BUY';
  return (
    <div className="flex flex-wrap items-baseline gap-x-2">
      <span className="w-14 shrink-0 text-ink-500">{role}</span>
      <span className={long ? 'text-emerald-400' : 'text-rose-400'}>{long ? t('trade.deal.long') : t('trade.deal.short')}</span>
      <span className="text-ink-400">{prettyVenue(parseSymbol(contract).exchange)}</span>
      <span className="text-ink-500">@</span>
      <span className="num text-ink-100">{sig(price)}</span>
      <span className="text-[10px] text-ink-500">{note}</span>
    </div>
  );
}

/** The taker's realized slippage against the maker's limit, as a same-asset
 * entry basis. Leg A = maker (limit), leg B = taker (hedge); one is BUY and one
 * SELL. Null until BOTH legs have an average fill (single-leg deals have no
 * basis). */
function dealSlippage(pair: DealPair, report: DealReport | null): DealSlippage | null {
  const aAvg = report?.aAvgFill != null ? Number(report.aAvgFill) : NaN;
  const bAvg = report?.bAvgFill != null ? Number(report.bAvgFill) : NaN;
  if (!pair.b || !Number.isFinite(aAvg) || !Number.isFinite(bAvg) || aAvg <= 0 || bAvg <= 0) {
    return null;
  }
  const buyAvg = pair.a.side === 'BUY' ? aAvg : bAvg;
  const sellAvg = pair.a.side === 'BUY' ? bAvg : aAvg;
  const diff = sellAvg - buyAvg;
  const ref = (buyAvg + sellAvg) / 2;
  return { takerAvg: bAvg, limitAvg: aAvg, diff, ratio: ref > 0 ? diff / ref : 0 };
}

export function DealModal({ dealId, onClose }: { dealId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const view = useDealView(dealId);
  const alerts = useAlerts();
  const ack = useAckAlert();
  const convert = useDealCommand('convert');
  const repeg = useDealCommand('repeg');
  const stop = useDealCommand('stop');
  const resume = useDealCommand('resume');
  const now = useNow(1_000);

  const pair = view.data?.pair;
  const proj = view.data?.projection;
  const orders = view.data?.orders ?? [];
  const opening = pair?.mode === 'OPENING';
  const dealAlerts = (alerts.data ?? []).filter((a) => a.pairId === dealId);
  const report: DealReport | null = pair?.reportJson ? (JSON.parse(pair.reportJson) as DealReport) : null;
  const slip = pair ? dealSlippage(pair, report) : null;
  /** What a leg actually was, off the orders rather than the deal's mode — so a
   * maker converted to a taker still reads as it executed. No rows = never
   * rested. */
  const legRole = (leg: 'A' | 'B'): 'maker' | 'taker' =>
    orders.some((o) => o.leg === leg && o.kind === 'maker') ? 'maker' : 'taker';
  const anyCmdPending = convert.isPending || repeg.isPending || stop.isPending || resume.isPending;
  const cmdError = (convert.error ?? repeg.error ?? stop.error ?? resume.error) as
    | { message: string; hint?: string }
    | null;
  // Custom re-peg price (the route takes an optional body price; without one it
  // re-pegs to the fresh touch).
  const [customPx, setCustomPx] = useState('');
  // Snapped side-aware (BUY down, SELL up): the engine pins this price for
  // post-only orders, so a nearest snap onto the touch would reject every one.
  // A BUY below one tick snaps to "0" — null keeps the button disabled.
  const customN = Number(customPx);
  const restPx =
    pair && customPx.trim() !== '' && Number.isFinite(customN) && customN > 0
      ? formatRestPrice(customN, pair.a.side, pair.a.contract, pair.a.tick)
      : null;
  const customPrice = restPx !== null && Number(restPx) > 0 ? restPx : null;
  const modeLabel: Record<DealPair['mode'], string> = {
    OPENING: t('trade.deal.modeOpening'),
    CONVERTING: t('trade.deal.modeConverting'),
    STOPPING: t('trade.deal.modeStopping'),
    HALTED: t('trade.deal.modeHalted'),
    DONE: t('trade.deal.modeDone'),
  };
  const orderState: Record<DealOrder['state'], string> = {
    PENDING: t('trade.deal.statePending'),
    OPEN: t('trade.deal.stateOpen'),
    CLOSED: t('trade.deal.stateClosed'),
    DEAD: t('trade.deal.stateDead'),
  };
  const roleText = (role: 'maker' | 'taker') => (role === 'maker' ? t('trade.deal.maker') : t('trade.deal.taker'));

  return (
    <Modal
      onClose={onClose}
      widthClass="w-[560px]"
      title={
        <>
          <Trans
            i18nKey="trade.deal.title"
            values={{ id: dealId.slice(0, 8) }}
            components={{ n: <span className="num text-ink-400" /> }}
          />
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {!pair || !proj ? (
          <div className="py-6 text-center text-xs text-ink-500">
            {view.isError ? (
              <span role="alert" className="text-rose-300">
                {t('trade.deal.loadFailed')}
              </span>
            ) : (
              <Spinner className="inline h-4 w-4" />
            )}
          </div>
        ) : (
          <>
            <div className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs ${MODE_TONE[pair.mode]}`}>
              <span className="inline-flex items-center gap-2">
                {pair.mode !== 'DONE' && pair.mode !== 'HALTED' && <Spinner className="h-3 w-3" />}
                {modeLabel[pair.mode]}
                {pair.mode === 'HALTED' && pair.haltReason ? ` — ${localizeServerText(pair.haltReason)}` : ''}
              </span>
              {opening && pair.deadlineAt !== null && (
                <span className="num" title={t('trade.deal.deadlineTitle')}>
                  {t('trade.deal.untilConvert', {
                    time: pair.deadlineAt - now <= 0 ? t('trade.deal.now') : fmtCountdown(pair.deadlineAt - now),
                  })}
                </span>
              )}
            </div>

            {/* Safety signals (the old legs table is gone — the graph carries
                the book/limit story; these two must survive in every mode). */}
            {pair.b && Number(proj.unhedged) > 0 && (
              <div role="alert" className="text-[11px] text-amber-300">
                <Trans
                  i18nKey="trade.deal.unhedgedNext"
                  values={{ size: sig(proj.unhedged) }}
                  components={{ n: <span className="num" /> }}
                />
              </div>
            )}
            {(proj.anyPending || proj.anyQuarantined) && (
              <div className="text-[11px] text-amber-300">
                <Spinner className="inline h-3 w-3" /> {t('trade.deal.resolving')}
              </div>
            )}

            {/* Real-time book vs our resting maker — while the maker works. */}
            {opening && (
              <DealBookImpact
                makerContract={pair.a.contract}
                makerSide={pair.a.side}
                hedgeContract={pair.b?.contract ?? null}
                limitPrice={
                  (proj.makerOrder?.state === 'OPEN' ? proj.makerOrder.price : null) ??
                  pair.limitPrice
                }
                limitQty={
                  (proj.makerOrder?.state === 'OPEN' ? proj.makerOrder.qty : null) ??
                  proj.residualA
                }
                hedgeQty={remainderQty(pair.targetQty, proj.bReserved)}
              />
            )}

            {/* A failed command used to do NOTHING visible: the mutation has no
                error path, so a rejected Stop looked like a dead button. */}
            {cmdError && (
              <p role="alert" className="text-[12px] text-rose-300">
                {cmdError.message}
                {cmdError.hint ? <span className="text-ink-400"> {cmdError.hint}</span> : null}
              </p>
            )}

            {/* Controls */}
            {pair.mode !== 'DONE' && (
              <div className="flex flex-wrap gap-1.5">
                {opening && (
                  <>
                    <button
                      type="button"
                      className="btn-ghost-xs border-amber-500/50 text-amber-300"
                      disabled={anyCmdPending}
                      title={t('trade.deal.convertTitle')}
                      onClick={() => convert.mutate({ id: dealId })}
                    >
                      {t('trade.deal.convertNow')}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost-xs border-cyan-500/50 text-cyan-300"
                      disabled={anyCmdPending}
                      title={t('trade.deal.repegTitle')}
                      onClick={() => repeg.mutate({ id: dealId })}
                    >
                      {t('trade.deal.repegTouch')}
                    </button>
                    <span
                      className="inline-flex items-center gap-1"
                      title={t('trade.deal.customTitle')}
                    >
                      <input
                        aria-label={t('trade.deal.customAria')}
                        className="input num h-[26px] w-24 !py-0 text-[11px]"
                        inputMode="decimal"
                        placeholder={t('trade.deal.customPlaceholder')}
                        value={customPx}
                        onChange={(e) => setCustomPx(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn-ghost-xs border-cyan-500/50 text-cyan-300"
                        disabled={anyCmdPending || customPrice === null}
                        onClick={() =>
                          customPrice !== null &&
                          repeg.mutate(
                            { id: dealId, body: { price: customPrice } },
                            { onSuccess: () => setCustomPx('') },
                          )
                        }
                      >
                        {t('trade.deal.repegPrice')}
                      </button>
                    </span>
                  </>
                )}
                {pair.mode !== 'HALTED' && (
                  <button
                    type="button"
                    className="btn-ghost-xs border-rose-500/50 text-rose-300"
                    disabled={anyCmdPending}
                    title={t('trade.deal.stopTitle')}
                    onClick={() => stop.mutate({ id: dealId })}
                  >
                    {t('trade.deal.stop')}
                  </button>
                )}
                {pair.mode === 'HALTED' && (
                  <button
                    type="button"
                    className="btn-ghost-xs border-rose-500/50 text-rose-300"
                    disabled={anyCmdPending}
                    title={t('trade.deal.resumeTitle')}
                    onClick={() => resume.mutate({ id: dealId })}
                  >
                    {t('trade.deal.resume')}
                  </button>
                )}
              </div>
            )}

            {/* Orders */}
            {orders.length > 0 && (
              <div className="max-h-48 overflow-y-auto rounded-lg border border-ink-800">
                <table className="w-full text-[11px]">
                  <thead className="text-left text-[12px] font-normal text-ink-300">
                    <tr>
                      <th className="px-2 py-1">{t('trade.deal.colLeg')}</th>
                      <th className="px-2 py-1">{t('trade.deal.colKind')}</th>
                      <th className="px-2 py-1 text-right">{t('trade.deal.colQty')}</th>
                      <th className="px-2 py-1 text-right">{t('trade.deal.colFilled')}</th>
                      <th className="px-2 py-1">{t('trade.deal.colState')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orders.map((o) => (
                      <tr key={`${o.leg}${o.seq}`} className="border-t border-ink-800/60">
                        <td className="px-2 py-1">{o.leg}</td>
                        <td className="px-2 py-1">
                          {roleText(o.kind)}
                          {o.price ? <span className="num text-ink-500"> @{sig(o.price)}</span> : ''}
                        </td>
                        <td className="num px-2 py-1 text-right">{sig(o.qty)}</td>
                        <td className="num px-2 py-1 text-right">{sig(o.cumQty)}</td>
                        <td className={`px-2 py-1 ${ORDER_STATE_TONE[o.state]}`}>
                          {orderState[o.state]}
                          {o.closeReason ? <span className="text-ink-500"> · {localizeServerText(o.closeReason)}</span> : ''}
                          {o.venueReason ? (
                            <div className="mt-0.5 max-w-[46ch] whitespace-normal text-[11px] leading-snug text-ink-400">
                              {venueReasonText(o.venueReason)}
                            </div>
                          ) : null}
                          {o.quarantinedStatus ? (
                            <span className="text-amber-400"> · “{o.quarantinedStatus}”</span>
                          ) : (
                            ''
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Standing alerts for this deal */}
            {dealAlerts.map((a) => (
              <div
                key={a.id}
                role="alert"
                className="flex items-center justify-between gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-2.5 py-1.5 text-[11px] text-rose-300"
              >
                <span>{a.message}</span>
                <button type="button" className="btn-ghost-xs shrink-0" onClick={() => ack.mutate(a.id)}>
                  {t('common.dismiss')}
                </button>
              </div>
            ))}

            {/* The one terminal cause the user can immediately fix: a limit
                that was already through the market simply needs a fresh price.
                The regex pins decide.ts's POC-budget reason text. */}
            {report && /crossing the market/i.test(report.reason) && (
              <div
                role="alert"
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-200"
              >
                <Trans i18nKey="trade.deal.crossed" components={{ b: <span className="font-semibold" /> }} />
              </div>
            )}

            {/* Terminal report */}
            {report && (
              <div
                data-testid="deal-report"
                className="rounded-lg border border-ink-800 bg-ink-950/60 px-3 py-2 text-[11px] text-ink-300"
              >
                <div className="mb-1 text-[12px] font-normal text-ink-300">{t('trade.deal.report')}</div>
                <div className="flex flex-wrap gap-x-4 gap-y-0.5">
                  <span>
                    <Trans
                      i18nKey="trade.deal.aFilled"
                      values={{ size: sig(report.aFilled) }}
                      components={{ n: <span className="num text-ink-100" /> }}
                    />
                  </span>
                  {pair.b && (
                    <span>
                      <Trans
                        i18nKey="trade.deal.hedged"
                        values={{ size: sig(report.bFilled) }}
                        components={{ n: <span className="num text-ink-100" /> }}
                      />
                    </span>
                  )}
                  {Number(report.unhedged) > 0 && (
                    <span className="tip-label text-amber-300" title={t('trade.deal.dustTitle')}>
                      <Trans
                        i18nKey="trade.deal.dust"
                        values={{ size: sig(report.unhedged) }}
                        components={{ n: <span className="num" /> }}
                      />
                    </span>
                  )}
                  <span className="text-ink-500">{upperFirst(localizeServerText(report.reason))}</span>
                </div>
                {slip && pair.b && (
                  <div className="mt-1.5 flex flex-col gap-0.5 border-t border-ink-800 pt-1.5">
                    {/* Hardcoded maker/taker here described a market-order pair
                        as "maker — the filled resting leg", directly under a
                        table whose own kind column said taker on both rows. The
                        slippage below is a difference of averages and was never
                        affected. */}
                    <LegFillLine
                      role={roleText(legRole('A'))}
                      side={pair.a.side}
                      contract={pair.a.contract}
                      price={slip.limitAvg}
                      note={legRole('A') === 'maker' ? t('trade.deal.noteLimit') : t('trade.deal.noteMarket')}
                    />
                    <LegFillLine
                      role={roleText(legRole('B'))}
                      side={pair.b.side}
                      contract={pair.b.contract}
                      price={slip.takerAvg}
                      note={t('trade.deal.noteHedge')}
                    />
                    <div
                      className="flex flex-wrap items-baseline gap-x-2 pt-0.5"
                      title={t('trade.deal.slipTitle')}
                    >
                      <span className="w-14 shrink-0 text-ink-500">{t('trade.deal.slippage')}</span>
                      <span className={`num ${signedClass(slip.diff)}`}>
                        {slip.diff >= 0 ? '+' : '−'}
                        {sig(Math.abs(slip.diff))}
                      </span>
                      <span className={`num ${signedClass(slip.diff)}`}>
                        ({slip.diff >= 0 ? '+' : '−'}
                        {fmtPct(Math.abs(slip.ratio), 3)})
                      </span>
                      <span className="text-[10px] text-ink-500">
                        {slip.diff >= 0 ? t('trade.deal.favorable') : t('trade.deal.adverse')}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="text-center text-[10px] text-ink-500">
              {t('trade.deal.serverSide')}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
