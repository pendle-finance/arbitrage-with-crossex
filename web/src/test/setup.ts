import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './server';

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
