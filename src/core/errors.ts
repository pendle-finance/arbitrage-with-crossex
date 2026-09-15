/** Error taxonomy: human-readable messages + typed envelopes for the API. */

/** Turn a Gate SDK / axios error (or any error) into a readable one-line message. */
export function describeError(err: unknown): string {
  const e = err as {
    response?: { status?: number; data?: { label?: string; message?: string } };
    message?: string;
  };
  const data = e?.response?.data;
  if (data && (data.label || data.message)) {
    const status = e.response?.status ? ` (HTTP ${e.response.status})` : '';
    return `Gate API error${status} [${data.label ?? 'unknown'}]: ${data.message ?? ''}`.trim();
  }
  return e?.message ?? String(err);
}

export type ErrorCategory =
  | 'auth'
  | 'not-configured'
  | 'insufficient-margin'
  | 'size-too-small'
  | 'size-too-large'
  | 'price-limit'
  | 'post-only-would-cross'
  | 'leverage'
  | 'reduce-only-violation'
  | 'rate-limited'
  | 'symbol-invalid'
  | 'venue-rejected'
  | 'validation'
  | 'network'
  | 'unknown';

export interface ClassifiedError {
  category: ErrorCategory;
  label?: string;
  message: string;
  httpStatus?: number;
  retryable: boolean;
  hint?: string;
}

/** Validation/domain failure raised by core code (never carries a Gate response). */
export class CoreError extends Error {
  constructor(
    msg: string,
    public category: ErrorCategory = 'validation',
    public details?: unknown,
  ) {
    super(msg);
    this.name = 'CoreError';
  }
}

/** Ordered label-substring → category rules. Gate's exact CrossEx labels are only
 * partly documented, so match case-insensitive substrings and let callers log any
 * label that falls through to `unknown` (the table grows from recorded truth). */
const LABEL_RULES: Array<{ match: RegExp; category: ErrorCategory; hint?: string }> = [
  // Permission is an auth problem, not a funds problem — must beat the balance rule.
  { match: /INVALID_KEY|INVALID_SIGNATURE|FORBIDDEN|MISSING_REQUIRED_HEADER|INVALID_CREDENTIALS|PERMISSION/, category: 'auth', hint: 'Check the API key/secret and its CrossEx permission in Settings.' },
  { match: /TOO_MANY|RATE_LIMIT/, category: 'rate-limited' },
  { match: /POST_ONLY|POC_/, category: 'post-only-would-cross', hint: 'A post-only order would have crossed the book.' },
  { match: /REDUCE_ONLY/, category: 'reduce-only-violation' },
  { match: /LEVERAGE|RISK_LIMIT/, category: 'leverage' },
  { match: /CAN_NOT_DELETE_LARGE_POSITION/, category: 'venue-rejected', hint: 'Close via a reduce-only marketable limit instead of the position endpoint.' },
  { match: /MIN_NOTIONAL|SIZE_TOO_SMALL|MIN_SIZE|TOO_SMALL/, category: 'size-too-small' },
  { match: /MAX_MARKET_SIZE|MAX_LIMIT_SIZE|SIZE_TOO_LARGE|TOO_LARGE/, category: 'size-too-large' },
  { match: /SIGNIFICANT_FIGURES|PRICE/, category: 'price-limit', hint: 'Price outside the venue’s allowed band or precision.' },
  // Anchor INSUFFICIENT to a funds word so INSUFFICIENT_PERMISSION (handled above) can't reach here.
  { match: /BALANCE|MARGIN|INSUFFICIENT_(BALANCE|MARGIN|AVAILABLE|FUND)|NOT_ENOUGH|TRANSFER_AMOUNT_INSUFFICIENT/, category: 'insufficient-margin' },
  // Order/position "not found" is a stale-state validation error, NOT a bad symbol —
  // must beat the broad SYMBOL/NOT_FOUND rule below.
  { match: /ORDER_NOT_FOUND|ORDER_CLOSED|ORDER_FINISHED|POSITION_NOT_FOUND|NO_POSITION/, category: 'validation' },
  { match: /SYMBOL|CONTRACT_NOT_FOUND|NOT_FOUND/, category: 'symbol-invalid' },
];

/** Classify any thrown error (Gate SDK/axios/CoreError/other) for the API envelope. */
export function classifyGateError(err: unknown): ClassifiedError {
  if (err instanceof CoreError) {
    return { category: err.category, message: err.message, retryable: false };
  }
  const e = err as {
    response?: { status?: number; data?: { label?: string; message?: string } };
    code?: string;
    message?: string;
  };
  const status = e?.response?.status;
  const label = e?.response?.data?.label;
  const message = describeError(err);

  if (status === 401 || status === 403) {
    return { category: 'auth', label, message, httpStatus: status, retryable: false, hint: 'Check the API key/secret in Settings.' };
  }
  if (status === 429) {
    return { category: 'rate-limited', label, message, httpStatus: status, retryable: true };
  }
  if (label) {
    const upper = label.toUpperCase();
    for (const rule of LABEL_RULES) {
      if (rule.match.test(upper)) {
        return {
          category: rule.category,
          label,
          message,
          httpStatus: status,
          retryable: rule.category === 'rate-limited',
          hint: rule.hint,
        };
      }
    }
    return { category: 'unknown', label, message, httpStatus: status, retryable: false };
  }
  // No Gate envelope: axios network errors have a code and no response.
  if (!e?.response && (e?.code || /network|timeout|socket|ECONN|EAI_AGAIN/i.test(e?.message ?? ''))) {
    return { category: 'network', message, retryable: true };
  }
  return { category: 'unknown', message, httpStatus: status, retryable: false };
}

type GateErrorShape = {
  response?: { status?: number; data?: { label?: string; message?: string } };
  message?: string;
};

const KEY_REFUSED_LABELS: readonly string[] = ['INVALID_KEY', 'INVALID_CREDENTIALS', 'INVALID_SIGNATURE'];

const isKeyRefused = (e: GateErrorShape): boolean => {
  const label = e?.response?.data?.label;
  return label ? KEY_REFUSED_LABELS.includes(label.toUpperCase()) : e?.response?.status === 401;
};

export function refusalReason(err: unknown): string {
  const e = err as GateErrorShape;
  const data = e?.response?.data;
  if (isKeyRefused(e)) return 'Gate refused the API key';
  if (!data || !(data.label || data.message)) return e?.message ?? String(err);
  const text = (data.message ?? '').trim().replace(/[\s.]+$/, '');
  const minimum = /MINTRANS/.test((data.label ?? '').toUpperCase()) ? text.match(/\d+(?:\.\d+)?/g)?.at(-1) : undefined;
  if (minimum !== undefined) return `below Gate's minimum of ${Number(minimum)}`;
  return text || `Gate error ${data.label}`;
}

const asSentence = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

export function plainErrorFor(err: unknown): Pick<ClassifiedError, 'message' | 'hint'> {
  const e = err as GateErrorShape;
  if (isKeyRefused(e)) return { message: 'Gate refused the API key.', hint: 'Check it in Settings.' };
  const data = e?.response?.data;
  const reason = refusalReason(err);
  return {
    message: data?.label || data?.message ? asSentence(reason) : reason,
    hint: e?.response?.status === 401 ? undefined : classifyGateError(err).hint,
  };
}

export function classifyPlain(err: unknown): ClassifiedError {
  if (err instanceof CoreError) return classifyGateError(err);
  return { ...classifyGateError(err), ...plainErrorFor(err) };
}
