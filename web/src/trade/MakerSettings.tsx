import { useEffect, useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { MakerLegPreview } from '../api/types';
import { Chip } from '../components/Chip';
import { HoverCard } from '../components/HoverCard';
import { SegmentedToggle } from '../components/SegmentedToggle';
import { num, sig } from '../lib/fmt';
import { parseSpan, spanText } from '../lib/span';
import { stripZeros } from '../lib/ticks';
import { FoldRow } from './FoldRow';

export type TakerAfter = { kind: '5m' | '10m' | 'never' | 'custom'; sec: number | null };

type Side = 'LONG' | 'SHORT';
type LegPick = 'a' | 'b';

const PRESET_SEC = { '5m': 300, '10m': 600 } as const;
const CUSTOM_MIN_SEC = 30;
const CUSTOM_MAX_SEC = 86_400;
const MAKER_FEE_BP = 2;
const TAKER_FEE_BP = 5;
export const REPEG_DEFAULT_BP = 5;
const REPEG_BP = [2, 5, 10] as const;
const MARKET_SLIPPAGE_PCT = [0.2, 0.5, 1, 2] as const;

export function takerAfterSec(v: TakerAfter): number | null {
  if (v.kind === 'never') return null;
  if (v.kind === 'custom') return v.sec;
  return PRESET_SEC[v.kind];
}

const pct = (p: number) => `${stripZeros(num(p, 2))}%`;

function SettingLabel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <HoverCard label={<span className="text-[11.5px] text-ink-200">{label}</span>} widthPx={320}>
      <div className="flex flex-col gap-1.5 text-[11.5px] text-ink-200">{children}</div>
    </HoverCard>
  );
}

function sideKey(side: Side, upper: boolean): 'common.longUpper' | 'common.shortUpper' | 'common.long' | 'common.short' {
  if (upper) return side === 'LONG' ? 'common.longUpper' : 'common.shortUpper';
  return side === 'LONG' ? 'common.long' : 'common.short';
}

function CustomTakerBox({
  sec,
  capSec,
  onSec,
}: {
  sec: number | null;
  capSec: number | null;
  onSec: (sec: number | null) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(sec !== null ? spanText(sec) : '');
  useEffect(() => {
    if (sec !== null && parseSpan(text) !== sec) setText(spanText(sec));
  }, [sec]);
  const parsed = parseSpan(text);
  const inRange = parsed !== null && parsed >= CUSTOM_MIN_SEC && parsed <= CUSTOM_MAX_SEC;
  const overCap = parsed !== null && capSec !== null && parsed > capSec;
  return (
    <div className="flex flex-col gap-1">
      <input
        className={`input num ${text !== '' && (!inRange || overCap) ? '!border-rose-500/60' : ''}`}
        aria-label={t('pairTicket.makerSettings.customAria')}
        placeholder={t('pairTicket.makerSettings.customRange')}
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          const s = parseSpan(next);
          setText(next);
          onSec(s !== null && s >= CUSTOM_MIN_SEC && s <= CUSTOM_MAX_SEC && (capSec === null || s <= capSec) ? s : null);
        }}
      />
      {text !== '' && overCap && capSec !== null && (
        <span className="text-[11px] text-rose-300">{t('pairTicket.makerSettings.takerOver', { max: spanText(capSec) })}</span>
      )}
      {text !== '' && !inRange && !overCap && (
        <span className="text-[11px] text-rose-300">{t('pairTicket.makerSettings.customRange')}</span>
      )}
    </div>
  );
}

