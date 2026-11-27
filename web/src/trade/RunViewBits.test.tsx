import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { TwapChildView } from '../api/types';
import i18n from '../i18n';
import { localizeServerText } from '../i18n/serverMessages';
import { makeDealView } from '../test/fixtures';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { feeText, qtyText, SideText, SliceGraph, SlicePriceBox, TwapActs } from './RunViewBits';

vi.mock('./PriceImpactGraph', () => ({ DealBookImpact: () => <div data-testid="book-graph" /> }));

describe('qtyText', () => {
  it.each([
    [0.02, '0.02'],
    [1.5, '1.50'],
    [146.12, '146.12'],
    [1999.999, '1,999.999'],
    [2000.011, '2,000.011'],
    [3468.208, '3,468.208'],
    [58653.25, '58,653.25'],
    [2000000.123, '2,000,000.123'],
    [6000000, '6,000,000.00'],
  ])('%f reads %s', (value, expected) => {
    expect(qtyText(value)).toBe(expected);
  });
});

describe('feeText', () => {
  it('one figure with the read and estimated parts named', () => {
    expect(feeText({ readUsd: 12.4, estUsd: 3.1, est: true })).toBe('$16 ($12 from Gate, $3 estimated)');
  });
  it('the server total wins when present', () => {
    expect(feeText({ readUsd: 0, estUsd: 0.139, est: true, totalUsd: 0.139 })).toBe('$0.14 estimated');
  });
  it('an estimate alone is the figure, never $0', () => {
    expect(feeText({ readUsd: 0, estUsd: 4200, est: true })).toContain('$4,200');
  });
  it('a fully read fee has no estimate note', () => {
    expect(feeText({ readUsd: 4200, estUsd: 0, est: false })).toBe('$4,200');
  });
});

describe('SideText', () => {
  it('uses the translated word', () => {
    renderWithClient(<SideText side="LONG" />);
    expect(screen.getByText('Long')).toBeTruthy();
  });
});

describe('server text', () => {
  it('maps the not-closed rest on zh-CN', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(localizeServerText('3,468.208 ETH not closed')).toBe('3,468.208 ETH 未平');
  });
});

const CHILD: TwapChildView = {
  id: 'c1',
  mode: 'OPENING',
  slice: 1,
  makerLeg: 'a',
  side: 'BUY',
  restPrice: '1729.8',
  bestPrice: '1730.15',
  behindPct: 0.0002,
  repegRefused: null,
};

describe('slice deal read failure', () => {
  it('shows an error and retries', async () => {
    let calls = 0;
    server.use(
      http.get('/api/deals/:id', () => {
        calls += 1;
        return calls === 1 ? HttpResponse.json({ ok: false, error: { message: 'boom' } }, { status: 500 }) : HttpResponse.json(env(makeDealView({ pair: { id: 'c1' } })));
      }),
    );
    renderWithClient(<SliceGraph childId="c1" oneLeg={false} />);
    fireEvent.click(await screen.findByText('Retry'));
    expect(await screen.findByTestId('book-graph')).toBeTruthy();
  });
});

describe('slice price box', () => {
  it('clears the typed price after a Move', async () => {
    server.use(
      http.get('/api/deals/:id', () => HttpResponse.json(env(makeDealView({ pair: { id: 'c1' } })))),
      http.post('/api/deals/:id/repeg', () => HttpResponse.json(env({ id: 'c1' }))),
    );
    renderWithClient(<SlicePriceBox child={CHILD} />);
    const input = (await screen.findByRole('textbox')) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '1720' } });
    expect(input.value).toBe('1720');
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect((screen.getByRole('textbox') as HTMLInputElement).value).not.toBe('1720'));
  });
});

describe('TwapActs', () => {
  it('shows a refused pause', async () => {
    server.use(http.post('/api/rebalance/:id/pause', () => HttpResponse.json({ ok: false, error: { message: 'Not now' } }, { status: 409 })));
    renderWithClient(<TwapActs jobId="j1" state="running" holds={null} borosHold={null} />);
    fireEvent.click(screen.getByText('Pause'));
    expect(await screen.findByText('Not now')).toBeTruthy();
  });
});
