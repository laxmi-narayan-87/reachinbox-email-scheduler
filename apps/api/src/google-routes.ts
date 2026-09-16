import { Router } from 'express';
import { googleCallback, startGoogleAuth } from './oauth.js';

export const googleRouter = Router();
googleRouter.get('/google', startGoogleAuth);
googleRouter.get('/google/callback', (req, res) => { void googleCallback(req, res); });
