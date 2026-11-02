import type { FastifyInstance, FastifyReply } from 'fastify';
import { CoreError } from '../../core/errors';
import { AssetPrefsFile, BOOK_KEY_PATTERN } from '../assetPrefs';
import type { AppDeps } from '../app';

function bookOf(params: unknown): string {
  const { book } = params as { book: string };
  if (!BOOK_KEY_PATTERN.test(book)) throw new CoreError('book key is not valid');
  return book;
}

function failed(err: unknown, reply: FastifyReply): FastifyReply {
  if (err instanceof CoreError) throw err;
  return reply
    .code(500)
    .send({ ok: false, error: { category: 'unknown', message: 'could not save asset prefs', retryable: true } });
}

export function assetPrefsRoutes(deps: AppDeps) {
  return async function plugin(app: FastifyInstance): Promise<void> {
    const store = new AssetPrefsFile(deps.dataDir);

    app.get('/asset-prefs/:book', async (req, reply) => {
      const prefs = store.get(bookOf(req.params));
      return reply.ok(store.wasUnreadable ? { ...prefs, unreadable: true } : prefs);
    });

    app.patch('/asset-prefs/:book', async (req, reply) => {
      const book = bookOf(req.params);
      try {
        return reply.ok(store.patch(book, req.body));
      } catch (err) {
        return failed(err, reply);
      }
    });

    app.post('/asset-prefs/import', async (req, reply) => {
      try {
        store.importAll(req.body);
      } catch (err) {
        return failed(err, reply);
      }
      return reply.ok({});
    });
  };
}
