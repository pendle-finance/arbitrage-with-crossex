import { EventEmitter } from 'node:events';
import type { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { startKeepAwake } from '../../src/server/keepAwake';

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
    expect(t.calls).toEqual([{ cmd: 'caffeinate', args: ['-i', '-w', '4242'] }]);
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
