import nodemailer from 'nodemailer';

export interface EmailMessage { from: string; to: string; subject: string; text: string; }
export interface SendResult { messageId?: string; provider?: string; }
export interface EmailProvider { send(message: EmailMessage): Promise<SendResult>; }

type ProviderConfig = Record<string, unknown>;

function config(value: unknown): ProviderConfig { return value && typeof value === 'object' ? value as ProviderConfig : {}; }

export class SmtpProvider implements EmailProvider {
  constructor(private readonly providerConfig: unknown = {}) {}

  private buildTransport() {
    const cfg = config(this.providerConfig);
    const password = typeof cfg.password === 'string' ? cfg.password : process.env.SMTP_PASSWORD;
    return nodemailer.createTransport({
      host: typeof cfg.host === 'string' ? cfg.host : process.env.SMTP_HOST ?? 'smtp.ethereal.email',
      port: Number(cfg.port ?? process.env.SMTP_PORT ?? 587),
      secure: Boolean(cfg.secure ?? String(process.env.SMTP_SECURE ?? 'false') === 'true'),
      auth: cfg.username || password ? { user: String(cfg.username ?? process.env.SMTP_USER ?? ''), pass: String(password ?? '') } : undefined,
    });
  }

  async send(message: EmailMessage): Promise<SendResult> {
    const info = await this.buildTransport().sendMail(message);
    return { messageId: info.messageId, provider: 'SMTP' };
  }
}

export class GmailProvider implements EmailProvider {
  constructor(private readonly providerConfig: unknown = {}) {}

  async send(message: EmailMessage): Promise<SendResult> {
    const cfg = config(this.providerConfig);
    const accessToken = typeof cfg.accessToken === 'string' ? await this.getAccessToken(cfg) : '';
    if (!accessToken) throw new Error('Gmail access token is not configured');
    const raw = [`From: ${message.from}`, `To: ${message.to}`, `Subject: ${message.subject}`, 'Content-Type: text/plain; charset=utf-8', '', message.text].join('\r\n');
    const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }),
    });
    if (!response.ok) throw new Error(`Gmail ${response.status}: ${await response.text()}`);
    const data = await response.json() as { id?: string };
    return { messageId: data.id, provider: 'GMAIL' };
  }

  private async getAccessToken(cfg: ProviderConfig): Promise<string> {
    const token = String(cfg.accessToken ?? '');
    const expires = Number(cfg.accessTokenExpiresAt ?? 0);
    if (token && expires > Date.now() + 60_000) return token;
    const refreshToken = String(cfg.refreshToken ?? '');
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    if (!refreshToken || !clientId || !clientSecret) throw new Error('Gmail OAuth credentials are not configured');
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    if (!response.ok) throw new Error(`Google token refresh failed: ${response.status}`);
    const data = await response.json() as { access_token: string; expires_in: number };
    return data.access_token;
  }
}

export class OutlookProvider implements EmailProvider {
  constructor(private readonly providerConfig: unknown = {}) {}

  async send(message: EmailMessage): Promise<SendResult> {
    const cfg = config(this.providerConfig);
    const accessToken = String(cfg.accessToken ?? '');
    if (!accessToken) throw new Error('Outlook access token is not configured');
    const response = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { subject: message.subject, body: { contentType: 'Text', content: message.text }, toRecipients: [{ emailAddress: { address: message.to } }] } }),
    });
    if (!response.ok) throw new Error(`Microsoft Graph ${response.status}: ${await response.text()}`);
    return { messageId: `graph-${Date.now()}-${message.to}`, provider: 'OUTLOOK' };
  }
}

export function createProvider(provider: string, providerConfig: unknown = {}): EmailProvider {
  switch (provider) {
    case 'GMAIL': return new GmailProvider(providerConfig);
    case 'OUTLOOK': return new OutlookProvider(providerConfig);
    case 'SMTP':
    default: return new SmtpProvider(providerConfig);
  }
}
