import nodemailer from 'nodemailer';

export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface SendResult {
  messageId?: string;
}

export interface EmailProvider {
  send(message: EmailMessage): Promise<SendResult>;
}

export class SmtpProvider implements EmailProvider {
  private readonly transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'smtp.ethereal.email',
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: String(process.env.SMTP_SECURE ?? 'false') === 'true',
    auth: process.env.SMTP_USER && process.env.SMTP_PASSWORD
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
      : undefined,
  });

  async send(message: EmailMessage): Promise<SendResult> {
    const info = await this.transporter.sendMail(message);
    return { messageId: info.messageId };
  }
}

export class GmailProvider extends SmtpProvider {}
export class OutlookProvider extends SmtpProvider {}

export function createProvider(provider: string): EmailProvider {
  switch (provider) {
    case 'GMAIL':
      return new GmailProvider();
    case 'OUTLOOK':
      return new OutlookProvider();
    case 'SMTP':
    default:
      return new SmtpProvider();
  }
}
