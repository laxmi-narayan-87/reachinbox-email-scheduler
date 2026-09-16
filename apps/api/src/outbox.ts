import { prisma } from '@reachinbox/database';
import { createEmailQueue, getEmailJobId } from '@reachinbox/queue';

const queue = createEmailQueue();

export async function publishPendingOutbox(limit = 100): Promise<number> {
  const events = await prisma.outboxEvent.findMany({
    where: { status: { in: ['PENDING', 'FAILED'] } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });

  let published = 0;
  for (const event of events) {
    try {
      const payload = event.payload as { emailId?: string };
      if (event.eventType !== 'EMAIL_SCHEDULED' || !payload.emailId) {
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: { status: 'FAILED', attempts: { increment: 1 }, lastError: 'unsupported outbox event' },
        });
        continue;
      }

      const email = await prisma.email.findUnique({ where: { id: payload.emailId } });
      if (!email || email.status === 'CANCELLED') {
        await prisma.outboxEvent.update({
          where: { id: event.id },
          data: { status: 'PUBLISHED', processedAt: new Date() },
        });
        continue;
      }

      await queue.add(
        'send-email',
        { emailId: email.id, attempt: email.attemptCount },
        {
          delay: Math.max(0, email.scheduledAt.getTime() - Date.now()),
          jobId: getEmailJobId(email.id),
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 5000 },
        },
      );

      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'PUBLISHED', processedAt: new Date(), lastError: null },
      });
      published += 1;
    } catch (error) {
      await prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          status: 'FAILED',
          attempts: { increment: 1 },
          lastError: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }
  return published;
}
