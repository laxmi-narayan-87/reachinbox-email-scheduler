import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { prisma } from '@reachinbox/database';

export const SESSION_COOKIE = 'reachinbox_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string, res: Response): Promise<void> {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await prisma.session.upsert({
    where: { tokenHash },
    update: { userId, expiresAt },
    create: { userId, tokenHash, expiresAt },
  });
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/',
  });
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === 'string') {
    await prisma.session.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) {
    res.status(401).json({ error: 'authentication required' });
    return;
  }
  const session = await prisma.session.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: true },
  });
  if (!session || session.expiresAt.getTime() <= Date.now()) {
    res.status(401).json({ error: 'session expired' });
    return;
  }
  req.user = session.user;
  next();
}

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; name: string | null };
    }
  }
}
