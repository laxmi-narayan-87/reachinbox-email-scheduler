import nodemailer from 'nodemailer';
import { decryptSecret } from '../../api/src/crypto.js';

export type SenderRecord = {
  email: string;
  provider: 'SMTP' | 'GMAIL' | 'OUTLOOK';
  providerConfig: unknown;
};

export type SendMessage = { from: string; to: string; subject: string; text: string; html?: string };
export type SendResult = { messageId: string; provider: string };

function configObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export interface EmailProvider {
  send(message: SendMessage): Promise<SendResult>;
}

class SmtpProvider implements EmailProvider {
  async send(message: SendMessage): Promise<SendResult> {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST ?? 'smtp.ethereal.email',
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: String(process.env.SMTP_SECURE ?? 'false') === 'true',
      auth: process.env.SMTP_USER && process.env.SMTP_PASSWORD ? {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASSWORD,
      } : undefined,
    });
    const result = await transporter.sendMail(message);
    return { messageId: result.messageId, provider: 'SMTP' };
  }
}

class GmailProvider implements EmailProvider {
  async send(message: SendMessage): Promise<SendResult> {
    const cfg = configObject(this.config);
    const accessToken = await this.getAccessToken(cfg);
    const raw = [
      `From: ${message.from}`,
      `To: ${message.to}`,
      `Subject: ${message.subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      message.text,
    ].join('\r\n');
    const encoded = Buffer.from(raw).toString('base64url');
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: encoded }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gmail ${response.status}: ${text}`);
    }
    const data = await response.json() as { id: string };
    return { messageId: data.id, provider: 'GMAIL' };
  }

  constructor(private readonly config: unknown = {}) {}

  private async getAccessToken(cfg: Record<string, unknown>): Promise<string> {
    const access = typeof cfg.accessToken === 'string' ? cfg.accessToken : '';
    const expiresAt = Number(cfg.accessTokenExpiresAt ?? 0);
    if (access && expiresAt > Date.now() + 60_000) return decryptSecret(access);
    const encryptedRefresh = typeof cfg.refreshToken === 'string' ? cfg.refreshToken : '';
    if (!encryptedRefresh) throw new Error('Gmail refresh token is not configured');
    const refreshToken = decryptSecret(encryptedRefresh);
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error('Google OAuth client credentials are not configured');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    if (!response.ok) throw new Error(`Google token refresh failed: ${response.status}`);
    const data = await response.json() as { access_token: string; expires_in: number };
    return data.access_token;
  }
}

class OutlookProvider implements EmailProvider {
  constructor(private readonly config: unknown) {}

  async send(message: SendMessage): Promise<SendResult> {
    const cfg = configObject(this.config);
    const accessToken = typeof cfg.accessToken === 'string' ? decryptSecret(cfg.accessToken) : '';
    if (!accessToken) throw new Error('Outlook access token is not configured');
    const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { subject: message.subject, body: { contentType: 'Text', content: message.text }, toRecipients: [{ emailAddress: { address: message.to } }] } }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Microsoft Graph ${response.status}: ${text}`);
    }
    return { messageId: `graph-${Date.now()}-${message.to}`, provider: 'OUTLOOK' };
  }
}

export function providerForSender(sender: SenderRecord): EmailProvider {
  if (sender.provider === 'GMAIL') return new GmailProvider(sender.providerConfig);
  if (sender.provider === 'OUTLOOK') return new OutlookProvider(sender.providerConfig);
  return new SmtpProvider();
}
