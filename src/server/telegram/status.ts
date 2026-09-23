import type { BotAuthReason, TelegramSettings } from './botClient';

export type TelegramAuth = 'ok' | BotAuthReason;

export class TelegramStatus {
  lastSyncAt: number | null = null;
  lastSyncError: { at: number; message: string } | null = null;
  auth: TelegramAuth | null = null;
  settings: TelegramSettings | null = null;
  alertWallet: string | null = null;
  walletRefused: string | null = null;

  setSynced(at: number, settings: TelegramSettings, wallet: string | null = null): void {
    this.lastSyncAt = at;
    this.alertWallet = wallet;
    this.walletRefused = null;
    this.lastSyncError = null;
    this.auth = 'ok';
    this.settings = settings;
  }

  setSyncError(at: number, message: string): void {
    this.lastSyncError = { at, message };
  }

  setWalletRefused(wallet: string): void {
    this.walletRefused = wallet;
  }

  setAuth(auth: TelegramAuth | null): void {
    this.auth = auth;
  }

  setSettings(settings: TelegramSettings | null): void {
    this.settings = settings;
  }
}
