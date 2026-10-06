import type { NotificationPayload } from './format.js';

export interface TelegramSendResult {
  ok: boolean;
  messageId?: number;
  error?: string;
  /** False for permanent errors (bad token, bad chat id) so we stop retrying. */
  retryable: boolean;
}

export interface TelegramClient {
  send(payload: NotificationPayload): Promise<TelegramSendResult>;
}

export interface TelegramOptions {
  botToken: string;
  chatId: string;
  disableWebPagePreview: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Telegram Bot API client. Only an "Open vacancy" URL button is supported. */
export function createTelegramClient(options: TelegramOptions): TelegramClient {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async send(payload) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
      try {
        const response = await doFetch(`https://api.telegram.org/bot${options.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            chat_id: options.chatId,
            text: payload.text,
            disable_web_page_preview: options.disableWebPagePreview,
            reply_markup: {
              inline_keyboard: [[{ text: payload.buttonText, url: payload.url }]],
            },
          }),
        });
        const body = (await response.json().catch(() => ({}))) as any;
        if (response.ok && body?.ok) {
          return { ok: true, messageId: body.result?.message_id, retryable: false };
        }
        const description = body?.description ?? `HTTP ${response.status}`;
        // 4xx other than 429 means the request itself is wrong - retrying is pointless.
        const retryable = response.status === 429 || response.status >= 500;
        return { ok: false, error: String(description).slice(0, 1900), retryable };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          retryable: true,
        };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Client used by `--dry-run`: prints instead of sending. */
export function createDryRunClient(sink: (line: string) => void): TelegramClient {
  return {
    async send(payload) {
      sink('--- telegram (dry run) ---');
      sink(payload.text);
      sink(`[button] ${payload.buttonText} -> ${payload.url}`);
      sink('');
      return { ok: true, retryable: false };
    },
  };
}
