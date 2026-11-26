import crypto from 'node:crypto';

export type StaffRole = 'owner' | 'admin' | 'support';
export type AppUserRole = StaffRole | 'customer';

export const ADMIN_PERMISSION_DEFS = [
  {
    key: 'overview:view',
    labelAr: 'الرئيسية والإحصائيات',
    labelEn: 'Overview & Analytics',
    groupAr: 'المراقبة',
    ownerOnly: false,
  },
  {
    key: 'products:manage',
    labelAr: 'إدارة المنتجات والأقسام والاستيراد',
    labelEn: 'Products, Categories & Imports',
    groupAr: 'الكتالوج',
    ownerOnly: false,
  },
  {
    key: 'pricing:manage',
    labelAr: 'الأسعار وهوامش الربح والكوبونات',
    labelEn: 'Pricing, Margins & Coupons',
    groupAr: 'الكتالوج',
    ownerOnly: false,
  },
  {
    key: 'providers:manage',
    labelAr: 'إدارة الخوادم ومفاتيح API والمزامنة',
    labelEn: 'Providers, API Keys & Sync',
    groupAr: 'البنية والمزودون',
    ownerOnly: false,
  },
  {
    key: 'orders:manage',
    labelAr: 'إدارة الطلبات والاسترداد',
    labelEn: 'Orders & Refunds',
    groupAr: 'المالية والعمليات',
    ownerOnly: false,
  },
  {
    key: 'deposits:approve',
    labelAr: 'اعتماد الإيداعات وبوابات الدفع',
    labelEn: 'Deposits Approval & Gateways',
    groupAr: 'المالية والعمليات',
    ownerOnly: false,
  },
  {
    key: 'customers:manage',
    labelAr: 'إدارة العملاء والمحافظ والحظر',
    labelEn: 'Customers, Wallets & Blocking',
    groupAr: 'المالية والعمليات',
    ownerOnly: false,
  },
  {
    key: 'telegram:manage',
    labelAr: 'إدارة بوت تيليجرام والأزرار والبث',
    labelEn: 'Telegram Bot, Menus & Broadcasts',
    groupAr: 'القنوات',
    ownerOnly: false,
  },
  {
    key: 'referrals:manage',
    labelAr: 'إدارة الإحالات والعمولات',
    labelEn: 'Referrals & Commissions',
    groupAr: 'النمو',
    ownerOnly: false,
  },
  {
    key: 'settings:manage',
    labelAr: 'إعدادات المتجر واللغات وأسعار الصرف',
    labelEn: 'Store Settings, Languages & FX',
    groupAr: 'النظام',
    ownerOnly: false,
  },
  {
    key: 'audit:view',
    labelAr: 'التنبيهات وسجل التدقيق وفحص الأمان',
    labelEn: 'Alerts, Audit Logs & Security Audit',
    groupAr: 'النظام',
    ownerOnly: false,
  },
  {
    key: 'moderators:manage',
    labelAr: 'إدارة المشرفين وتعيين الصلاحيات (للمالك فقط)',
    labelEn: 'Moderators & Permissions (Owner Only)',
    groupAr: 'الحوكمة',
    ownerOnly: true,
  },
] as const;

export type AdminPermissionKey = (typeof ADMIN_PERMISSION_DEFS)[number]['key'];

export const ALL_ADMIN_PERMISSIONS: AdminPermissionKey[] = ADMIN_PERMISSION_DEFS.map(
  (d) => d.key
);

export const ASSIGNABLE_MODERATOR_PERMISSIONS: AdminPermissionKey[] =
  ADMIN_PERMISSION_DEFS.filter((d) => !d.ownerOnly).map((d) => d.key);

const VALID_PERMISSION_SET = new Set<string>(ALL_ADMIN_PERMISSIONS);
const ASSIGNABLE_PERMISSION_SET = new Set<string>(ASSIGNABLE_MODERATOR_PERMISSIONS);

export const DEFAULT_ROLE_PERMISSION_PRESETS: Record<'admin' | 'support', AdminPermissionKey[]> = {
  admin: [
    'overview:view',
    'products:manage',
    'pricing:manage',
    'orders:manage',
    'deposits:approve',
    'customers:manage',
    'telegram:manage',
    'referrals:manage',
  ],
  support: ['overview:view', 'orders:manage'],
};

