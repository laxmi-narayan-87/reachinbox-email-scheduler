import { z } from 'zod';

export const emailStatusSchema = z.enum([
  'SCHEDULED',
  'PROCESSING',
  'SENT',
  'FAILED',
  'CANCELLED',
]);

export const createEmailSchema = z.object({
  senderId: z.string().min(1),
  recipientEmail: z.string().email(),
  subject: z.string().min(1).max(998),
  body: z.string().min(1),
  scheduledAt: z.coerce.date(),
});

export const bulkEmailSchema = z.object({
  senderId: z.string().min(1),
  subject: z.string().min(1).max(998),
  body: z.string().min(1),
  scheduledAt: z.coerce.date(),
  delayBetweenEmailsMs: z.number().int().min(0).max(86_400_000).default(5000),
});

export type EmailStatus = z.infer<typeof emailStatusSchema>;
export type CreateEmailInput = z.infer<typeof createEmailSchema>;
export type BulkEmailInput = z.infer<typeof bulkEmailSchema>;
