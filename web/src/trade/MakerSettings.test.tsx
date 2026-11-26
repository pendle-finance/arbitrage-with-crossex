import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MakerSettings } from './MakerSettings';

describe('MakerSettings', () => {
  it('groups thousands in the Saves line', () => {
    render(
      <MakerSettings
        legs={[
          { name: 'Gate', side: 'LONG' },
          { name: 'Binance', side: 'SHORT' },
        ]}
        makerLeg="a"
        autoPick={null}
        saving={1800}
        onMakerLeg={() => {}}
        takerAfter={{ kind: '5m', sec: 300 }}
        onTakerAfter={() => {}}
        takerCapSec={null}
        repegBehindBp={5}
        repegLocked={false}
        onRepeg={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Maker settings/ }));
    expect(screen.getByText('Saves ≈ 1,800 USDT')).toBeInTheDocument();
  });
});
