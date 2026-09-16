import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { prisma } from '@reachinbox/database';
import { createSession } from './auth.js';
import { encryptSecret } from './crypto.js';

const STATE_COOKIE = 'reachinbox_oauth_state';
const stateTtlMs = 10 * 60 * 1000;

function googleConfig() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_CALLBACK_URL) {
    throw new Error('Google OAuth environment variables are not configured');
  }
  return { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_CALLBACK_URL };
}

export function startGoogleAuth(_req: Request, res: Response): void {
  const { GOOGLE_CLIENT_ID, GOOGLE_CALLBACK_URL } = googleConfig();
  const state = crypto.randomBytes(24).toString('base64url');
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', GOOGLE_CALLBACK_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile https://www.googleapis.com/auth/gmail.send');
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: stateTtlMs,
    path: '/',
  });
  res.redirect(authUrl.toString());
}

export async function googleCallback(req: Request, res: Response): Promise<void> {
  const config = googleConfig();
  const code = typeof req.query.code === 'string' ? req.query.code : '';
  const state = typeof req.query.state === 'string' ? req.query.state : '';
  const expectedState = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: '/' });
  if (!code || !state || !expectedState || state !== expectedState) {
    res.status(400).send('Invalid OAuth state or code');
    return;
  }

  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      redirect_uri: config.GOOGLE_CALLBACK_URL,
      grant_type: 'authorization_code',
    }),
  });
  if (!tokenResponse.ok) {
    res.status(502).send('Google token exchange failed');
    return;
  }
  const tokens = await tokenResponse.json() as { access_token: string; refresh_token?: string; expires_in: number };
  const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  if (!profileResponse.ok) {
    res.status(502).send('Google profile lookup failed');
    return;
  }
  const profile = await profileResponse.json() as { sub: string; email: string; name?: string };
  if (!profile.email || !profile.sub) {
    res.status(502).send('Google did not provide an email identity');
    return;
  }

  const user = await prisma.user.upsert({
    where: { email: profile.email.toLowerCase() },
    update: { name: profile.name ?? null, googleId: profile.sub },
    create: { email: profile.email.toLowerCase(), name: profile.name ?? null, googleId: profile.sub },
  });

  if (tokens.refresh_token) {
    const existing = await prisma.sender.findUnique({ where: { userId_email: { userId: user.id, email: user.email } } });
    const providerConfig = {
      ...(existing?.providerConfig && typeof existing.providerConfig === 'object' ? existing.providerConfig : {}),
      refreshToken: encryptSecret(tokens.refresh_token),
      accessToken: encryptSecret(tokens.access_token),
      accessTokenExpiresAt: Date.now() + tokens.expires_in * 1000,
    };
    await prisma.sender.upsert({
      where: { userId_email: { userId: user.id, email: user.email } },
      update: { provider: 'GMAIL', providerConfig },
      create: { userId: user.id, email: user.email, provider: 'GMAIL', providerConfig },
    });
  }

  await createSession(user.id, res);
  res.redirect(process.env.WEB_ORIGIN ?? 'http://localhost:3000');
}
