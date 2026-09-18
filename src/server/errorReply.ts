import type { FastifyReply, FastifyRequest } from 'fastify';
import { classifyGateError, CoreError, type ClassifiedError, type ErrorCategory } from '../core/errors';

function statusFor(classified: ClassifiedError, err: unknown): number {
  switch (classified.category) {
    case 'validation':
    case 'symbol-invalid':
      return 400;
    case 'auth':
      return classified.httpStatus === 403 ? 403 : 401;
    case 'not-configured':
      return 503;
    case 'rate-limited':
      return 429;
    case 'network':
      return 502;
    default: {
      const s = classified.httpStatus ?? (err as { statusCode?: number })?.statusCode;
      if (s && s >= 400 && s <= 599) return s;
      return err instanceof CoreError ? 400 : 500;
    }
  }
}

export function sendError(
  err: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
  classify: (err: unknown) => ClassifiedError,
): FastifyReply {
  const classified = classify(err);
  const status = statusFor(classified, err);
  if (status === 500) {
    req.log?.error?.(err);
    return reply.code(500).send({
      ok: false,
      error: { category: 'unknown', message: 'internal server error', retryable: false },
    });
  }
  return reply.code(status).send({ ok: false, error: classified });
}

export const catchRateLimit = <T>(read: Promise<T>): Promise<T | null> =>
  read.catch((err: unknown) => {
    if (classifyGateError(err).category === 'rate-limited') return null;
    throw err;
  });

interface Refusal {
  code: number;
  category: ErrorCategory;
  message: string;
  retryable: boolean;
}

export function refuse(reply: FastifyReply, { code, category, message, retryable }: Refusal): FastifyReply {
  return reply.code(code).send({ ok: false, error: { category, message, retryable } });
}
