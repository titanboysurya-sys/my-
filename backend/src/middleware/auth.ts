import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { getSupabaseAdmin } from '../db/supabase.js';
import { sanitizeErrorMessage } from '../config/env.js';

export interface AuthenticatedUser {
  id: string;
  email?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: AuthenticatedUser;
}

/**
 * Verifies the caller's Supabase Auth Bearer JWT on every protected API endpoint.
 */
export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' });
      return;
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token || token.length < 20) {
      res.status(401).json({ error: 'Malformed bearer token' });
      return;
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      res.status(401).json({ error: 'Invalid or expired authentication session' });
      return;
    }

    req.user = {
      id: data.user.id,
      email: data.user.email,
    };
    next();
  } catch (err) {
    res.status(500).json({ error: sanitizeErrorMessage(err) });
  }
}

/**
 * General API rate limiter to prevent abuse.
 */
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});

/**
 * Tighter rate limiter for credential validation and job creation endpoints.
 */
export const sensitiveRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded for sensitive operation. Please retry shortly.' },
});

export function getAuthUserId(req: AuthenticatedRequest): string {
  if (!req.user?.id) {
    throw new Error('Unauthorized request context');
  }
  return req.user.id;
}
