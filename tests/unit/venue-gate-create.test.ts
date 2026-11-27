import { describe, expect, it } from 'vitest';
import type { Clients } from '../../src/core/clients';
import { classifyGateError } from '../../src/core/errors';
import { gateVenue } from '../../src/engine/venueGate';

const refusing = (label: string): Clients =>
  ({
    crossEx: {
      createCrossexOrder: async () => {
        throw { response: { status: 400, data: { label, message: 'Too many order sent for Hyperliquid.' } } };
      },
    },
  }) as unknown as Clients;

describe('gateVenue.create', () => {
  it.each(['TRADE_HYPERLIQUID_ORDER_LIMIT_ERROR', 'TRADE_LIGHTER_ORDER_LIMIT_ERROR'])(
    'reads %s as a definite refusal of kind order-allowance',
    async (label) => {
      const venue = gateVenue(() => refusing(label));
      const out = await venue.create({
        contract: 'HYPERLIQUID_FUTURE_ETH_USDC',
        side: 'BUY',
        qty: '57.803',
        price: '1730.15',
        tif: 'poc',
        clientText: 't-p1.A2',
      });
      expect(out).toEqual({ kind: 'reject', label, message: 'Too many order sent for Hyperliquid.' });
      expect(classifyGateError({ response: { data: { label } } }).category).toBe('order-allowance');
    },
  );
});