const COMMON_WEAK_PASSWORDS = new Set([
  '12345678',
  '123456789',
  '1234567890',
  'password',
  'password123',
  'admin123',
  'admin1234',
  'qwertyui',
  'qwerty123',
  '00000000',
  '11111111',
]);

export function normalizeEmail(raw?: string | null): string {
  return String(raw || '')
    .trim()
    .toLowerCase();
}

export function isStaffRole(role: string | undefined | null): role is StaffRole {
  return role === 'owner' || role === 'admin' || role === 'support';
}

export function sanitizeModeratorPermissionsInput(rawPerms: unknown): AdminPermissionKey[] {
  if (!Array.isArray(rawPerms)) return [];
  const out: AdminPermissionKey[] = [];
  const seen = new Set<string>();
  for (const item of rawPerms) {
    if (typeof item !== 'string') continue;
    const clean = item.trim();
    // Never allow assigning owner-exclusive 'moderators:manage' to a moderator
    if (!ASSIGNABLE_PERMISSION_SET.has(clean) || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean as AdminPermissionKey);
  }
  return out;
}

export function getEffectivePermissions(
  role: string | undefined | null,
  permissionsJson?: string[] | null
): AdminPermissionKey[] {
  if (role === 'owner') {
    return [...ALL_ADMIN_PERMISSIONS];
  }
  if (role !== 'admin' && role !== 'support') {
    return [];
  }
  if (Array.isArray(permissionsJson)) {
    const cleaned = sanitizeModeratorPermissionsInput(permissionsJson);
    return cleaned;
  }
  return [...DEFAULT_ROLE_PERMISSION_PRESETS[role]];
}

export function hasPermission(
  user: { role?: string | null; permissions?: readonly string[] | null } | null | undefined,
  permission: AdminPermissionKey
): boolean {
  if (!user) return false;
  if (user.role === 'owner') return true;
  if (!isStaffRole(user.role)) return false;
  if (permission === 'moderators:manage') return false;
  if (!VALID_PERMISSION_SET.has(permission)) return false;
  return Array.isArray(user.permissions) && user.permissions.includes(permission);
}

export function hasAnyPermission(
  user: { role?: string | null; permissions?: readonly string[] | null } | null | undefined,
  permissionsList: readonly AdminPermissionKey[]
): boolean {
  if (!user) return false;
  if (user.role === 'owner') return true;
  return permissionsList.some((perm) => hasPermission(user, perm));
}

export function canManageTargetModerator(
  actor: { id: number; role: string },
  target: { id: number; role: string }
): { allowed: boolean; reasonAr?: string } {
  if (actor.role !== 'owner') {
    return { allowed: false, reasonAr: 'فقط مالك المتجر يملك صلاحية إدارة المشرفين.' };
  }
  if (target.id === actor.id) {
    return { allowed: false, reasonAr: 'لا يمكنك تعديل أو حظر حسابك الخاص من قائمة المشرفين.' };
  }
  if (target.role === 'owner') {
    return { allowed: false, reasonAr: 'لا يمكن تعديل أو تخفيض صلاحيات حساب مالك المتجر.' };
  }
  return { allowed: true };
}

export function validatePasswordStrength(password: string): { ok: boolean; errorAr?: string } {
  if (typeof password !== 'string') {
    return { ok: false, errorAr: 'يرجى إدخال كلمة مرور صالحة.' };
  }
  if (password.length < 8) {
    return { ok: false, errorAr: 'يجب أن تتكون كلمة المرور من 8 أحرف على الأقل.' };
  }
  if (password.length > 128) {
    return { ok: false, errorAr: 'كلمة المرور طويلة جدًا (الحد الأقصى 128 حرفًا).' };
  }
  if (COMMON_WEAK_PASSWORDS.has(password.trim().toLowerCase())) {
    return { ok: false, errorAr: 'كلمة المرور ضعيفة وشائعة جدًا، يرجى اختيار كلمة مرور أقوى.' };
  }
  return { ok: true };
}

export function hashPasswordScrypt(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPasswordScrypt(password: string, storedHash?: string | null): boolean {
  if (!password || !storedHash) return false;
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, saltHex, hashHex] = parts;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return false;

  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  if (expected.length === 0) return false;

  const derived = crypto.scryptSync(password, salt, expected.length, { N: 16384, r: 8, p: 1 });
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

export function timingSafeSecretCompare(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}
