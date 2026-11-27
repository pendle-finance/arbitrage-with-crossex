import { useState } from 'react';
import type { SliceOption } from '../api/types';
import { MakerSettings, REPEG_DEFAULT_BP } from '../trade/MakerSettings';
import { type TakerAfterState, useTakerAfter } from '../trade/useTwapTakerAfter';

export const MAKER_ORDER_SEC = 300;

export interface MakerOpts {
  takerAfterSec: number | null;
  repegBehindBp: number | null;
}

export interface CloseMaker {
  taker: TakerAfterState;
  repegBp: number | null;
  setRepegBp: (bp: number | null) => void;
  opts: MakerOpts;
}

export function useCloseMaker(): CloseMaker {
  const taker = useTakerAfter();
  const [repegBp, setRepegBp] = useState<number | null>(REPEG_DEFAULT_BP);
  return { taker, repegBp, setRepegBp, opts: { takerAfterSec: taker.sec, repegBehindBp: repegBp } };
}

export function CloseMakerSettings({ maker, capSec, symbols }: { maker: CloseMaker; capSec: number | null; symbols?: readonly string[] }) {
  return (
    <MakerSettings
      legs={null}
      symbols={symbols}
      makerLeg="auto"
      autoPick={null}
      onMakerLeg={() => undefined}
      takerAfter={maker.taker.takerAfter}
      onTakerAfter={maker.taker.pick}
      takerCapSec={capSec}
      repegBehindBp={maker.repegBp}
      repegLocked={false}
      onRepeg={maker.setRepegBp}
    />
  );
}

export const withMakerWait = (options: SliceOption[], waitSec: number | null): SliceOption[] =>
  waitSec === null || waitSec === MAKER_ORDER_SEC
    ? options
    : options.map((o) => ({ ...o, seconds: { ...o.seconds, maker: (o.seconds.maker / MAKER_ORDER_SEC) * waitSec } }));
