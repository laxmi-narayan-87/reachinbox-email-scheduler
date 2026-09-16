import 'dotenv/config';
import pino from 'pino';
import { Worker } from 'bullmq';
import { prisma } from '@reachinbox/database';
import { EMAIL_QUEUE_NAME, EmailJobData, createRedisConnection, createEmailQueue, getEmailJobId } from '@reachinbox/queue';
import IORedis from 'ioredis';
import { createProvider } from './provider.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const redis = createRedisConnection();
const queue = createEmailQueue();

class RateLimitExceeded extends Error {
  constructor(public readonly retryAt: Date) { super('sender hourly rate limit exceeded'); this.name = 'RateLimitExceeded'; }
}

function hourKey(senderId: string, date = new Date()): string {
  const year = date.getUTCFullYear(); const month = String(date.getUTCMonth() + 1).padStart(2, '0'); const day = String(date.getUTCDate()).padStart(2, '0'); const hour = String(date.getUTCHours()).padStart(2, '0');
  return `email-rate:${senderId}:${year}${month}${day}${hour}`;
}
function nextUtcHour(date = new Date()): Date { const next = new Date(date); next.setUTCMinutes(0, 0, 0); next.setUTCHours(next.getUTCHours() + 1); return next; }
async function acquireRateSlot(senderId: string, hourlyLimit: number): Promise<void> { const key = hourKey(senderId); const count = await redis.incr(key); if (count === 1) await redis.expire(key, 3700); if (count <= hourlyLimit) return; await redis.decr(key); throw new RateLimitExceeded(nextUtcHour()); }
async function releaseRateSlot(senderId: string): Promise<void> { const key = hourKey(senderId); const value = await redis.decr(key); if (value < 0) await redis.set(key, '0', 'EX', 3700); }
function isTransientProviderError(error: unknown): boolean { const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase(); return /timeout|temporar|econn|429|rate|5\d\d/.test(message); }

async function publishOutbox(): Promise<number> {
  const events = await prisma.outboxEvent.findMany({ where: { status: { in: ['PENDING', 'FAILED'] } }, orderBy: { createdAt: 'asc' }, take: 100 });
  let published = 0;
  for (const event of events) {
    try {
      const payload = event.payload as { emailId?: string };
      if (event.eventType !== 'EMAIL_SCHEDULED' || !payload.emailId) { await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'FAILED', attempts: { increment: 1 }, lastError: 'unsupported outbox event' } }); continue; }
      const email = await prisma.email.findUnique({ where: { id: payload.emailId } });
      if (!email || email.status === 'CANCELLED') { await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'PUBLISHED', processedAt: new Date() } }); continue; }
      await queue.add('send-email', { emailId: email.id, attempt: email.attemptCount }, { delay: Math.max(0, email.scheduledAt.getTime() - Date.now()), jobId: getEmailJobId(email.id), removeOnComplete: { count: 1000 }, removeOnFail: { count: 5000 }, attempts: Number(process.env.EMAIL_MAX_ATTEMPTS ?? 5), backoff: { type: 'exponential', delay: 1000 } });
      await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'PUBLISHED', processedAt: new Date(), lastError: null } });
      published += 1;
    } catch (error) {
      await prisma.outboxEvent.update({ where: { id: event.id }, data: { status: 'FAILED', attempts: { increment: 1 }, lastError: error instanceof Error ? error.message : String(error) } });
    }
  }
  return published;
}

async function processEmail(jobData: EmailJobData, jobId?: string): Promise<void> {
  const email = await prisma.email.findUnique({ where: { id: jobData.emailId }, include: { sender: true } });
  if (!email) throw new Error('email record not found');
  if (email.status !== 'SCHEDULED') return;
  const claim = await prisma.email.updateMany({ where: { id: email.id, status: 'SCHEDULED' }, data: { status: 'PROCESSING', processingAt: new Date(), attemptCount: { increment: 1 } } });
  if (claim.count !== 1) return;

  let rateSlotAcquired = false;
  try {
    await acquireRateSlot(email.senderId, email.sender.hourlyLimit); rateSlotAcquired = true;
    const provider = createProvider(email.sender.provider, email.sender.providerConfig);
    const result = await provider.send({ from: email.sender.email, to: email.recipientEmail, subject: email.subject, text: email.body });
    await prisma.email.update({ where: { id: email.id }, data: { status: 'SENT', sentAt: new Date(), providerMessageId: result.messageId, lastError: null } });
    if (email.batchId) { await prisma.batch.update({ where: { id: email.batchId }, data: { processedEmails: { increment: 1 }, sentEmails: { increment: 1 } } }); await finalizeBatchIfReady(email.batchId); }
    logger.info({ emailId: email.id, jobId, provider: result.provider }, 'email sent');
  } catch (error) {
    if (error instanceof RateLimitExceeded) {
      await prisma.email.update({ where: { id: email.id }, data: { status: 'SCHEDULED', processingAt: null } });
      await queue.add('send-email', { emailId: email.id, attempt: jobData.attempt + 1 }, { delay: Math.max(0, error.retryAt.getTime() - Date.now()), jobId: getEmailJobId(email.id), attempts: 1 });
      return;
    }
    if (rateSlotAcquired && isTransientProviderError(error)) await releaseRateSlot(email.senderId);
    const transient = isTransientProviderError(error);
    const message = error instanceof Error ? error.message : String(error);
    if (transient) { await prisma.email.update({ where: { id: email.id }, data: { status: 'SCHEDULED', processingAt: null, lastError: message } }); throw error; }
    await prisma.email.update({ where: { id: email.id }, data: { status: 'FAILED', failedAt: new Date(), lastError: message } });
    if (email.batchId) { await prisma.batch.update({ where: { id: email.batchId }, data: { processedEmails: { increment: 1 }, failedEmails: { increment: 1 } } }); await finalizeBatchIfReady(email.batchId); }
    logger.error({ err: error, emailId: email.id }, 'email permanently failed');
  }
}
async function finalizeBatchIfReady(batchId: string): Promise<void> { const batch = await prisma.batch.findUnique({ where: { id: batchId } }); if (!batch || batch.processedEmails < batch.totalEmails) return; await prisma.batch.update({ where: { id: batchId }, data: { status: batch.failedEmails > 0 ? 'PARTIAL_FAILURE' : 'COMPLETED' } }); }

const worker = new Worker<EmailJobData>(EMAIL_QUEUE_NAME, async (job) => processEmail(job.data, job.id), { connection: redis as IORedis, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 5) });
worker.on('completed', (job) => logger.info({ jobId: job.id }, 'job completed'));
worker.on('failed', (job, error) => logger.error({ err: error, jobId: job?.id }, 'job failed'));
worker.on('error', (error) => logger.error({ err: error }, 'worker error'));
const publisherTimer = setInterval(() => { void publishOutbox(); }, 1000);
void publishOutbox();
async function shutdown(signal: string): Promise<void> { logger.info({ signal }, 'shutting down worker'); clearInterval(publisherTimer); await worker.close(); await queue.close(); await redis.quit(); await prisma.$disconnect(); process.exit(0); }
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
