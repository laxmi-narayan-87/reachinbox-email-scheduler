import 'dotenv/config';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import express from 'express';
import helmet from 'helmet';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { prisma } from '@reachinbox/database';
import { createEmailQueue } from '@reachinbox/queue';
import { bulkEmailSchema, createEmailSchema } from '@reachinbox/shared';
import { createSession, destroySession, requireAuth } from './auth.js';
import { publishPendingOutbox } from './outbox.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const app = express();
const port = Number(process.env.PORT ?? 5000);
const queue = createEmailQueue();

app.use(helmet());
app.use(cors({ origin: process.env.WEB_ORIGIN?.split(',') ?? true, credentials: true }));
app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ logger }));

app.get('/health/live', (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/health/ready', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await queue.getJobCounts();
    res.status(200).json({ status: 'ready' });
  } catch (error) {
    logger.error({ err: error }, 'readiness check failed');
    res.status(503).json({ status: 'not_ready' });
  }
});

app.post('/auth/logout', requireAuth, async (req, res) => {
  await destroySession(req, res);
  res.status(204).send();
});

app.get('/api/me', requireAuth, (req, res) => res.json(req.user));

app.post('/api/bootstrap', async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'valid email required' });

  const user = await prisma.user.upsert({ where: { email }, update: { name }, create: { email, name } });
  await createSession(user.id, res);
  res.status(200).json({ id: user.id, email: user.email, name: user.name });
});

app.post('/api/senders', requireAuth, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const provider = typeof req.body?.provider === 'string' ? req.body.provider.toUpperCase() : 'SMTP';
  const hourlyLimit = Number(req.body?.hourlyLimit ?? 100);
  const providerConfig = req.body?.providerConfig ?? {};
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'valid sender email required' });
  if (!['SMTP', 'GMAIL', 'OUTLOOK'].includes(provider)) return res.status(400).json({ error: 'unsupported provider' });
  if (!Number.isInteger(hourlyLimit) || hourlyLimit < 1 || hourlyLimit > 100000) return res.status(400).json({ error: 'invalid hourlyLimit' });
  const sender = await prisma.sender.upsert({
    where: { userId_email: { userId: req.user!.id, email } },
    update: { provider: provider as 'SMTP' | 'GMAIL' | 'OUTLOOK', hourlyLimit, providerConfig },
    create: { userId: req.user!.id, email, provider: provider as 'SMTP' | 'GMAIL' | 'OUTLOOK', hourlyLimit, providerConfig },
  });
  res.status(201).json({ ...sender, providerConfig: undefined });
});

app.get('/api/senders', requireAuth, async (req, res) => {
  const senders = await prisma.sender.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: 'desc' } });
  res.json(senders.map(({ providerConfig: _config, ...sender }) => sender));
});

app.post('/api/emails', requireAuth, async (req, res) => {
  const parsed = createEmailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { senderId, recipientEmail, subject, body, scheduledAt } = parsed.data;
  if (scheduledAt.getTime() < Date.now()) return res.status(400).json({ error: 'scheduledAt must be in the future' });

  try {
    const sender = await prisma.sender.findFirst({ where: { id: senderId, userId: req.user!.id } });
    if (!sender) return res.status(404).json({ error: 'sender not found' });

    const email = await prisma.$transaction(async (tx) => {
      const created = await tx.email.create({ data: { userId: req.user!.id, senderId, recipientEmail, subject, body, scheduledAt } });
      await tx.outboxEvent.create({ data: { aggregateId: created.id, eventType: 'EMAIL_SCHEDULED', payload: { emailId: created.id } } });
      return created;
    });
    return res.status(201).json(email);
  } catch (error) {
    logger.error({ err: error }, 'failed to schedule email');
    return res.status(500).json({ error: 'failed to schedule email' });
  }
});

app.post('/api/batches', requireAuth, async (req, res) => {
  const parsed = bulkEmailSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const { senderId, subject, body, scheduledAt, delayBetweenEmailsMs } = parsed.data;
  if (scheduledAt.getTime() < Date.now()) return res.status(400).json({ error: 'scheduledAt must be in the future' });

  const recipients = Array.isArray(req.body.recipients) ? req.body.recipients : [];
  const validRecipients = recipients.filter((value): value is string => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  const uniqueRecipients = [...new Set(validRecipients)];
  if (uniqueRecipients.length === 0) return res.status(400).json({ error: 'recipients must contain at least one valid email' });
  if (uniqueRecipients.length > Number(process.env.MAX_BATCH_SIZE ?? 5000)) return res.status(400).json({ error: 'batch is too large' });

  try {
    const sender = await prisma.sender.findFirst({ where: { id: senderId, userId: req.user!.id } });
    if (!sender) return res.status(404).json({ error: 'sender not found' });

    const result = await prisma.$transaction(async (tx) => {
      const batch = await tx.batch.create({ data: { userId: req.user!.id, totalEmails: uniqueRecipients.length, status: 'SCHEDULING' } });
      const emails = await Promise.all(uniqueRecipients.map((recipient, index) => tx.email.create({
        data: {
          userId: req.user!.id,
          senderId,
          batchId: batch.id,
          recipientEmail: recipient,
          subject,
          body,
          scheduledAt: new Date(scheduledAt.getTime() + index * delayBetweenEmailsMs),
        },
      })));
      await tx.outboxEvent.createMany({
        data: emails.map((email) => ({ aggregateId: email.id, eventType: 'EMAIL_SCHEDULED', payload: { emailId: email.id } })),
      });
      await tx.batch.update({ where: { id: batch.id }, data: { status: 'SCHEDULED' } });
      return { batchId: batch.id, totalEmails: emails.length };
    });
    return res.status(201).json(result);
  } catch (error) {
    logger.error({ err: error }, 'failed to schedule batch');
    return res.status(500).json({ error: 'failed to schedule batch' });
  }
});

app.get('/api/emails', requireAuth, async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const emails = await prisma.email.findMany({
    where: { userId: req.user!.id, ...(status ? { status: status as never } : {}) },
    orderBy: { scheduledAt: 'desc' },
    take: 100,
  });
  res.json(emails);
});

app.delete('/api/emails/:id', requireAuth, async (req, res) => {
  const result = await prisma.email.updateMany({ where: { id: req.params.id, userId: req.user!.id, status: 'SCHEDULED' }, data: { status: 'CANCELLED' } });
  if (result.count !== 1) return res.status(409).json({ error: 'email not found or cannot be cancelled' });
  res.status(204).send();
});

app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  const [scheduled, processing, sent, failed, cancelled] = await Promise.all([
    prisma.email.count({ where: { userId: req.user!.id, status: 'SCHEDULED' } }),
    prisma.email.count({ where: { userId: req.user!.id, status: 'PROCESSING' } }),
    prisma.email.count({ where: { userId: req.user!.id, status: 'SENT' } }),
    prisma.email.count({ where: { userId: req.user!.id, status: 'FAILED' } }),
    prisma.email.count({ where: { userId: req.user!.id, status: 'CANCELLED' } }),
  ]);
  res.json({ scheduled, processing, sent, failed, cancelled });
});

const server = app.listen(port, () => logger.info({ port }, 'API listening'));
const outboxTimer = setInterval(() => { void publishPendingOutbox().catch((error) => logger.error({ err: error }, 'outbox publisher failed')); }, 1000);
void publishPendingOutbox();

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down API');
  clearInterval(outboxTimer);
  server.close();
  await queue.close();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
