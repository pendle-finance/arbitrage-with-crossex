import { useEffect, useState } from 'react';
import { takerAfterSec, type TakerAfter } from './MakerSettings';

const TAKER_AFTER_DEFAULT: TakerAfter = { kind: '5m', sec: 300 };

export interface TakerAfterState {
  takerAfter: TakerAfter;
  sec: number | null;
  picked: boolean;
  pick: (v: TakerAfter) => void;
  follow: (v: TakerAfter) => void;
}

export function useTakerAfter(): TakerAfterState {
  const [takerAfter, setTakerAfter] = useState<TakerAfter>(TAKER_AFTER_DEFAULT);
  const [picked, setPicked] = useState(false);
  return {
    takerAfter,
    sec: takerAfterSec(takerAfter),
    picked,
    pick: (v) => {
      setTakerAfter(v);
      setPicked(true);
    },
    follow: (v) => {
      setTakerAfter(v);
      setPicked(false);
    },
  };
}

export function useTwapTakerAfter(taker: TakerAfterState, twapOn: boolean, planTakerSec: number | null): boolean {
  const { takerAfter, sec, picked, follow } = taker;
  useEffect(() => {
    if (!twapOn) {
      if (!picked) follow(TAKER_AFTER_DEFAULT);
      return;
    }
    if (planTakerSec === null) return;
    const presetOver = takerAfter.kind !== 'custom' && sec !== null && sec > planTakerSec;
    if (!picked || presetOver) follow({ kind: 'custom', sec: planTakerSec });
  }, [twapOn, planTakerSec]);
  const capSec = twapOn ? planTakerSec : null;
  return (takerAfter.kind === 'custom' && takerAfter.sec === null) || (capSec !== null && sec !== null && sec > capSec);
}
