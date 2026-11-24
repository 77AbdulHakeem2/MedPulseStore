import { Request, Response, NextFunction } from 'express';
import { eq } from 'drizzle-orm';
import { adminAuth } from '../lib/firebase-admin.ts';
import { verifySessionToken } from '../server/crypto.ts';
import { db } from '../db/index.ts';
import { users } from '../db/schema.ts';

export type UserRole = 'owner' | 'admin' | 'support' | 'customer';

export interface AuthUser {
  id: number;
  uid: string;
  email: string | null;
  displayName: string;
  role: UserRole;
  telegramUserId?: string | null;
}

export interface AuthRequest extends Request {
  user?: AuthUser;
}

/**
 * Pure RBAC check (unit-testable!)
 */
export function hasRoleAccess(userRole: string | undefined, allowedRoles: UserRole[]): boolean {
  if (!userRole) return false;
  return allowedRoles.includes(userRole as UserRole);
}

async function upsertFirebaseUser(uid: string, email: string, name?: string): Promise<AuthUser> {
  const ownerEmail = (process.env.OWNER_EMAIL || '').trim().toLowerCase();
  const isConfiguredOwner = ownerEmail && email.toLowerCase() === ownerEmail;

  const existing = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
  if (existing.length > 0) {
    const u = existing[0];
    return {
      id: u.id,
      uid: u.uid,
      email: u.email,
      displayName: u.displayName,
      role: u.role as UserRole,
      telegramUserId: u.telegramUserId,
    };
  }

  // First Firebase user signing in to a fresh workspace becomes owner if no non-demo owner exists,
  // or if email matches OWNER_EMAIL; otherwise customer by default.
  const existingOwners = await db.select().from(users).where(eq(users.role, 'owner')).limit(2);
  const hasRealFirebaseOwner = existingOwners.some((o) => !o.uid.startsWith('local:'));
  const assignedRole: UserRole = isConfiguredOwner || !hasRealFirebaseOwner ? 'owner' : 'customer';

  const [inserted] = await db
    .insert(users)
    .values({
      uid,
      email,
      displayName: name || email.split('@')[0] || 'مستخدم',
      role: assignedRole,
    })
    .onConflictDoUpdate({
      target: users.uid,
      set: { email, updatedAt: new Date() },
    })
    .returning();

  return {
    id: inserted.id,
    uid: inserted.uid,
    email: inserted.email,
    displayName: inserted.displayName,
    role: inserted.role as UserRole,
    telegramUserId: inserted.telegramUserId,
  };
}

export const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول للوصول إلى هذا المورد.' });
  }

  const token = authHeader.slice('Bearer '.length).trim();

  // 1. Check signed session token first (fast HMAC verify)
  if (token.startsWith('raqm.')) {
    const payload = verifySessionToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'جلسة الدخول غير صالحة أو منتهية.' });
    }
    try {
      const [dbUser] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1);
      if (!dbUser || dbUser.isBlocked) {
        return res.status(403).json({ error: 'الحساب غير متاح أو محظور.' });
      }
      req.user = {
        id: dbUser.id,
        uid: dbUser.uid,
        email: dbUser.email,
        displayName: dbUser.displayName,
        role: dbUser.role as UserRole,
        telegramUserId: dbUser.telegramUserId,
      };
      return next();
    } catch (err) {
      console.error('Session lookup failed:', err);
      return res.status(500).json({ error: 'تعذر التحقق من الجلسة حاليًا.' });
    }
  }

  // 2. Otherwise verify real Firebase Auth ID token
  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const dbUser = await upsertFirebaseUser(
      decoded.uid,
      decoded.email || `${decoded.uid}@firebase.local`,
      decoded.name
    );
    const [freshRow] = await db.select({ isBlocked: users.isBlocked }).from(users).where(eq(users.id, dbUser.id)).limit(1);
    if (freshRow?.isBlocked) {
      return res.status(403).json({ error: 'الحساب محظور حاليًا. يرجى التواصل مع الإدارة.' });
    }
    req.user = dbUser;
    return next();
  } catch (err) {
    console.error('Firebase token verify failed:', err);
    return res.status(401).json({ error: 'رمز المصادقة غير صالح.' });
  }
};

export const optionalAuth = async (req: AuthRequest, _res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (token.startsWith('raqm.')) {
    const payload = verifySessionToken(token);
    if (!payload) return next();
    try {
      const [dbUser] = await db.select().from(users).where(eq(users.id, payload.userId)).limit(1);
      if (dbUser && !dbUser.isBlocked) {
        req.user = {
          id: dbUser.id,
          uid: dbUser.uid,
          email: dbUser.email,
          displayName: dbUser.displayName,
          role: dbUser.role as UserRole,
          telegramUserId: dbUser.telegramUserId,
        };
      }
    } catch {
      // Ignore optional auth lookup error and fall back to public view
    }
    return next();
  }

  try {
    const decoded = await adminAuth.verifyIdToken(token);
    const dbUser = await upsertFirebaseUser(
      decoded.uid,
      decoded.email || `${decoded.uid}@firebase.local`,
      decoded.name
    );
    const [freshRow] = await db
      .select({ isBlocked: users.isBlocked })
      .from(users)
      .where(eq(users.id, dbUser.id))
      .limit(1);
    if (!freshRow?.isBlocked) {
      req.user = dbUser;
    }
  } catch {
    // Ignore invalid optional token and continue as guest
  }
  return next();
};

export const requireRoles = (allowedRoles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً.' });
    }
    if (!hasRoleAccess(req.user.role, allowedRoles)) {
      return res.status(403).json({
        error: 'غير مصرح لك بالوصول إلى لوحة الإدارة أو بيانات المزودين.',
      });
    }
    return next();
  };
};

export const requireAdmin = [requireAuth, requireRoles(['owner', 'admin', 'support'])];
export const requireOwnerOrAdmin = [requireAuth, requireRoles(['owner', 'admin'])];