export function MakerSettings({
  legs,
  makerLeg,
  autoPick,
  saving,
  savingHint,
  onMakerLeg,
  takerAfter,
  onTakerAfter,
  takerCapSec: capSec,
  repegBehindBp,
  repegLocked,
  onRepeg,
  marketSlippage,
  attached,
}: {
  legs: { name: string; side: Side }[] | null;
  makerLeg: 'auto' | LegPick;
  autoPick: MakerLegPreview | null;
  saving?: number | null;
  savingHint?: string;
  onMakerLeg: (v: 'auto' | LegPick) => void;
  takerAfter: TakerAfter;
  onTakerAfter: (v: TakerAfter) => void;
  takerCapSec: number | null;
  repegBehindBp: number | null;
  repegLocked: boolean;
  onRepeg: (v: number | null) => void;
  marketSlippage?: { value: number; onChange: (v: number) => void };
  attached?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const picked: LegPick | null = makerLeg !== 'auto' ? makerLeg : autoPick?.auto ?? null;
  const pickedLeg = legs && picked ? legs[picked === 'a' ? 0 : 1] ?? null : null;
  const autoWhy = autoPick ? t(autoPick.why === 'fees' ? 'pairTicket.makerSettings.autoFees' : 'pairTicket.makerSettings.autoBook') : undefined;
  const takerSec = takerAfterSec(takerAfter);
  const takerText =
    takerAfter.kind === 'never' ? t('pairTicket.makerSettings.takerNever') : takerSec !== null ? spanText(takerSec) : '—';
  const repegOnBp = !repegLocked ? repegBehindBp : null;
  const repegText = repegOnBp !== null ? pct(repegOnBp / 100) : t('pairTicket.makerSettings.repegOff');
  const summary = legs
    ? t('pairTicket.makerSettings.foldValue', {
        leg: pickedLeg?.name ?? t('pairTicket.makerSettings.auto'),
        taker: takerText,
        repeg: repegText,
      })
    : t('pairTicket.makerSettings.foldValueSingle', { taker: takerText, repeg: repegText });
  const overText = capSec !== null ? t('pairTicket.makerSettings.takerOver', { max: spanText(capSec) }) : undefined;
  const presetOff = (sec: number) => capSec !== null && sec > capSec;

  return (
    <FoldRow label={t('pairTicket.makerSettings.title')} summary={summary} open={open} onToggle={() => setOpen((v) => !v)} attached={attached}>
      {legs && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <SettingLabel label={t('pairTicket.makerSettings.makerLeg')}>
              {legs.map((leg, i) => {
                const rests = picked === (i === 0 ? 'a' : 'b');
                return (
                  <div key={i} className="flex items-center gap-2">
                    <Chip sm tone={leg.side === 'LONG' ? 'green' : 'red'} className="font-semibold">
                      {t(sideKey(leg.side, true))}
                    </Chip>
                    <span className="text-ink-50">{leg.name}</span>
                    {picked && (
                      <span className="text-ink-300">
                        {rests
                          ? t('pairTicket.makerSettings.hoverRests', { bp: MAKER_FEE_BP, pct: num(MAKER_FEE_BP / 100, 2) })
                          : t('pairTicket.makerSettings.hoverHedges', { bp: TAKER_FEE_BP, pct: num(TAKER_FEE_BP / 100, 2) })}
                      </span>
                    )}
                  </div>
                );
              })}
              {makerLeg === 'auto' && autoWhy && <span className="text-ink-400">{autoWhy}</span>}
            </SettingLabel>
            {makerLeg === 'auto' ? (
              <Chip sm tone="info" title={autoWhy}>
                {t('pairTicket.makerSettings.auto')}
              </Chip>
            ) : (
              <button type="button" className="btn-link text-[11px]" onClick={() => onMakerLeg('auto')}>
                {t('pairTicket.makerSettings.reset')}
              </button>
            )}
          </div>
          {saving != null && saving > 0 && (
            <span className="text-[11px] text-ink-400" title={savingHint ?? t('pairTicket.makerSettings.savingHint')}>
              <Trans
                i18nKey="pairTicket.makerSettings.saving"
                values={{ amount: sig(saving) }}
                components={{ g: <span className="num text-emerald-400" /> }}
              />
            </span>
          )}
          <SegmentedToggle<LegPick | ''>
            ariaLabel={t('pairTicket.makerSettings.makerLeg')}
            fill
            value={picked ?? ''}
            onChange={(v) => {
              if (v) onMakerLeg(v);
            }}
            options={legs.slice(0, 2).map((leg, i) => ({
              value: i === 0 ? 'a' : 'b',
              label: (
                <>
                  {leg.name}{' '}
                  <span className={leg.side === 'LONG' ? 'text-emerald-400' : 'text-rose-400'}>{t(sideKey(leg.side, false))}</span>
                </>
              ),
            }))}
          />
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <SettingLabel label={t('pairTicket.makerSettings.takerAfter')}>
          <span>{t('pairTicket.makerSettings.takerHover', { bp: TAKER_FEE_BP, pct: num(TAKER_FEE_BP / 100, 2) })}</span>
          <span className="text-ink-400">{t('pairTicket.makerSettings.takerNeverHover')}</span>
        </SettingLabel>
        <SegmentedToggle<TakerAfter['kind']>
          ariaLabel={t('pairTicket.makerSettings.takerAfter')}
          fill
          value={takerAfter.kind}
          onChange={(kind) =>
            onTakerAfter(
              kind === 'custom'
                ? { kind, sec: takerAfter.kind === 'custom' ? takerAfter.sec : null }
                : { kind, sec: kind === 'never' ? null : PRESET_SEC[kind] },
            )
          }
          options={[
            { value: '5m', label: t('pairTicket.makerSettings.takerChoice.m5'), disabled: presetOff(PRESET_SEC['5m']), title: presetOff(PRESET_SEC['5m']) ? overText : undefined },
            { value: '10m', label: t('pairTicket.makerSettings.takerChoice.m10'), disabled: presetOff(PRESET_SEC['10m']), title: presetOff(PRESET_SEC['10m']) ? overText : undefined },
            { value: 'never', label: t('pairTicket.makerSettings.takerChoice.never') },
            { value: 'custom', label: t('pairTicket.makerSettings.takerChoice.custom') },
          ]}
        />
        {takerAfter.kind === 'custom' && (
          <CustomTakerBox sec={takerAfter.sec} capSec={capSec} onSec={(sec) => onTakerAfter({ kind: 'custom', sec })} />
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <SettingLabel label={t('pairTicket.makerSettings.repeg')}>
          <span>{t('pairTicket.makerSettings.repegHover')}</span>
          {repegLocked && <span className="text-ink-400">{t('pairTicket.limitPrice.typedHint')}</span>}
        </SettingLabel>
        <SegmentedToggle<string>
          ariaLabel={t('pairTicket.makerSettings.repeg')}
          fill
          value={repegOnBp !== null ? String(repegOnBp) : 'off'}
          onChange={(v) => {
            if (!repegLocked) onRepeg(v === 'off' ? null : Number(v));
          }}
          options={[
            ...REPEG_BP.map((bp) => ({
              value: String(bp),
              label: pct(bp / 100),
              disabled: repegLocked,
              title: repegLocked ? t('pairTicket.limitPrice.typedHint') : undefined,
            })),
            { value: 'off', label: t('pairTicket.makerSettings.repegChoiceOff') },
          ]}
        />
      </div>

      {marketSlippage && (
        <div className="flex flex-col gap-1.5">
          <SettingLabel label={t('accounts.closePair.twap.marketSlippage')}>
            <span>{t('accounts.closePair.twap.marketSlippageHint')}</span>
          </SettingLabel>
          <SegmentedToggle<string>
            ariaLabel={t('accounts.closePair.twap.marketSlippage')}
            fill
            value={String(marketSlippage.value)}
            onChange={(v) => marketSlippage.onChange(Number(v))}
            options={(MARKET_SLIPPAGE_PCT as readonly number[])
              .concat(MARKET_SLIPPAGE_PCT.includes(marketSlippage.value as never) ? [] : [marketSlippage.value])
              .sort((a, b) => a - b)
              .map((p) => ({ value: String(p), label: pct(p) }))}
          />
        </div>
      )}
    </FoldRow>
  );
}
