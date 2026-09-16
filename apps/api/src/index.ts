import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { prisma } from '@reachinbox/database';
import { createEmailQueue, getEmailJobId } from '@reachinbox/queue';
import { bulkEmailSchema, createEmailSchema } from '@reachinbox/shared';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const app = express();
const port = Number(process.env.PORT ?? 5000);
const queue = createEmailQueue();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(pinoHttp({ logger }));

app.get('/health/live', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

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

app.post('/api/emails', async (req, res) => {
  const parsed = createEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { senderId, recipientEmail, subject, body, scheduledAt } = parsed.data;
  if (scheduledAt.getTime() < Date.now()) {
    return res.status(400).json({ error: 'scheduledAt must be in the future' });
  }

  try {
    const sender = await prisma.sender.findUnique({ where: { id: senderId } });
    if (!sender) return res.status(404).json({ error: 'sender not found' });

    const email = await prisma.email.create({
      data: {
        userId: sender.userId,
        senderId,
        recipientEmail,
        subject,
        body,
        scheduledAt,
      },
    });

    await queue.add(
      'send-email',
      { emailId: email.id, attempt: 0 },
      { delay: Math.max(0, scheduledAt.getTime() - Date.now()), jobId: getEmailJobId(email.id) },
    );

    return res.status(201).json(email);
  } catch (error) {
    logger.error({ err: error }, 'failed to schedule email');
    return res.status(500).json({ error: 'failed to schedule email' });
  }
});

app.post('/api/batches', async (req, res) => {
  const parsed = bulkEmailSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { senderId, subject, body, scheduledAt, delayBetweenEmailsMs } = parsed.data;
  if (scheduledAt.getTime() < Date.now()) {
    return res.status(400).json({ error: 'scheduledAt must be in the future' });
  }

  const recipients = Array.isArray(req.body.recipients) ? req.body.recipients : [];
  const validRecipients = recipients.filter((value): value is string => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  const uniqueRecipients = [...new Set(validRecipients)];

  if (uniqueRecipients.length === 0) {
    return res.status(400).json({ error: 'recipients must contain at least one valid email' });
  }

  try {
    const sender = await prisma.sender.findUnique({ where: { id: senderId } });
    if (!sender) return res.status(404).json({ error: 'sender not found' });

    const batch = await prisma.batch.create({
      data: {
        userId: sender.userId,
        totalEmails: uniqueRecipients.length,
        status: 'SCHEDULING',
      },
    });

    const emails = await prisma.$transaction(
      uniqueRecipients.map((recipient, index) =>
        prisma.email.create({
          data: {
            userId: sender.userId,
            senderId,
            batchId: batch.id,
            recipientEmail: recipient,
            subject,
            body,
            scheduledAt: new Date(scheduledAt.getTime() + index * delayBetweenEmailsMs),
          },
        }),
      ),
    );

    await Promise.all(
      emails.map((email) =>
        queue.add(
          'send-email',
          { emailId: email.id, attempt: 0 },
          {
            delay: Math.max(0, email.scheduledAt.getTime() - Date.now()),
            jobId: getEmailJobId(email.id),
          },
        ),
      ),
    );

    await prisma.batch.update({ where: { id: batch.id }, data: { status: 'SCHEDULED' } });
    return res.status(201).json({ batchId: batch.id, totalEmails: emails.length });
  } catch (error) {
    logger.error({ err: error }, 'failed to schedule batch');
    return res.status(500).json({ error: 'failed to schedule batch' });
  }
});

app.get('/api/emails', async (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const emails = await prisma.email.findMany({
    where: status ? { status: status as never } : undefined,
    orderBy: { scheduledAt: 'desc' },
    take: 100,
  });
  res.json(emails);
});

app.delete('/api/emails/:id', async (req, res) => {
  const email = await prisma.email.findUnique({ where: { id: req.params.id } });
  if (!email) return res.status(404).json({ error: 'email not found' });
  if (email.status !== 'SCHEDULED') return res.status(409).json({ error: 'only scheduled emails can be cancelled' });

  await prisma.email.update({ where: { id: email.id }, data: { status: 'CANCELLED' } });
  await queue.getJob(getEmailJobId(email.id)).then((job) => job?.remove());
  return res.status(204).send();
});

app.get('/api/dashboard/stats', async (_req, res) => {
  const [scheduled, processing, sent, failed, cancelled] = await Promise.all([
    prisma.email.count({ where: { status: 'SCHEDULED' } }),
    prisma.email.count({ where: { status: 'PROCESSING' } }),
    prisma.email.count({ where: { status: 'SENT' } }),
    prisma.email.count({ where: { status: 'FAILED' } }),
    prisma.email.count({ where: { status: 'CANCELLED' } }),
  ]);
  res.json({ scheduled, processing, sent, failed, cancelled });
});

const server = app.listen(port, () => logger.info({ port }, 'API listening'));

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down API');
  server.close();
  await queue.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
