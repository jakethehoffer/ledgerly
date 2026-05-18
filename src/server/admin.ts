import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * Express middleware that gates admin endpoints behind a bearer token.
 *
 * The comparison is constant-time (Node's {@link timingSafeEqual}) to avoid
 * leaking token length or contents through response-time analysis. Both
 * mismatched length and mismatched contents respond with HTTP 401, but in
 * separate code paths so we never hand `timingSafeEqual` buffers of unequal
 * length (which throws synchronously).
 *
 * Routes mounted with this middleware should only be wired when the operator
 * has supplied `LEDGERLY_ADMIN_TOKEN`. If the token env var is unset, the
 * admin routes should not be mounted at all — Express's default 404 handler
 * then makes the existence of the admin surface invisible to unauthenticated
 * scanners.
 */
export function adminAuthMiddleware(
  adminToken: string,
): (req: Request, res: Response, next: NextFunction) => void {
  const expected = Buffer.from(adminToken, 'utf8');
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    if (!match) {
      res.status(401).json({ error: 'missing bearer token' });
      return;
    }
    const provided = Buffer.from(match[1] ?? '', 'utf8');
    if (provided.length !== expected.length) {
      res.status(401).json({ error: 'invalid bearer token' });
      return;
    }
    if (!timingSafeEqual(provided, expected)) {
      res.status(401).json({ error: 'invalid bearer token' });
      return;
    }
    next();
  };
}
