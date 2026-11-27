import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ComponentProps } from 'react';
import { describe, expect, it } from 'vitest';
import type { VenueFees } from '../api/types';
import { env, server } from '../test/server';
import { renderWithClient } from '../test/utils';
import { MakerSettings } from './MakerSettings';

type Props = ComponentProps<typeof MakerSettings>;

const base: Props = {
  legs: [
    { name: 'Gate', side: 'LONG' },
    { name: 'Binance', side: 'SHORT' },
  ],
  makerLeg: 'a',
  autoPick: null,
  onMakerLeg: () => {},
  takerAfter: { kind: '5m', sec: 300 },
  onTakerAfter: () => {},
  takerCapSec: null,
  repegBehindBp: 5,
  repegLocked: false,
  onRepeg: () => {},
};

const fees: VenueFees[] = [
  { exchangeType: 'GATE', spotMakerFee: '0.001', spotTakerFee: '0.001', futureMakerFee: '0.00015', futureTakerFee: '0.0004', specialFeeList: [] },
  {
    exchangeType: 'BINANCE',
    spotMakerFee: '0.001',
    spotTakerFee: '0.001',
    futureMakerFee: '0.0002',
    futureTakerFee: '0.0005',
    specialFeeList: [{ symbol: 'BINANCE_FUTURE_ETH_USDT', makerFeeRate: '0.0001', takerFeeRate: '0.00045' }],
  },
];

describe('MakerSettings', () => {
  it('groups thousands in the Saves line', () => {
    render(<MakerSettings {...base} saving={1800} />);
    fireEvent.click(screen.getByRole('button', { name: /Maker settings/ }));
    expect(screen.getByText('Saves ≈ 1,800 USDT')).toBeInTheDocument();
  });

  it.each([
    ['30', '= 30m'],
    ['90', '= 1h 30m'],
    ['1h30m', '= 1h 30m'],
  ])('shows how it reads a custom taker-after of %s', (typed, reads) => {
    render(<MakerSettings {...base} takerAfter={{ kind: 'custom', sec: null }} />);
    fireEvent.click(screen.getByRole('button', { name: /Maker settings/ }));
    fireEvent.change(screen.getByLabelText('Taker after, custom time'), { target: { value: typed } });
    expect(screen.getByText(reads)).toBeInTheDocument();
  });

  it('adds nothing beside a custom taker-after already written in full', () => {
    render(<MakerSettings {...base} takerAfter={{ kind: 'custom', sec: null }} />);
    fireEvent.click(screen.getByRole('button', { name: /Maker settings/ }));
    fireEvent.change(screen.getByLabelText('Taker after, custom time'), { target: { value: '30s' } });
    expect(screen.queryByText(/^= /)).not.toBeInTheDocument();
  });

  it("shows the account's own maker and taker fees in the hovers", async () => {
    server.use(http.get('/api/fees', () => HttpResponse.json(env(fees))));
    const user = userEvent.setup();
    renderWithClient(<MakerSettings {...base} symbols={['GATE_FUTURE_ETH_USDT', 'BINANCE_FUTURE_ETH_USDT']} />);
    await user.click(screen.getByRole('button', { name: /Maker settings/ }));
    await user.hover(screen.getByText('Maker leg', { selector: 'span' }));
    const legCard = await screen.findByRole('tooltip');
    expect(await within(legCard).findByText('Rests the limit order · maker fee 1.5 bps (0.015%)')).toBeInTheDocument();
    expect(within(legCard).getByText('Hedges each fill at market · taker fee 4.5 bps (0.045%)')).toBeInTheDocument();
    await user.unhover(screen.getByText('Maker leg', { selector: 'span' }));
    await user.hover(screen.getByText('Taker after', { selector: 'span' }));
    const takerCard = await screen.findByRole('tooltip');
    expect(await within(takerCard).findByText('What is still unfilled then goes as a market order (4 bps, 0.04%, taker fee).')).toBeInTheDocument();
  });

  it('gives a range when the legs pay different taker fees and no leg is picked', async () => {
    server.use(http.get('/api/fees', () => HttpResponse.json(env(fees))));
    const user = userEvent.setup();
    renderWithClient(<MakerSettings {...base} legs={null} symbols={['GATE_FUTURE_ETH_USDT', 'BINANCE_FUTURE_BTC_USDT']} />);
    await user.click(screen.getByRole('button', { name: /Maker settings/ }));
    await user.hover(screen.getByText('Taker after', { selector: 'span' }));
    const card = await screen.findByRole('tooltip');
    expect(await within(card).findByText('What is still unfilled then goes as a market order (4–5 bps, 0.04–0.05%, taker fee).')).toBeInTheDocument();
  });

  it('names the fee without a number when the venue rate is unknown', async () => {
    server.use(http.get('/api/fees', () => HttpResponse.json(env(fees))));
    const user = userEvent.setup();
    renderWithClient(<MakerSettings {...base} legs={null} symbols={['LIGHTER_FUTURE_ETH_USDC']} />);
    await user.click(screen.getByRole('button', { name: /Maker settings/ }));
    await user.hover(screen.getByText('Taker after', { selector: 'span' }));
    const card = await screen.findByRole('tooltip');
    expect(await within(card).findByText('What is still unfilled then goes as a market order, at the taker fee.')).toBeInTheDocument();
  });
});
