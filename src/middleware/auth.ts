import type { Request, Response, NextFunction } from 'express';
import { eq, sql } from 'drizzle-orm';
import { adminAuth } from '../lib/firebase-admin.ts';
import { verifySessionToken } from '../server/crypto.ts';
import { db } from '../db/index.ts';
import { users } from '../db/schema.ts';
import {
  getEffectivePermissions,
  hasAnyPermission,
  hasPermission,
  isStaffRole,
  normalizeEmail,
  type AdminPermissionKey,
  type AppUserRole,
} from '../server/rbacEngine.ts';
import { getRuntimeVaultValue } from '../server/runtimeSecretStore.ts';

export type UserRole = AppUserRole;

export interface AuthUser {
  id: number;
  uid: string;
  email: string | null;
  displayName: string;
  role: UserRole;
  permissions: AdminPermissionKey[];
  tokenVersion: number;
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

function toAuthUser(dbRow: typeof users.$inferSelect): AuthUser {
  const role = (dbRow.role || 'customer') as UserRole;
  return {
    id: dbRow.id,
    uid: dbRow.uid,
    email: dbRow.email,
    displayName: dbRow.displayName,
    role,
    permissions: getEffectivePermissions(role, dbRow.permissionsJson),
    tokenVersion: dbRow.tokenVersion ?? 1,
    telegramUserId: dbRow.telegramUserId,
  };
}

async function upsertFirebaseUser(
  uid: string,
  rawEmail: string | undefined,
  emailVerified: boolean,
  name?: string
): Promise<AuthUser> {
  const ownerEmail = normalizeEmail(getRuntimeVaultValue('ownerEmail') || process.env.OWNER_EMAIL);
  const email = normalizeEmail(rawEmail);
  const hasRealEmail = Boolean(email && !email.endsWith('@firebase.local'));
  const isConfiguredOwner = Boolean(ownerEmail && hasRealEmail && emailVerified && email === ownerEmail);

  // 1. Direct match by Firebase UID
  const existingByUid = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
  if (existingByUid.length > 0) {
    let row = existingByUid[0];
    if (isConfiguredOwner && row.role !== 'owner') {
      const [promoted] = await db
        .update(users)
        .set({ role: 'owner', updatedAt: new Date() })
        .where(eq(users.id, row.id))
        .returning();
      if (promoted) row = promoted;
    }
    return toAuthUser(row);
  }

  // 2. Pre-invited moderator or pre-configured owner matching VERIFIED email
  if (hasRealEmail && emailVerified) {
    const emailMatches = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`);

    // Prefer binding an invited/local staff account first
    const candidate =
      emailMatches.find((u) => isStaffRole(u.role) && (u.uid.startsWith('invited:') || u.uid.startsWith('local:'))) ||
      emailMatches.find((u) => u.uid.startsWith('invited:')) ||
      null;

    if (candidate) {
      const nextRole: UserRole = isConfiguredOwner ? 'owner' : (candidate.role as UserRole);
      const [bound] = await db
        .update(users)
        .set({
          uid,
          email,
          role: nextRole,
          displayName: candidate.displayName || name || email.split('@')[0] || 'مستخدم',
          lastLoginAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(users.id, candidate.id))
        .returning();
      if (bound) {
        return toAuthUser(bound);
      }
    }
  }

  // 3. Brand new Firebase user:
  // ONLY explicit verified OWNER_EMAIL becomes 'owner'; everyone else defaults strictly to 'customer'.
  // Never auto-promote an arbitrary first Firebase user to 'owner'!
  const assignedRole: UserRole = isConfiguredOwner ? 'owner' : 'customer';

  const [inserted] = await db
    .insert(users)
    .values({
      uid,
      email: hasRealEmail ? email : `${uid}@firebase.local`,
      displayName: name || (hasRealEmail ? email.split('@')[0] : '') || 'مستخدم',
      role: assignedRole,
      permissionsJson: [],
      lastLoginAt: new Date(),
    })
    .onConflictDoUpdate({
      target: users.uid,
      set: {
        email: hasRealEmail ? email : `${uid}@firebase.local`,
        lastLoginAt: new Date(),
        updatedAt: new Date(),
      },
    })
    .returning();

  return toAuthUser(inserted);
}

export const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'يجب تسجيل الدخول للوصول إلى هذا المورد.' });
  }

  const token = authHeader.slice('Bearer '.length).trim();

  // 1. Check signed server session token first (fast HMAC verify + DB tokenVersion check)
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
      if ((payload.tv ?? 1) !== (dbUser.tokenVersion ?? 1)) {
        return res.status(401).json({ error: 'تم إنهاء الجلسة بعد تحديث الصلاحيات أو كلمة المرور. يرجى إعادة تسجيل الدخول.' });
      }
      req.user = toAuthUser(dbUser);
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
      decoded.email,
      Boolean(decoded.email_verified),
      decoded.name
    );
    const [freshRow] = await db
      .select({ isBlocked: users.isBlocked })
      .from(users)
      .where(eq(users.id, dbUser.id))
      .limit(1);
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
      if (dbUser && !dbUser.isBlocked && (payload.tv ?? 1) === (dbUser.tokenVersion ?? 1)) {
        req.user = toAuthUser(dbUser);
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
      decoded.email,
      Boolean(decoded.email_verified),
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

export const requirePermission = (permission: AdminPermissionKey) => {
  return [
    requireAuth,
    (req: AuthRequest, res: Response, next: NextFunction) => {
      if (!req.user) {
        return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً.' });
      }
      if (!isStaffRole(req.user.role) || !hasPermission(req.user, permission)) {
        return res.status(403).json({
          error: 'ليس لديك الصلاحية اللازمة لتنفيذ هذا الإجراء.',
        });
      }
      return next();
    },
  ];
};

export const requireAnyPermission = (permissionsList: readonly AdminPermissionKey[]) => {
  return [
    requireAuth,
    (req: AuthRequest, res: Response, next: NextFunction) => {
      if (!req.user) {
        return res.status(401).json({ error: 'يجب تسجيل الدخول أولاً.' });
      }
      if (!isStaffRole(req.user.role) || !hasAnyPermission(req.user, permissionsList)) {
        return res.status(403).json({
          error: 'ليس لديك الصلاحية اللازمة للوصول إلى هذا القسم.',
        });
      }
      return next();
    },
  ];
};

export const requireOwner = [requireAuth, requireRoles(['owner'])];
export const requireStaff = [requireAuth, requireRoles(['owner', 'admin', 'support'])];
export const requireAdmin = requireStaff;
export const requireOwnerOrAdmin = [requireAuth, requireRoles(['owner', 'admin'])];
