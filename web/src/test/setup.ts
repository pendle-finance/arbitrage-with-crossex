import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './server';

// A hover card took over the 1 s default to open on a slow CI runner.
configure({ asyncUtilTimeout: 3000 });

// jsdom implements neither scrollIntoView nor scrollTo — the trade rail and the
// tab switcher call them.
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
window.scrollTo = () => {};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));

afterEach(() => {
  cleanup();
  server.resetHandlers();
  localStorage.clear(); // basket drafts / recent symbols / active tab must not leak across tests
});

afterAll(() => server.close());
