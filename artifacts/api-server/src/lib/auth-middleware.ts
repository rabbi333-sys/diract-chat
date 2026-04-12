import { createHmac } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger.js";

// Extend Express Request to carry the verified userId from the JWT
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string;
    }
  }
}

// ─── HS256 JWT Verification ───────────────────────────────────────────────────
// Supabase signs user JWTs with HS256 using the project JWT secret.
// We verify the signature locally using Node's built-in crypto — no extra deps.

function base64urlDecodeStr(str: string): string {
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, "=");
  return Buffer.from(padded, "base64").toString("utf8");
}

interface JwtPayload {
  sub?: string;
  exp?: number;
  [key: string]: unknown;
}

function verifyHS256JWT(token: string, secret: string): JwtPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sigB64] = parts;

  // Recompute the expected HS256 signature
  const expectedSig = createHmac("sha256", secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest("base64url");

  // Constant-time comparison to prevent timing attacks
  if (expectedSig.length !== sigB64.length) return null;
  let diff = 0;
  for (let i = 0; i < expectedSig.length; i++) {
    diff |= expectedSig.charCodeAt(i) ^ sigB64.charCodeAt(i);
  }
  if (diff !== 0) return null;

  // Decode and parse the payload
  let payload: JwtPayload;
  try {
    payload = JSON.parse(base64urlDecodeStr(payloadB64)) as JwtPayload;
  } catch {
    return null;
  }

  // Reject expired tokens
  if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
// If SUPABASE_JWT_SECRET is not configured, auth is disabled (dev-mode bypass)
// with a one-time warning. Set this env var in all production deployments.

let _bypassWarningLogged = false;

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.SUPABASE_JWT_SECRET;

  if (!secret) {
    if (!_bypassWarningLogged) {
      logger.warn(
        "SUPABASE_JWT_SECRET is not configured — API authentication is DISABLED. " +
        "Set SUPABASE_JWT_SECRET in production to enforce authentication."
      );
      _bypassWarningLogged = true;
    }
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.slice(7).trim();
  const payload = verifyHS256JWT(token, secret);
  if (!payload) {
    res.status(401).json({ error: "Invalid or expired token" });
    return;
  }

  if (!payload.sub) {
    res.status(401).json({ error: "Token missing subject claim" });
    return;
  }

  req.userId = payload.sub;
  next();
}
