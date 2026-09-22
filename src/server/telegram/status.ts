import type { BotAuthReason, TelegramSettings } from './botClient';

export type TelegramAuth = 'ok' | BotAuthReason;

export class TelegramStatus {
  lastSyncAt: number | null = null;
  lastSyncError: { at: number; message: string } | null = null;
  auth: TelegramAuth | null = null;
  settings: TelegramSettings | null = null;

  setSynced(at: number, settings: TelegramSettings): void {
    this.lastSyncAt = at;
    this.lastSyncError = null;
    this.auth = 'ok';
    this.settings = settings;
  }

  setSyncError(at: number, message: string): void {
    this.lastSyncError = { at, message };
  }

  setAuth(auth: TelegramAuth | null): void {
    this.auth = auth;
  }

  setSettings(settings: TelegramSettings | null): void {
    this.settings = settings;
  }
}
