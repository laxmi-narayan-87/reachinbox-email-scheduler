import { Queue } from 'bullmq';
import IORedis from 'ioredis';

export const EMAIL_QUEUE_NAME = 'email-send';

export interface EmailJobData {
  emailId: string;
  attempt: number;
}

function getRedisUrl(): string {
  const value = process.env.REDIS_URL;
  if (!value) {
    throw new Error('REDIS_URL is required');
  }
  return value;
}

export function createRedisConnection(): IORedis {
  return new IORedis(getRedisUrl(), {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export function createEmailQueue(): Queue<EmailJobData> {
  return new Queue<EmailJobData>(EMAIL_QUEUE_NAME, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: 'exponential',
        delay: 1000,
      },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 604_800, count: 10_000 },
    },
  });
}

export function getEmailJobId(emailId: string): string {
  return `email:${emailId}`;
}
