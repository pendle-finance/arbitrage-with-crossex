import type { ImUsedRow } from '../api/types';

const IM_STOP = 1 / 1.12;

export const crossexImFull = (rows: ImUsedRow[] | undefined): ImUsedRow | null =>
  rows?.find((row) => row.account === 'CROSSEX' && row.pct > IM_STOP) ?? null;
