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
// Verifies the Supabase JWT from the Authorization header.
// FAIL-CLOSED: if SUPABASE_JWT_SECRET is not configured the server returns 503
// rather than bypassing authentication. This prevents accidental open access in
// misconfigured deployments. Set SUPABASE_JWT_SECRET to the JWT Secret found in
// your Supabase project settings → API → JWT Settings.

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const secret = process.env.SUPABASE_JWT_SECRET;

  if (!secret) {
    logger.error(
      "SUPABASE_JWT_SECRET is not configured. Set this env var to enable API authentication."
    );
    res.status(503).json({
      error: "Server misconfiguration: SUPABASE_JWT_SECRET is not set. Contact the administrator.",
    });
    return;
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
