import { afterEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import { ApiError } from '../api/client';
import { apiErrorText } from './apiErrorText';

const error = (message: string, hint?: string) => new ApiError({ category: 'auth', message, hint, retryable: false });

describe('apiErrorText', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('joins a Chinese message and hint with no stray period', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(apiErrorText(error('Gate refused the API key.', 'Check it in Settings.'))).toBe('Gate 拒绝了该 API 密钥。请在设置中检查。');
    expect(apiErrorText(error('Gate refused the API key', 'Check it in Settings.'))).toBe('Gate 拒绝了该 API 密钥。请在设置中检查。');
  });

  it('adds a period in English only when the message has none', async () => {
    await i18n.changeLanguage('en');
    expect(apiErrorText(error('Gate refused the API key.', 'Check it in Settings.'))).toBe('Gate refused the API key. Check it in Settings.');
    expect(apiErrorText(error('Gate refused the API key', 'Check it in Settings.'))).toBe('Gate refused the API key. Check it in Settings.');
  });

  it('shows the message alone when there is no hint', () => {
    expect(apiErrorText(error('Nothing to close.'))).toBe('Nothing to close.');
    expect(apiErrorText(new Error('boom'))).toBe('boom');
  });
});
