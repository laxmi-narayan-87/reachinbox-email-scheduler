import 'dotenv/config';
import pino from 'pino';
import nodemailer from 'nodemailer';
import { Worker, UnrecoverableError } from 'bullmq';
import { prisma } from '@reachinbox/database';
import { EMAIL_QUEUE_NAME, EmailJobData, createRedisConnection, createEmailQueue, getEmailJobId } from '@reachinbox/queue';
import IORedis from 'ioredis';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const redis = createRedisConnection();
const queue = createEmailQueue();

class RateLimitExceeded extends Error {
  constructor(public readonly retryAt: Date) {
    super('sender hourly rate limit exceeded');
    this.name = 'RateLimitExceeded';
  }
}

function hourKey(senderId: string, date = new Date()): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  return `email-rate:${senderId}:${year}${month}${day}${hour}`;
}

function nextUtcHour(date = new Date()): Date {
  const next = new Date(date);
  next.setUTCMinutes(0, 0, 0);
  next.setUTCHours(next.getUTCHours() + 1);
  return next;
}

async function acquireRateSlot(senderId: string, hourlyLimit: number): Promise<void> {
  const key = hourKey(senderId);
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 3700);
  }
  if (count <= hourlyLimit) return;
  await redis.decr(key);
  throw new RateLimitExceeded(nextUtcHour());
}

async function releaseRateSlot(senderId: string): Promise<void> {
  const key = hourKey(senderId);
  const value = await redis.decr(key);
  if (value < 0) await redis.set(key, '0', 'EX', 3700);
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST ?? 'smtp.ethereal.email',
  port: Number(process.env.SMTP_PORT ?? 587),
  secure: String(process.env.SMTP_SECURE ?? 'false') === 'true',
  auth: process.env.SMTP_USER && process.env.SMTP_PASSWORD
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
    : undefined,
});

function isTransientProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('timeout') || message.includes('temporar') || message.includes('econn') || message.includes('429') || message.includes('rate');
}

async function processEmail(jobData: EmailJobData, jobId?: string): Promise<void> {
  const email = await prisma.email.findUnique({
    where: { id: jobData.emailId },
    include: { sender: true },
  });

  if (!email) throw new UnrecoverableError('email record not found');
  if (email.status !== 'SCHEDULED') return;

  const claim = await prisma.email.updateMany({
    where: { id: email.id, status: 'SCHEDULED' },
    data: {
      status: 'PROCESSING',
      processingAt: new Date(),
      attemptCount: { increment: 1 },
    },
  });

  if (claim.count !== 1) return;

  let rateSlotAcquired = false;
  try {
    await acquireRateSlot(email.senderId, email.sender.hourlyLimit);
    rateSlotAcquired = true;

    const info = await transporter.sendMail({
      from: email.sender.email,
      to: email.recipientEmail,
      subject: email.subject,
      text: email.body,
    });

    await prisma.email.update({
      where: { id: email.id },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        providerMessageId: info.messageId,
        lastError: null,
      },
    });

    if (email.batchId) {
      await prisma.batch.update({
        where: { id: email.batchId },
        data: { processedEmails: { increment: 1 }, sentEmails: { increment: 1 } },
      });
    }

    logger.info({ emailId: email.id, jobId }, 'email sent');
  } catch (error) {
    if (error instanceof RateLimitExceeded) {
      await prisma.email.update({ where: { id: email.id }, data: { status: 'SCHEDULED', processingAt: null } });
      await queue.add(
        'send-email',
        { emailId: email.id, attempt: jobData.attempt + 1 },
        { delay: Math.max(0, error.retryAt.getTime() - Date.now()), jobId: getEmailJobId(email.id) },
      );
      logger.warn({ emailId: email.id, retryAt: error.retryAt }, 'email rescheduled by rate limit');
      return;
    }

    if (rateSlotAcquired && isTransientProviderError(error)) {
      await releaseRateSlot(email.senderId);
    }

    const transient = isTransientProviderError(error);
    if (transient) {
      await prisma.email.update({
        where: { id: email.id },
        data: { status: 'SCHEDULED', processingAt: null, lastError: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }

    await prisma.email.update({
      where: { id: email.id },
      data: { status: 'FAILED', failedAt: new Date(), lastError: error instanceof Error ? error.message : String(error) },
    });

    if (email.batchId) {
      await prisma.batch.update({
        where: { id: email.batchId },
        data: { processedEmails: { increment: 1 }, failedEmails: { increment: 1 } },
      });
    }

    logger.error({ err: error, emailId: email.id }, 'email permanently failed');
  }
}

const worker = new Worker<EmailJobData>(
  EMAIL_QUEUE_NAME,
  async (job) => processEmail(job.data, job.id),
  {
    connection: redis as IORedis,
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5),
    limiter: undefined,
  },
);

worker.on('completed', (job) => logger.info({ jobId: job.id }, 'job completed'));
worker.on('failed', (job, error) => logger.error({ err: error, jobId: job?.id }, 'job failed'));
worker.on('error', (error) => logger.error({ err: error }, 'worker error'));

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down worker');
  await worker.close();
  await queue.close();
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
