import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { LegSpec, PairRow } from '../../src/engine/types';
import { needsAwake, startKeepAwake } from '../../src/server/keepAwake';
import type { Job } from '../../src/server/rebalanceJob';

class FakeChild extends EventEmitter {
  killed = false;
  kill(): boolean {
    this.killed = true;
    this.emit('exit');
    return true;
  }
  unref(): void {}
}

function setup(platform: NodeJS.Platform) {
  const calls: { cmd: string; args: readonly string[] }[] = [];
  const children: FakeChild[] = [];
  let live = false;
  const fake = ((cmd: string, args: readonly string[]) => {
    calls.push({ cmd, args });
    const c = new FakeChild();
    children.push(c);
    return c;
  }) as unknown as typeof spawn;
  const keep = startKeepAwake({ platform, pid: 4242, spawn: fake, isLive: () => live });
  return {
    calls,
    children,
    keep,
    setLive(v: boolean) {
      live = v;
    },
  };
}

describe('caffeinate while live', () => {
  it('spawns caffeinate -i -w <pid> once while live on darwin', () => {
    const t = setup('darwin');
    t.setLive(true);
    t.keep.update();
    t.keep.update();
    expect(t.calls).toEqual([{ cmd: '/usr/bin/caffeinate', args: ['-i', '-w', '4242'] }]);
  });

  it('ends the process when nothing is live', () => {
    const t = setup('darwin');
    t.setLive(true);
    t.keep.update();
    t.setLive(false);
    t.keep.update();
    expect(t.children[0].killed).toBe(true);
  });

  it('spawns again after it ended and work is live again', () => {
    const t = setup('darwin');
    t.setLive(true);
    t.keep.update();
    t.setLive(false);
    t.keep.update();
    t.setLive(true);
    t.keep.update();
    expect(t.calls).toHaveLength(2);
  });

  it('spawns again when the process died by itself', () => {
    const t = setup('darwin');
    t.setLive(true);
    t.keep.update();
    t.children[0].emit('exit');
    t.keep.update();
    expect(t.calls).toHaveLength(2);
  });

  it('spawns again after a spawn error', () => {
    const t = setup('darwin');
    t.setLive(true);
    t.keep.update();
    t.children[0].emit('error', new Error('ENOENT'));
    t.keep.update();
    expect(t.calls).toHaveLength(2);
  });

  it('stop ends the process and is safe twice', () => {
    const t = setup('darwin');
    t.setLive(true);
    t.keep.update();
    t.keep.stop();
    t.keep.stop();
    expect(t.children[0].killed).toBe(true);
  });

  it('does nothing when nothing is live', () => {
    const t = setup('darwin');
    t.keep.update();
    expect(t.calls).toHaveLength(0);
  });

  it('does nothing on other systems', () => {
    for (const platform of ['linux', 'win32'] as const) {
      const t = setup(platform);
      t.setLive(true);
      t.keep.update();
      t.keep.stop();
      expect(t.calls).toHaveLength(0);
    }
  });
});

describe('what keeps the Mac awake', () => {
  const leg = (contract: string, side: 'BUY' | 'SELL'): LegSpec => ({ contract, side, lot: '0.001', minSize: '0.001', minNotional: '0', tick: '0.01' });
  const deal = (over: Partial<PairRow>): PairRow => ({
    id: 'd1',
    mode: 'OPENING',
    a: leg('GATE_FUTURE_ETH_USDT', 'BUY'),
    b: null,
    targetQty: '1',
    limitPrice: '3000',
    pricePolicy: 'fixed',
    deadlineAt: null,
    makerNotBefore: 0,
    hedgeNotBefore: 0,
    pocRejects: 0,
    hedgeRejectStreak: 0,
    maxClip: null,
    clipBandBp: null,
    repegBehindBp: null,
    repegAutoBp: null,
    repegNotBefore: 0,
    haltKind: null,
    haltReason: null,
    reportJson: null,
    createdAt: 0,
    ...over,
  });
  const job = (kind: Job['kind'], status: Job['status']): Job => ({ kind, status, deleverTwap: null }) as unknown as Job;

  it('a resting single limit with no deadline does not keep it awake', () => {
    expect(needsAwake([deal({})], null)).toBe(false);
  });

  it('a halted deal does not keep it awake', () => {
    expect(needsAwake([deal({ mode: 'HALTED', b: leg('HYPERLIQUID_FUTURE_ETH_USDC', 'SELL') })], null)).toBe(false);
  });

  it('a deal with a hedge leg, a deadline or at market keeps it awake', () => {
    expect(needsAwake([deal({ b: leg('HYPERLIQUID_FUTURE_ETH_USDC', 'SELL') })], null)).toBe(true);
    expect(needsAwake([deal({ deadlineAt: 60_000 })], null)).toBe(true);
    expect(needsAwake([deal({ mode: 'CONVERTING' })], null)).toBe(true);
  });

  it('a running job keeps it awake, a halted or finished one does not', () => {
    expect(needsAwake([], job('twap', 'running'))).toBe(true);
    expect(needsAwake([], job('move', 'running'))).toBe(true);
    expect(needsAwake([], job('realize', 'running'))).toBe(true);
    expect(needsAwake([], job('twap', 'halted'))).toBe(false);
    expect(needsAwake([], job('realize', 'done'))).toBe(false);
  });
});
