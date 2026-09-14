import { describe, expect, it } from 'vitest';
import { classifyGateError, CoreError } from '../../src/core/errors';

const gate = (status: number, label: string) => ({ response: { status, data: { label, message: label } } });

describe('classifyGateError label anchoring', () => {
  it('permission errors are auth, not insufficient-margin (anchoring fix)', () => {
    expect(classifyGateError(gate(400, 'INSUFFICIENT_PERMISSION')).category).toBe('auth');
    expect(classifyGateError(gate(400, 'NO_PERMISSION')).category).toBe('auth');
  });

  it('order/position "not found" is validation, not symbol-invalid', () => {
    expect(classifyGateError(gate(400, 'POSITION_NOT_FOUND')).category).toBe('validation');
    expect(classifyGateError(gate(400, 'ORDER_NOT_FOUND')).category).toBe('validation');
  });

  it('genuine balance/margin shortfalls still classify as insufficient-margin', () => {
    expect(classifyGateError(gate(400, 'BALANCE_NOT_ENOUGH')).category).toBe('insufficient-margin');
    expect(classifyGateError(gate(400, 'MARGIN_NOT_ENOUGH')).category).toBe('insufficient-margin');
    expect(classifyGateError(gate(400, 'INSUFFICIENT_AVAILABLE')).category).toBe('insufficient-margin');
  });

  it('a genuine 403 keeps httpStatus 403 (so the app returns 403, not 401)', () => {
    const c = classifyGateError(gate(403, 'FORBIDDEN'));
    expect(c.category).toBe('auth');
    expect(c.httpStatus).toBe(403);
  });

  it('other labels: rate-limit, leverage, size, price, post-only, reduce-only', () => {
    expect(classifyGateError(gate(429, 'TOO_MANY_REQUESTS')).category).toBe('rate-limited');
    expect(classifyGateError(gate(400, 'LEVERAGE_TOO_LARGE')).category).toBe('leverage');
    expect(classifyGateError(gate(400, 'SIZE_TOO_SMALL')).category).toBe('size-too-small');
    expect(classifyGateError(gate(400, 'MAX_MARKET_SIZE')).category).toBe('size-too-large');
    expect(classifyGateError(gate(400, 'POST_ONLY_REJECT')).category).toBe('post-only-would-cross');
    expect(classifyGateError(gate(400, 'REDUCE_ONLY_VIOLATION')).category).toBe('reduce-only-violation');
    expect(classifyGateError(gate(400, 'CAN_NOT_DELETE_LARGE_POSITION')).category).toBe('venue-rejected');
  });

  it('a CoreError keeps its category; a bare network error is retryable', () => {
    expect(classifyGateError(new CoreError('x', 'leverage')).category).toBe('leverage');
    const net = classifyGateError(Object.assign(new Error('socket'), { code: 'ECONNRESET' }));
    expect(net.category).toBe('network');
    expect(net.retryable).toBe(true);
  });

  it('transfer amount insufficient is margin', () => {
    const c = classifyGateError(gate(422, 'TRANSFER_AMOUNT_INSUFFICIENT'));
    expect(c.category).toBe('insufficient-margin');
    expect(c.retryable).toBe(false);
  });

  it('transfer amount below minimum is still unknown', () => {
    expect(classifyGateError(gate(422, 'TRANSFER_AMOUNT_MINTRANS_INVALID_ERROR')).category).toBe('unknown');
  });
});
