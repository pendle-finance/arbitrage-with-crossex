import { describe, expect, it } from 'vitest';
import { classifyGateError, classifyPlain, CoreError, plainErrorFor, refusalReason } from '../../src/core/errors';

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

const said = (status: number, label: string, message: string) => ({ response: { status, data: { label, message } } });

describe('classifyGateError message', () => {
  it("classifyGateError keeps Gate's status and label in the message", () => {
    const notFound = Object.assign(new Error('Request failed with status code 400'), {
      response: { status: 400, data: { label: 'ORDER_NOT_FOUND', message: 'order not found' } },
    });

    expect(classifyGateError(notFound).message).toBe('Gate API error (HTTP 400) [ORDER_NOT_FOUND]: order not found');
    expect(classifyGateError(said(401, 'INVALID_KEY', 'invalid key')).hint).toBe('Check the API key/secret in Settings.');
  });
});

describe('plainErrorFor', () => {
  it("shows Gate's message as a sentence with no status or label", () => {
    expect(plainErrorFor(said(400, 'TRADE_INVALID_QUOTE_ORDER_QTY', 'quote qty is required'))).toEqual({
      message: 'Quote qty is required.',
      hint: undefined,
    });
  });

  it('names the minimum Gate sent on a transfer below it', () => {
    const refused = said(422, 'TRANSFER_AMOUNT_MINTRANS_INVALID_ERROR', 'The Minimum amount needs to be greater than 11.');

    expect(refusalReason(refused)).toBe("below Gate's minimum of 11");
    expect(plainErrorFor(refused).message).toBe("Below Gate's minimum of 11.");
  });

  it('a 401 or INVALID_KEY is a refused key with the Settings hint', () => {
    const refusals = [
      said(401, 'INVALID_KEY', 'invalid key'),
      said(401, 'INVALID_SIGNATURE', 'signature mismatch'),
      said(401, 'INVALID_CREDENTIALS', 'invalid credentials'),
      { response: { status: 401 } },
    ];

    for (const refused of refusals) {
      expect(plainErrorFor(refused)).toEqual({ message: 'Gate refused the API key.', hint: 'Check it in Settings.' });
      expect(classifyGateError(refused)).toMatchObject({ category: 'auth', retryable: false });
    }
  });

  it("a 401 for an expired request keeps Gate's message", () => {
    const expired = said(401, 'REQUEST_EXPIRED', 'gap between request Timestamp and server time exceeds 60');

    const plain = plainErrorFor(expired);

    expect(plain.message).toBe('Gap between request Timestamp and server time exceeds 60.');
    expect(`${plain.message} ${plain.hint ?? ''}`).not.toContain('API key');
    expect(refusalReason(expired)).not.toContain('API key');
  });

  it('an error with no Gate envelope keeps its own message', () => {
    expect(classifyGateError(new Error('socket hang up')).message).toBe('socket hang up');
    expect(refusalReason(new Error('socket hang up'))).toBe('socket hang up');
    expect(plainErrorFor(new Error('socket hang up')).message).toBe('socket hang up');
  });
});

describe('classifyPlain', () => {
  it('keeps a CoreError as it is', () => {
    const classified = classifyPlain(new CoreError('Already even.'));

    expect(classified.message).toBe('Already even.');
    expect(classified.category).toBe('validation');
  });
});
