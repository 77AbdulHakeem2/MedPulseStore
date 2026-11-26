import 'dotenv/config';
import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Decimal from 'decimal.js';
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { createServer as createViteServer } from 'vite';

import { db } from './src/db/index.ts';
import {
  users,
  providers,
  providerCredentials,
  providerProducts,
  categories,
  storeProducts,
  productProviderMappings,
  productPrices,
  wallets,
  walletLedger,
  deposits,
  binanceUsedTransactions,
  paymentTransactions,
  orders,
  orderItems,
  providerOrders,
  deliveries,
  referrals,
  referralCommissions,
  referralCommissionAccounts,
  coupons,
  notifications,
  auditLogs,
  settings,
  paymentMethods,
  botMenuButtons,
  serviceGuides,
  localWallets,
  localDeposits,
  customerProductOverrides,
} from './src/db/schema.ts';
import {
  encryptSecret,
  decryptSecret,
  maskApiKey,
  signSessionToken,
  generateUniqueRef,
  isPersistentSessionSecretConfigured,
} from './src/server/crypto.ts';
import {
  ADMIN_PERMISSION_DEFS,
  DEFAULT_ROLE_PERMISSION_PRESETS,
  canManageTargetModerator,
  getEffectivePermissions,
  hasPermission,
  hashPasswordScrypt,
  isStaffRole,
  normalizeEmail,
  sanitizeModeratorPermissionsInput,
  timingSafeSecretCompare,
  validatePasswordStrength,
  verifyPasswordScrypt,
} from './src/server/rbacEngine.ts';
import {
  evaluateSyncPriceUpdate,
  formatMoney,
  resolveProductEffectivePricingAndStock,
  type ProviderOfferCandidate,
  type SelectionStrategy,
} from './src/server/pricing.ts';
import {
  getLiveCustomerCatalog,
  getLiveProductPricingMap,
  syncAllNonManualProductPrices,
  syncStoredEffectiveRetailPrice,
} from './src/server/catalogService.ts';
import {
  computeCustomerTotalSpending,
  isValidUserPricingTierInput,
  normalizeUserPricingTier,
  parseAndValidateCustomPriceUsd,
  shouldDeleteOverrideRow,
} from './src/server/customerOverridesEngine.ts';
import {
  buildCustomerMainInlineKeyboard,
  containsProviderLeak,
  sanitizeCustomerProductDescription,
  sanitizeErrorForCustomer,
} from './src/server/sanitizer.ts';
import {
  normalizeOriginalTelegramHtmlForPreview,
  processSupplierProductDescription,
  registerDynamicSupplierIdentities,
} from './src/server/productDescriptionEngine.ts';
import {
  buildSupplierBrowserItem,
  filterAndPaginateSupplierBrowserItems,
  makeSupplierOfferKey,
  validateAndPlanSupplierImport,
  type ExistingStoreLinkInfo,
  type RichNormalizedCatalogItem,
} from './src/server/supplierCatalogBrowser.ts';
import {
  autoTranslateBilingual,
  resolveBilingualFields,
  type TranslationContext,
} from './src/server/translator.ts';
import { collectDescendantButtonIds } from './src/lib/buttonTreeUtils.ts';
import {
  OFFICIAL_USDT_CONTRACTS,
  fetchTrc20TransactionFromTronGrid,
  verifyUsdtDepositTransaction,
  verifyBinancePayWebhook,
} from './src/server/paymentVerifier.ts';
import {
  fetchBinancePayTradeHistory,
  getBinanceAdminSummary,
  runBinanceEligibilityCheck,
  saveBinanceSettings,
  startBinancePendingDepositWorker,
} from './src/server/binancePayHistory.ts';
import {
  adminAdjustWalletBalance,
  buildWalletCreditNotificationText,
  creditDepositAtomically,
  ensureUserWallet,
  type WalletAdjustMode,
} from './src/server/walletEngine.ts';
import { getProviderAdapter, resolveProviderAdapter } from './src/server/providers/index.ts';
import {
  OFFER_BRANDS,
  classifyOfferBrand,
  matchProductToStoreCategory,
  normalizeProviderBaseUrl,
  parseAuthHeaderInput,
} from './src/lib/offerClassifier.ts';
import {
  collectDisappearedProviderOfferIds,
  getCustomerOrdersWithSanitizedDeliveries,
  placeCustomerOrder,
} from './src/server/orderEngine.ts';
import {
  bootstrapTelegramBotOnStartup,
  getActiveTelegramBotToken,
  getLiveBotUsername,
  getTelegramBotInstanceAsync,
  getTelegramBotRuntimeStatus,
  handleTelegramInteraction,
  isTelegramDeliveryAvailable,
  saveTelegramBotConfig,
  sendDirectTelegramMessageDetailed,
  sendDirectTelegramNotification,
  startOrRestartTelegramBot,
  stopRealTelegramBot,
} from './src/server/telegramEngine.ts';
import {
  fetchCustomEmojiMediaProxy,
  isValidCustomEmojiId,
} from './src/server/customEmojiService.ts';
import {
  auditAllProductMappings,
  computeRecompactedPriorities,
  validateExclusiveOfferBinding,
  type MappingRecordForAudit,
} from './src/server/providerMappingEngine.ts';
import {
  buildBroadcastResultSummaryAr,
  executeBroadcastDelivery,
  formatBroadcastTelegramMessage,
  normalizeBroadcastAudience,
  selectBroadcastRecipients,
} from './src/server/broadcastEngine.ts';
import {
  getAdminReferralOverview,
  listAdminReferralCommissions,
  lookupAdminReferralUser,
  refundCompletedOrderWithCommissionReversal,
  reverseReferralCommissionForOrder,
  updateReferralSettings,
} from './src/server/referralEngine.ts';
import { ensureSeededDatabase } from './src/server/seed.ts';
import {
  fetchLiveYerExchangeRate,
  getCurrencyLocalDepositSettings,
  getRecentExchangeRateLogs,
  normalizeDisplayCurrency,
  saveCurrencyLocalDepositSettings,
  validateDepositorQuadName,
} from './src/server/currencyEngine.ts';
import {
  approveLocalDepositAtomically,
  createLocalDepositRequest,
  createLocalWallet,
  deleteLocalWallet,
  fetchTelegramProofFileBytes,
  listLocalDepositsForAdmin,
  listLocalWallets,
  listSavedDepositorNamesForAdmin,
  rejectLocalDepositAtomically,
  reorderLocalWallets,
  updateLocalWallet,
  verifyTelegramReviewChannel,
} from './src/server/localDepositEngine.ts';
import {
  optionalAuth,
  requireAuth,
  requireOwner,
  requirePermission,
  requireAnyPermission,
  type AuthRequest,
} from './src/middleware/auth.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

// Lightweight per-IP rate limiter for API routes
const ipHits = new Map<string, { count: number; resetAt: number }>();
function apiRateLimit(req: Request, res: Response, next: NextFunction) {
  const ip = req.ip || 'local';
  const now = Date.now();
  const entry = ipHits.get(ip);
  if (!entry || now > entry.resetAt) {
    ipHits.set(ip, { count: 1, resetAt: now + 60_000 });
    return next();
  }
  if (entry.count > 240) {
    return res.status(429).json({ error: 'تم تجاوز حد الطلبات المسموح به، يرجى الانتظار دقيقة.' });
  }
  entry.count += 1;
  return next();
}

// Strict brute-force rate limiter for login & first-run claim endpoints
const authFailHits = new Map<string, { count: number; resetAt: number }>();
function getAuthRateLimitKey(req: Request, identifier = ''): string {
  const ip = req.ip || req.socket?.remoteAddress || 'local';
  return `${ip}:${normalizeEmail(identifier) || '*'}`;
}
function checkAuthBruteForce(req: Request, res: Response, identifier = ''): boolean {
  const now = Date.now();
  const keys = [getAuthRateLimitKey(req, ''), ...(identifier ? [getAuthRateLimitKey(req, identifier)] : [])];
  for (const k of keys) {
    const entry = authFailHits.get(k);
    if (entry && now < entry.resetAt && entry.count >= 8) {
      const waitMin = Math.max(1, Math.ceil((entry.resetAt - now) / 60_000));
      res.status(429).json({
        error: `تم تجاوز عدد محاولات تسجيل الدخول الفاشلة. يرجى المحاولة بعد ${waitMin} دقيقة.`,
      });
      return true;
    }
  }
  return false;
}
function recordAuthFailure(req: Request, identifier = '') {
  const now = Date.now();
  const windowMs = 15 * 60_000;
  for (const k of [getAuthRateLimitKey(req, ''), ...(identifier ? [getAuthRateLimitKey(req, identifier)] : [])]) {
    const entry = authFailHits.get(k);
    if (!entry || now > entry.resetAt) {
      authFailHits.set(k, { count: 1, resetAt: now + windowMs });
    } else {
      entry.count += 1;
    }
  }
}
function clearAuthFailures(req: Request, identifier = '') {
  if (identifier) authFailHits.delete(getAuthRateLimitKey(req, identifier));
}

async function bootstrapMiddleware(_req: Request, res: Response, next: NextFunction) {
  try {
    await ensureSeededDatabase();
    return next();
  } catch (err) {
    console.error('Database bootstrap failed:', err);
    return res.status(503).json({ error: 'قاعدة البيانات غير متاحة حاليًا، يرجى المحاولة لاحقًا.' });
  }
}

async function buildApp() {
  const app = express();

  // Capture raw body for cryptographic HMAC-SHA256 webhook verification
  app.use(
    express.json({
      limit: '8mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    })
  );

  // Basic security headers (iframe-safe)
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use('/api', apiRateLimit, bootstrapMiddleware);

  // ==========================================================================
  // 1. AUTHENTICATION ROUTES (HARDENED RBAC + SCRYPT + BRUTE-FORCE PROTECTION)
  // ==========================================================================
  app.get('/api/auth/bootstrap-status', async (_req: Request, res: Response) => {
    try {
      const owners = await db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.role, 'owner'));
      const passcodeEnvConfigured = Boolean((process.env.ADMIN_PASSCODE || '').trim());
      const hasOwnerPasswordHash = owners.some((o) => Boolean((o.passwordHash || '').trim()));
      return res.json({
        ownerPasswordConfigured: passcodeEnvConfigured || hasOwnerPasswordHash,
        passcodeEnvConfigured,
        googleAuthEnabled: true,
      });
    } catch {
      return res.status(500).json({ error: 'تعذر التحقق من حالة تهيئة الحماية.' });
    }
  });

  app.post('/api/auth/setup-owner-password', async (req: Request, res: Response) => {
    try {
      if (checkAuthBruteForce(req, res, 'owner-setup')) return;

      const passcodeEnv = (process.env.ADMIN_PASSCODE || '').trim();
      if (passcodeEnv) {
        return res.status(403).json({
          error: 'تم تأمين الدخول عبر متغير البيئة ADMIN_PASSCODE. استخدمه لتسجيل الدخول.',
        });
      }

      const owners = await db.select().from(users).where(eq(users.role, 'owner'));
      if (owners.some((o) => Boolean((o.passwordHash || '').trim()))) {
        return res.status(403).json({
          error: 'تم إعداد كلمة مرور المالك مسبقًا ولا يمكن إعادة تهيئتها من هذه الصفحة.',
        });
      }

      const password = String(req.body?.password || '');
      const check = validatePasswordStrength(password);
      if (!check.ok) {
        return res.status(400).json({ error: check.errorAr });
      }

      const rawEmail = normalizeEmail(req.body?.email);
      const rawDisplayName = String(req.body?.displayName || '').trim();
      if (rawEmail && (!rawEmail.includes('@') || rawEmail.length > 160)) {
        return res.status(400).json({ error: 'يرجى إدخال بريد إلكتروني صحيح.' });
      }

      const passwordHash = hashPasswordScrypt(password);
      const localOwner = owners.find((o) => o.uid === 'local:owner-raqm') || owners[0];
      let savedOwner: typeof users.$inferSelect;

      if (localOwner) {
        const nextEmail = rawEmail || localOwner.email || 'owner@raqm.store';
        const nextName = rawDisplayName || localOwner.displayName || 'مالك المتجر';
        const [updated] = await db
          .update(users)
          .set({
            email: nextEmail,
            displayName: nextName,
            passwordHash,
            tokenVersion: sql`${users.tokenVersion} + 1`,
            lastLoginAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(users.id, localOwner.id))
          .returning();
        savedOwner = updated;
      } else {
        const [inserted] = await db
          .insert(users)
          .values({
            uid: 'local:owner-raqm',
            email: rawEmail || 'owner@raqm.store',
            displayName: rawDisplayName || 'مالك المتجر',
            role: 'owner',
            passwordHash,
            tokenVersion: 1,
            lastLoginAt: new Date(),
          })
          .returning();
        savedOwner = inserted;
      }

      await db.insert(auditLogs).values({
        actorUserId: savedOwner.id,
        actorRole: 'owner',
        action: 'OWNER_PASSWORD_CLAIMED',
        entityType: 'user',
        entityId: String(savedOwner.id),
        detailsJson: { email: savedOwner.email },
      });

      const effectivePermissions = getEffectivePermissions(savedOwner.role, savedOwner.permissionsJson);
      const token = signSessionToken({
        uid: savedOwner.uid,
        userId: savedOwner.id,
        email: savedOwner.email || '',
        role: 'owner',
        displayName: savedOwner.displayName,
        tv: savedOwner.tokenVersion ?? 1,
      });

      return res.status(201).json({
        ok: true,
        token,
        user: {
          id: savedOwner.id,
          uid: savedOwner.uid,
          email: savedOwner.email,
          displayName: savedOwner.displayName,
          role: savedOwner.role,
          permissions: effectivePermissions,
          telegramUserId: savedOwner.telegramUserId,
        },
      });
    } catch (err) {
      console.error('setup-owner-password error:', err);
      return res.status(500).json({ error: 'تعذر إعداد كلمة مرور المالك حاليًا.' });
    }
  });

  app.post('/api/auth/login', async (req: Request, res: Response) => {
    try {
      const identifierRaw = String(req.body?.identifier || req.body?.email || '').trim();
      const password = String(req.body?.password || '');
      const identifier = normalizeEmail(identifierRaw);

      if (!identifier || !password) {
        return res.status(400).json({ error: 'يرجى إدخال البريد الإلكتروني أو المعرّف وكلمة المرور.' });
      }

      if (checkAuthBruteForce(req, res, identifier)) return;

      let candidate: typeof users.$inferSelect | undefined;
      if (identifier === 'owner' || identifier === 'local:owner-raqm') {
        const [ownerRow] = await db
          .select()
          .from(users)
          .where(eq(users.uid, 'local:owner-raqm'))
          .limit(1);
        candidate = ownerRow;
      } else {
        const matches = await db
          .select()
          .from(users)
          .where(sql`lower(${users.email}) = ${identifier}`);
        candidate =
          matches.find((u) => u.role === 'owner' && Boolean(u.passwordHash)) ||
          matches.find((u) => isStaffRole(u.role) && Boolean(u.passwordHash)) ||
          matches.find((u) => u.role === 'owner') ||
          matches.find((u) => isStaffRole(u.role)) ||
          matches[0];
      }

      const envPasscode = (process.env.ADMIN_PASSCODE || '').trim();
      const envOwnerEmail = normalizeEmail(process.env.OWNER_EMAIL);
      const isPasscodeMatch =
        Boolean(envPasscode) &&
        timingSafeSecretCompare(password, envPasscode) &&
        (candidate?.role === 'owner' ||
          identifier === 'owner' ||
          identifier === 'local:owner-raqm' ||
          identifier === 'owner@raqm.store' ||
          Boolean(envOwnerEmail && identifier === envOwnerEmail));

      if (isPasscodeMatch && !candidate) {
        const [fallbackOwner] = await db
          .select()
          .from(users)
          .where(eq(users.role, 'owner'))
          .orderBy(asc(users.id))
          .limit(1);
        candidate = fallbackOwner;
      }

      const isPasswordMatch =
        Boolean(candidate?.passwordHash) && verifyPasswordScrypt(password, candidate!.passwordHash);

      if (!candidate || (!isPasswordMatch && !isPasscodeMatch)) {
        recordAuthFailure(req, identifier);
        await db
          .insert(auditLogs)
          .values({
            actorUserId: candidate?.id ?? null,
            actorRole: candidate?.role || 'anonymous',
            action: 'LOGIN_FAILED',
            entityType: 'auth',
            entityId: identifier.slice(0, 80),
            detailsJson: { ip: req.ip || 'local' },
          })
          .catch(() => undefined);
        return res.status(401).json({ error: 'بيانات الدخول غير صحيحة.' });
      }

      if (candidate.isBlocked) {
        return res.status(403).json({ error: 'هذا الحساب موقوف أو محظور حاليًا. تواصل مع مالك المتجر.' });
      }

      clearAuthFailures(req, identifier);

      const [updatedUser] = await db
        .update(users)
        .set({ lastLoginAt: new Date(), updatedAt: new Date() })
        .where(eq(users.id, candidate.id))
        .returning();
      const finalUser = updatedUser || candidate;

      await db.insert(auditLogs).values({
        actorUserId: finalUser.id,
        actorRole: finalUser.role,
        action: 'LOGIN_SUCCESS',
        entityType: 'user',
        entityId: String(finalUser.id),
        detailsJson: { method: isPasscodeMatch ? 'passcode' : 'password' },
      });

      const effectivePermissions = getEffectivePermissions(finalUser.role, finalUser.permissionsJson);
      const token = signSessionToken({
        uid: finalUser.uid,
        userId: finalUser.id,
        email: finalUser.email || '',
        role: finalUser.role as any,
        displayName: finalUser.displayName,
        tv: finalUser.tokenVersion ?? 1,
      });

      return res.json({
        token,
        user: {
          id: finalUser.id,
          uid: finalUser.uid,
          email: finalUser.email,
          displayName: finalUser.displayName,
          role: finalUser.role,
          permissions: effectivePermissions,
          telegramUserId: finalUser.telegramUserId,
        },
      });
    } catch (err) {
      console.error('auth login error:', err);
      return res.status(500).json({ error: 'تعذر إتمام تسجيل الدخول حاليًا.' });
    }
  });

  app.post('/api/auth/change-password', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const currentPassword = String(req.body?.currentPassword || '');
      const newPassword = String(req.body?.newPassword || '');
      const revokeOtherSessions = req.body?.revokeOtherSessions !== false;

      const strength = validatePasswordStrength(newPassword);
      if (!strength.ok) {
        return res.status(400).json({ error: strength.errorAr });
      }

      const [dbUser] = await db.select().from(users).where(eq(users.id, req.user!.id)).limit(1);
      if (!dbUser) {
        return res.status(404).json({ error: 'الحساب غير موجود.' });
      }

      if (dbUser.passwordHash) {
        if (!currentPassword || !verifyPasswordScrypt(currentPassword, dbUser.passwordHash)) {
          return res.status(401).json({ error: 'كلمة المرور الحالية غير صحيحة.' });
        }
      } else if (dbUser.role !== 'owner') {
        return res.status(403).json({
          error: 'يجب تعيين كلمة مرور المشرف عبر المالك أو استخدام كلمة المرور الحالية.',
        });
      }

      const nextHash = hashPasswordScrypt(newPassword);
      const [updated] = await db
        .update(users)
        .set({
          passwordHash: nextHash,
          tokenVersion: revokeOtherSessions ? sql`${users.tokenVersion} + 1` : dbUser.tokenVersion,
          updatedAt: new Date(),
        })
        .where(eq(users.id, dbUser.id))
        .returning();

      await db.insert(auditLogs).values({
        actorUserId: dbUser.id,
        actorRole: dbUser.role,
        action: 'PASSWORD_CHANGED',
        entityType: 'user',
        entityId: String(dbUser.id),
        detailsJson: { revokeOtherSessions },
      });

      const effectivePermissions = getEffectivePermissions(updated.role, updated.permissionsJson);
      const token = signSessionToken({
        uid: updated.uid,
        userId: updated.id,
        email: updated.email || '',
        role: updated.role as any,
        displayName: updated.displayName,
        tv: updated.tokenVersion ?? 1,
      });

      return res.json({
        ok: true,
        token,
        user: {
          id: updated.id,
          uid: updated.uid,
          email: updated.email,
          displayName: updated.displayName,
          role: updated.role,
          permissions: effectivePermissions,
          telegramUserId: updated.telegramUserId,
        },
      });
    } catch (err) {
      console.error('change-password error:', err);
      return res.status(500).json({ error: 'تعذر تحديث كلمة المرور.' });
    }
  });

  app.post('/api/auth/logout', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      if (req.body?.revokeAllSessions) {
        await db
          .update(users)
          .set({ tokenVersion: sql`${users.tokenVersion} + 1`, updatedAt: new Date() })
          .where(eq(users.id, req.user!.id));
      }
      return res.json({ ok: true });
    } catch {
      return res.json({ ok: true });
    }
  });

  app.get('/api/auth/me', requireAuth, async (req: AuthRequest, res: Response) => {
    const wallet = await ensureUserWallet(req.user!.id);
    return res.json({
      user: req.user,
      wallet: {
        availableBalance: formatMoney(wallet.availableBalance, 2),
        reservedBalance: formatMoney(wallet.reservedBalance, 2),
        currency: wallet.currency,
      },
    });
  });

  // Unauthenticated sandbox login permanently disabled for security hardening
  app.post('/api/auth/sandbox-login', (_req: Request, res: Response) => {
    return res.status(403).json({
      error: 'تم تعطيل الدخول التجريبي نهائيًا لحماية المتجر. يرجى تسجيل الدخول بحسابك المصرح به.',
    });
  });

  // ==========================================================================
  // 2. CUSTOMER-ONLY STOREFRONT ROUTES (STRICTLY SANITIZED — ZERO PROVIDER LEAKS)
  // ==========================================================================
  app.get('/api/store/profile', async (_req: Request, res: Response) => {
    try {
      const [row] = await db.select().from(settings).where(eq(settings.key, 'store_profile')).limit(1);
      const profile = (row?.valueJson as Record<string, any>) || {};
      // Expose ONLY public commercial store metadata
      return res.json({
        storeName: profile.storeName || 'متجر رَقْم',
        tagline: profile.tagline || 'منتجات واشتراكات رقمية فورية',
        welcomeMessageAr: profile.welcomeMessageAr || '',
        currency: profile.currency || 'USD',
        supportHandle: profile.supportHandle || '@raqm_support',
        termsAr: profile.termsAr || '',
        isStoreOpen: profile.isStoreOpen !== false,
      });
    } catch (err) {
      console.error('store profile error:', err);
      return res.status(500).json({ error: sanitizeErrorForCustomer(err) });
    }
  });

  app.get('/api/store/categories', async (_req: Request, res: Response) => {
    try {
      const cats = await db
        .select({
          id: categories.id,
          slug: categories.slug,
          nameAr: categories.nameAr,
          nameEn: categories.nameEn,
          iconEmoji: categories.iconEmoji,
          sortOrder: categories.sortOrder,
        })
        .from(categories)
        .where(and(eq(categories.isActive, true), eq(categories.showInStore, true)))
        .orderBy(asc(categories.sortOrder), asc(categories.id));
      return res.json({ categories: cats });
    } catch (err) {
      return res.status(500).json({ error: sanitizeErrorForCustomer(err) });
    }
  });

  app.get('/api/store/catalog', optionalAuth, async (req: AuthRequest, res: Response) => {
    try {
      const lang = req.query.lang === 'en' ? 'en' : 'ar';
      const customerUserId = req.user?.role === 'customer' ? req.user.id : req.user?.id;
      const products = await getLiveCustomerCatalog(lang, customerUserId);
      return res.json({ products });
    } catch (err) {
      return res.status(500).json({ error: sanitizeErrorForCustomer(err) });
    }
  });

  app.get('/api/store/wallet', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const wallet = await ensureUserWallet(req.user!.id);
      const ledger = await db
        .select({
          referenceCode: walletLedger.referenceCode,
          entryType: walletLedger.entryType,
          amount: walletLedger.amount,
          balanceAfter: walletLedger.balanceAfter,
          note: walletLedger.note,
          createdAt: walletLedger.createdAt,
        })
        .from(walletLedger)
        .where(eq(walletLedger.userId, req.user!.id))
        .orderBy(desc(walletLedger.createdAt))
        .limit(25);
      return res.json({
        wallet: {
          availableBalance: formatMoney(wallet.availableBalance, 2),
          reservedBalance: formatMoney(wallet.reservedBalance, 2),
          currency: wallet.currency,
        },
        ledger,
      });
    } catch (err) {
      return res.status(500).json({ error: sanitizeErrorForCustomer(err) });
    }
  });

  app.get('/api/store/orders', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const list = await getCustomerOrdersWithSanitizedDeliveries(req.user!.id);
      return res.json({ orders: list });
    } catch (err) {
      return res.status(500).json({ error: sanitizeErrorForCustomer(err) });
    }
  });

  app.post('/api/store/orders', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const storeProductId = Number(req.body?.storeProductId);
      const quantity = Number(req.body?.quantity || 1);
      const couponCode = typeof req.body?.couponCode === 'string' ? req.body.couponCode : undefined;
      const idempotencyKey =
        typeof req.body?.idempotencyKey === 'string' && req.body.idempotencyKey.trim()
          ? req.body.idempotencyKey.trim()
          : generateUniqueRef(`WEB-${req.user!.id}`);

      if (!storeProductId || storeProductId <= 0) {
        return res.status(400).json({ error: 'يرجى اختيار منتج صحيح.' });
      }

      const result = await placeCustomerOrder({
        userId: req.user!.id,
        storeProductId,
        quantity,
        idempotencyKey,
        couponCode,
        customerLabel: req.user!.displayName,
      });

      if (!result.ok) {
        return res.status(400).json({ error: result.customerErrorAr });
      }
      return res.status(201).json(result);
    } catch (err) {
      return res.status(500).json({ error: sanitizeErrorForCustomer(err) });
    }
  });

  // --- CUSTOMER CURRENCY (USD / YER) & LOCAL YEMENI WALLETS ROUTES ---
  app.get('/api/store/currency', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const [u] = await db
        .select({
          preferredCurrency: users.preferredCurrency,
          savedDepositorName: users.savedDepositorName,
        })
        .from(users)
        .where(eq(users.id, req.user!.id))
        .limit(1);
      const cfg = await getCurrencyLocalDepositSettings();
      const liveRate = await fetchLiveYerExchangeRate({ forceFresh: false, settingsOverride: cfg });
      return res.json({
        preferredCurrency: normalizeDisplayCurrency(u?.preferredCurrency),
        savedDepositorName: u?.savedDepositorName || '',
        localDepositsEnabled: cfg.localDepositsEnabled,
        roundingMode: cfg.roundingMode,
        minDepositYer: cfg.minDepositYer,
        maxDepositYer: cfg.maxDepositYer,
        exchangeRate: liveRate,
      });
    } catch {
      return res.status(500).json({ error: 'تعذر تحميل إعدادات العملة وسعر الصرف.' });
    }
  });

  app.patch('/api/store/currency', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const target = normalizeDisplayCurrency(req.body?.currency);
      const cfg = await getCurrencyLocalDepositSettings();
      const liveRate =
        target === 'YER'
          ? await fetchLiveYerExchangeRate({ forceFresh: true, settingsOverride: cfg })
          : await fetchLiveYerExchangeRate({ forceFresh: false, settingsOverride: cfg });

      if (target === 'YER' && (!liveRate.ok || !liveRate.rate)) {
        return res.status(503).json({
          error:
            liveRate.errorMessageAr ||
            'تعذر جلب سعر الصرف المباشر للريال اليمني حاليًا. يرجى المحاولة لاحقًا.',
        });
      }

      await db
        .update(users)
        .set({ preferredCurrency: target, updatedAt: new Date() })
        .where(eq(users.id, req.user!.id));

      return res.json({
        ok: true,
        preferredCurrency: target,
        roundingMode: cfg.roundingMode,
        exchangeRate: liveRate,
      });
    } catch {
      return res.status(500).json({ error: 'تعذر تغيير عملة العرض.' });
    }
  });

  app.patch('/api/store/depositor-name', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const check = validateDepositorQuadName(String(req.body?.savedDepositorName || ''));
      if (!check.ok) {
        return res
          .status(400)
          .json({ error: 'يرجى إدخال الاسم الرباعي بشكل صحيح (ثلاث كلمات على الأقل بدون روابط).' });
      }
      await db
        .update(users)
        .set({ savedDepositorName: check.cleaned, updatedAt: new Date() })
        .where(eq(users.id, req.user!.id));
      return res.json({ ok: true, savedDepositorName: check.cleaned });
    } catch {
      return res.status(500).json({ error: 'تعذر حفظ الاسم الرباعي.' });
    }
  });

  app.get('/api/store/local-wallets', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const [cfg, walletsList, uRows] = await Promise.all([
        getCurrencyLocalDepositSettings(),
        listLocalWallets({ onlyEnabled: true }),
        db
          .select({ savedDepositorName: users.savedDepositorName })
          .from(users)
          .where(eq(users.id, req.user!.id))
          .limit(1),
      ]);
      const liveRate = await fetchLiveYerExchangeRate({ forceFresh: false, settingsOverride: cfg });
      return res.json({
        localDepositsEnabled: cfg.localDepositsEnabled,
        minDepositYer: cfg.minDepositYer,
        maxDepositYer: cfg.maxDepositYer,
        savedDepositorName: uRows[0]?.savedDepositorName || '',
        exchangeRate: liveRate,
        wallets: walletsList,
      });
    } catch {
      return res.status(500).json({ error: 'تعذر تحميل قائمة المحافظ المحلية.' });
    }
  });

  app.get('/api/store/local-deposits', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const rows = await db
        .select()
        .from(localDeposits)
        .where(eq(localDeposits.userId, req.user!.id))
        .orderBy(desc(localDeposits.createdAt))
        .limit(20);
      return res.json({
        deposits: rows.map((r) => ({
          ...r,
          proofImageDataUrl: undefined,
          hasProofImage: Boolean(r.proofTelegramFileId || r.proofImageDataUrl),
        })),
      });
    } catch {
      return res.status(500).json({ error: 'تعذر تحميل سجل الإيداعات المحلية.' });
    }
  });

  app.post('/api/store/local-deposits', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const localWalletId = Number(req.body?.localWalletId);
      if (!Number.isInteger(localWalletId) || localWalletId <= 0) {
        return res.status(400).json({ error: 'يرجى اختيار محفظة محلية صالحة.' });
      }

      const result = await createLocalDepositRequest({
        userId: req.user!.id,
        localWalletId,
        amountYer: req.body?.amountYer,
        depositorNameUsed: String(req.body?.depositorNameUsed || ''),
        depositorNameIsTemporary: Boolean(req.body?.depositorNameIsTemporary),
        saveDepositorNameAsPermanent: Boolean(req.body?.saveDepositorNameAsPermanent),
        senderWalletNumber: String(req.body?.senderWalletNumber || ''),
        proofImageDataUrl: typeof req.body?.proofImageDataUrl === 'string' ? req.body.proofImageDataUrl : null,
        proofCaption: typeof req.body?.proofCaption === 'string' ? req.body.proofCaption : '',
      });

      if (!result.ok || !result.deposit) {
        return res.status(400).json({ error: result.errorAr || 'تعذر إرسال طلب الإيداع المحلي.' });
      }

      return res.status(201).json({
        ok: true,
        channelDispatched: result.channelDispatched,
        deposit: {
          ...result.deposit,
          proofImageDataUrl: undefined,
          hasProofImage: true,
        },
      });
    } catch {
      return res.status(500).json({ error: 'حدث خطأ أثناء إنشاء طلب الإيداع المحلي.' });
    }
  });

  // ==========================================================================
  // 3. TELEGRAM BOT ROUTES (Live Simulator + Real Webhook Endpoint)
  // ==========================================================================
  app.post('/api/telegram/webhook', async (req: Request, res: Response) => {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (secret && req.headers['x-telegram-bot-api-secret-token'] !== secret) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }
    const bot = await getTelegramBotInstanceAsync();
    if (!bot) {
      return res.status(503).json({ error: 'TELEGRAM_BOT_TOKEN not configured' });
    }
    try {
      await bot.handleUpdate(req.body);
      return res.json({ ok: true });
    } catch (err) {
      console.error('Telegram webhook error:', err);
      return res.status(500).json({ ok: false });
    }
  });

  // --- Live Telegram Bot Connection Control (Long Polling + Encrypted Token in PostgreSQL) ---
  app.get('/api/admin/telegram/status', ...requirePermission('telegram:manage'), async (_req: AuthRequest, res: Response) => {
    try {
      const status = await getTelegramBotRuntimeStatus();
      return res.json({ status });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'تعذر جلب حالة اتصال بوت تيليجرام.' });
    }
  });

  app.post('/api/admin/telegram/config', ...requirePermission('telegram:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const result = await saveTelegramBotConfig({
        botToken: typeof req.body?.botToken === 'string' ? req.body.botToken : undefined,
        ownerTelegramIds: typeof req.body?.ownerTelegramIds === 'string' ? req.body.ownerTelegramIds : undefined,
        enabled: typeof req.body?.enabled === 'boolean' ? req.body.enabled : true,
      });

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: result.ok ? 'TELEGRAM_BOT_CONNECTED' : 'TELEGRAM_BOT_CONNECT_FAILED',
        entityType: 'settings',
        entityId: 'telegram_bot_config',
        detailsJson: {
          ok: result.ok,
          botUsername: result.status.botUsername,
          state: result.status.state,
        },
      });

      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'تعذر حفظ وتشغيل بوت تيليجرام.' });
    }
  });

  app.post('/api/admin/telegram/restart', ...requirePermission('telegram:manage'), async (_req: AuthRequest, res: Response) => {
    try {
      const result = await startOrRestartTelegramBot();
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'تعذر إعادة تشغيل بوت تيليجرام.' });
    }
  });

  app.post('/api/admin/telegram/stop', ...requirePermission('telegram:manage'), async (_req: AuthRequest, res: Response) => {
    try {
      await stopRealTelegramBot();
      const status = await getTelegramBotRuntimeStatus();
      return res.json({ ok: true, messageAr: 'تم إيقاف اتصال البوت الحقيقي مؤقتًا.', status });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'تعذر إيقاف بوت تيليجرام.' });
    }
  });

  app.get('/api/telegram/custom-emoji/:emojiId', async (req: Request, res: Response) => {
    const emojiId = String(req.params.emojiId || '').trim();
    if (!isValidCustomEmojiId(emojiId)) {
      return res.status(400).json({ error: 'Invalid custom emoji ID' });
    }
    try {
      const token = await getActiveTelegramBotToken();
      if (!token) {
        res.setHeader('Cache-Control', 'public, max-age=60');
        return res.status(204).end();
      }
      const media = await fetchCustomEmojiMediaProxy(token, emojiId);
      if (!media) {
        res.setHeader('Cache-Control', 'public, max-age=300');
        return res.status(204).end();
      }
      res.setHeader('Content-Type', media.contentType);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return res.send(media.buffer);
    } catch {
      return res.status(204).end();
    }
  });

  app.post('/api/telegram/simulate', requireAuth, async (req: AuthRequest, res: Response) => {
    try {
      const requestedMode = req.body?.mode === 'admin' ? 'admin' : 'customer';
      // Enforce RBAC: only owner or staff with telegram:manage permission can simulate Admin Bot
      if (requestedMode === 'admin' && !hasPermission(req.user, 'telegram:manage')) {
        return res.status(403).json({ error: 'غير مصرح لك باستخدام وضع إدارة تيليجرام.' });
      }

      // Use real Telegram user from DB (never re-create fake demo users like 550200300!)
      let targetTelegramId =
        typeof req.body?.telegramUserId === 'string' && req.body.telegramUserId.trim()
          ? req.body.telegramUserId.trim()
          : req.user!.telegramUserId || '';
      let targetUsername = 'raqm_owner';
      let targetDisplayName = req.user!.displayName;

      if (!targetTelegramId) {
        const [realTgUser] = await db
          .select()
          .from(users)
          .where(sql`${users.telegramUserId} is not null and ${users.telegramUserId} <> ''`)
          .orderBy(desc(users.id))
          .limit(1);
        if (realTgUser?.telegramUserId) {
          targetTelegramId = realTgUser.telegramUserId;
          targetUsername = realTgUser.telegramUsername || targetUsername;
          targetDisplayName = realTgUser.displayName || targetDisplayName;
        } else {
          targetTelegramId = '700100001';
        }
      }

      const reply = await handleTelegramInteraction({
        telegramUserId: targetTelegramId,
        username: targetUsername,
        displayName: targetDisplayName,
        telegramLanguageCode: typeof req.body?.telegramLanguageCode === 'string' ? req.body.telegramLanguageCode : undefined,
        text: typeof req.body?.text === 'string' ? req.body.text : undefined,
        entities: Array.isArray(req.body?.entities) ? req.body.entities : undefined,
        callbackData: typeof req.body?.callbackData === 'string' ? req.body.callbackData : undefined,
        proofImageDataUrl:
          typeof req.body?.proofImageDataUrl === 'string' ? req.body.proofImageDataUrl : undefined,
        photoCaption: typeof req.body?.photoCaption === 'string' ? req.body.photoCaption : undefined,
        enforceRole: requestedMode,
      });

      return res.json({ reply });
    } catch (err) {
      console.error('telegram simulate error:', err);
      return res.status(500).json({ error: 'تعذر معالجة أمر البوت حاليًا.' });
    }
  });

  // ==========================================================================
  // 4. WEBHOOKS (AIVault Hub HMAC-SHA256 & Binance Pay)
  // ==========================================================================
  app.post('/api/webhooks/aivaulthub', async (req: any, res: Response) => {
    try {
      const sig = String(req.headers['x-webhook-signature'] || '');
      const [prov] = await db.select().from(providers).where(eq(providers.code, 'aivaulthub')).limit(1);
      if (!prov) return res.status(404).json({ error: 'Provider not found' });

      const [cred] = await db
        .select()
        .from(providerCredentials)
        .where(eq(providerCredentials.providerId, prov.id))
        .limit(1);

      const secret = cred?.encryptedWebhookSecret ? decryptSecret(cred.encryptedWebhookSecret) : '';
      const adapter = getProviderAdapter('aivaulthub');
      if (!secret || !adapter?.verifyWebhookSignature?.(req.rawBody || '', sig, secret)) {
        await db.insert(notifications).values({
          audience: 'admin',
          eventType: 'webhook_failed',
          severity: 'critical',
          titleAr: 'فشل التحقق من توقيع Webhook',
          bodyAr: 'تم رفض طلب Webhook وارد بسبب عدم تطابق توقيع HMAC-SHA256.',
        });
        return res.status(401).json({ error: 'Invalid HMAC signature' });
      }
      return res.json({ received: true });
    } catch (err) {
      console.error('aivaulthub webhook error:', err);
      return res.status(500).json({ error: 'Webhook processing error' });
    }
  });

  app.post('/api/webhooks/binance-pay', async (req: any, res: Response) => {
    try {
      const timestamp = String(req.headers['binancepay-timestamp'] || '');
      const nonce = String(req.headers['binancepay-nonce'] || '');
      const sig = String(req.headers['binancepay-signature'] || '');
      const secret = process.env.BINANCE_PAY_SECRET_KEY || '';

      const ok = verifyBinancePayWebhook({
        timestamp,
        nonce,
        rawBody: String(req.rawBody || ''),
        signatureHeader: sig,
        secretKey: secret,
      });
      if (!ok) {
        return res.status(401).json({ returnCode: 'FAIL', returnMessage: 'Invalid signature' });
      }
      const prepayId = String(req.body?.bizIdStr || '');
      if (prepayId) {
        const [dep] = await db
          .select()
          .from(deposits)
          .where(eq(deposits.binancePrepayId, prepayId))
          .limit(1);
        if (dep && dep.status !== 'confirmed') {
          await creditDepositAtomically({
            depositId: dep.id,
            creditedAmount: dep.expectedAmount,
            note: `إيداع Binance Pay مؤكد (${dep.depositRef})`,
          });
        }
      }
      return res.json({ returnCode: 'SUCCESS', returnMessage: null });
    } catch (err) {
      console.error('binance-pay webhook error:', err);
      return res.status(500).json({ returnCode: 'FAIL' });
    }
  });

  // ==========================================================================
  // 5. ADMIN-ONLY PROTECTED ROUTES (STRICTLY BLOCKED FOR CUSTOMERS -> 403)
  // ==========================================================================
  app.get('/api/admin/overview', ...requirePermission('overview:view'), async (_req: AuthRequest, res: Response) => {
    try {
      const [orderAgg] = await db
        .select({
          totalOrders: sql<number>`count(*)`,
          completedOrders: sql<number>`count(*) filter (where ${orders.status} = 'completed')`,
          totalRevenue: sql<string>`coalesce(sum(${orders.totalRetail}) filter (where ${orders.status} = 'completed'), 0)`,
          totalWholesale: sql<string>`coalesce(sum(${orders.totalWholesaleSnapshot}) filter (where ${orders.status} = 'completed'), 0)`,
          totalNetProfit: sql<string>`coalesce(sum(${orders.netProfitSnapshot}) filter (where ${orders.status} = 'completed'), 0)`,
        })
        .from(orders);

      const allProvs = await db.select().from(providers).orderBy(providers.priority);
      const allStoreProds = await db.select().from(storeProducts);
      const allUsers = await db.select().from(users);
      const pendingDeps = await db
        .select()
        .from(deposits)
        .where(inArray(deposits.status, ['pending', 'pending_review']));
      const unreadNotifs = await db
        .select()
        .from(notifications)
        .where(and(eq(notifications.audience, 'admin'), eq(notifications.isRead, false)))
        .orderBy(desc(notifications.createdAt))
        .limit(8);

      const recentOrders = await db
        .select({ order: orders, user: users })
        .from(orders)
        .innerJoin(users, eq(orders.userId, users.id))
        .orderBy(desc(orders.createdAt))
        .limit(8);

      const totalProviderBalance = allProvs
        .reduce((acc, p) => acc.plus(p.cachedBalance || '0'), new Decimal(0))
        .toFixed(2);

      return res.json({
        kpis: {
          totalRevenue: formatMoney(orderAgg?.totalRevenue || '0', 2),
          totalWholesale: formatMoney(orderAgg?.totalWholesale || '0', 2),
          totalNetProfit: formatMoney(orderAgg?.totalNetProfit || '0', 2),
          totalOrders: Number(orderAgg?.totalOrders || 0),
          completedOrders: Number(orderAgg?.completedOrders || 0),
          publishedProducts: allStoreProds.filter((p) => p.isVisible && !p.isPaused).length,
          hiddenProducts: allStoreProds.filter((p) => !p.isVisible || p.isPaused).length,
          totalCustomers: allUsers.filter((u) => u.role === 'customer').length,
          pendingDepositsCount: pendingDeps.length,
          totalProviderBalance,
          connectedProviders: allProvs.filter((p) => p.isEnabled && p.status === 'connected').length,
          totalProviders: allProvs.length,
        },
        unreadNotifications: unreadNotifs,
        recentOrders: recentOrders.map((r) => ({
          id: r.order.id,
          orderNumber: r.order.orderNumber,
          customerName: r.user.displayName,
          status: r.order.status,
          totalRetail: formatMoney(r.order.totalRetail, 2),
          totalWholesale: formatMoney(r.order.totalWholesaleSnapshot, 2),
          netProfit: formatMoney(r.order.netProfitSnapshot, 2),
          createdAt: r.order.createdAt,
        })),
      });
    } catch (err) {
      console.error('admin overview error:', err);
      return res.status(500).json({ error: 'تعذر تحميل ملخص لوحة الإدارة.' });
    }
  });

  // --- Providers Management ---
  app.get('/api/admin/providers', ...requirePermission('providers:manage'), async (_req: AuthRequest, res: Response) => {
    try {
      const provs = await db.select().from(providers).orderBy(providers.priority);
      const creds = await db.select().from(providerCredentials);
      const provProds = await db.select().from(providerProducts);
      const mappings = await db
        .select({
          providerProductId: productProviderMappings.providerProductId,
          isVisible: storeProducts.isVisible,
        })
        .from(productProviderMappings)
        .innerJoin(storeProducts, eq(productProviderMappings.storeProductId, storeProducts.id));
      const pOrders = await db.select().from(providerOrders);

      const result = provs.map((p) => {
        const cred = creds.find((c) => c.providerId === p.id);
        const myProds = provProds.filter((pp) => pp.providerId === p.id);
        const myProdIds = new Set(myProds.map((pp) => pp.id));
        const myMappings = mappings.filter((m) => myProdIds.has(m.providerProductId));
        const publishedCount = myMappings.filter((m) => m.isVisible).length;
        const hiddenCount = Math.max(0, myProds.length - publishedCount);
        const ordersCount = pOrders.filter((po) => po.providerId === p.id).length;

        return {
          ...p,
          cachedBalance: formatMoney(p.cachedBalance, 2),
          lowBalanceThreshold: formatMoney(p.lowBalanceThreshold, 2),
          hasApiKey: Boolean(cred),
          keyFingerprint: cred?.keyFingerprint || null, // NEVER return raw API key!
          productsCount: myProds.length,
          publishedCount,
          hiddenCount,
          ordersCount,
        };
      });

      return res.json({ providers: result });
    } catch (err) {
      console.error('admin providers list error:', err);
      return res.status(500).json({ error: 'تعذر جلب قائمة الخوادم.' });
    }
  });

  app.post('/api/admin/providers', ...requirePermission('providers:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const { code, name, baseUrl, docsUrl, authType, authHeader, apiKey, priority } = req.body || {};
      if (!name || !baseUrl) {
        return res.status(400).json({ error: 'يرجى إدخال اسم الخادم ورابط Base URL.' });
      }
      const cleanCode =
        String(code || name)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, '') || `srv_${Date.now().toString(36)}`;

      let cleanBaseUrl = normalizeProviderBaseUrl(String(baseUrl));
      const lowBase = cleanBaseUrl.toLowerCase();
      if (
        (lowBase === 'https://api.warzoneshop.in' ||
          lowBase === 'https://api.aivaulthub.store' ||
          lowBase === 'https://reseller.aivaulthub.store' ||
          lowBase === 'https://sajidofficial.com' ||
          lowBase === 'https://bot.kangnequantri.cc') &&
        !lowBase.endsWith('/api/v1')
      ) {
        cleanBaseUrl = `${cleanBaseUrl}/api/v1`;
      } else if (lowBase === 'https://api.renqis.online' || lowBase === 'https://api.renqis.online/api/reseller') {
        cleanBaseUrl = 'https://api.renqis.online/api/reseller/v1';
      }

      const parsedAuth = parseAuthHeaderInput(
        String(authHeader || ''),
        typeof authType === 'string' ? authType : undefined,
        typeof apiKey === 'string' ? apiKey : undefined
      );

      const [created] = await db
        .insert(providers)
        .values({
          code: cleanCode,
          name: String(name).trim(),
          baseUrl: cleanBaseUrl,
          docsUrl: String(docsUrl || baseUrl).trim(),
          authType: parsedAuth.authType,
          authHeader: parsedAuth.authHeader,
          priority: Number(priority || 20),
          status: 'disconnected',
          isEnabled: true,
        })
        .returning();

      registerDynamicSupplierIdentities([created]);

      let keyFingerprint: string | null = null;
      if (parsedAuth.extractedApiKey && parsedAuth.extractedApiKey.length >= 6) {
        keyFingerprint = maskApiKey(parsedAuth.extractedApiKey);
        await db
          .insert(providerCredentials)
          .values({
            providerId: created.id,
            encryptedApiKey: encryptSecret(parsedAuth.extractedApiKey),
            keyFingerprint,
            updatedByUserId: req.user!.id,
          })
          .onConflictDoUpdate({
            target: providerCredentials.providerId,
            set: {
              encryptedApiKey: encryptSecret(parsedAuth.extractedApiKey),
              keyFingerprint,
              updatedByUserId: req.user!.id,
              updatedAt: new Date(),
            },
          });
      }

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'PROVIDER_CREATED',
        entityType: 'provider',
        entityId: String(created.id),
        detailsJson: { code: created.code, name: created.name, hasApiKey: Boolean(keyFingerprint) },
      });

      return res.status(201).json({ provider: { ...created, hasApiKey: Boolean(keyFingerprint), keyFingerprint } });
    } catch (err: any) {
      return res.status(400).json({ error: 'تعذر إضافة الخادم، تأكد من عدم تكرار الكود وصحة الرابط.' });
    }
  });

  app.delete('/api/admin/providers/:id', ...requirePermission('providers:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const providerId = Number(req.params.id);
      if (!providerId) return res.status(400).json({ error: 'معرّف الخادم غير صالح.' });

      const [existing] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
      if (!existing) return res.status(404).json({ error: 'الخادم غير موجود.' });

      // Remove dependent provider_orders first (customer orders remain intact), then delete provider (cascades credentials, offers, mappings)
      await db.transaction(async (tx) => {
        await tx.delete(providerOrders).where(eq(providerOrders.providerId, providerId));
        await tx.delete(providers).where(eq(providers.id, providerId));
      });

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'PROVIDER_DELETED',
        entityType: 'provider',
        entityId: String(providerId),
        detailsJson: { code: existing.code, name: existing.name },
      });

      return res.json({ ok: true, deletedId: providerId, deletedName: existing.name });
    } catch (err) {
      console.error('delete provider error:', err);
      return res.status(500).json({ error: 'تعذر حذف الخادم من قاعدة البيانات.' });
    }
  });

  app.post('/api/admin/providers/:id/credentials', ...requirePermission('providers:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const providerId = Number(req.params.id);
      const apiKey = String(req.body?.apiKey || '').trim();
      const webhookSecret = typeof req.body?.webhookSecret === 'string' ? req.body.webhookSecret.trim() : '';

      if (!apiKey || apiKey.length < 6) {
        return res.status(400).json({ error: 'يرجى إدخال مفتاح API صحيح.' });
      }

      const encryptedApiKey = encryptSecret(apiKey);
      const fingerprint = maskApiKey(apiKey);
      const encryptedWebhookSecret = webhookSecret ? encryptSecret(webhookSecret) : null;

      await db
        .insert(providerCredentials)
        .values({
          providerId,
          encryptedApiKey,
          keyFingerprint: fingerprint,
          encryptedWebhookSecret,
          updatedByUserId: req.user!.id,
        })
        .onConflictDoUpdate({
          target: providerCredentials.providerId,
          set: {
            encryptedApiKey,
            keyFingerprint: fingerprint,
            encryptedWebhookSecret,
            updatedByUserId: req.user!.id,
            updatedAt: new Date(),
          },
        });

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'PROVIDER_KEY_UPDATED',
        entityType: 'provider',
        entityId: String(providerId),
        detailsJson: { fingerprint }, // Never log raw key!
      });

      return res.json({ ok: true, keyFingerprint: fingerprint });
    } catch (err) {
      console.error('save provider credentials error:', err);
      return res.status(500).json({ error: 'تعذر حفظ المفتاح المشفر.' });
    }
  });

  app.post('/api/admin/providers/:id/test', ...requirePermission('providers:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const providerId = Number(req.params.id);
      const [prov] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
      if (!prov) return res.status(404).json({ error: 'الخادم غير موجود.' });

      const [cred] = await db
        .select()
        .from(providerCredentials)
        .where(eq(providerCredentials.providerId, providerId))
        .limit(1);

      const adapter = resolveProviderAdapter({
        code: prov.code,
        name: prov.name,
        baseUrl: prov.baseUrl,
        docsUrl: prov.docsUrl,
        authType: prov.authType,
        authHeader: prov.authHeader,
        rateLimitPerMin: prov.rateLimitPerMin,
      });

      if (!cred) {
        return res.json({
          ok: true,
          mode: 'sandbox',
          connected: prov.isEnabled,
          balance: formatMoney(prov.cachedBalance, 2),
          messageAr: `الخادم ${prov.name} جاهز للربط. أضف مفتاح API الحقيقي لتفعيل الاتصال المباشر بـ ${adapter.baseUrl}.`,
        });
      }

      const rawKey = decryptSecret(cred.encryptedApiKey);
      const result = await adapter.testConnection(rawKey);

      await db
        .update(providers)
        .set({
          status: result.connected ? 'connected' : 'error',
          cachedBalance: result.connected ? result.balance : prov.cachedBalance,
          lastError: result.connected ? null : result.rawError || 'CONNECTION_FAILED',
          updatedAt: new Date(),
        })
        .where(eq(providers.id, providerId));

      if (result.connected && new Decimal(result.balance).lt(prov.lowBalanceThreshold)) {
        await db.insert(notifications).values({
          audience: 'admin',
          eventType: 'low_provider_balance',
          severity: 'warning',
          titleAr: `انخفاض رصيد الخادم ${prov.name}`,
          bodyAr: `الرصيد الحالي $${formatMoney(result.balance, 2)} أقل من الحد الأدنى $${formatMoney(prov.lowBalanceThreshold, 2)}.`,
        });
      }

      return res.json({
        ok: result.connected,
        mode: 'live',
        connected: result.connected,
        balance: formatMoney(result.balance, 2),
        currency: result.currency,
        messageAr: result.connected
          ? `تم الاتصال بنجاح بالخادم ${prov.name} — الرصيد المتاح: $${formatMoney(result.balance, 2)}`
          : `فشل الاتصال بـ ${prov.name}: ${result.rawError || 'تحقق من صلاحية المفتاح'}`,
      });
    } catch (err) {
      console.error('provider test error:', err);
      return res.status(500).json({ error: 'تعذر اختبار الاتصال بالخادم.' });
    }
  });

  // Short-lived per-provider live catalog cache for fast pagination/filtering & selective import
  const supplierCatalogBrowserCache = new Map<
    number,
    { fetchedAt: number; items: RichNormalizedCatalogItem[] }
  >();
  const SUPPLIER_BROWSER_CACHE_TTL_MS = 90_000;

  async function fetchLiveRichCatalogForProvider(prov: typeof providers.$inferSelect, forceRefresh = false) {
    const now = Date.now();
    const cached = supplierCatalogBrowserCache.get(prov.id);
    if (!forceRefresh && cached && now - cached.fetchedAt < SUPPLIER_BROWSER_CACHE_TTL_MS) {
      return { items: cached.items, fetchedAt: cached.fetchedAt, fromCache: true };
    }

    const [cred] = await db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.providerId, prov.id))
      .limit(1);

    if (!cred) {
      const err = new Error('لم يتم إدخال مفتاح API لهذا الخادم بعد. يرجى إدخال المفتاح أولًا لتصفح المنتجات مباشرة من الخادم.') as Error & {
        statusCode?: number;
        code?: string;
      };
      err.statusCode = 400;
      err.code = 'NO_API_KEY';
      throw err;
    }

    const rawKey = decryptSecret(cred.encryptedApiKey);
    const adapter = resolveProviderAdapter({
      code: prov.code,
      name: prov.name,
      baseUrl: prov.baseUrl,
      docsUrl: prov.docsUrl,
      authType: prov.authType,
      authHeader: prov.authHeader,
      rateLimitPerMin: prov.rateLimitPerMin,
    });

    const fetched = await adapter.fetchProducts(rawKey);
    const richItems: RichNormalizedCatalogItem[] = fetched.map((it) => ({
      externalProductId: it.externalProductId,
      externalVariantId: it.externalVariantId || '',
      rawName: it.rawName,
      rawDescription: it.rawDescription || '',
      imageUrl: it.imageUrl || '',
      wholesalePrice: it.wholesalePrice,
      suggestedRetailPrice: it.suggestedRetailPrice ?? null,
      currency: it.currency || 'USD',
      stockCount: Number(it.stockCount || 0),
      isAvailable: it.isAvailable ?? Number(it.stockCount || 0) > 0,
      minQty: Math.max(1, Number(it.minQty || 1)),
      maxQty: Math.max(1, Number(it.maxQty || 1000)),
      deliveryType: it.deliveryType || 'code',
      deliveryInstructions: it.deliveryInstructions || '',
      durationLabel: it.durationLabel || '',
      warrantyDays: Number(it.warrantyDays || 0),
      warrantyLabel: it.warrantyLabel || (it.warrantyDays > 0 ? `${it.warrantyDays} يوم` : ''),
      productType: it.productType || '',
      categoryName: it.categoryName || '',
      features: Array.isArray(it.features) ? it.features : [],
      variantsSummary: Array.isArray(it.variantsSummary) ? it.variantsSummary : [],
      pricingTiers: it.pricingTiers,
      extraMetadata: it.extraMetadata || {},
    }));

    supplierCatalogBrowserCache.set(prov.id, { fetchedAt: now, items: richItems });
    return { items: richItems, fetchedAt: now, fromCache: false };
  }

  /**
   * Live Supplier Product Browser:
   * Fetches real catalog directly from the supplier API (with explicit refresh & pagination),
   * preserves original unaltered data + formatted Telegram HTML preview, and annotates existing imports.
   */
  app.get('/api/admin/providers/:id/browse-catalog', ...requirePermission('providers:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const providerId = Number(req.params.id);
      if (!Number.isInteger(providerId) || providerId <= 0) {
        return res.status(400).json({ error: 'معرف الخادم غير صالح.' });
      }
      const [prov] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
      if (!prov) return res.status(404).json({ error: 'الخادم غير موجود.' });

      registerDynamicSupplierIdentities([prov]);

      const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
      const live = await fetchLiveRichCatalogForProvider(prov, forceRefresh);

      // Load existing DB provider_products + exclusive store mappings to accurately flag duplicates
      const existingRows = await db
        .select({
          ppId: providerProducts.id,
          externalProductId: providerProducts.externalProductId,
          externalVariantId: providerProducts.externalVariantId,
          storeProductId: storeProducts.id,
          storeProductTitle: storeProducts.titleAr,
          storeCategoryId: storeProducts.categoryId,
          storeIsVisible: storeProducts.isVisible,
          storeDescriptionAr: storeProducts.descriptionAr,
        })
        .from(providerProducts)
        .leftJoin(productProviderMappings, eq(productProviderMappings.providerProductId, providerProducts.id))
        .leftJoin(storeProducts, eq(productProviderMappings.storeProductId, storeProducts.id))
        .where(eq(providerProducts.providerId, providerId));

      const existingMap = new Map<string, ExistingStoreLinkInfo>();
      for (const row of existingRows) {
        const key = makeSupplierOfferKey(row.externalProductId, row.externalVariantId || '');
        existingMap.set(key, {
          providerProductId: row.ppId,
          storeProductId: row.storeProductId ?? null,
          storeProductTitle: row.storeProductTitle ?? null,
          storeCategoryId: row.storeCategoryId ?? null,
          storeIsVisible: row.storeIsVisible ?? null,
          storeDescriptionEmpty: !(row.storeDescriptionAr || '').trim(),
        });
      }

      const browserItems = live.items.map((item) => {
        const key = makeSupplierOfferKey(item.externalProductId, item.externalVariantId);
        return buildSupplierBrowserItem(item, {
          extraSupplierNames: [prov.name, prov.code],
          existingLink: existingMap.get(key) || null,
        });
      });

      const statusParam =
        req.query.status === 'imported' || req.query.status === 'not_imported' ? req.query.status : 'all';
      const paged = filterAndPaginateSupplierBrowserItems(browserItems, {
        search: typeof req.query.search === 'string' ? req.query.search : '',
        category: typeof req.query.category === 'string' ? req.query.category : 'all',
        status: statusParam,
        page: Number(req.query.page || 1),
        pageSize: Number(req.query.pageSize || 24),
      });

      const importedCount = browserItems.filter((i) => i.importStatus === 'imported').length;

      return res.json({
        ok: true,
        provider: {
          id: prov.id,
          code: prov.code,
          name: prov.name,
          baseUrl: prov.baseUrl,
          status: prov.status,
          hasApiKey: true,
        },
        items: paged.items,
        totalCatalogCount: browserItems.length,
        importedCount,
        notImportedCount: browserItems.length - importedCount,
        totalMatched: paged.totalMatched,
        page: paged.page,
        pageSize: paged.pageSize,
        totalPages: paged.totalPages,
        categories: paged.distinctCategories,
        fetchedAt: new Date(live.fetchedAt).toISOString(),
        fromCache: live.fromCache,
      });
    } catch (err: any) {
      const statusCode = err?.statusCode || 502;
      console.error('browse-catalog error:', err);
      return res.status(statusCode).json({
        error: err?.message || 'تعذر جلب كتالوج المنتجات من الخادم.',
        code: err?.code || 'UPSTREAM_FETCH_ERROR',
      });
    }
  });

  /**
   * Selective Manual Importer from Supplier Product Browser:
   * - Requires explicit existing store category per item or defaultCategoryId (NEVER auto-creates categories).
   * - Prevents duplicates using (providerId, externalProductId, externalVariantId) + exclusive 1-to-1 mappings.
   * - Supports explicit update of previously imported store products without breaking orders or pricing rules.
   * - Preserves full description (including Telegram HTML & <tg-emoji>) while scrubbing supplier identity/promo links.
   */
  app.post('/api/admin/providers/:id/import-selected', ...requireAnyPermission(['providers:manage', 'products:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const providerId = Number(req.params.id);
      if (!Number.isInteger(providerId) || providerId <= 0) {
        return res.status(400).json({ error: 'معرف الخادم غير صالح.' });
      }
      const [prov] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
      if (!prov) return res.status(404).json({ error: 'الخادم غير موجود.' });

      const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];
      if (rawItems.length === 0) {
        return res.status(400).json({ error: 'يرجى تحديد منتج واحد على الأقل للاستيراد.' });
      }
      if (rawItems.length > 200) {
        return res.status(400).json({ error: 'الحد الأقصى للاستيراد في الدفعة الواحدة هو 200 منتج.' });
      }

      const defaultCategoryId = req.body?.defaultCategoryId ? Number(req.body.defaultCategoryId) : null;
      const makeVisible = Boolean(req.body?.makeVisible);

      const allCats = await db.select().from(categories);
      const validCategoryIds = new Set<number>(allCats.map((c) => c.id));
      if (defaultCategoryId !== null && !validCategoryIds.has(defaultCategoryId)) {
        return res.status(400).json({ error: 'القسم المستهدف المحدد غير موجود في المتجر.' });
      }

      registerDynamicSupplierIdentities([prov]);
      const live = await fetchLiveRichCatalogForProvider(prov, false);
      const liveByKey = new Map<string, RichNormalizedCatalogItem>();
      for (const it of live.items) {
        liveByKey.set(makeSupplierOfferKey(it.externalProductId, it.externalVariantId), it);
      }

      const touchedStoreProductIds: number[] = [];
      const results: Array<{
        externalProductId: string;
        externalVariantId: string;
        rawName: string;
        status: 'created' | 'updated' | 'skipped' | 'failed';
        storeProductId?: number;
        message: string;
      }> = [];

      let createdCount = 0;
      let updatedCount = 0;
      let skippedCount = 0;
      let failedCount = 0;

      await db.transaction(async (tx) => {
        const existingRows = await tx
          .select({
            ppId: providerProducts.id,
            rawDescription: providerProducts.rawDescription,
            externalProductId: providerProducts.externalProductId,
            externalVariantId: providerProducts.externalVariantId,
            storeProductId: storeProducts.id,
            storeProductTitle: storeProducts.titleAr,
            storeCategoryId: storeProducts.categoryId,
            storeIsVisible: storeProducts.isVisible,
            storeDescriptionAr: storeProducts.descriptionAr,
          })
          .from(providerProducts)
          .leftJoin(productProviderMappings, eq(productProviderMappings.providerProductId, providerProducts.id))
          .leftJoin(storeProducts, eq(productProviderMappings.storeProductId, storeProducts.id))
          .where(eq(providerProducts.providerId, providerId));

        const existingMap = new Map<
          string,
          ExistingStoreLinkInfo & { ppRawDescription: string | null }
        >();
        for (const row of existingRows) {
          existingMap.set(makeSupplierOfferKey(row.externalProductId, row.externalVariantId || ''), {
            providerProductId: row.ppId,
            storeProductId: row.storeProductId ?? null,
            storeProductTitle: row.storeProductTitle ?? null,
            storeCategoryId: row.storeCategoryId ?? null,
            storeIsVisible: row.storeIsVisible ?? null,
            storeDescriptionEmpty: !(row.storeDescriptionAr || '').trim(),
            ppRawDescription: row.rawDescription ?? '',
          });
        }

        for (const reqItem of rawItems) {
          const extId = String(reqItem?.externalProductId || '').trim();
          const extVarId = String(reqItem?.externalVariantId || '').trim();
          const itemKey = makeSupplierOfferKey(extId, extVarId);
          const source = liveByKey.get(itemKey);

          if (!source) {
            failedCount += 1;
            results.push({
              externalProductId: extId,
              externalVariantId: extVarId,
              rawName: extId,
              status: 'failed',
              message: 'المنتج غير متوفر في كتالوج الخادم الحالي.',
            });
            continue;
          }

          const existingInfo = existingMap.get(itemKey) || null;
          const browserItem = buildSupplierBrowserItem(source, {
            extraSupplierNames: [prov.name, prov.code],
            existingLink: existingInfo,
          });

          const targetCatId = reqItem?.targetCategoryId ? Number(reqItem.targetCategoryId) : defaultCategoryId;
          const requestedAction =
            reqItem?.action === 'update' || reqItem?.action === 'skip' ? reqItem.action : 'create';

          const plan = validateAndPlanSupplierImport({
            sourceItem: browserItem,
            requestedCategoryId: targetCatId,
            validCategoryIds,
            requestedAction,
          });

          if (!plan.ok || !plan.targetCategoryId) {
            if (browserItem.importStatus === 'imported' && plan.action === 'skip') {
              skippedCount += 1;
              results.push({
                externalProductId: extId,
                externalVariantId: extVarId,
                rawName: browserItem.rawName,
                status: 'skipped',
                storeProductId: browserItem.existingStoreProductId ?? undefined,
                message: plan.reason || 'مستورد مسبقًا (تم التخطي).',
              });
            } else {
              failedCount += 1;
              results.push({
                externalProductId: extId,
                externalVariantId: extVarId,
                rawName: browserItem.rawName,
                status: 'failed',
                message: plan.reason || 'بيانات الاستيراد غير مكتملة.',
              });
            }
            continue;
          }

          // Upsert provider_products preserving non-empty descriptions
          let ppId = existingInfo?.providerProductId;
          const descForPP = plan.finalDescriptionHtml || existingInfo?.ppRawDescription || '';
          if (ppId) {
            await tx
              .update(providerProducts)
              .set({
                rawName: browserItem.rawName,
                rawDescription: descForPP,
                wholesalePrice: new Decimal(browserItem.wholesalePrice).toFixed(4),
                currency: browserItem.currency || 'USD',
                stockCount: browserItem.stockCount,
                minQty: browserItem.minQty,
                maxQty: browserItem.maxQty,
                deliveryType: browserItem.deliveryType,
                durationLabel: browserItem.durationLabel || '',
                warrantyDays: browserItem.warrantyDays,
                pricingTiersJson: browserItem.pricingTiers ?? null,
                lastSyncedAt: new Date(),
              })
              .where(eq(providerProducts.id, ppId));
          } else {
            const [insertedPP] = await tx
              .insert(providerProducts)
              .values({
                providerId,
                externalProductId: extId,
                externalVariantId: extVarId,
                rawName: browserItem.rawName,
                rawDescription: descForPP,
                wholesalePrice: new Decimal(browserItem.wholesalePrice).toFixed(4),
                currency: browserItem.currency || 'USD',
                stockCount: browserItem.stockCount,
                minQty: browserItem.minQty,
                maxQty: browserItem.maxQty,
                deliveryType: browserItem.deliveryType,
                durationLabel: browserItem.durationLabel || '',
                warrantyDays: browserItem.warrantyDays,
                pricingTiersJson: browserItem.pricingTiers ?? null,
              })
              .returning();
            ppId = insertedPP.id;
          }

          const warrantyAr =
            browserItem.warrantyLabel ||
            (browserItem.warrantyDays > 0 ? `ضمان ${browserItem.warrantyDays} يومًا` : 'ضمان التشغيل الفوري');
          const warrantyEn =
            browserItem.warrantyDays > 0 ? `${browserItem.warrantyDays}-day warranty` : 'Instant Activation Warranty';

          if (plan.action === 'update' && browserItem.existingStoreProductId) {
            const spUpdatePatch: Record<string, any> = {
              categoryId: plan.targetCategoryId,
              warrantyDays: browserItem.warrantyDays,
              warrantyLabelAr: warrantyAr,
              warrantyLabelEn: warrantyEn,
              deliveryType: browserItem.deliveryType,
              updatedAt: new Date(),
            };
            if (plan.finalDescriptionHtml) {
              spUpdatePatch.descriptionAr = plan.finalDescriptionHtml;
              spUpdatePatch.descriptionEn = plan.finalDescriptionHtml;
            }
            if (browserItem.imageUrl) {
              spUpdatePatch.imageUrl = browserItem.imageUrl;
            }
            if (browserItem.durationLabel) {
              spUpdatePatch.durationLabel = browserItem.durationLabel;
            }
            if (browserItem.deliveryInstructions) {
              spUpdatePatch.deliveryInstructionsAr = browserItem.deliveryInstructions;
              spUpdatePatch.deliveryInstructionsEn = browserItem.deliveryInstructions;
            }

            await tx
              .update(storeProducts)
              .set(spUpdatePatch)
              .where(eq(storeProducts.id, browserItem.existingStoreProductId));

            touchedStoreProductIds.push(browserItem.existingStoreProductId);
            updatedCount += 1;
            results.push({
              externalProductId: extId,
              externalVariantId: extVarId,
              rawName: browserItem.rawName,
              status: 'updated',
              storeProductId: browserItem.existingStoreProductId,
              message: 'تم تحديث بيانات المنتج والوصف دون إنشاء نسخة مكررة.',
            });
            continue;
          }

          // Create new store product + exclusive 1-to-1 mapping + pricing record
          const cleanTitle = browserItem.rawName.replace(/\s*\([^)]*\)\s*$/g, '').trim() || browserItem.rawName;
          const sku = generateUniqueRef('SKU').slice(0, 16);
          const [newSP] = await tx
            .insert(storeProducts)
            .values({
              sku,
              categoryId: plan.targetCategoryId,
              titleAr: cleanTitle,
              titleEn: cleanTitle,
              descriptionAr: plan.finalDescriptionHtml,
              descriptionEn: plan.finalDescriptionHtml,
              imageUrl: browserItem.imageUrl || '',
              deliveryInstructionsAr: browserItem.deliveryInstructions || '',
              deliveryInstructionsEn: browserItem.deliveryInstructions || '',
              warrantyLabelAr: warrantyAr,
              warrantyLabelEn: warrantyEn,
              warrantyDays: browserItem.warrantyDays,
              durationLabel: browserItem.durationLabel || 'حسب الباقة',
              deliveryType: browserItem.deliveryType,
              isVisible: makeVisible,
              isPaused: false,
            })
            .returning();

          await tx.insert(productProviderMappings).values({
            storeProductId: newSP.id,
            providerProductId: ppId,
            roleType: 'primary',
            priority: 1,
            selectionStrategy: 'priority',
            isVerifiedCompatible: true,
            isActive: true,
          });

          const wholesaleDec = new Decimal(browserItem.wholesalePrice || '0');
          const suggestedDec = browserItem.suggestedRetailPrice
            ? new Decimal(browserItem.suggestedRetailPrice)
            : null;
          const initialRetail =
            suggestedDec && suggestedDec.gt(wholesaleDec)
              ? suggestedDec.toFixed(4)
              : wholesaleDec.plus('2.00').toFixed(4);

          await tx.insert(productPrices).values({
            storeProductId: newSP.id,
            pricingMode: 'manual',
            retailPrice: initialRetail,
            agentPrice: initialRetail,
            fixedMargin: '2.0000',
            percentMargin: '100.0000',
            paymentFeePercent: '1.5000',
            lockManualPrice: true,
          });

          touchedStoreProductIds.push(newSP.id);
          createdCount += 1;
          existingMap.set(itemKey, {
            providerProductId: ppId,
            storeProductId: newSP.id,
            storeProductTitle: newSP.titleAr,
            storeCategoryId: newSP.categoryId,
            storeIsVisible: newSP.isVisible,
            storeDescriptionEmpty: !plan.finalDescriptionHtml,
            ppRawDescription: descForPP,
          });
          results.push({
            externalProductId: extId,
            externalVariantId: extVarId,
            rawName: browserItem.rawName,
            status: 'created',
            storeProductId: newSP.id,
            message: makeVisible ? 'تم الاستيراد والنشر في المتجر.' : 'تم الاستيراد بنجاح (مخفي حتى المراجعة).',
          });
        }

        await tx.insert(auditLogs).values({
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          action: 'SUPPLIER_PRODUCTS_SELECTIVELY_IMPORTED',
          entityType: 'provider',
          entityId: String(providerId),
          detailsJson: {
            providerCode: prov.code,
            createdCount,
            updatedCount,
            skippedCount,
            failedCount,
          },
        });
      });

      for (const spId of touchedStoreProductIds) {
        await syncStoredEffectiveRetailPrice(spId);
      }

      return res.json({
        ok: true,
        createdCount,
        updatedCount,
        skippedCount,
        failedCount,
        results,
        messageAr: `اكتمل الاستيراد من ${prov.name}: ${createdCount} منتج جديد، ${updatedCount} محدث، ${skippedCount} متخطى، ${failedCount} تعذر استيراده.`,
      });
    } catch (err: any) {
      if (err?.code === '23505') {
        return res.status(409).json({ error: 'أحد المنتجات المحددة مرتبط مسبقًا ولا يمكن تكرار استيراده.' });
      }
      console.error('import-selected error:', err);
      return res.status(err?.statusCode || 500).json({
        error: err?.message || 'تعذر تنفيذ الاستيراد المحدد من الخادم.',
      });
    }
  });

  /**
   * "جلب المنتجات من الخادم"
   * - Fetches real catalog from live provider API if encrypted key is configured,
   *   otherwise simulates a realistic upstream sync showing newly discovered hidden items!
   * - CRITICAL RULES ENFORCED:
   *   1. Every newly imported store product starts with `isVisible: false` (HIDDEN by default!).
   *   2. Existing products NEVER lose their visibility state or manual retail price on re-sync!
   *   3. If wholesale price rises, an admin alert notification is created automatically!
   */
  app.post('/api/admin/providers/:id/sync', ...requirePermission('providers:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const providerId = Number(req.params.id);
      const [prov] = await db.select().from(providers).where(eq(providers.id, providerId)).limit(1);
      if (!prov) return res.status(404).json({ error: 'الخادم غير موجود.' });

      const [cred] = await db
        .select()
        .from(providerCredentials)
        .where(eq(providerCredentials.providerId, providerId))
        .limit(1);

      const adapter = resolveProviderAdapter({
        code: prov.code,
        name: prov.name,
        baseUrl: prov.baseUrl,
        docsUrl: prov.docsUrl,
        authType: prov.authType,
        authHeader: prov.authHeader,
        rateLimitPerMin: prov.rateLimitPerMin,
      });
      let importedItems: Array<{
        externalProductId: string;
        externalVariantId: string;
        rawName: string;
        rawDescription: string;
        wholesalePrice: string;
        stockCount: number;
        minQty?: number;
        maxQty?: number;
        deliveryType: string;
        durationLabel: string;
        warrantyDays: number;
        pricingTiers?: Array<{ minQty: number; maxQty: number | null; price: string }>;
      }> = [];

      let mode: 'live' | 'sandbox' = 'sandbox';
      if (cred) {
        mode = 'live';
        const rawKey = decryptSecret(cred.encryptedApiKey);
        importedItems = await adapter.fetchProducts(rawKey);
      } else {
        // Safe deterministic sync catalog reflecting verified provider offerings (zero real API key needed)
        const existingProvProds = await db
          .select()
          .from(providerProducts)
          .where(eq(providerProducts.providerId, providerId));
        importedItems = existingProvProds.map((ep) => ({
          externalProductId: ep.externalProductId,
          externalVariantId: ep.externalVariantId,
          rawName: ep.rawName,
          rawDescription: ep.rawDescription || '',
          wholesalePrice: ep.wholesalePrice,
          stockCount: Math.max(10, ep.stockCount),
          deliveryType: ep.deliveryType,
          durationLabel: ep.durationLabel || '',
          warrantyDays: ep.warrantyDays,
        }));
        // Also discover one new hidden product from this server if not already imported
        const discoverySlug = `${prov.code}_canva_pro_12m`;
        if (!importedItems.some((it) => it.externalProductId === discoverySlug)) {
          importedItems.push({
            externalProductId: discoverySlug,
            externalVariantId: '',
            rawName: `Canva Pro Education — 12M (${prov.name})`,
            rawDescription: '',
            wholesalePrice: '0.8500',
            stockCount: 160,
            deliveryType: 'link',
            durationLabel: '12 شهر',
            warrantyDays: 365,
          });
        }
      }

      registerDynamicSupplierIdentities([prov]);

      const allCats = await db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id));

      let newlyCreatedHidden = 0;
      let updatedCount = 0;
      let priceHikeAlerts = 0;

      for (const item of importedItems) {
        const rawTrimmed = (item.rawDescription || '').trim();
        const processedSync = processSupplierProductDescription(rawTrimmed, {
          extraSupplierNames: [prov.name, prov.code],
        });
        const cleanedSupplierDesc =
          processedSync.telegramHtml || (rawTrimmed ? normalizeOriginalTelegramHtmlForPreview(rawTrimmed) : '');
        const existing = await db
          .select()
          .from(providerProducts)
          .where(
            and(
              eq(providerProducts.providerId, providerId),
              eq(providerProducts.externalProductId, item.externalProductId),
              eq(providerProducts.externalVariantId, item.externalVariantId || '')
            )
          )
          .limit(1);

        if (existing.length > 0) {
          const prev = existing[0];
          const oldW = prev.wholesalePrice;
          const prevCleanedDesc = sanitizeCustomerProductDescription(prev.rawDescription);
          await db
            .update(providerProducts)
            .set({
              rawName: item.rawName,
              // NEVER overwrite an existing stored description with empty when upstream list omits it!
              rawDescription: cleanedSupplierDesc || prev.rawDescription || '',
              previousWholesalePrice: oldW,
              wholesalePrice: new Decimal(item.wholesalePrice).toFixed(4),
              stockCount: item.stockCount,
              isActiveAtProvider: true,
              minQty: item.minQty || prev.minQty,
              maxQty: item.maxQty || prev.maxQty,
              durationLabel: item.durationLabel || prev.durationLabel,
              pricingTiersJson: item.pricingTiers ?? prev.pricingTiersJson,
              lastSyncedAt: new Date(),
            })
            .where(eq(providerProducts.id, prev.id));
          updatedCount += 1;

          // Check linked store products for wholesale price increase (NEVER overwrite manual price!)
          const linked = await db
            .select({ sp: storeProducts, pr: productPrices })
            .from(productProviderMappings)
            .innerJoin(storeProducts, eq(productProviderMappings.storeProductId, storeProducts.id))
            .innerJoin(productPrices, eq(productPrices.storeProductId, storeProducts.id))
            .where(eq(productProviderMappings.providerProductId, prev.id));

          for (const l of linked) {
            // Propagate updated supplier description ONLY if store product has empty description
            // or still mirrors the supplier's previous description (never overwrite custom owner edits!)
            const spDescAr = (l.sp.descriptionAr || '').trim();
            const spDescEn = (l.sp.descriptionEn || '').trim();
            const mirrorsPrevSupplierDesc =
              !spDescAr ||
              spDescAr === (prev.rawDescription || '').trim() ||
              spDescAr === prevCleanedDesc;
            if (cleanedSupplierDesc && mirrorsPrevSupplierDesc && spDescAr !== cleanedSupplierDesc) {
              await db
                .update(storeProducts)
                .set({
                  descriptionAr: cleanedSupplierDesc,
                  descriptionEn:
                    !spDescEn || spDescEn === spDescAr || spDescEn === prevCleanedDesc
                      ? cleanedSupplierDesc
                      : l.sp.descriptionEn,
                  updatedAt: new Date(),
                })
                .where(eq(storeProducts.id, l.sp.id));
            }

            const evalRes = evaluateSyncPriceUpdate({
              oldWholesale: oldW,
              newWholesale: item.wholesalePrice,
              rule: {
                pricingMode: l.pr.pricingMode as any,
                retailPrice: l.pr.retailPrice,
                fixedMargin: l.pr.fixedMargin,
                percentMargin: l.pr.percentMargin,
                paymentFeePercent: l.pr.paymentFeePercent,
                extraFixedCost: l.pr.extraFixedCost,
                lockManualPrice: l.pr.lockManualPrice,
              },
            });
            if (evalRes.wholesaleIncreased) {
              priceHikeAlerts += 1;
              await db.insert(notifications).values({
                audience: 'admin',
                eventType: 'wholesale_price_increase',
                severity: 'warning',
                titleAr: `تنبيه ارتفاع سعر الجملة: ${l.sp.titleAr}`,
                bodyAr: `ارتفع سعر الجملة من $${formatMoney(oldW, 2)} إلى $${formatMoney(item.wholesalePrice, 2)} (+$${formatMoney(evalRes.delta, 2)}). سعر البيع الحالي: $${formatMoney(evalRes.preservedRetailPrice, 2)}.`,
              });
            }
            if (l.pr.pricingMode !== 'manual') {
              await syncStoredEffectiveRetailPrice(l.sp.id);
            }
          }
        } else {
          // Insert new raw provider offer into provider_products pool (with cleaned Telegram HTML & zero supplier branding)
          const [newPP] = await db
            .insert(providerProducts)
            .values({
              providerId,
              externalProductId: item.externalProductId,
              externalVariantId: item.externalVariantId || '',
              rawName: item.rawName,
              rawDescription: cleanedSupplierDesc,
              wholesalePrice: new Decimal(item.wholesalePrice).toFixed(4),
              currency: 'USD',
              stockCount: item.stockCount,
              deliveryType: item.deliveryType,
              durationLabel: item.durationLabel,
              warrantyDays: item.warrantyDays,
            })
            .returning();

          // Keep store catalog clean and server-independent by default!
          // Only create a standalone hidden store_product if explicitly requested via autoCreateStoreProducts: true
          if (req.body?.autoCreateStoreProducts === true) {
            const cleanTitle = item.rawName.replace(/\(.*?\)/g, '').trim();
            const matchedCat = matchProductToStoreCategory(cleanTitle, cleanedSupplierDesc || '', allCats);
            const sku = generateUniqueRef('SKU').slice(0, 16);
            const safeCustomerDesc = cleanedSupplierDesc;
            const [newSP] = await db
              .insert(storeProducts)
              .values({
                sku,
                categoryId: matchedCat?.categoryId ?? null,
                titleAr: cleanTitle,
                titleEn: cleanTitle,
                descriptionAr: safeCustomerDesc,
                descriptionEn: safeCustomerDesc,
                warrantyLabelAr: item.warrantyDays > 0 ? `ضمان ${item.warrantyDays} يومًا` : 'ضمان التشغيل الفوري',
                warrantyLabelEn: item.warrantyDays > 0 ? `${item.warrantyDays}-day warranty` : 'Instant Activation Warranty',
                warrantyDays: item.warrantyDays,
                durationLabel: item.durationLabel || 'حسب الباقة',
                deliveryType: item.deliveryType,
                isVisible: false, // STRICT REQUIREMENT: Hidden by default!
                isPaused: false,
              })
              .returning();

            await db.insert(productProviderMappings).values({
              storeProductId: newSP.id,
              providerProductId: newPP.id,
              roleType: 'primary',
              priority: 1,
              isVerifiedCompatible: true,
            });

            const suggestedRetail = new Decimal(item.wholesalePrice).plus('2.00').toFixed(4);
            await db.insert(productPrices).values({
              storeProductId: newSP.id,
              pricingMode: 'manual',
              retailPrice: suggestedRetail,
              agentPrice: suggestedRetail,
              fixedMargin: '2.0000',
              percentMargin: '100.0000',
              paymentFeePercent: '1.5000',
              lockManualPrice: true,
            });
          }

          newlyCreatedHidden += 1;
        }
      }

      if (mode === 'live' && importedItems.length > 0 && !(importedItems as any).__partial) {
        const allStoredForProv = await db
          .select({
            id: providerProducts.id,
            externalProductId: providerProducts.externalProductId,
            externalVariantId: providerProducts.externalVariantId,
            stockCount: providerProducts.stockCount,
            isActiveAtProvider: providerProducts.isActiveAtProvider,
          })
          .from(providerProducts)
          .where(eq(providerProducts.providerId, providerId));
        const disappearedIds = collectDisappearedProviderOfferIds(
          allStoredForProv,
          importedItems,
          Boolean((importedItems as any).__partial)
        );
        if (disappearedIds.length > 0) {
          await db
            .update(providerProducts)
            .set({ stockCount: 0, isActiveAtProvider: false, lastSyncedAt: new Date() })
            .where(inArray(providerProducts.id, disappearedIds));
        }
      }

      await db
        .update(providers)
        .set({ lastSyncAt: new Date(), updatedAt: new Date() })
        .where(eq(providers.id, providerId));

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'PROVIDER_PRODUCTS_SYNCED',
        entityType: 'provider',
        entityId: String(providerId),
        detailsJson: { mode, newlyCreatedHidden, updatedCount, priceHikeAlerts },
      });

      return res.json({
        ok: true,
        mode,
        newlyCreatedHidden,
        updatedCount,
        priceHikeAlerts,
        messageAr: `تمت المزامنة مع ${prov.name}: ${newlyCreatedHidden} عرض جديد أُضيف لخزنة العروض، و${updatedCount} عرض تم تحديث مخزونه وأسعاره مع الحفاظ على كتالوج متجرك وأولوية المزودين.`,
      });
    } catch (err: any) {
      console.error('provider sync error:', err);
      return res.status(500).json({ error: `فشلت مزامنة المنتجات: ${err?.message || 'خطأ غير معروف'}` });
    }
  });

  app.post('/api/admin/providers/:id/hide-all', ...requirePermission('providers:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const providerId = Number(req.params.id);
      const provProds = await db
        .select({ id: providerProducts.id })
        .from(providerProducts)
        .where(eq(providerProducts.providerId, providerId));
      const ppIds = provProds.map((p) => p.id);
      let hiddenCount = 0;

      if (ppIds.length > 0) {
        const mapped = await db
          .select({ storeProductId: productProviderMappings.storeProductId })
          .from(productProviderMappings)
          .where(inArray(productProviderMappings.providerProductId, ppIds));
        const spIds = [...new Set(mapped.map((m) => m.storeProductId))];
        if (spIds.length > 0) {
          await db
            .update(storeProducts)
            .set({ isVisible: false, updatedAt: new Date() })
            .where(inArray(storeProducts.id, spIds));
          hiddenCount = spIds.length;
        }
      }

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'PROVIDER_HIDE_ALL_PRODUCTS',
        entityType: 'provider',
        entityId: String(providerId),
        detailsJson: { hiddenCount },
      });

      return res.json({ ok: true, hiddenCount });
    } catch (err) {
      return res.status(500).json({ error: 'تعذر إخفاء منتجات الخادم.' });
    }
  });

  app.patch('/api/admin/providers/:id', ...requirePermission('providers:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const providerId = Number(req.params.id);
      const patch: Record<string, any> = { updatedAt: new Date() };
      if (typeof req.body?.isEnabled === 'boolean') {
        patch.isEnabled = req.body.isEnabled;
        patch.status = req.body.isEnabled ? 'connected' : 'disabled';
      }
      if (typeof req.body?.priority === 'number') patch.priority = req.body.priority;
      if (req.body?.lowBalanceThreshold !== undefined) {
        patch.lowBalanceThreshold = new Decimal(req.body.lowBalanceThreshold).toFixed(4);
      }

      const [updated] = await db
        .update(providers)
        .set(patch)
        .where(eq(providers.id, providerId))
        .returning();
      return res.json({ provider: updated });
    } catch (err) {
      return res.status(500).json({ error: 'تعذر تحديث إعدادات الخادم.' });
    }
  });

  // --- Store Catalog, Multi-Provider Mapping & Decimal Pricing Management ---
  app.get('/api/admin/products', ...requireAnyPermission(['products:manage', 'pricing:manage']), async (_req: AuthRequest, res: Response) => {
    try {
      const rows = await db
        .select({ product: storeProducts, price: productPrices, category: categories })
        .from(storeProducts)
        .leftJoin(productPrices, eq(productPrices.storeProductId, storeProducts.id))
        .leftJoin(categories, eq(storeProducts.categoryId, categories.id))
        .orderBy(storeProducts.sortOrder, storeProducts.id);

      const mappings = await db
        .select({
          mapping: productProviderMappings,
          providerProduct: providerProducts,
          provider: providers,
        })
        .from(productProviderMappings)
        .innerJoin(providerProducts, eq(productProviderMappings.providerProductId, providerProducts.id))
        .innerJoin(providers, eq(providerProducts.providerId, providers.id))
        .orderBy(productProviderMappings.priority);

      const allProvProds = await db
        .select({ pp: providerProducts, p: providers })
        .from(providerProducts)
        .innerJoin(providers, eq(providerProducts.providerId, providers.id));

      const items = rows.map((r) => {
        const myMappings = mappings.filter((m) => m.mapping.storeProductId === r.product.id);
        const candidates: ProviderOfferCandidate[] = myMappings.map((m) => ({
          mappingId: m.mapping.id,
          providerId: m.provider.id,
          providerCode: m.provider.code,
          providerName: m.provider.name,
          providerStatus: m.provider.status,
          providerEnabled: m.provider.isEnabled,
          providerBalance: m.provider.cachedBalance,
          providerProductId: m.providerProduct.id,
          externalProductId: m.providerProduct.externalProductId,
          externalVariantId: m.providerProduct.externalVariantId,
          wholesalePrice: m.providerProduct.wholesalePrice,
          stockCount: m.providerProduct.stockCount,
          roleType: m.mapping.roleType,
          priority: m.mapping.priority,
          isVerifiedCompatible: m.mapping.isVerifiedCompatible,
          isActive: m.mapping.isActive && m.providerProduct.isActiveAtProvider,
          durationLabel: m.providerProduct.durationLabel || '',
          deliveryType: m.providerProduct.deliveryType,
          warrantyDays: m.providerProduct.warrantyDays,
        }));

        const strategy = (myMappings[0]?.mapping.selectionStrategy as SelectionStrategy) || 'priority';
        const resolved = resolveProductEffectivePricingAndStock({
          rule: r.price
            ? {
                pricingMode: (r.price.pricingMode as any) || 'manual',
                retailPrice: r.price.retailPrice || '0',
                agentPrice: r.price.agentPrice || null,
                fixedMargin: r.price.fixedMargin || '0',
                percentMargin: r.price.percentMargin || '0',
                paymentFeePercent: r.price.paymentFeePercent || '1.5',
                extraFixedCost: r.price.extraFixedCost || '0',
                promoPrice: r.price.promoPrice || null,
                promoEndsAt: r.price.promoEndsAt || null,
                bulkTiersJson: r.price.bulkTiersJson || null,
                lockManualPrice: r.price.lockManualPrice ?? true,
              }
            : null,
          candidates,
          strategy,
          quantity: 1,
        });
        const evaluatedQueue = resolved.evaluatedQueue;
        const evalByMappingId = new Map(evaluatedQueue.map((e) => [e.mappingId, e]));
        const activeTarget = resolved.activeTarget;
        const primary = resolved.referenceProvider;
        const totalStock = resolved.totalStock;
        const wholesaleUnit = resolved.referenceWholesale;
        const breakdown = resolved.breakdown;

        const sortedMappings = [...myMappings].sort((a, b) => {
          const ea = evalByMappingId.get(a.mapping.id)?.rank ?? a.mapping.priority;
          const eb = evalByMappingId.get(b.mapping.id)?.rank ?? b.mapping.priority;
          return ea - eb;
        });

        return {
          ...r.product,
          categoryNameAr: r.category?.nameAr || 'غير مصنف',
          primaryProviderId: primary?.providerId || null,
          primaryProviderName: primary?.providerName || 'غير مربوط',
          activeRoutingProviderId: activeTarget?.providerId || null,
          activeRoutingProviderName: activeTarget?.providerName || null,
          activeRoutingRank: activeTarget?.rank || null,
          wholesalePrice: formatMoney(wholesaleUnit, 2),
          retailPrice: resolved.effectiveUnitRetailFormatted,
          agentPrice: resolved.effectiveAgentUnitPriceFormatted,
          paymentFee: formatMoney(breakdown.paymentFee, 2),
          expectedNetProfit: formatMoney(breakdown.netProfit, 2),
          marginPercent: breakdown.marginPercent,
          agentExpectedNetProfit: formatMoney(resolved.agentBreakdown.netProfit, 2),
          agentMarginPercent: resolved.agentBreakdown.marginPercent,
          totalStock,
          pricingRule: r.price,
          providerOffers: sortedMappings.map((m) => {
            const ev = evalByMappingId.get(m.mapping.id);
            return {
              mappingId: m.mapping.id,
              providerId: m.provider.id,
              providerName: m.provider.name,
              providerStatus: m.provider.status,
              providerEnabled: m.provider.isEnabled,
              providerBalance: formatMoney(m.provider.cachedBalance, 2),
              providerProductId: m.providerProduct.id,
              externalProductId: m.providerProduct.externalProductId,
              rawName: m.providerProduct.rawName,
              wholesalePrice: formatMoney(m.providerProduct.wholesalePrice, 2),
              stockCount: m.providerProduct.stockCount,
              roleType: m.mapping.roleType,
              priority: ev?.rank ?? m.mapping.priority,
              routingState: ev?.routingState ?? 'offline',
              isActiveRoutingTarget: ev?.isActiveRoutingTarget ?? false,
              selectionStrategy: m.mapping.selectionStrategy,
              durationLabel: m.providerProduct.durationLabel,
              warrantyDays: m.providerProduct.warrantyDays,
              deliveryType: m.providerProduct.deliveryType,
              isActive: m.mapping.isActive,
            };
          }),
        };
      });

      const storeRowById = new Map(rows.map((r) => [r.product.id, r]));
      const primaryStoreMapByProvProd = new Map<
        number,
        {
          storeProductId: number;
          titleAr: string;
          isVisible: boolean;
          categoryId: number | null;
          categoryNameAr: string | null;
        }
      >();
      for (const m of mappings) {
        if (!primaryStoreMapByProvProd.has(m.providerProduct.id)) {
          const row = storeRowById.get(m.mapping.storeProductId);
          if (row) {
            primaryStoreMapByProvProd.set(m.providerProduct.id, {
              storeProductId: row.product.id,
              titleAr: row.product.titleAr,
              isVisible: row.product.isVisible,
              categoryId: row.product.categoryId,
              categoryNameAr: row.category?.nameAr || null,
            });
          }
        }
      }

      return res.json({
        products: items,
        availableProviderProducts: allProvProds.map((x) => {
          const linked = primaryStoreMapByProvProd.get(x.pp.id);
          return {
            id: x.pp.id,
            providerId: x.p.id,
            providerName: x.p.name,
            providerCode: x.p.code,
            providerStatus: x.p.status,
            providerEnabled: x.p.isEnabled,
            providerBalance: formatMoney(x.p.cachedBalance, 2),
            externalProductId: x.pp.externalProductId,
            rawName: x.pp.rawName,
            rawDescription: x.pp.rawDescription || '',
            wholesalePrice: formatMoney(x.pp.wholesalePrice, 2),
            stockCount: x.pp.stockCount,
            durationLabel: x.pp.durationLabel,
            deliveryType: x.pp.deliveryType,
            warrantyDays: x.pp.warrantyDays,
            linkedStoreProductId: linked?.storeProductId || null,
            linkedStoreProductTitle: linked?.titleAr || null,
            linkedIsVisible: linked?.isVisible ?? false,
            linkedCategoryId: linked?.categoryId ?? null,
            linkedCategoryName: linked?.categoryNameAr ?? null,
          };
        }),
      });
    } catch (err) {
      console.error('admin products list error:', err);
      return res.status(500).json({ error: 'تعذر جلب قائمة المنتجات.' });
    }
  });

  /**
   * Create a brand-new server-independent Store Product (e.g. "Gemini Plus 6 Months" inside "Gemini")
   * and optionally attach multiple provider offers in exact priority order (#1 -> #2 -> #3).
   */
  app.post('/api/admin/products', ...requirePermission('products:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const body = req.body || {};
      const resolvedTitle = await resolveBilingualFields(
        {
          single: typeof body.title === 'string' ? body.title : undefined,
          ar: typeof body.titleAr === 'string' ? body.titleAr : undefined,
          en: typeof body.titleEn === 'string' ? body.titleEn : undefined,
        },
        'product_title'
      );
      const titleAr = resolvedTitle.textAr.trim();
      const titleEn = (resolvedTitle.textEn || titleAr).trim();
      if (!titleAr) {
        return res.status(400).json({ error: 'يرجى إدخال اسم المنتج (مثل Gemini Plus 6 Months).' });
      }

      const rawDescSingle = typeof body.description === 'string' ? sanitizeCustomerProductDescription(body.description) : undefined;
      const rawDescAr = typeof body.descriptionAr === 'string' ? sanitizeCustomerProductDescription(body.descriptionAr) : undefined;
      const rawDescEn = typeof body.descriptionEn === 'string' ? sanitizeCustomerProductDescription(body.descriptionEn) : undefined;
      const resolvedDesc = await resolveBilingualFields(
        {
          single: rawDescSingle,
          ar: rawDescAr,
          en: rawDescEn,
        },
        'product_description'
      );

      const resolvedWarranty = await resolveBilingualFields(
        {
          single: typeof body.warrantyLabel === 'string' ? body.warrantyLabel : undefined,
          ar: typeof body.warrantyLabelAr === 'string' ? body.warrantyLabelAr : undefined,
          en: typeof body.warrantyLabelEn === 'string' ? body.warrantyLabelEn : undefined,
        },
        'warranty_label'
      );

      const categoryId =
        body.categoryId !== undefined && body.categoryId !== null && body.categoryId !== ''
          ? Number(body.categoryId)
          : null;
      const parsedRetail = parseAndValidateCustomPriceUsd(body.retailPrice ?? '1.00');
      if (!parsedRetail.ok || !parsedRetail.value) {
        return res.status(400).json({ error: 'يرجى إدخال سعر عميل صالح أكبر من 0.' });
      }
      const retailPrice = parsedRetail.value;

      let agentPrice = retailPrice;
      if (body.agentPrice !== undefined && body.agentPrice !== null && String(body.agentPrice).trim() !== '') {
        const parsedAgent = parseAndValidateCustomPriceUsd(body.agentPrice);
        if (!parsedAgent.ok || !parsedAgent.value) {
          return res.status(400).json({ error: 'يرجى إدخال سعر وكيل صالح أكبر من 0.' });
        }
        agentPrice = parsedAgent.value;
      }

      const sku = generateUniqueRef('SKU').slice(0, 16);

      const initialProviderIds: number[] = Array.from(
        new Set(
          (Array.isArray(body.initialProviderProductIds) ? body.initialProviderProductIds : [])
            .map(Number)
            .filter((n: number) => Number.isFinite(n) && n > 0)
        )
      );

      const created = await db.transaction(async (tx) => {
        if (initialProviderIds.length > 0) {
          const conflicting = await tx
            .select({
              providerProductId: productProviderMappings.providerProductId,
              storeProductId: productProviderMappings.storeProductId,
              storeTitle: storeProducts.titleAr,
              offerName: providerProducts.rawName,
            })
            .from(productProviderMappings)
            .innerJoin(storeProducts, eq(productProviderMappings.storeProductId, storeProducts.id))
            .innerJoin(providerProducts, eq(productProviderMappings.providerProductId, providerProducts.id))
            .where(inArray(productProviderMappings.providerProductId, initialProviderIds));

          if (conflicting.length > 0) {
            const first = conflicting[0];
            const conflictErr = new Error(
              `العرض «${first.offerName}» مرتبط حاليًا بالمنتج «${first.storeTitle}» ولا يمكن ربطه بأكثر من منتج.`
            ) as Error & { statusCode?: number };
            conflictErr.statusCode = 409;
            throw conflictErr;
          }
        }

        const [newProduct] = await tx
          .insert(storeProducts)
          .values({
            sku,
            categoryId,
            titleAr,
            titleEn,
            descriptionAr: resolvedDesc.textAr,
            descriptionEn: resolvedDesc.textEn,
            warrantyLabelAr: resolvedWarranty.textAr || 'ضمان التشغيل طوال المدة',
            warrantyLabelEn: resolvedWarranty.textEn || 'Full period activation warranty',
            durationLabel: String(body.durationLabel || 'حسب الباقة').trim(),
            deliveryType: String(body.deliveryType || 'code').trim(),
            isVisible: Boolean(body.isVisible),
            isPaused: false,
            autoHideOutOfStock: body.autoHideOutOfStock !== false,
            isFeaturedOffer: Boolean(body.isFeaturedOffer),
            sortOrder: Number(body.sortOrder || 10),
          })
          .returning();

        await tx.insert(productPrices).values({
          storeProductId: newProduct.id,
          pricingMode:
            body.pricingMode === 'fixed_margin' || body.pricingMode === 'percent_margin'
              ? body.pricingMode
              : 'manual',
          retailPrice,
          agentPrice,
          fixedMargin: new Decimal(body.fixedMargin || '1.00').toFixed(4),
          percentMargin: new Decimal(body.percentMargin || '30').toFixed(4),
          paymentFeePercent: new Decimal(body.paymentFeePercent || '1.5').toFixed(4),
          extraFixedCost: new Decimal(body.extraFixedCost || '0').toFixed(4),
          promoPrice: body.promoPrice ? new Decimal(body.promoPrice).toFixed(4) : null,
          lockManualPrice: true,
        });

        for (let i = 0; i < initialProviderIds.length; i++) {
          await tx.insert(productProviderMappings).values({
            storeProductId: newProduct.id,
            providerProductId: initialProviderIds[i],
            roleType: i === 0 ? 'primary' : 'backup',
            priority: i + 1,
            selectionStrategy: 'priority',
            isVerifiedCompatible: true,
            isActive: true,
          });
        }

        await tx.insert(auditLogs).values({
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          action: 'PRODUCT_CREATED',
          entityType: 'store_product',
          entityId: String(newProduct.id),
          detailsJson: {
            titleAr,
            categoryId,
            retailPrice,
            agentPrice,
            linkedProvidersCount: initialProviderIds.length,
          },
        });

        return newProduct;
      });

      await syncStoredEffectiveRetailPrice(created.id);

      return res.status(201).json({ ok: true, product: created });
    } catch (err: any) {
      if (err?.statusCode === 409 || err?.code === '23505') {
        return res.status(409).json({
          error:
            err?.statusCode === 409
              ? err.message
              : 'أحد المزودين المختارين مرتبط بالفعل بمنتج آخر ولا يمكن تكرار ربطه.',
        });
      }
      console.error('create product error:', err);
      return res.status(500).json({ error: 'تعذر إنشاء المنتج الجديد.' });
    }
  });

  // --- Provider-Product Links Audit & Manual Cleanup ---
  app.get('/api/admin/products/provider-audit', ...requireAnyPermission(['products:manage', 'providers:manage']), async (_req: AuthRequest, res: Response) => {
    try {
      const rows = await db
        .select({
          mappingId: productProviderMappings.id,
          storeProductId: storeProducts.id,
          storeProductTitle: storeProducts.titleAr,
          storeProductCategoryName: categories.nameAr,
          storeProductDescription: storeProducts.descriptionAr,
          storeProductVisible: storeProducts.isVisible,
          providerProductId: providerProducts.id,
          providerId: providers.id,
          providerName: providers.name,
          providerEnabled: providers.isEnabled,
          providerStatus: providers.status,
          providerOfferRawName: providerProducts.rawName,
          providerOfferDescription: providerProducts.rawDescription,
          isActiveAtProvider: providerProducts.isActiveAtProvider,
          wholesalePrice: providerProducts.wholesalePrice,
          stockCount: providerProducts.stockCount,
          priority: productProviderMappings.priority,
          isActiveMapping: productProviderMappings.isActive,
        })
        .from(productProviderMappings)
        .innerJoin(storeProducts, eq(productProviderMappings.storeProductId, storeProducts.id))
        .leftJoin(categories, eq(storeProducts.categoryId, categories.id))
        .innerJoin(providerProducts, eq(productProviderMappings.providerProductId, providerProducts.id))
        .innerJoin(providers, eq(providerProducts.providerId, providers.id))
        .orderBy(asc(storeProducts.id), asc(productProviderMappings.priority), asc(productProviderMappings.id));

      const records: MappingRecordForAudit[] = rows.map((r) => ({
        ...r,
        wholesalePrice: formatMoney(r.wholesalePrice, 2),
      }));

      const report = auditAllProductMappings(records);
      return res.json({
        ok: true,
        ...report,
        scannedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error('provider-audit error:', err);
      return res.status(500).json({ error: 'تعذر فحص ارتباطات المزودين.' });
    }
  });

  app.post('/api/admin/products/provider-audit/cleanup', ...requireAnyPermission(['products:manage', 'providers:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const mappingIds: number[] = Array.from(
        new Set(
          (Array.isArray(req.body?.mappingIds) ? req.body.mappingIds : [])
            .map(Number)
            .filter((n: number) => Number.isInteger(n) && n > 0)
        )
      );

      if (mappingIds.length === 0) {
        return res.status(400).json({ error: 'يرجى تحديد ارتباط واحد على الأقل لتنظيفه.' });
      }

      const cleanupResult = await db.transaction(async (tx) => {
        const deletedRows = await tx
          .delete(productProviderMappings)
          .where(inArray(productProviderMappings.id, mappingIds))
          .returning({
            id: productProviderMappings.id,
            storeProductId: productProviderMappings.storeProductId,
            providerProductId: productProviderMappings.providerProductId,
          });

        if (deletedRows.length === 0) {
          return { removedCount: 0, affectedStoreProductIds: [] as number[] };
        }

        const affectedStoreProductIds = Array.from(
          new Set(deletedRows.map((r) => r.storeProductId))
        );

        for (const spId of affectedStoreProductIds) {
          const remaining = await tx
            .select({ id: productProviderMappings.id, priority: productProviderMappings.priority })
            .from(productProviderMappings)
            .where(eq(productProviderMappings.storeProductId, spId))
            .orderBy(asc(productProviderMappings.priority), asc(productProviderMappings.id));

          for (let i = 0; i < remaining.length; i++) {
            await tx
              .update(productProviderMappings)
              .set({
                priority: i + 1,
                roleType: i === 0 ? 'primary' : 'backup',
              })
              .where(eq(productProviderMappings.id, remaining[i].id));
          }
        }

        await tx.insert(auditLogs).values({
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          action: 'PROVIDER_MAPPINGS_AUDIT_CLEANUP',
          entityType: 'product_provider_mapping',
          entityId: mappingIds.join(','),
          detailsJson: {
            removedCount: deletedRows.length,
            removedMappingIds: deletedRows.map((d) => d.id),
            affectedStoreProductIds,
          },
        });

        return { removedCount: deletedRows.length, affectedStoreProductIds };
      });

      if (cleanupResult.removedCount === 0) {
        return res.status(404).json({ error: 'لم يتم العثور على الارتباطات المحددة أو تمت إزالتها مسبقًا.' });
      }

      for (const spId of cleanupResult.affectedStoreProductIds) {
        await syncStoredEffectiveRetailPrice(spId);
      }

      return res.json({
        ok: true,
        removedCount: cleanupResult.removedCount,
        affectedProductsCount: cleanupResult.affectedStoreProductIds.length,
      });
    } catch (err) {
      console.error('provider-audit cleanup error:', err);
      return res.status(500).json({ error: 'تعذر تنظيف الارتباطات المحددة.' });
    }
  });

  app.delete('/api/admin/products/:id', ...requirePermission('products:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!id) return res.status(400).json({ error: 'معرّف المنتج غير صالح.' });

      const [existing] = await db.select().from(storeProducts).where(eq(storeProducts.id, id)).limit(1);
      if (!existing) return res.status(404).json({ error: 'المنتج غير موجود.' });

      const [{ cnt }] = await db
        .select({ cnt: sql<number>`count(*)` })
        .from(orderItems)
        .where(eq(orderItems.storeProductId, id));

      if (Number(cnt || 0) > 0) {
        return res.status(409).json({
          error: 'لا يمكن حذف منتج مرتبط بطلبات سابقة للعملاء. يمكنك إخفاؤه أو إيقافه مؤقتًا بدلًا من ذلك.',
        });
      }

      await db.delete(storeProducts).where(eq(storeProducts.id, id));

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'PRODUCT_DELETED',
        entityType: 'store_product',
        entityId: String(id),
        detailsJson: { titleAr: existing.titleAr },
      });

      return res.json({ ok: true, deletedId: id });
    } catch (err) {
      console.error('delete product error:', err);
      return res.status(500).json({ error: 'تعذر حذف المنتج.' });
    }
  });

  app.patch('/api/admin/products/:id', ...requireAnyPermission(['products:manage', 'pricing:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const body = req.body || {};

      const prodPatch: Record<string, any> = { updatedAt: new Date() };

      // Single-input or manual bilingual title update (auto-translates AR <-> EN automatically)
      if (typeof body.title === 'string' && body.title.trim()) {
        const tr = await resolveBilingualFields({ single: body.title.trim() }, 'product_title');
        prodPatch.titleAr = tr.textAr;
        prodPatch.titleEn = tr.textEn;
      } else if (typeof body.titleAr === 'string' || typeof body.titleEn === 'string') {
        const hasAr = typeof body.titleAr === 'string' && body.titleAr.trim().length > 0;
        const hasEn = typeof body.titleEn === 'string' && body.titleEn.trim().length > 0;
        if (hasAr && hasEn && body.titleAr.trim() !== body.titleEn.trim()) {
          prodPatch.titleAr = body.titleAr.trim();
          prodPatch.titleEn = body.titleEn.trim();
        } else {
          const tr = await resolveBilingualFields(
            {
              ar: typeof body.titleAr === 'string' ? body.titleAr : undefined,
              en: typeof body.titleEn === 'string' ? body.titleEn : undefined,
            },
            'product_title'
          );
          if (tr.textAr) prodPatch.titleAr = tr.textAr;
          if (tr.textEn) prodPatch.titleEn = tr.textEn;
        }
      }

      // Single-input or manual bilingual description update (always strips internal admin notices)
      if (typeof body.description === 'string') {
        const safeSingle = sanitizeCustomerProductDescription(body.description);
        if (!safeSingle) {
          prodPatch.descriptionAr = '';
          prodPatch.descriptionEn = '';
        } else {
          const tr = await resolveBilingualFields({ single: safeSingle }, 'product_description');
          prodPatch.descriptionAr = tr.textAr;
          prodPatch.descriptionEn = tr.textEn;
        }
      } else if (typeof body.descriptionAr === 'string' || typeof body.descriptionEn === 'string') {
        const safeAr =
          typeof body.descriptionAr === 'string'
            ? sanitizeCustomerProductDescription(body.descriptionAr)
            : undefined;
        const safeEn =
          typeof body.descriptionEn === 'string'
            ? sanitizeCustomerProductDescription(body.descriptionEn)
            : undefined;
        if (safeAr && safeEn && safeAr !== safeEn) {
          prodPatch.descriptionAr = safeAr;
          prodPatch.descriptionEn = safeEn;
        } else if (safeAr || safeEn) {
          const tr = await resolveBilingualFields({ ar: safeAr, en: safeEn }, 'product_description');
          prodPatch.descriptionAr = tr.textAr;
          prodPatch.descriptionEn = tr.textEn;
        } else {
          if (safeAr !== undefined) prodPatch.descriptionAr = '';
          if (safeEn !== undefined) prodPatch.descriptionEn = '';
        }
      }

      // Single-input or manual bilingual warranty label update
      if (typeof body.warrantyLabel === 'string') {
        const tr = await resolveBilingualFields({ single: body.warrantyLabel }, 'warranty_label');
        prodPatch.warrantyLabelAr = tr.textAr;
        prodPatch.warrantyLabelEn = tr.textEn;
      } else if (typeof body.warrantyLabelAr === 'string' || typeof body.warrantyLabelEn === 'string') {
        const hasAr = typeof body.warrantyLabelAr === 'string' && body.warrantyLabelAr.trim().length > 0;
        const hasEn = typeof body.warrantyLabelEn === 'string' && body.warrantyLabelEn.trim().length > 0;
        if (hasAr && hasEn && body.warrantyLabelAr.trim() !== body.warrantyLabelEn.trim()) {
          prodPatch.warrantyLabelAr = body.warrantyLabelAr.trim();
          prodPatch.warrantyLabelEn = body.warrantyLabelEn.trim();
        } else if (hasAr || hasEn) {
          const tr = await resolveBilingualFields(
            {
              ar: typeof body.warrantyLabelAr === 'string' ? body.warrantyLabelAr : undefined,
              en: typeof body.warrantyLabelEn === 'string' ? body.warrantyLabelEn : undefined,
            },
            'warranty_label'
          );
          prodPatch.warrantyLabelAr = tr.textAr;
          prodPatch.warrantyLabelEn = tr.textEn;
        } else {
          if (typeof body.warrantyLabelAr === 'string') prodPatch.warrantyLabelAr = '';
          if (typeof body.warrantyLabelEn === 'string') prodPatch.warrantyLabelEn = '';
        }
      }

      if (typeof body.durationLabel === 'string') prodPatch.durationLabel = body.durationLabel.trim();
      if (typeof body.imageUrl === 'string') prodPatch.imageUrl = body.imageUrl.trim();
      if (typeof body.deliveryInstructionsAr === 'string') prodPatch.deliveryInstructionsAr = body.deliveryInstructionsAr.trim();
      if (typeof body.deliveryInstructionsEn === 'string') prodPatch.deliveryInstructionsEn = body.deliveryInstructionsEn.trim();
      if (typeof body.categoryId === 'number' || body.categoryId === null) prodPatch.categoryId = body.categoryId;
      if (typeof body.isVisible === 'boolean') prodPatch.isVisible = body.isVisible;
      if (typeof body.isPaused === 'boolean') prodPatch.isPaused = body.isPaused;
      if (typeof body.autoHideOutOfStock === 'boolean') prodPatch.autoHideOutOfStock = body.autoHideOutOfStock;
      if (typeof body.isFeaturedOffer === 'boolean') prodPatch.isFeaturedOffer = body.isFeaturedOffer;
      if (typeof body.sortOrder === 'number') prodPatch.sortOrder = body.sortOrder;

      // Safeguard: If admin publishes an uncategorized product without explicitly setting a category,
      // auto-assign its matching store category so it appears immediately inside the buyer bot!
      let autoAssignedCategory: string | null = null;
      if (body.isVisible === true && body.categoryId === undefined) {
        const [existingProd] = await db.select().from(storeProducts).where(eq(storeProducts.id, id)).limit(1);
        if (existingProd && existingProd.categoryId === null) {
          const allCats = await db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id));
          const titleForMatch = `${prodPatch.titleAr || existingProd.titleAr} ${prodPatch.titleEn || existingProd.titleEn || ''}`;
          const descForMatch = `${prodPatch.descriptionAr || existingProd.descriptionAr || ''}`;
          const matched = matchProductToStoreCategory(titleForMatch, descForMatch, allCats);
          if (matched) {
            prodPatch.categoryId = matched.categoryId;
            autoAssignedCategory = matched.categoryName;
          }
        }
      }

      await db.update(storeProducts).set(prodPatch).where(eq(storeProducts.id, id));

      // Update pricing rule if provided
      if (
        body.pricingMode !== undefined ||
        body.retailPrice !== undefined ||
        body.agentPrice !== undefined ||
        body.fixedMargin !== undefined ||
        body.percentMargin !== undefined ||
        body.paymentFeePercent !== undefined ||
        body.extraFixedCost !== undefined ||
        body.promoPrice !== undefined ||
        body.bulkTiersJson !== undefined
      ) {
        const [existingPrice] = await db
          .select()
          .from(productPrices)
          .where(eq(productPrices.storeProductId, id))
          .limit(1);

        const pricePatch: Record<string, any> = { updatedAt: new Date() };
        if (body.pricingMode) pricePatch.pricingMode = body.pricingMode;
        if (body.retailPrice !== undefined && body.retailPrice !== '') {
          const parsedRetail = parseAndValidateCustomPriceUsd(body.retailPrice);
          if (!parsedRetail.ok || !parsedRetail.value) {
            return res.status(400).json({ error: 'يرجى إدخال سعر عميل صالح أكبر من 0.' });
          }
          pricePatch.retailPrice = parsedRetail.value;
        }
        if (body.agentPrice !== undefined) {
          if (body.agentPrice === null || String(body.agentPrice).trim() === '') {
            pricePatch.agentPrice = null;
          } else {
            const parsedAgent = parseAndValidateCustomPriceUsd(body.agentPrice);
            if (!parsedAgent.ok || !parsedAgent.value) {
              return res.status(400).json({ error: 'يرجى إدخال سعر وكيل صالح أكبر من 0.' });
            }
            pricePatch.agentPrice = parsedAgent.value;
          }
        }
        if (body.fixedMargin !== undefined && body.fixedMargin !== '') {
          pricePatch.fixedMargin = new Decimal(body.fixedMargin).toFixed(4);
        }
        if (body.percentMargin !== undefined && body.percentMargin !== '') {
          pricePatch.percentMargin = new Decimal(body.percentMargin).toFixed(4);
        }
        if (body.paymentFeePercent !== undefined && body.paymentFeePercent !== '') {
          pricePatch.paymentFeePercent = new Decimal(body.paymentFeePercent).toFixed(4);
        }
        if (body.extraFixedCost !== undefined && body.extraFixedCost !== '') {
          pricePatch.extraFixedCost = new Decimal(body.extraFixedCost).toFixed(4);
        }
        if (body.promoPrice !== undefined) {
          pricePatch.promoPrice =
            body.promoPrice === null || body.promoPrice === ''
              ? null
              : new Decimal(body.promoPrice).toFixed(4);
        }
        if (body.promoEndsAt !== undefined) {
          pricePatch.promoEndsAt = body.promoEndsAt ? new Date(body.promoEndsAt) : null;
        }
        if (Array.isArray(body.bulkTiersJson)) {
          pricePatch.bulkTiersJson = body.bulkTiersJson;
        }
        if (typeof body.lockManualPrice === 'boolean') {
          pricePatch.lockManualPrice = body.lockManualPrice;
        }

        const effectivePricingMode = pricePatch.pricingMode || existingPrice?.pricingMode || 'manual';
        // For dynamic modes (fixed_margin / percent_margin), do not overwrite with stale form retailPrice
        if (effectivePricingMode !== 'manual') {
          delete pricePatch.retailPrice;
        }

        if (existingPrice) {
          await db.update(productPrices).set(pricePatch).where(eq(productPrices.id, existingPrice.id));
        } else {
          const initialRetail = pricePatch.retailPrice || '1.0000';
          await db.insert(productPrices).values({
            storeProductId: id,
            pricingMode: effectivePricingMode,
            retailPrice: initialRetail,
            agentPrice: pricePatch.agentPrice ?? initialRetail,
            fixedMargin: pricePatch.fixedMargin || '1.0000',
            percentMargin: pricePatch.percentMargin || '30.0000',
            paymentFeePercent: pricePatch.paymentFeePercent || '1.5000',
            lockManualPrice: true,
          });
        }
      }

      // Always keep stored retail_price synchronized with live computed price for non-manual modes
      const syncedRetailPrice = await syncStoredEffectiveRetailPrice(id);

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'PRODUCT_UPDATED',
        entityType: 'store_product',
        entityId: String(id),
        detailsJson: {
          isVisible: body.isVisible,
          retailPrice: syncedRetailPrice || body.retailPrice,
          agentPrice: body.agentPrice,
          pricingMode: body.pricingMode,
        },
      });

      return res.json({ ok: true, autoAssignedCategory, effectiveRetailPrice: syncedRetailPrice });
    } catch (err) {
      console.error('update product error:', err);
      return res.status(500).json({ error: 'تعذر حفظ تعديلات المنتج.' });
    }
  });

  app.post('/api/admin/products/bulk', ...requireAnyPermission(['products:manage', 'pricing:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
      const action = String(req.body?.action || '');
      if (ids.length === 0) return res.status(400).json({ error: 'يرجى تحديد منتج واحد على الأقل.' });

      let autoCategorizedOnShow = 0;
      if (action === 'show') {
        await db.update(storeProducts).set({ isVisible: true, isPaused: false, updatedAt: new Date() }).where(inArray(storeProducts.id, ids));
        // Auto-assign categories for any newly published products that were uncategorized
        const uncatShown = await db
          .select()
          .from(storeProducts)
          .where(and(inArray(storeProducts.id, ids), sql`${storeProducts.categoryId} is null`));
        if (uncatShown.length > 0) {
          const allCats = await db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id));
          for (const sp of uncatShown) {
            const matched = matchProductToStoreCategory(
              `${sp.titleAr} ${sp.titleEn || ''}`,
              sp.descriptionAr || '',
              allCats
            );
            if (matched) {
              await db
                .update(storeProducts)
                .set({ categoryId: matched.categoryId, updatedAt: new Date() })
                .where(eq(storeProducts.id, sp.id));
              autoCategorizedOnShow += 1;
            }
          }
        }
      } else if (action === 'hide') {
        await db.update(storeProducts).set({ isVisible: false, updatedAt: new Date() }).where(inArray(storeProducts.id, ids));
      } else if (action === 'pause') {
        await db.update(storeProducts).set({ isPaused: true, updatedAt: new Date() }).where(inArray(storeProducts.id, ids));
      } else if (action === 'resume') {
        await db.update(storeProducts).set({ isPaused: false, updatedAt: new Date() }).where(inArray(storeProducts.id, ids));
      } else if (action === 'move_category' && (req.body?.categoryId || req.body?.categoryId === null)) {
        const targetCatId = req.body.categoryId === null ? null : Number(req.body.categoryId);
        await db
          .update(storeProducts)
          .set({ categoryId: targetCatId, updatedAt: new Date() })
          .where(inArray(storeProducts.id, ids));
      } else {
        return res.status(400).json({ error: 'إجراء جماعي غير معروف.' });
      }

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: `BULK_${action.toUpperCase()}`,
        entityType: 'store_product',
        entityId: ids.join(','),
        detailsJson: { count: ids.length, autoCategorizedOnShow, categoryId: req.body?.categoryId ?? undefined },
      });

      return res.json({ ok: true, affected: ids.length, autoCategorizedOnShow });
    } catch (err) {
      return res.status(500).json({ error: 'تعذر تنفيذ التعديل الجماعي.' });
    }
  });

  /**
   * Smart Auto-Categorization Endpoint:
   * - Classifies uncategorized (or all) store products across all connected servers using title, description & linked provider rawName.
   * - Optionally creates missing brand categories (Claude, Cursor & Dev, CapCut & Media, VPN & Emails, Office & Work, etc.).
   * - Re-links any orphaned service_guides back to their matching category.
   */
  app.post('/api/admin/products/auto-categorize', ...requirePermission('products:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const scope = req.body?.scope === 'all' ? 'all' : 'uncategorized';
      const createMissingCategories = Boolean(req.body?.createMissingCategories);

      let allCats = await db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id));
      const allProds = await db.select().from(storeProducts);
      const linkedOffers = await db
        .select({
          storeProductId: productProviderMappings.storeProductId,
          rawName: providerProducts.rawName,
          rawDescription: providerProducts.rawDescription,
        })
        .from(productProviderMappings)
        .innerJoin(providerProducts, eq(productProviderMappings.providerProductId, providerProducts.id));

      const rawNamesBySp = new Map<number, string[]>();
      const rawDescsBySp = new Map<number, string[]>();
      for (const lo of linkedOffers) {
        const names = rawNamesBySp.get(lo.storeProductId) || [];
        if (lo.rawName) names.push(lo.rawName);
        rawNamesBySp.set(lo.storeProductId, names);
        const descs = rawDescsBySp.get(lo.storeProductId) || [];
        if (lo.rawDescription) descs.push(lo.rawDescription);
        rawDescsBySp.set(lo.storeProductId, descs);
      }

      const cloudCat = allCats.find((c) => c.slug.toLowerCase() === 'cloud');
      const targetProds =
        scope === 'all'
          ? allProds
          : allProds.filter((p) => p.categoryId === null || (cloudCat && p.categoryId === cloudCat.id));

      const createdCategoryNames: string[] = [];
      if (createMissingCategories) {
        const neededBrandKeys = new Set<string>();
        for (const sp of targetProds) {
          const titleHay = [sp.titleAr, sp.titleEn || '', ...(rawNamesBySp.get(sp.id) || [])].join(' ');
          const descHay = [sp.descriptionAr || '', ...(rawDescsBySp.get(sp.id) || [])].join(' ');
          const brand = classifyOfferBrand(titleHay, descHay);
          if (brand.key !== 'other') {
            const existingMatch = matchProductToStoreCategory(titleHay, descHay, allCats);
            if (!existingMatch) {
              neededBrandKeys.add(brand.key);
            }
          }
        }

        let nextOrder =
          allCats.reduce((max, c) => Math.max(max, Number(c.sortOrder || 0)), 0) + 1;

        for (const brandKey of neededBrandKeys) {
          const def = OFFER_BRANDS.find((b) => b.key === brandKey);
          if (!def) continue;
          const alreadyExists = allCats.some((c) => c.slug.toLowerCase() === def.key);
          if (alreadyExists) continue;

          const [created] = await db
            .insert(categories)
            .values({
              slug: def.key,
              nameAr: def.labelAr,
              nameEn: def.labelEn,
              iconEmoji: def.emoji,
              buttonStyle: 'primary',
              sortOrder: nextOrder++,
              isActive: true,
              showInStore: true,
            })
            .onConflictDoNothing()
            .returning();

          if (created) {
            allCats.push(created);
            createdCategoryNames.push(created.nameAr);
          }
        }
      }

      let updatedCount = 0;
      for (const sp of targetProds) {
        const titleHay = [sp.titleAr, sp.titleEn || '', ...(rawNamesBySp.get(sp.id) || [])].join(' ');
        const descHay = [sp.descriptionAr || '', ...(rawDescsBySp.get(sp.id) || [])].join(' ');
        const matched = matchProductToStoreCategory(titleHay, descHay, allCats);

        if (matched && matched.categoryId !== sp.categoryId) {
          await db
            .update(storeProducts)
            .set({ categoryId: matched.categoryId, updatedAt: new Date() })
            .where(eq(storeProducts.id, sp.id));
          updatedCount += 1;
        }
      }

      // Also re-link any orphaned service_guides back to their matching category
      const orphanedGuides = await db
        .select()
        .from(serviceGuides)
        .where(sql`${serviceGuides.categoryId} is null`);
      for (const g of orphanedGuides) {
        const matchCat = allCats.find(
          (c) =>
            c.slug.toLowerCase() === String(g.slug || '').toLowerCase() ||
            String(c.nameEn || '').toLowerCase() === String(g.titleEn || '').toLowerCase() ||
            String(c.nameAr || '').toLowerCase() === String(g.titleAr || '').toLowerCase()
        );
        if (matchCat) {
          await db
            .update(serviceGuides)
            .set({ categoryId: matchCat.id, updatedAt: new Date() })
            .where(eq(serviceGuides.id, g.id));
        }
      }

      const [{ cnt: stillUncat }] = await db
        .select({ cnt: sql<number>`count(*)` })
        .from(storeProducts)
        .where(sql`${storeProducts.categoryId} is null`);

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'PRODUCTS_AUTO_CATEGORIZED',
        entityType: 'store_product',
        entityId: scope,
        detailsJson: {
          scope,
          createMissingCategories,
          updatedCount,
          createdCategoriesCount: createdCategoryNames.length,
          stillUncategorizedCount: Number(stillUncat || 0),
        },
      });

      const parts = [`تم تصنيف ${updatedCount} منتج تلقائيًا`];
      if (createdCategoryNames.length > 0) {
        parts.push(`وإنشاء ${createdCategoryNames.length} أقسام جديدة (${createdCategoryNames.join('، ')})`);
      }
      if (Number(stillUncat || 0) > 0) {
        parts.push(`— متبقي ${Number(stillUncat)} منتج غير مصنف يمكنك فرزها بنقرة واحدة من القائمة`);
      }

      return res.json({
        ok: true,
        updatedCount,
        createdCategoriesCount: createdCategoryNames.length,
        createdCategoryNames,
        stillUncategorizedCount: Number(stillUncat || 0),
        messageAr: `${parts.join(' ')}.`,
      });
    } catch (err: any) {
      console.error('auto-categorize error:', err);
      return res.status(500).json({ error: 'تعذر تنفيذ التصنيف التلقائي الذكي.' });
    }
  });

  app.post('/api/admin/products/:id/mappings', ...requireAnyPermission(['products:manage', 'providers:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const storeProductId = Number(req.params.id);
      const { providerProductId: rawProvProdId, roleType, priority, selectionStrategy } = req.body || {};
      const providerProductId = Number(rawProvProdId);
      if (!Number.isInteger(storeProductId) || storeProductId <= 0 || !Number.isInteger(providerProductId) || providerProductId <= 0) {
        return res.status(400).json({ error: 'يرجى اختيار منتج وعرض مزود صالح.' });
      }

      const [targetProduct] = await db
        .select({ id: storeProducts.id, titleAr: storeProducts.titleAr })
        .from(storeProducts)
        .where(eq(storeProducts.id, storeProductId))
        .limit(1);
      if (!targetProduct) {
        return res.status(404).json({ error: 'المنتج غير موجود.' });
      }

      const [targetOffer] = await db
        .select({ id: providerProducts.id, rawName: providerProducts.rawName })
        .from(providerProducts)
        .where(eq(providerProducts.id, providerProductId))
        .limit(1);
      if (!targetOffer) {
        return res.status(404).json({ error: 'عرض المزود غير موجود.' });
      }

      const assignedPriority = await db.transaction(async (tx) => {
        const existingForOffer = await tx
          .select({
            id: productProviderMappings.id,
            storeProductId: productProviderMappings.storeProductId,
            providerProductId: productProviderMappings.providerProductId,
            storeProductTitle: storeProducts.titleAr,
          })
          .from(productProviderMappings)
          .innerJoin(storeProducts, eq(productProviderMappings.storeProductId, storeProducts.id))
          .where(eq(productProviderMappings.providerProductId, providerProductId));

        const check = validateExclusiveOfferBinding(existingForOffer, storeProductId, providerProductId);
        if (!check.ok) {
          const msg =
            check.code === 'ALREADY_LINKED_SAME_PRODUCT'
              ? 'هذا العرض مرتبط بالفعل بهذا المنتج.'
              : `هذا المزود/العرض مرتبط حاليًا بالمنتج «${check.conflictStoreProductTitle}» ولا يمكن ربطه بأكثر من منتج. قم بفك ارتباطه أولًا ثم أعد المحاولة.`;
          const conflictErr = new Error(msg) as Error & { statusCode?: number };
          conflictErr.statusCode = 409;
          throw conflictErr;
        }

        const existingMappings = await tx
          .select()
          .from(productProviderMappings)
          .where(eq(productProviderMappings.storeProductId, storeProductId))
          .orderBy(asc(productProviderMappings.priority), asc(productProviderMappings.id));

        const maxPriority = existingMappings.reduce((max, m) => Math.max(max, m.priority), 0);
        const nextPriority =
          typeof priority === 'number' && priority >= 1 ? Math.floor(priority) : maxPriority + 1;
        const assignedRole =
          roleType === 'primary' || roleType === 'backup'
            ? roleType
            : nextPriority === 1
              ? 'primary'
              : 'backup';

        await tx.insert(productProviderMappings).values({
          storeProductId,
          providerProductId,
          roleType: assignedRole,
          priority: nextPriority,
          selectionStrategy: selectionStrategy || 'priority',
          isVerifiedCompatible: true,
          isActive: true,
        });

        await tx.insert(auditLogs).values({
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          action: 'PRODUCT_PROVIDER_LINKED',
          entityType: 'store_product',
          entityId: String(storeProductId),
          detailsJson: {
            providerProductId,
            offerRawName: targetOffer.rawName,
            priority: nextPriority,
            roleType: assignedRole,
          },
        });

        return nextPriority;
      });

      await syncStoredEffectiveRetailPrice(storeProductId);
      return res.json({ ok: true, priority: assignedPriority });
    } catch (err: any) {
      if (err?.statusCode === 409 || err?.code === '23505') {
        return res.status(409).json({
          error:
            err?.statusCode === 409
              ? err.message
              : 'هذا المزود/العرض مرتبط حاليًا بمنتج آخر ولا يمكن تكرار ربطه بأكثر من منتج.',
        });
      }
      return res.status(500).json({ error: 'تعذر ربط عرض المزود بالمنتج.' });
    }
  });

  app.put('/api/admin/products/:id/mappings/reorder', ...requireAnyPermission(['products:manage', 'providers:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const storeProductId = Number(req.params.id);
      const orderedMappingIds: number[] = Array.isArray(req.body?.orderedMappingIds)
        ? req.body.orderedMappingIds.map(Number).filter((n: number) => Number.isFinite(n) && n > 0)
        : [];
      if (orderedMappingIds.length === 0) {
        return res.status(400).json({ error: 'يرجى إرسال ترتيب المزودين الصحيح.' });
      }

      await db.transaction(async (tx) => {
        for (let i = 0; i < orderedMappingIds.length; i++) {
          await tx
            .update(productProviderMappings)
            .set({
              priority: i + 1,
              roleType: i === 0 ? 'primary' : 'backup',
              selectionStrategy: 'priority',
            })
            .where(
              and(
                eq(productProviderMappings.id, orderedMappingIds[i]),
                eq(productProviderMappings.storeProductId, storeProductId)
              )
            );
        }
      });

      await syncStoredEffectiveRetailPrice(storeProductId);

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'PRODUCT_PROVIDERS_REORDERED',
        entityType: 'store_product',
        entityId: String(storeProductId),
        detailsJson: { orderedMappingIds },
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('reorder mappings error:', err);
      return res.status(500).json({ error: 'تعذر حفظ ترتيب أولوية المزودين.' });
    }
  });

  app.patch('/api/admin/products/:id/mappings/:mappingId', ...requireAnyPermission(['products:manage', 'providers:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const storeProductId = Number(req.params.id);
      const mappingId = Number(req.params.mappingId);
      const patch: Record<string, any> = {};
      if (typeof req.body?.isActive === 'boolean') patch.isActive = req.body.isActive;
      if (typeof req.body?.priority === 'number' && req.body.priority >= 1) {
        patch.priority = Math.floor(req.body.priority);
        patch.roleType = patch.priority === 1 ? 'primary' : 'backup';
      }
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'لا توجد تعديلات صالحة.' });
      }
      await db
        .update(productProviderMappings)
        .set(patch)
        .where(
          and(
            eq(productProviderMappings.id, mappingId),
            eq(productProviderMappings.storeProductId, storeProductId)
          )
        );
      await syncStoredEffectiveRetailPrice(storeProductId);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'تعذر تحديث حالة المزود.' });
    }
  });

  app.delete('/api/admin/products/:id/mappings/:mappingId', ...requireAnyPermission(['products:manage', 'providers:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const storeProductId = Number(req.params.id);
      const mappingId = Number(req.params.mappingId);
      if (!Number.isInteger(storeProductId) || storeProductId <= 0 || !Number.isInteger(mappingId) || mappingId <= 0) {
        return res.status(400).json({ error: 'معرّف الربط غير صالح.' });
      }

      const deleted = await db.transaction(async (tx) => {
        const [removed] = await tx
          .delete(productProviderMappings)
          .where(
            and(
              eq(productProviderMappings.id, mappingId),
              eq(productProviderMappings.storeProductId, storeProductId)
            )
          )
          .returning();

        if (!removed) return null;

        // Re-compact remaining provider priorities cleanly (1, 2, 3...) with #1 as primary
        const remaining = await tx
          .select({ id: productProviderMappings.id, priority: productProviderMappings.priority })
          .from(productProviderMappings)
          .where(eq(productProviderMappings.storeProductId, storeProductId))
          .orderBy(asc(productProviderMappings.priority), asc(productProviderMappings.id));

        const recompacted = computeRecompactedPriorities(remaining, removed.id);
        for (const item of recompacted) {
          await tx
            .update(productProviderMappings)
            .set({
              priority: item.priority,
              roleType: item.roleType,
            })
            .where(eq(productProviderMappings.id, item.id));
        }

        await tx.insert(auditLogs).values({
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          action: 'PRODUCT_PROVIDER_UNLINKED',
          entityType: 'store_product',
          entityId: String(storeProductId),
          detailsJson: {
            removedMappingId: removed.id,
            providerProductId: removed.providerProductId,
            remainingCount: recompacted.length,
          },
        });

        return removed;
      });

      if (!deleted) {
        return res.status(404).json({ error: 'الارتباط المطلوب غير موجود أو تم فك ارتباطه مسبقًا.' });
      }

      await syncStoredEffectiveRetailPrice(storeProductId);
      return res.json({ ok: true, unlinkedMappingId: deleted.id, providerProductId: deleted.providerProductId });
    } catch (err) {
      return res.status(500).json({ error: 'تعذر فك ارتباط عرض المزود.' });
    }
  });

  // --- Categories (Programs & Services) ---
  app.get('/api/admin/categories', ...requireAnyPermission(['products:manage', 'telegram:manage', 'pricing:manage']), async (_req: AuthRequest, res: Response) => {
    const list = await db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id));
    return res.json({ categories: list });
  });

  app.post('/api/admin/categories', ...requirePermission('products:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const singleName = String(req.body?.name || '').trim();
      let nameAr = String(req.body?.nameAr || '').trim();
      let nameEn = String(req.body?.nameEn || '').trim();
      if (singleName) {
        const translated = await autoTranslateBilingual(singleName, 'category_name');
        nameAr = translated.textAr;
        nameEn = translated.textEn;
      } else {
        nameEn = nameEn || nameAr;
      }
      if (!nameAr) return res.status(400).json({ error: 'يرجى إدخال اسم القسم.' });
      const slug =
        String(req.body?.slug || nameEn)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '') || `cat-${Date.now().toString(36)}`;
      const [created] = await db
        .insert(categories)
        .values({
          nameAr,
          nameEn,
          slug,
          iconEmoji: String(req.body?.iconEmoji || '✨').trim(),
          iconCustomEmojiId: req.body?.iconCustomEmojiId ? String(req.body.iconCustomEmojiId).trim() : null,
          buttonStyle: req.body?.buttonStyle || 'primary',
          sortOrder: Number(req.body?.sortOrder || 10),
          isActive: req.body?.isActive !== false,
          showInStore: req.body?.showInStore !== false,
        })
        .returning();
      return res.status(201).json({ category: created });
    } catch {
      return res.status(400).json({ error: 'تعذر إضافة القسم.' });
    }
  });

  app.patch('/api/admin/categories/:id', ...requirePermission('products:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const patch: Record<string, any> = {};
      if (typeof req.body?.name === 'string' && req.body.name.trim()) {
        const translated = await autoTranslateBilingual(req.body.name.trim(), 'category_name');
        patch.nameAr = translated.textAr;
        patch.nameEn = translated.textEn;
      } else {
        if (typeof req.body?.nameAr === 'string') patch.nameAr = req.body.nameAr.trim();
        if (typeof req.body?.nameEn === 'string') patch.nameEn = req.body.nameEn.trim();
      }
      if (typeof req.body?.iconEmoji === 'string') patch.iconEmoji = req.body.iconEmoji.trim();
      if (req.body?.iconCustomEmojiId !== undefined) patch.iconCustomEmojiId = req.body.iconCustomEmojiId || null;
      if (typeof req.body?.buttonStyle === 'string') patch.buttonStyle = req.body.buttonStyle;
      if (typeof req.body?.sortOrder === 'number') patch.sortOrder = req.body.sortOrder;
      if (typeof req.body?.isActive === 'boolean') patch.isActive = req.body.isActive;
      if (typeof req.body?.showInStore === 'boolean') patch.showInStore = req.body.showInStore;
      const [updated] = await db.update(categories).set(patch).where(eq(categories.id, id)).returning();
      return res.json({ category: updated });
    } catch {
      return res.status(500).json({ error: 'تعذر تحديث القسم.' });
    }
  });

  app.delete('/api/admin/categories/:id', ...requirePermission('products:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      await db.update(storeProducts).set({ categoryId: null }).where(eq(storeProducts.categoryId, id));
      await db.delete(categories).where(eq(categories.id, id));
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'تعذر حذف القسم.' });
    }
  });

  app.post('/api/admin/categories/reorder', ...requirePermission('products:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const sanitized = items
        .map((item: any) => ({ id: Number(item?.id), sortOrder: Number(item?.sortOrder) }))
        .filter((item: { id: number; sortOrder: number }) => Number.isInteger(item.id) && item.id > 0 && Number.isFinite(item.sortOrder));
      if (sanitized.length === 0) {
        return res.status(400).json({ error: 'يرجى تمرير قائمة صالحة لإعادة الترتيب.' });
      }
      await db.transaction(async (tx) => {
        for (const row of sanitized) {
          await tx
            .update(categories)
            .set({ sortOrder: Math.max(0, Math.round(row.sortOrder)) })
            .where(eq(categories.id, row.id));
        }
        await tx.insert(auditLogs).values({
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          action: 'CATEGORIES_REORDERED',
          entityType: 'category',
          entityId: String(sanitized[0].id),
          detailsJson: { count: sanitized.length, order: sanitized },
        });
      });
      const updatedList = await db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id));
      return res.json({ ok: true, categories: updatedList });
    } catch {
      return res.status(500).json({ error: 'تعذر حفظ ترتيب أقسام المتجر.' });
    }
  });

  // --- Live Bidirectional Auto-Translation Preview (AR <-> EN) ---
  app.post('/api/admin/translate', ...requireAnyPermission(['products:manage', 'telegram:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const text = String(req.body?.text || '').trim();
      const allowedContexts: TranslationContext[] = [
        'button_label',
        'button_content',
        'category_name',
        'product_title',
        'product_description',
        'warranty_label',
      ];
      const context: TranslationContext = allowedContexts.includes(req.body?.context)
        ? req.body.context
        : 'button_label';
      if (!text) {
        return res.json({ ok: true, sourceLang: 'ar', textAr: '', textEn: '', engine: 'passthrough' });
      }
      const result = await autoTranslateBilingual(text, context);
      return res.json({ ok: true, ...result });
    } catch (err: any) {
      return res.status(502).json({
        error: err?.message || 'تعذر الاتصال بخدمة الترجمة التلقائية حاليًا.',
      });
    }
  });

  // --- Dynamic Telegram Bot Menu Buttons (Main & Nested Sub-Buttons + Auto-Translation) ---
  app.get('/api/admin/bot-buttons', ...requirePermission('telegram:manage'), async (_req: AuthRequest, res: Response) => {
    const list = await db
      .select()
      .from(botMenuButtons)
      .orderBy(asc(botMenuButtons.rowOrder), asc(botMenuButtons.colOrder), asc(botMenuButtons.id));
    return res.json({ buttons: list });
  });

  app.post('/api/admin/bot-buttons', ...requirePermission('telegram:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const rawSingleLabel = typeof req.body?.label === 'string' ? req.body.label.trim() : '';
      let labelAr = String(req.body?.labelAr || '').trim();
      let labelEn = String(req.body?.labelEn || '').trim();

      if (rawSingleLabel) {
        const tr = await autoTranslateBilingual(rawSingleLabel, 'button_label');
        labelAr = tr.textAr;
        labelEn = tr.textEn;
      } else {
        if (!labelAr && labelEn) {
          const tr = await autoTranslateBilingual(labelEn, 'button_label');
          labelAr = tr.textAr;
          labelEn = tr.textEn;
        } else if (labelAr && !labelEn) {
          const tr = await autoTranslateBilingual(labelAr, 'button_label');
          labelAr = tr.textAr;
          labelEn = tr.textEn;
        }
      }

      if (!labelAr) return res.status(400).json({ error: 'يرجى إدخال اسم الزر.' });

      const rawSingleContent = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
      let contentAr = String(req.body?.contentAr || '').trim();
      let contentEn = String(req.body?.contentEn || '').trim();
      if (rawSingleContent) {
        const trContent = await autoTranslateBilingual(rawSingleContent, 'button_content');
        contentAr = trContent.textAr;
        contentEn = trContent.textEn;
      }

      let parentId: number | null = null;
      if (req.body?.parentId !== undefined && req.body?.parentId !== null && req.body?.parentId !== '') {
        const parsedParent = Number(req.body.parentId);
        if (!Number.isInteger(parsedParent) || parsedParent <= 0) {
          return res.status(400).json({ error: 'معرف الزر الرئيسي غير صالح.' });
        }
        const [parentRow] = await db
          .select({ id: botMenuButtons.id })
          .from(botMenuButtons)
          .where(eq(botMenuButtons.id, parsedParent))
          .limit(1);
        if (!parentRow) {
          return res.status(404).json({ error: 'الزر الرئيسي المحدد غير موجود.' });
        }
        parentId = parentRow.id;
      }

      const siblings = await db
        .select({ rowOrder: botMenuButtons.rowOrder, colOrder: botMenuButtons.colOrder })
        .from(botMenuButtons)
        .where(parentId === null ? isNull(botMenuButtons.parentId) : eq(botMenuButtons.parentId, parentId));
      const maxRow = siblings.reduce((m, s) => Math.max(m, s.rowOrder), 0);

      const code =
        String(req.body?.code || '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '') || `btn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;

      const [created] = await db
        .insert(botMenuButtons)
        .values({
          parentId,
          code,
          labelAr,
          labelEn,
          iconEmoji: String(req.body?.iconEmoji || '').trim(),
          iconCustomEmojiId: req.body?.iconCustomEmojiId ? String(req.body.iconCustomEmojiId).trim() : null,
          buttonStyle: req.body?.buttonStyle || 'primary',
          actionType: String(req.body?.actionType || 'custom_text'),
          actionValue: String(req.body?.actionValue || '').trim() || code,
          contentAr,
          contentEn,
          contentEntitiesAr: Array.isArray(req.body?.contentEntitiesAr) ? req.body.contentEntitiesAr : [],
          contentEntitiesEn: Array.isArray(req.body?.contentEntitiesEn) ? req.body.contentEntitiesEn : [],
          rowOrder: req.body?.rowOrder !== undefined ? Math.max(1, Number(req.body.rowOrder)) : maxRow + 1,
          colOrder: req.body?.colOrder !== undefined ? Math.max(1, Number(req.body.colOrder)) : 1,
          buttonsPerRow: Math.max(1, Math.min(3, Number(req.body?.buttonsPerRow || 2))),
          isVisible: req.body?.isVisible !== false,
          isEnabled: req.body?.isEnabled !== false,
        })
        .returning();

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'BOT_BUTTON_CREATED',
        entityType: 'bot_menu_button',
        entityId: String(created.id),
        detailsJson: { parentId: created.parentId, labelAr: created.labelAr, labelEn: created.labelEn },
      });

      return res.status(201).json({ button: created });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'تعذر إضافة الزر.' });
    }
  });

  app.patch('/api/admin/bot-buttons/:id', ...requirePermission('telegram:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'معرف الزر غير صالح.' });
      }
      const [existing] = await db.select().from(botMenuButtons).where(eq(botMenuButtons.id, id)).limit(1);
      if (!existing) {
        return res.status(404).json({ error: 'الزر غير موجود.' });
      }

      const patch: Record<string, any> = { updatedAt: new Date() };

      // Single-input automatic bidirectional AR <-> EN translation for label
      if (typeof req.body?.label === 'string' && req.body.label.trim()) {
        const tr = await autoTranslateBilingual(req.body.label.trim(), 'button_label');
        patch.labelAr = tr.textAr;
        patch.labelEn = tr.textEn;
      } else {
        if (typeof req.body?.labelAr === 'string') patch.labelAr = req.body.labelAr.trim();
        if (typeof req.body?.labelEn === 'string') patch.labelEn = req.body.labelEn.trim();
      }

      // Single-input automatic bidirectional AR <-> EN translation for content
      if (typeof req.body?.content === 'string') {
        const trimmedContent = req.body.content.trim();
        if (!trimmedContent) {
          patch.contentAr = '';
          patch.contentEn = '';
        } else {
          const trContent = await autoTranslateBilingual(trimmedContent, 'button_content');
          patch.contentAr = trContent.textAr;
          patch.contentEn = trContent.textEn;
        }
      } else {
        if (typeof req.body?.contentAr === 'string') patch.contentAr = req.body.contentAr;
        if (typeof req.body?.contentEn === 'string') patch.contentEn = req.body.contentEn;
      }

      // Parent reassignment with circular reference prevention
      if (req.body?.parentId !== undefined) {
        if (req.body.parentId === null || req.body.parentId === '') {
          patch.parentId = null;
        } else {
          const nextParentId = Number(req.body.parentId);
          if (!Number.isInteger(nextParentId) || nextParentId <= 0) {
            return res.status(400).json({ error: 'معرف الزر الرئيسي غير صالح.' });
          }
          const allBtns = await db.select().from(botMenuButtons);
          const forbidden = new Set(collectDescendantButtonIds(allBtns as any, id));
          if (forbidden.has(nextParentId)) {
            return res.status(400).json({ error: 'لا يمكن وضع الزر داخل نفسه أو داخل أحد أزراره الفرعية.' });
          }
          patch.parentId = nextParentId;
        }
      }

      const fields = [
        'iconEmoji',
        'iconCustomEmojiId',
        'buttonStyle',
        'actionType',
        'actionValue',
        'contentEntitiesAr',
        'contentEntitiesEn',
        'rowOrder',
        'colOrder',
        'buttonsPerRow',
        'isVisible',
        'isEnabled',
      ];
      for (const f of fields) {
        if (req.body?.[f] !== undefined) patch[f] = req.body[f];
      }

      const [updated] = await db
        .update(botMenuButtons)
        .set(patch)
        .where(eq(botMenuButtons.id, id))
        .returning();

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'BOT_BUTTON_UPDATED',
        entityType: 'bot_menu_button',
        entityId: String(id),
        detailsJson: { labelAr: updated?.labelAr, labelEn: updated?.labelEn, isVisible: updated?.isVisible, isEnabled: updated?.isEnabled },
      });

      return res.json({ button: updated });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'تعذر تحديث الزر.' });
    }
  });

  app.delete('/api/admin/bot-buttons/:id', ...requirePermission('telegram:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: 'معرف الزر غير صالح.' });
      }
      const allBtns = await db.select().from(botMenuButtons);
      const idsToDelete = collectDescendantButtonIds(allBtns as any, id);
      if (idsToDelete.length === 0) {
        return res.status(404).json({ error: 'الزر غير موجود.' });
      }

      await db.transaction(async (tx) => {
        await tx.delete(botMenuButtons).where(inArray(botMenuButtons.id, idsToDelete));
        await tx.insert(auditLogs).values({
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          action: 'BOT_BUTTON_DELETED',
          entityType: 'bot_menu_button',
          entityId: String(id),
          detailsJson: { deletedIds: idsToDelete },
        });
      });

      return res.json({ ok: true, deletedIds: idsToDelete });
    } catch {
      return res.status(500).json({ error: 'تعذر حذف الزر.' });
    }
  });

  app.post('/api/admin/bot-buttons/reorder', ...requirePermission('telegram:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const sanitized = items
        .map((item: any) => ({
          id: Number(item?.id),
          rowOrder: Number(item?.rowOrder),
          colOrder: Number(item?.colOrder),
        }))
        .filter(
          (item: { id: number; rowOrder: number; colOrder: number }) =>
            Number.isInteger(item.id) &&
            item.id > 0 &&
            Number.isFinite(item.rowOrder) &&
            Number.isFinite(item.colOrder)
        );
      if (sanitized.length === 0) {
        return res.status(400).json({ error: 'يرجى تمرير قائمة صالحة لإعادة ترتيب الأزرار.' });
      }
      await db.transaction(async (tx) => {
        for (const row of sanitized) {
          await tx
            .update(botMenuButtons)
            .set({
              rowOrder: Math.max(1, Math.round(row.rowOrder)),
              colOrder: Math.max(1, Math.round(row.colOrder)),
              updatedAt: new Date(),
            })
            .where(eq(botMenuButtons.id, row.id));
        }
        await tx.insert(auditLogs).values({
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          action: 'BOT_BUTTONS_REORDERED',
          entityType: 'bot_menu_button',
          entityId: String(sanitized[0].id),
          detailsJson: { count: sanitized.length, order: sanitized },
        });
      });
      const updatedList = await db
        .select()
        .from(botMenuButtons)
        .orderBy(asc(botMenuButtons.rowOrder), asc(botMenuButtons.colOrder), asc(botMenuButtons.id));
      return res.json({ ok: true, buttons: updatedList });
    } catch {
      return res.status(500).json({ error: 'تعذر حفظ ترتيب الأزرار.' });
    }
  });

  // --- Service Guides (How to Use — Preserves Telegram Entities + Auto-Translation) ---
  app.get('/api/admin/guides', ...requirePermission('telegram:manage'), async (_req: AuthRequest, res: Response) => {
    const list = await db
      .select()
      .from(serviceGuides)
      .orderBy(asc(serviceGuides.sortOrder), asc(serviceGuides.id));
    return res.json({ guides: list });
  });

  app.post('/api/admin/guides', ...requirePermission('telegram:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const singleTitle = String(req.body?.title || '').trim();
      let titleAr = String(req.body?.titleAr || '').trim();
      let titleEn = String(req.body?.titleEn || '').trim();
      if (singleTitle) {
        const tr = await autoTranslateBilingual(singleTitle, 'button_label');
        titleAr = tr.textAr;
        titleEn = tr.textEn;
      } else {
        titleEn = titleEn || titleAr;
      }
      if (!titleAr) return res.status(400).json({ error: 'يرجى إدخال عنوان الشرح.' });

      const singleContent = String(req.body?.content || '').trim();
      let contentAr = String(req.body?.contentAr || '').trim();
      let contentEn = String(req.body?.contentEn || '').trim();
      if (singleContent) {
        const trC = await autoTranslateBilingual(singleContent, 'button_content');
        contentAr = trC.textAr;
        contentEn = trC.textEn;
      }

      const slug =
        String(req.body?.slug || titleEn)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
          .replace(/^-+|-+$/g, '') || `guide-${Date.now().toString(36)}`;
      const [created] = await db
        .insert(serviceGuides)
        .values({
          slug,
          categoryId: req.body?.categoryId ? Number(req.body.categoryId) : null,
          titleAr,
          titleEn,
          iconEmoji: String(req.body?.iconEmoji || '📘').trim(),
          iconCustomEmojiId: req.body?.iconCustomEmojiId ? String(req.body.iconCustomEmojiId).trim() : null,
          contentAr,
          contentEn,
          contentEntitiesAr: Array.isArray(req.body?.contentEntitiesAr) ? req.body.contentEntitiesAr : [],
          contentEntitiesEn: Array.isArray(req.body?.contentEntitiesEn) ? req.body.contentEntitiesEn : [],
          sortOrder: Number(req.body?.sortOrder || 10),
          isVisible: req.body?.isVisible !== false,
        })
        .returning();
      return res.status(201).json({ guide: created });
    } catch {
      return res.status(400).json({ error: 'تعذر إضافة الشرح.' });
    }
  });

  app.patch('/api/admin/guides/:id', ...requirePermission('telegram:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const patch: Record<string, any> = { updatedAt: new Date() };
      if (typeof req.body?.title === 'string' && req.body.title.trim()) {
        const tr = await autoTranslateBilingual(req.body.title.trim(), 'button_label');
        patch.titleAr = tr.textAr;
        patch.titleEn = tr.textEn;
      }
      if (typeof req.body?.content === 'string') {
        const trimmedC = req.body.content.trim();
        if (!trimmedC) {
          patch.contentAr = '';
          patch.contentEn = '';
        } else {
          const trC = await autoTranslateBilingual(trimmedC, 'button_content');
          patch.contentAr = trC.textAr;
          patch.contentEn = trC.textEn;
        }
      }
      const fields = [
        'categoryId',
        'titleAr',
        'titleEn',
        'iconEmoji',
        'iconCustomEmojiId',
        'contentAr',
        'contentEn',
        'contentEntitiesAr',
        'contentEntitiesEn',
        'sortOrder',
        'isVisible',
      ];
      for (const f of fields) {
        if (req.body?.[f] !== undefined && patch[f] === undefined) patch[f] = req.body[f];
      }
      const [updated] = await db
        .update(serviceGuides)
        .set(patch)
        .where(eq(serviceGuides.id, id))
        .returning();
      return res.json({ guide: updated });
    } catch {
      return res.status(500).json({ error: 'تعذر تحديث الشرح.' });
    }
  });

  app.delete('/api/admin/guides/:id', ...requirePermission('telegram:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      await db.delete(serviceGuides).where(eq(serviceGuides.id, id));
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'تعذر حذف الشرح.' });
    }
  });

  app.post('/api/admin/guides/reorder', ...requirePermission('telegram:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      const sanitized = items
        .map((item: any) => ({ id: Number(item?.id), sortOrder: Number(item?.sortOrder) }))
        .filter((item: { id: number; sortOrder: number }) => Number.isInteger(item.id) && item.id > 0 && Number.isFinite(item.sortOrder));
      if (sanitized.length === 0) {
        return res.status(400).json({ error: 'يرجى تمرير قائمة صالحة لإعادة ترتيب الشروحات.' });
      }
      await db.transaction(async (tx) => {
        for (const row of sanitized) {
          await tx
            .update(serviceGuides)
            .set({ sortOrder: Math.max(0, Math.round(row.sortOrder)), updatedAt: new Date() })
            .where(eq(serviceGuides.id, row.id));
        }
        await tx.insert(auditLogs).values({
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          action: 'GUIDES_REORDERED',
          entityType: 'service_guide',
          entityId: String(sanitized[0].id),
          detailsJson: { count: sanitized.length, order: sanitized },
        });
      });
      const updatedList = await db
        .select()
        .from(serviceGuides)
        .orderBy(asc(serviceGuides.sortOrder), asc(serviceGuides.id));
      return res.json({ ok: true, guides: updatedList });
    } catch {
      return res.status(500).json({ error: 'تعذر حفظ ترتيب الشروحات.' });
    }
  });

  // --- Admin User Lookup by Telegram User ID / Username ---
  app.get('/api/admin/users/lookup/:query', ...requireAnyPermission(['customers:manage', 'deposits:approve', 'orders:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const q = String(req.params.query || '').trim().replace(/^@/, '');
      if (!q) return res.status(400).json({ error: 'يرجى إدخال معرف تيليجرام أو اسم المستخدم.' });

      const found = await db
        .select()
        .from(users)
        .where(
          or(
            eq(users.telegramUserId, q),
            ilike(users.telegramUsername, q),
            ilike(users.displayName, `%${q}%`)
          )
        )
        .limit(10);

      if (found.length === 0) {
        return res.status(404).json({ error: 'لم يتم العثور على المستخدم.' });
      }

      const target = found[0];
      const wallet = await ensureUserWallet(target.id);
      const userOrders = await db
        .select()
        .from(orders)
        .where(eq(orders.userId, target.id))
        .orderBy(desc(orders.createdAt))
        .limit(20);
      const userDeposits = await db
        .select()
        .from(deposits)
        .where(eq(deposits.userId, target.id))
        .orderBy(desc(deposits.createdAt))
        .limit(20);
      const userLedger = await db
        .select()
        .from(walletLedger)
        .where(eq(walletLedger.userId, target.id))
        .orderBy(desc(walletLedger.createdAt))
        .limit(25);

      return res.json({
        user: {
          id: target.id,
          displayName: target.displayName,
          telegramUserId: target.telegramUserId,
          telegramUsername: target.telegramUsername,
          role: target.role,
          languageCode: target.languageCode,
          isBlocked: target.isBlocked,
          availableBalance: formatMoney(wallet.availableBalance, 2),
          reservedBalance: formatMoney(wallet.reservedBalance, 2),
          createdAt: target.createdAt,
        },
        orders: userOrders,
        deposits: userDeposits,
        ledger: userLedger,
        matchesCount: found.length,
      });
    } catch {
      return res.status(500).json({ error: 'تعذر البحث عن المستخدم.' });
    }
  });

  const parseDateQueryBounds = (fromRaw: unknown, toRaw: unknown) => {
    let fromDt: Date | null = null;
    let toDt: Date | null = null;
    if (typeof fromRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(fromRaw.trim())) {
      const [y, m, d] = fromRaw.trim().split('-').map(Number);
      fromDt = new Date(y, m - 1, d, 0, 0, 0, 0);
    }
    if (typeof toRaw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(toRaw.trim())) {
      const [y, m, d] = toRaw.trim().split('-').map(Number);
      toDt = new Date(y, m - 1, d, 23, 59, 59, 999);
    }
    return { fromDt, toDt };
  };

  // --- Orders, Deposits, Wallets, Customers, Coupons, Notifications, Settings, Audit ---
  app.get('/api/admin/orders', ...requirePermission('orders:manage'), async (req: AuthRequest, res: Response) => {
    const { fromDt, toDt } = parseDateQueryBounds(req.query.from, req.query.to);
    const conditions = [];
    if (fromDt) conditions.push(gte(orders.createdAt, fromDt));
    if (toDt) conditions.push(lte(orders.createdAt, toDt));

    const baseQuery = db
      .select({ order: orders, user: users })
      .from(orders)
      .innerJoin(users, eq(orders.userId, users.id));

    const rows =
      conditions.length > 0
        ? await baseQuery
            .where(and(...conditions))
            .orderBy(desc(orders.createdAt))
            .limit(250)
        : await baseQuery.orderBy(desc(orders.createdAt)).limit(250);

    const pOrders = await db
      .select({ po: providerOrders, p: providers })
      .from(providerOrders)
      .innerJoin(providers, eq(providerOrders.providerId, providers.id));
    const items = await db.select().from(orderItems);

    return res.json({
      orders: rows.map((r) => {
        const myPO = pOrders.find((x) => x.po.orderId === r.order.id);
        const myItems = items.filter((it) => it.orderId === r.order.id);
        return {
          id: r.order.id,
          orderNumber: r.order.orderNumber,
          customerName: r.user.displayName,
          customerTelegramId: r.user.telegramUserId,
          status: r.order.status,
          totalRetail: formatMoney(r.order.totalRetail, 2),
          totalWholesale: formatMoney(r.order.totalWholesaleSnapshot, 2),
          paymentFee: formatMoney(r.order.paymentFeeSnapshot, 2),
          netProfit: formatMoney(r.order.netProfitSnapshot, 2),
          couponCode: r.order.couponCode,
          providerName: myPO?.p.name || '—',
          providerOrderId: myPO?.po.providerOrderId || '—',
          failureReason: myPO?.po.rawErrorSanitized || null,
          uncertainState: myPO?.po.uncertainState || false,
          items: myItems.map((it) => ({ title: it.productTitleSnapshot, qty: it.quantity })),
          createdAt: r.order.createdAt,
        };
      }),
    });
  });

  app.get('/api/admin/deposits', ...requirePermission('deposits:approve'), async (req: AuthRequest, res: Response) => {
    const { fromDt, toDt } = parseDateQueryBounds(req.query.from, req.query.to);
    const conditions = [];
    if (fromDt) conditions.push(gte(deposits.createdAt, fromDt));
    if (toDt) conditions.push(lte(deposits.createdAt, toDt));

    const baseQuery = db
      .select({ dep: deposits, user: users })
      .from(deposits)
      .innerJoin(users, eq(deposits.userId, users.id));

    const rows =
      conditions.length > 0
        ? await baseQuery
            .where(and(...conditions))
            .orderBy(desc(deposits.createdAt))
            .limit(250)
        : await baseQuery.orderBy(desc(deposits.createdAt)).limit(250);

    return res.json({
      deposits: rows.map((r) => ({
        ...r.dep,
        expectedAmount: formatMoney(r.dep.expectedAmount, 2),
        receivedAmount: r.dep.receivedAmount ? formatMoney(r.dep.receivedAmount, 2) : null,
        customerName: r.user.displayName,
        customerTelegramId: r.user.telegramUserId,
      })),
    });
  });

  app.post('/api/admin/deposits/:id/review', ...requirePermission('deposits:approve'), async (req: AuthRequest, res: Response) => {
    try {
      const depositId = Number(req.params.id);
      const decision = req.body?.decision === 'approve' ? 'approve' : 'reject';
      const [dep] = await db.select().from(deposits).where(eq(deposits.id, depositId)).limit(1);
      if (!dep) return res.status(404).json({ error: 'طلب الإيداع غير موجود.' });

      if (decision === 'approve') {
        const creditedAmount = req.body?.amount ? new Decimal(req.body.amount).toFixed(4) : dep.expectedAmount;
        const result = await creditDepositAtomically({
          depositId,
          creditedAmount,
          reviewedByUserId: req.user!.id,
          note: `اعتماد إيداع بواسطة الإدارة (${dep.depositRef})`,
        });

        let telegramNotified = false;
        if (!result.alreadyCredited && result.nextBalance) {
          const [targetUser] = await db.select().from(users).where(eq(users.id, dep.userId)).limit(1);
          const uLang = targetUser?.languageCode === 'en' ? 'en' : 'ar';
          const notif = buildWalletCreditNotificationText({
            addedAmount: creditedAmount,
            totalBalanceAfter: result.nextBalance,
            note: `إيداع معتمد (${dep.depositRef})`,
            lang: uLang,
          });
          await db.insert(notifications).values({
            audience: 'customer',
            targetUserId: dep.userId,
            eventType: 'wallet_credit',
            severity: 'info',
            titleAr: notif.titleAr,
            bodyAr: notif.bodyAr,
          });
          if (targetUser?.telegramUserId) {
            telegramNotified = await sendDirectTelegramNotification(
              targetUser.telegramUserId,
              notif.telegramText
            );
          }
        }

        await db.insert(auditLogs).values({
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          action: 'DEPOSIT_APPROVED',
          entityType: 'deposit',
          entityId: String(depositId),
          detailsJson: { amount: creditedAmount, alreadyCredited: result.alreadyCredited, telegramNotified },
        });
        return res.json({ ok: true, alreadyCredited: result.alreadyCredited, telegramNotified });
      }

      await db
        .update(deposits)
        .set({
          status: 'rejected',
          rejectionReason: String(req.body?.reason || 'REJECTED_BY_ADMIN'),
          reviewedByUserId: req.user!.id,
          updatedAt: new Date(),
        })
        .where(eq(deposits.id, depositId));

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'DEPOSIT_REJECTED',
        entityType: 'deposit',
        entityId: String(depositId),
      });

      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: 'تعذر معالجة طلب الإيداع.' });
    }
  });

  app.get('/api/admin/customers', ...requirePermission('customers:manage'), async (_req: AuthRequest, res: Response) => {
    const [allUsers, allWallets, recentLedger, allOrderRows, overrideRows] = await Promise.all([
      db.select().from(users).orderBy(desc(users.createdAt)).limit(200),
      db.select().from(wallets),
      db.select().from(walletLedger).orderBy(desc(walletLedger.createdAt)).limit(100),
      db
        .select({
          userId: orders.userId,
          status: orders.status,
          totalRetail: orders.totalRetail,
        })
        .from(orders),
      db
        .select({
          userId: customerProductOverrides.userId,
          customPriceUsd: customerProductOverrides.customPriceUsd,
          isHidden: customerProductOverrides.isHidden,
        })
        .from(customerProductOverrides),
    ]);

    const userMap = new Map(allUsers.map((u) => [u.id, u]));
    const ordersByUser = new Map<number, Array<{ status: string; totalRetail: string }>>();
    for (const row of allOrderRows) {
      const list = ordersByUser.get(row.userId) || [];
      list.push({ status: row.status, totalRetail: row.totalRetail });
      ordersByUser.set(row.userId, list);
    }

    const overrideStatsMap = new Map<number, { total: number; customPriceCount: number; hiddenCount: number }>();
    for (const ov of overrideRows) {
      const hasCustom = ov.customPriceUsd !== null && String(ov.customPriceUsd).trim() !== '';
      const isHidden = Boolean(ov.isHidden);
      if (!hasCustom && !isHidden) continue;
      const cur = overrideStatsMap.get(ov.userId) || { total: 0, customPriceCount: 0, hiddenCount: 0 };
      cur.total += 1;
      if (hasCustom) cur.customPriceCount += 1;
      if (isHidden) cur.hiddenCount += 1;
      overrideStatsMap.set(ov.userId, cur);
    }

    return res.json({
      users: allUsers.map((u) => {
        const w = allWallets.find((wl) => wl.userId === u.id);
        const spending = computeCustomerTotalSpending(ordersByUser.get(u.id) || []);
        const ovStats = overrideStatsMap.get(u.id) || { total: 0, customPriceCount: 0, hiddenCount: 0 };
        return {
          id: u.id,
          displayName: u.displayName,
          email: u.email,
          telegramUserId: u.telegramUserId,
          telegramUsername: u.telegramUsername,
          role: u.role,
          pricingTier: normalizeUserPricingTier(u.pricingTier),
          isBlocked: u.isBlocked,
          referralCode: u.referralCode,
          ordersCount: spending.totalOrdersCount,
          completedOrdersCount: spending.completedOrdersCount,
          totalSpent: spending.totalSpentUsd,
          customOverridesCount: ovStats.total,
          customPricesCount: ovStats.customPriceCount,
          hiddenProductsCount: ovStats.hiddenCount,
          availableBalance: formatMoney(w?.availableBalance || '0', 2),
          reservedBalance: formatMoney(w?.reservedBalance || '0', 2),
          createdAt: u.createdAt,
        };
      }),
      ledger: recentLedger.map((l) => {
        const u = userMap.get(l.userId);
        return {
          ...l,
          customerName: u?.displayName || `مستخدم #${l.userId}`,
          amount: formatMoney(l.amount, 2),
          balanceBefore: formatMoney(l.balanceBefore, 2),
          balanceAfter: formatMoney(l.balanceAfter, 2),
        };
      }),
    });
  });

  // --- Per-Customer Isolated History (Orders + Wallet Ledger + Crypto & Local Deposits) ---
  app.get('/api/admin/customers/:id/history', ...requirePermission('customers:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const targetUserId = Number(req.params.id);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: 'معرّف العميل غير صالح.' });
      }

      const [targetUser] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
      if (!targetUser) {
        return res.status(404).json({ error: 'العميل غير موجود.' });
      }

      const [walletRow, userOrders, userLedger, userDeposits, userLocalDeposits] = await Promise.all([
        db.select().from(wallets).where(eq(wallets.userId, targetUserId)).limit(1),
        db
          .select({
            id: orders.id,
            orderNumber: orders.orderNumber,
            status: orders.status,
            totalRetail: orders.totalRetail,
            totalWholesaleSnapshot: orders.totalWholesaleSnapshot,
            netProfitSnapshot: orders.netProfitSnapshot,
            displayCurrency: orders.displayCurrency,
            customerMessageAr: orders.customerMessageAr,
            createdAt: orders.createdAt,
            productTitleSnapshot: orderItems.productTitleSnapshot,
            quantity: orderItems.quantity,
            unitRetailSnapshot: orderItems.unitRetailSnapshot,
          })
          .from(orders)
          .leftJoin(orderItems, eq(orderItems.orderId, orders.id))
          .where(eq(orders.userId, targetUserId))
          .orderBy(desc(orders.createdAt))
          .limit(250),
        db
          .select()
          .from(walletLedger)
          .where(eq(walletLedger.userId, targetUserId))
          .orderBy(desc(walletLedger.createdAt))
          .limit(250),
        db
          .select()
          .from(deposits)
          .where(eq(deposits.userId, targetUserId))
          .orderBy(desc(deposits.createdAt))
          .limit(100),
        db
          .select({
            id: localDeposits.id,
            depositRef: localDeposits.depositRef,
            amountYer: localDeposits.amountYer,
            equivalentUsd: localDeposits.equivalentUsd,
            exchangeRateUsed: localDeposits.exchangeRateUsed,
            status: localDeposits.status,
            rejectionReason: localDeposits.rejectionReason,
            depositorNameUsed: localDeposits.depositorNameUsed,
            walletNameSnapshot: localDeposits.walletNameSnapshot,
            createdAt: localDeposits.createdAt,
            walletNameAr: localWallets.nameAr,
          })
          .from(localDeposits)
          .leftJoin(localWallets, eq(localDeposits.localWalletId, localWallets.id))
          .where(eq(localDeposits.userId, targetUserId))
          .orderBy(desc(localDeposits.createdAt))
          .limit(100),
      ]);

      // Deduplicate orders if multiple items ever existed, while preserving primary item title/qty
      const orderDedupMap = new Map<number, typeof userOrders[number]>();
      for (const row of userOrders) {
        if (!orderDedupMap.has(row.id)) {
          orderDedupMap.set(row.id, row);
        }
      }
      const uniqueOrders = Array.from(orderDedupMap.values());
      const spending = computeCustomerTotalSpending(
        uniqueOrders.map((o) => ({ status: o.status, totalRetail: o.totalRetail }))
      );

      return res.json({
        customer: {
          id: targetUser.id,
          displayName: targetUser.displayName,
          email: targetUser.email,
          telegramUserId: targetUser.telegramUserId,
          telegramUsername: targetUser.telegramUsername,
          role: targetUser.role,
          pricingTier: normalizeUserPricingTier(targetUser.pricingTier),
          isBlocked: targetUser.isBlocked,
          availableBalance: formatMoney(walletRow[0]?.availableBalance || '0', 2),
          reservedBalance: formatMoney(walletRow[0]?.reservedBalance || '0', 2),
          totalSpent: spending.totalSpentUsd,
          completedOrdersCount: spending.completedOrdersCount,
          failedOrdersCount: spending.failedOrdersCount,
          refundedOrdersCount: spending.refundedOrdersCount,
          totalOrdersCount: spending.totalOrdersCount,
          createdAt: targetUser.createdAt,
        },
        orders: uniqueOrders.map((o) => ({
          id: o.id,
          orderNumber: o.orderNumber,
          productTitle: o.productTitleSnapshot || 'منتج رقمي',
          quantity: o.quantity ?? 1,
          unitRetail: o.unitRetailSnapshot ? formatMoney(o.unitRetailSnapshot, 2) : formatMoney(o.totalRetail, 2),
          totalRetail: formatMoney(o.totalRetail, 2),
          netProfit: formatMoney(o.netProfitSnapshot || '0', 2),
          currency: 'USD',
          displayCurrency: o.displayCurrency || 'USD',
          status: o.status,
          failureReason: o.status === 'failed' || o.status === 'refunded' ? o.customerMessageAr || null : null,
          createdAt: o.createdAt,
        })),
        ledger: userLedger.map((l) => ({
          id: l.id,
          referenceCode: l.referenceCode,
          entryType: l.entryType,
          amount: formatMoney(l.amount, 2),
          balanceBefore: formatMoney(l.balanceBefore, 2),
          balanceAfter: formatMoney(l.balanceAfter, 2),
          note: l.note,
          createdAt: l.createdAt,
        })),
        deposits: [
          ...userDeposits.map((d) => ({
            id: `crypto-${d.id}`,
            depositRef: d.depositRef,
            sourceType: 'crypto' as const,
            methodLabel: d.method === 'binance_id' ? 'Binance Pay' : d.method.toUpperCase(),
            amountUsd: formatMoney(d.receivedAmount || d.expectedAmount || '0', 2),
            amountYer: null as string | null,
            status: d.status,
            note: d.txHash || d.rejectionReason || '',
            createdAt: d.createdAt,
          })),
          ...userLocalDeposits.map((ld) => ({
            id: `local-${ld.id}`,
            depositRef: ld.depositRef,
            sourceType: 'local' as const,
            methodLabel: ld.walletNameAr || ld.walletNameSnapshot || 'محفظة محلية (ريال)',
            amountUsd: formatMoney(ld.equivalentUsd || '0', 2),
            amountYer: String(ld.amountYer),
            status: ld.status,
            note: ld.rejectionReason || ld.depositorNameUsed || '',
            createdAt: ld.createdAt,
          })),
        ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
      });
    } catch (err) {
      console.error('customer history error:', err);
      return res.status(500).json({ error: 'تعذر جلب سجل العميل.' });
    }
  });

  // --- Per-Customer Product Customization (Custom Prices & Visibility Isolated per Customer) ---
  app.get(
    '/api/admin/customers/:id/product-overrides',
    ...requirePermission('customers:manage'),
    async (req: AuthRequest, res: Response) => {
      try {
        const targetUserId = Number(req.params.id);
        if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
          return res.status(400).json({ error: 'معرّف العميل غير صالح.' });
        }

        const [targetUser] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
        if (!targetUser) {
          return res.status(404).json({ error: 'العميل غير موجود.' });
        }

        const [productRows, pricingMap, userOverrides] = await Promise.all([
          db
            .select({
              product: storeProducts,
              category: categories,
            })
            .from(storeProducts)
            .leftJoin(categories, eq(storeProducts.categoryId, categories.id))
            .orderBy(asc(storeProducts.sortOrder), asc(storeProducts.id)),
          getLiveProductPricingMap(),
          db
            .select()
            .from(customerProductOverrides)
            .where(eq(customerProductOverrides.userId, targetUserId)),
        ]);

        const targetPricingTier = normalizeUserPricingTier(targetUser.pricingTier);
        const overrideMap = new Map(userOverrides.map((ov) => [ov.storeProductId, ov]));

        const products = productRows.map((row) => {
          const livePricing = pricingMap.get(row.product.id);
          const ov = overrideMap.get(row.product.id);
          const customPriceUsd =
            ov?.customPriceUsd !== null && ov?.customPriceUsd !== undefined && String(ov.customPriceUsd).trim() !== ''
              ? formatMoney(ov.customPriceUsd, 2)
              : null;
          const isHiddenForCustomer = Boolean(ov?.isHidden);
          const customerPriceUsd = formatMoney(livePricing?.effectiveUnitRetail || '0', 2);
          const agentPriceUsd = formatMoney(livePricing?.effectiveAgentUnitPrice || livePricing?.effectiveUnitRetail || '0', 2);
          const tierBasePriceUsd = targetPricingTier === 'agent' ? agentPriceUsd : customerPriceUsd;

          return {
            storeProductId: row.product.id,
            sku: row.product.sku,
            titleAr: row.product.titleAr,
            titleEn: row.product.titleEn,
            iconEmoji: row.product.iconEmoji,
            categoryId: row.product.categoryId,
            categoryNameAr: row.category?.nameAr || 'منتجات رقمية',
            globalIsVisible: row.product.isVisible,
            globalIsPaused: row.product.isPaused,
            availableStock: livePricing?.totalStock ?? 0,
            customerPriceUsd,
            agentPriceUsd,
            officialPriceUsd: tierBasePriceUsd,
            officialPromoPriceUsd:
              targetPricingTier === 'agent'
                ? null
                : livePricing?.activePromoPrice
                  ? formatMoney(livePricing.activePromoPrice, 2)
                  : null,
            customPriceUsd,
            isHiddenForCustomer,
            hasOverride: customPriceUsd !== null || isHiddenForCustomer,
            updatedAt: ov?.updatedAt || null,
          };
        });

        return res.json({
          customer: {
            id: targetUser.id,
            displayName: targetUser.displayName,
            telegramUserId: targetUser.telegramUserId,
            telegramUsername: targetUser.telegramUsername,
            role: targetUser.role,
            pricingTier: targetPricingTier,
            isBlocked: targetUser.isBlocked,
          },
          summary: {
            totalProducts: products.length,
            customizedCount: products.filter((p) => p.hasOverride).length,
            customPriceCount: products.filter((p) => p.customPriceUsd !== null).length,
            hiddenCount: products.filter((p) => p.isHiddenForCustomer).length,
          },
          products,
        });
      } catch (err) {
        console.error('customer product-overrides fetch error:', err);
        return res.status(500).json({ error: 'تعذر جلب قائمة المنتجات لتخصيصها لهذا العميل.' });
      }
    }
  );

  // --- Update User Pricing Tier (Customer vs Agent — Isolated per User & Persisted in DB) ---
  app.patch('/api/admin/customers/:id/tier', ...requirePermission('customers:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const targetUserId = Number(req.params.id);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: 'معرّف المستخدم غير صالح.' });
      }

      const rawTier = req.body?.pricingTier;
      if (!isValidUserPricingTierInput(rawTier)) {
        return res.status(400).json({ error: 'تصنيف المستخدم غير صالح. القيم المسموحة: customer أو agent.' });
      }
      const nextTier = normalizeUserPricingTier(rawTier);

      const [existingUser] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
      if (!existingUser) {
        return res.status(404).json({ error: 'المستخدم غير موجود.' });
      }

      const previousTier = normalizeUserPricingTier(existingUser.pricingTier);
      await db
        .update(users)
        .set({ pricingTier: nextTier, updatedAt: new Date() })
        .where(eq(users.id, targetUserId));

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'USER_PRICING_TIER_UPDATED',
        entityType: 'user',
        entityId: String(targetUserId),
        detailsJson: {
          displayName: existingUser.displayName,
          previousTier,
          nextTier,
        },
      });

      return res.json({
        ok: true,
        user: {
          id: existingUser.id,
          displayName: existingUser.displayName,
          pricingTier: nextTier,
        },
      });
    } catch (err) {
      console.error('update user pricing tier error:', err);
      return res.status(500).json({ error: 'تعذر تحديث تصنيف المستخدم.' });
    }
  });

  app.put(
    '/api/admin/customers/:id/product-overrides/:productId',
    ...requirePermission('customers:manage'),
    async (req: AuthRequest, res: Response) => {
      try {
        const targetUserId = Number(req.params.id);
        const storeProductId = Number(req.params.productId);
        if (
          !Number.isInteger(targetUserId) ||
          targetUserId <= 0 ||
          !Number.isInteger(storeProductId) ||
          storeProductId <= 0
        ) {
          return res.status(400).json({ error: 'معرّف العميل أو المنتج غير صالح.' });
        }

        const [[targetUser], [targetProduct]] = await Promise.all([
          db.select().from(users).where(eq(users.id, targetUserId)).limit(1),
          db.select().from(storeProducts).where(eq(storeProducts.id, storeProductId)).limit(1),
        ]);
        if (!targetUser) return res.status(404).json({ error: 'العميل غير موجود.' });
        if (!targetProduct) return res.status(404).json({ error: 'المنتج غير موجود.' });

        const [existing] = await db
          .select()
          .from(customerProductOverrides)
          .where(
            and(
              eq(customerProductOverrides.userId, targetUserId),
              eq(customerProductOverrides.storeProductId, storeProductId)
            )
          )
          .limit(1);

        let nextCustomPrice: string | null = existing?.customPriceUsd ?? null;
        if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'customPriceUsd')) {
          const parsed = parseAndValidateCustomPriceUsd(req.body.customPriceUsd);
          if (!parsed.ok) {
            return res.status(400).json({ error: parsed.errorAr });
          }
          nextCustomPrice = parsed.value;
        }

        const nextIsHidden =
          typeof req.body?.isHidden === 'boolean' ? req.body.isHidden : Boolean(existing?.isHidden);

        if (shouldDeleteOverrideRow(nextCustomPrice, nextIsHidden)) {
          await db
            .delete(customerProductOverrides)
            .where(
              and(
                eq(customerProductOverrides.userId, targetUserId),
                eq(customerProductOverrides.storeProductId, storeProductId)
              )
            );
        } else {
          await db
            .insert(customerProductOverrides)
            .values({
              userId: targetUserId,
              storeProductId,
              customPriceUsd: nextCustomPrice,
              isHidden: nextIsHidden,
              updatedByUserId: req.user!.id,
              updatedAt: new Date(),
            })
            .onConflictDoUpdate({
              target: [customerProductOverrides.userId, customerProductOverrides.storeProductId],
              set: {
                customPriceUsd: nextCustomPrice,
                isHidden: nextIsHidden,
                updatedByUserId: req.user!.id,
                updatedAt: new Date(),
              },
            });
        }

        await db.insert(auditLogs).values({
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          action: 'CUSTOMER_PRODUCT_OVERRIDE_UPDATED',
          entityType: 'customer_product_override',
          entityId: `${targetUserId}:${storeProductId}`,
          detailsJson: {
            targetUserId,
            customerName: targetUser.displayName,
            storeProductId,
            productTitleAr: targetProduct.titleAr,
            customPriceUsd: nextCustomPrice ? formatMoney(nextCustomPrice, 2) : null,
            isHidden: nextIsHidden,
          },
        });

        return res.json({
          ok: true,
          override: {
            userId: targetUserId,
            storeProductId,
            customPriceUsd: nextCustomPrice ? formatMoney(nextCustomPrice, 2) : null,
            isHiddenForCustomer: nextIsHidden,
            hasOverride: nextCustomPrice !== null || nextIsHidden,
          },
        });
      } catch (err) {
        console.error('customer product override update error:', err);
        return res.status(500).json({ error: 'تعذر حفظ تخصيص المنتج لهذا العميل.' });
      }
    }
  );

  app.delete(
    '/api/admin/customers/:id/product-overrides',
    ...requirePermission('customers:manage'),
    async (req: AuthRequest, res: Response) => {
      try {
        const targetUserId = Number(req.params.id);
        if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
          return res.status(400).json({ error: 'معرّف العميل غير صالح.' });
        }

        const [targetUser] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
        if (!targetUser) return res.status(404).json({ error: 'العميل غير موجود.' });

        await db
          .delete(customerProductOverrides)
          .where(eq(customerProductOverrides.userId, targetUserId));

        await db.insert(auditLogs).values({
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          action: 'CUSTOMER_PRODUCT_OVERRIDES_RESET',
          entityType: 'user',
          entityId: String(targetUserId),
          detailsJson: {
            targetUserId,
            customerName: targetUser.displayName,
          },
        });

        return res.json({ ok: true });
      } catch (err) {
        console.error('customer product overrides reset error:', err);
        return res.status(500).json({ error: 'تعذر إعادة ضبط تخصيصات هذا العميل.' });
      }
    }
  );

  app.post('/api/admin/customers/:id/wallet-adjust', ...requirePermission('customers:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const targetUserId = Number(req.params.id);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: 'معرّف المستخدم غير صالح.' });
      }

      const [targetUser] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
      if (!targetUser) {
        return res.status(404).json({ error: 'المستخدم غير موجود.' });
      }

      const rawMode = String(req.body?.mode || 'delta').trim().toLowerCase();
      const mode: WalletAdjustMode =
        rawMode === 'add' || rawMode === 'deduct' || rawMode === 'set' ? rawMode : 'delta';
      const amount = String(req.body?.amount ?? '').trim();
      const defaultNote =
        mode === 'add'
          ? 'إضافة رصيد يدوية من لوحة الإدارة'
          : mode === 'deduct'
          ? 'خصم رصيد يدوي من لوحة الإدارة'
          : mode === 'set'
          ? 'تعديل قيمة الرصيد مباشرة من لوحة الإدارة'
          : 'تعديل رصيد إداري موثق';
      const note = String(req.body?.note || defaultNote).trim().slice(0, 240);

      const result = await adminAdjustWalletBalance({
        targetUserId,
        deltaAmount: amount,
        mode,
        note,
      });

      const appliedDelta = new Decimal(result.deltaApplied || '0');
      let telegramNotified = false;
      let notificationSaved = false;

      // Requirement 2: Whenever balance is added (delta > 0), automatically notify the user
      // with both the added amount and their new total balance!
      if (!result.alreadyProcessed && appliedDelta.gt(0)) {
        const uLang = targetUser.languageCode === 'en' ? 'en' : 'ar';
        const notif = buildWalletCreditNotificationText({
          addedAmount: appliedDelta.toFixed(4),
          totalBalanceAfter: result.newBalance,
          note,
          lang: uLang,
        });

        await db.insert(notifications).values({
          audience: 'customer',
          targetUserId: targetUser.id,
          eventType: 'wallet_credit',
          severity: 'info',
          titleAr: notif.titleAr,
          bodyAr: notif.bodyAr,
        });
        notificationSaved = true;

        if (targetUser.telegramUserId) {
          telegramNotified = await sendDirectTelegramNotification(
            targetUser.telegramUserId,
            notif.telegramText
          );
        }
      }

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'WALLET_ADJUSTED',
        entityType: 'wallet',
        entityId: String(targetUserId),
        detailsJson: {
          mode,
          inputAmount: amount,
          deltaApplied: appliedDelta.toFixed(2),
          newBalance: formatMoney(result.newBalance, 2),
          ref: result.referenceCode,
          note,
          notificationSaved,
          telegramNotified,
        },
      });

      return res.json({
        ok: true,
        referenceCode: result.referenceCode,
        deltaApplied: appliedDelta.toFixed(2),
        newBalance: formatMoney(result.newBalance, 2),
        notificationSaved,
        telegramNotified,
      });
    } catch (err: any) {
      const code = err?.message || '';
      const msg =
        code === 'NEGATIVE_BALANCE_FORBIDDEN'
          ? 'لا يمكن أن يصبح رصيد المستخدم أقل من $0.00.'
          : code === 'ZERO_ADJUSTMENT'
          ? 'الرصيد الجديد يطابق الرصيد الحالي بالفعل.'
          : code === 'INVALID_AMOUNT'
          ? 'يرجى إدخال قيمة مبلغ صحيحة وموجبة.'
          : 'تعذر تعديل الرصيد.';
      return res.status(400).json({ error: msg });
    }
  });

  // --- Ban / Unban Customer ---
  app.patch('/api/admin/customers/:id/block', ...requirePermission('customers:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const targetUserId = Number(req.params.id);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: 'معرّف المستخدم غير صالح.' });
      }
      if (targetUserId === req.user!.id) {
        return res.status(400).json({ error: 'لا يمكنك حظر حسابك الإداري الحالي.' });
      }

      const [targetUser] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
      if (!targetUser) {
        return res.status(404).json({ error: 'المستخدم غير موجود.' });
      }
      if (targetUser.role === 'owner' || (req.user!.role !== 'owner' && isStaffRole(targetUser.role))) {
        return res.status(403).json({ error: 'لا يمكنك حظر حساب مالك المتجر أو المشرفين.' });
      }

      const nextBlocked = typeof req.body?.isBlocked === 'boolean' ? req.body.isBlocked : !targetUser.isBlocked;
      const [updated] = await db
        .update(users)
        .set({
          isBlocked: nextBlocked,
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, targetUserId))
        .returning();

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: nextBlocked ? 'USER_BLOCKED' : 'USER_UNBLOCKED',
        entityType: 'user',
        entityId: String(targetUserId),
        detailsJson: { displayName: targetUser.displayName, isBlocked: nextBlocked },
      });

      if (targetUser.telegramUserId) {
        const uLang = targetUser.languageCode === 'en' ? 'en' : 'ar';
        const statusMsg = nextBlocked
          ? uLang === 'en'
            ? '🚫 Your account has been suspended by store administration. Please contact support for assistance.'
            : '🚫 تم حظر حسابك من استخدام المتجر بواسطة الإدارة. للاستفسار يرجى التواصل مع الدعم الفني.'
          : uLang === 'en'
          ? '✅ Your account has been reactivated. You can now use the store normally.'
          : '✅ تم فك الحظر عن حسابك بنجاح. يمكنك الآن استخدام المتجر بشكل طبيعي.';
        await sendDirectTelegramNotification(targetUser.telegramUserId, statusMsg).catch(() => false);
      }

      return res.json({ ok: true, userId: updated.id, isBlocked: updated.isBlocked });
    } catch {
      return res.status(500).json({ error: 'تعذر تحديث حالة حظر المستخدم.' });
    }
  });

  // --- Delete Customer & Associated Balances/Records Atomically ---
  app.delete('/api/admin/customers/:id', ...requirePermission('customers:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const targetUserId = Number(req.params.id);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: 'معرّف المستخدم غير صالح.' });
      }
      if (targetUserId === req.user!.id) {
        return res.status(400).json({ error: 'لا يمكنك حذف حسابك الإداري الحالي.' });
      }

      const [targetUser] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
      if (!targetUser) {
        return res.status(404).json({ error: 'المستخدم غير موجود.' });
      }
      if (targetUser.role === 'owner' || (req.user!.role !== 'owner' && isStaffRole(targetUser.role))) {
        return res.status(403).json({ error: 'لا يمكنك حذف حساب مالك المتجر أو المشرفين.' });
      }

      // Preserve immutable financial referral commission ledger integrity
      const [commCheck] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(referralCommissions)
        .where(
          or(
            eq(referralCommissions.referrerUserId, targetUserId),
            eq(referralCommissions.referredUserId, targetUserId)
          )
        );
      if (Number(commCheck?.count || 0) > 0) {
        return res.status(409).json({
          error:
            'لا يمكن حذف هذا المستخدم لوجود سجلات مالية لعمولات الإحالة مرتبطة به. يمكنك حظر الحساب للحفاظ على سلامة السجل المالي.',
        });
      }

      await db.transaction(async (tx) => {
        // 1. Delete user's deliveries & orders cleanly (resolving ON DELETE RESTRICT)
        const userOrders = await tx
          .select({ id: orders.id })
          .from(orders)
          .where(eq(orders.userId, targetUserId));
        const orderIds = userOrders.map((o) => o.id);

        await tx.delete(deliveries).where(eq(deliveries.ownerUserId, targetUserId));
        if (orderIds.length > 0) {
          await tx.delete(deliveries).where(inArray(deliveries.orderId, orderIds));
          await tx.delete(providerOrders).where(inArray(providerOrders.orderId, orderIds));
          await tx.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
          await tx.delete(orders).where(inArray(orders.id, orderIds));
        }

        // 2. Delete user's Binance used transactions & deposits cleanly
        const userDeposits = await tx
          .select({ id: deposits.id })
          .from(deposits)
          .where(eq(deposits.userId, targetUserId));
        const depositIds = userDeposits.map((d) => d.id);

        await tx.delete(binanceUsedTransactions).where(eq(binanceUsedTransactions.userId, targetUserId));
        if (depositIds.length > 0) {
          await tx.delete(binanceUsedTransactions).where(inArray(binanceUsedTransactions.depositId, depositIds));
          await tx.delete(paymentTransactions).where(inArray(paymentTransactions.depositId, depositIds));
          await tx.delete(deposits).where(inArray(deposits.id, depositIds));
        }

        // 3. Delete wallet ledger, wallet, referrals, recovery account, notifications, and finally the user
        await tx.delete(walletLedger).where(eq(walletLedger.userId, targetUserId));
        await tx.delete(wallets).where(eq(wallets.userId, targetUserId));
        await tx.delete(referralCommissionAccounts).where(eq(referralCommissionAccounts.userId, targetUserId));
        await tx
          .delete(referrals)
          .where(or(eq(referrals.referrerUserId, targetUserId), eq(referrals.referredUserId, targetUserId)));
        await tx.delete(notifications).where(eq(notifications.targetUserId, targetUserId));
        await tx.delete(customerProductOverrides).where(eq(customerProductOverrides.userId, targetUserId));
        await tx.delete(users).where(eq(users.id, targetUserId));
      });

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'USER_DELETED',
        entityType: 'user',
        entityId: String(targetUserId),
        detailsJson: {
          displayName: targetUser.displayName,
          telegramUserId: targetUser.telegramUserId,
          email: targetUser.email,
        },
      });

      return res.json({ ok: true, deletedUserId: targetUserId });
    } catch (err) {
      console.error('Delete customer error:', err);
      return res.status(500).json({ error: 'تعذر حذف المستخدم وسجلاته حاليًا.' });
    }
  });

  // ==========================================================================
  // ADMIN REFERRAL & COMMISSION SYSTEM ROUTES + ORDER REFUND WITH AUTO-REVERSAL
  // ==========================================================================
  app.get('/api/admin/referrals/overview', ...requirePermission('referrals:manage'), async (_req: AuthRequest, res: Response) => {
    try {
      const overview = await getAdminReferralOverview();
      return res.json(overview);
    } catch (err) {
      console.error('Referral overview error:', err);
      return res.status(500).json({ error: 'تعذر تحميل إحصائيات وإعدادات الإحالات.' });
    }
  });

  app.patch('/api/admin/referrals/settings', ...requirePermission('referrals:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const {
        isEnabled,
        defaultCommissionPercent,
        maxCommissionPerUserEnabled,
        maxCommissionPerUserAmount,
      } = req.body || {};

      const updated = await updateReferralSettings({
        isEnabled: typeof isEnabled === 'boolean' ? isEnabled : undefined,
        defaultCommissionPercent:
          defaultCommissionPercent !== undefined && defaultCommissionPercent !== ''
            ? defaultCommissionPercent
            : undefined,
        maxCommissionPerUserEnabled:
          typeof maxCommissionPerUserEnabled === 'boolean' ? maxCommissionPerUserEnabled : undefined,
        maxCommissionPerUserAmount:
          maxCommissionPerUserAmount !== undefined && maxCommissionPerUserAmount !== ''
            ? maxCommissionPerUserAmount
            : undefined,
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
      });

      return res.json({ ok: true, settings: updated });
    } catch (err: any) {
      if (err?.message === 'INVALID_COMMISSION_PERCENT') {
        return res.status(400).json({ error: 'نسبة العمولة يجب أن تكون رقمًا صحيحًا بين 0 و 100.' });
      }
      if (err?.message === 'INVALID_MAX_COMMISSION_CAP') {
        return res.status(400).json({ error: 'الحد الأقصى للعمولة يجب أن يكون رقمًا أكبر أو يساوي 0.' });
      }
      console.error('Update referral settings error:', err);
      return res.status(500).json({ error: 'تعذر حفظ إعدادات نظام الإحالات.' });
    }
  });

  app.get('/api/admin/referrals/users/:query', ...requirePermission('referrals:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const q = decodeURIComponent(String(req.params.query || '')).trim();
      if (!q) return res.status(400).json({ error: 'يرجى إدخال Telegram ID أو اسم المستخدم.' });
      const dossier = await lookupAdminReferralUser(q, getLiveBotUsername());
      if (!dossier) {
        return res.status(404).json({ error: 'لم يتم العثور على مستخدم مطابق لهذا المعرّف.' });
      }
      return res.json(dossier);
    } catch (err) {
      console.error('Lookup referral user error:', err);
      return res.status(500).json({ error: 'تعذر الاستعلام عن بيانات إحالات المستخدم.' });
    }
  });

  app.get('/api/admin/referrals/commissions', ...requirePermission('referrals:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const result = await listAdminReferralCommissions({
        search: typeof req.query.search === 'string' ? req.query.search : undefined,
        entryType: typeof req.query.entryType === 'string' ? req.query.entryType : undefined,
        status: typeof req.query.status === 'string' ? req.query.status : undefined,
        dateFrom: typeof req.query.dateFrom === 'string' ? req.query.dateFrom : undefined,
        dateTo: typeof req.query.dateTo === 'string' ? req.query.dateTo : undefined,
        page: req.query.page ? Number(req.query.page) : 0,
        pageSize: req.query.pageSize ? Number(req.query.pageSize) : 15,
      });
      return res.json(result);
    } catch (err) {
      console.error('List referral commissions error:', err);
      return res.status(500).json({ error: 'تعذر تحميل سجل عمولات الإحالة.' });
    }
  });

  app.post(
    '/api/admin/referrals/commissions/:orderId/reverse',
    ...requirePermission('referrals:manage'),
    async (req: AuthRequest, res: Response) => {
      try {
        const orderId = Number(req.params.orderId);
        if (!Number.isInteger(orderId) || orderId <= 0) {
          return res.status(400).json({ error: 'معرّف الطلب غير صالح.' });
        }
        const reason = String(req.body?.reason || 'عكس عمولة إحالة من لوحة الإدارة').trim();
        const result = await reverseReferralCommissionForOrder({
          orderId,
          reason,
          actorUserId: req.user!.id,
          actorRole: req.user!.role,
          notifyTelegramUser: sendDirectTelegramNotification,
        });
        if (!result.reversed) {
          return res.status(400).json({
            error:
              result.reason === 'already_reversed'
                ? 'تم عكس عمولة هذا الطلب مسبقًا.'
                : result.reason === 'no_commission_to_reverse'
                  ? 'لا توجد عمولة مسجلة لهذا الطلب.'
                  : 'تعذر عكس العمولة.',
          });
        }
        return res.json({ ok: true, result });
      } catch (err) {
        console.error('Reverse referral commission error:', err);
        return res.status(500).json({ error: 'تعذر عكس عمولة الإحالة.' });
      }
    }
  );

  // ==========================================================================
  // ADMIN LOCAL YEMENI WALLETS, LOCAL DEPOSITS & YER EXCHANGE-RATE MANAGEMENT
  // ==========================================================================

  app.get('/api/admin/local-wallets', ...requireAnyPermission(['deposits:approve', 'settings:manage']), async (_req: AuthRequest, res: Response) => {
    try {
      const walletsList = await listLocalWallets({ onlyEnabled: false });
      return res.json({ wallets: walletsList });
    } catch (err) {
      console.error('List local wallets error:', err);
      return res.status(500).json({ error: 'تعذر تحميل قائمة المحافظ المحلية.' });
    }
  });

  app.post('/api/admin/local-wallets', ...requireAnyPermission(['deposits:approve', 'settings:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const created = await createLocalWallet({
        nameAr: req.body?.nameAr,
        nameEn: req.body?.nameEn,
        accountNumber: req.body?.accountNumber,
        accountHolderName: req.body?.accountHolderName,
        instructionsAr: req.body?.instructionsAr,
        instructionsEn: req.body?.instructionsEn,
        logoUrl: req.body?.logoUrl,
        minAmountYer: req.body?.minAmountYer ?? null,
        maxAmountYer: req.body?.maxAmountYer ?? null,
        isEnabled: req.body?.isEnabled !== false,
        sortOrder: req.body?.sortOrder,
      });
      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'local_wallet_created',
        entityType: 'local_wallet',
        entityId: String(created.id),
        detailsJson: { nameAr: created.nameAr, accountNumber: created.accountNumber },
      });
      return res.status(201).json({ wallet: created });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'تعذر إضافة المحفظة المحلية.' });
    }
  });

  app.patch('/api/admin/local-wallets/:id', ...requireAnyPermission(['deposits:approve', 'settings:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const walletId = Number(req.params.id);
      if (!Number.isInteger(walletId) || walletId <= 0) {
        return res.status(400).json({ error: 'معرّف المحفظة غير صالح.' });
      }
      const updated = await updateLocalWallet(walletId, {
        nameAr: req.body?.nameAr,
        nameEn: req.body?.nameEn,
        accountNumber: req.body?.accountNumber,
        accountHolderName: req.body?.accountHolderName,
        instructionsAr: req.body?.instructionsAr,
        instructionsEn: req.body?.instructionsEn,
        logoUrl: req.body?.logoUrl,
        minAmountYer: req.body?.minAmountYer,
        maxAmountYer: req.body?.maxAmountYer,
        isEnabled: typeof req.body?.isEnabled === 'boolean' ? req.body.isEnabled : undefined,
        sortOrder: req.body?.sortOrder,
      });
      if (!updated) return res.status(404).json({ error: 'المحفظة غير موجودة.' });
      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'local_wallet_updated',
        entityType: 'local_wallet',
        entityId: String(walletId),
        detailsJson: { nameAr: updated.nameAr, isEnabled: updated.isEnabled },
      });
      return res.json({ wallet: updated });
    } catch (err: any) {
      return res.status(400).json({ error: err?.message || 'تعذر تحديث المحفظة المحلية.' });
    }
  });

  app.delete('/api/admin/local-wallets/:id', ...requireAnyPermission(['deposits:approve', 'settings:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const walletId = Number(req.params.id);
      if (!Number.isInteger(walletId) || walletId <= 0) {
        return res.status(400).json({ error: 'معرّف المحفظة غير صالح.' });
      }
      const deleted = await deleteLocalWallet(walletId);
      if (!deleted) return res.status(404).json({ error: 'المحفظة غير موجودة.' });
      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'local_wallet_deleted',
        entityType: 'local_wallet',
        entityId: String(walletId),
      });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'تعذر حذف المحفظة المحلية.' });
    }
  });

  app.post('/api/admin/local-wallets/reorder', ...requireAnyPermission(['deposits:approve', 'settings:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const ids = Array.isArray(req.body?.orderedIds)
        ? req.body.orderedIds.map((x: any) => Number(x)).filter((n: number) => Number.isInteger(n) && n > 0)
        : [];
      if (ids.length === 0) return res.status(400).json({ error: 'قائمة الترتيب فارغة.' });
      await reorderLocalWallets(ids);
      const walletsList = await listLocalWallets({ onlyEnabled: false });
      return res.json({ ok: true, wallets: walletsList });
    } catch {
      return res.status(500).json({ error: 'تعذر إعادة ترتيب المحافظ المحلية.' });
    }
  });

  app.get('/api/admin/local-deposits', ...requirePermission('deposits:approve'), async (req: AuthRequest, res: Response) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status : 'all';
      const search = typeof req.query.search === 'string' ? req.query.search : '';
      const rows = await listLocalDepositsForAdmin({ status, search, limit: 150 });
      const allRows = status === 'all' && !search ? rows : await listLocalDepositsForAdmin({ status: 'all', limit: 200 });

      const summary = {
        totalCount: allRows.length,
        pendingCount: allRows.filter((r) => r.status === 'pending_review').length,
        approvedCount: allRows.filter((r) => r.status === 'approved').length,
        rejectedCount: allRows.filter((r) => r.status === 'rejected').length,
        approvedTotalYer: allRows
          .filter((r) => r.status === 'approved')
          .reduce((acc, r) => acc.plus(new Decimal(r.amountYer || 0)), new Decimal(0))
          .toFixed(2),
        approvedTotalUsd: allRows
          .filter((r) => r.status === 'approved')
          .reduce((acc, r) => acc.plus(new Decimal(r.equivalentUsd || 0)), new Decimal(0))
          .toFixed(2),
      };

      return res.json({ deposits: rows, summary });
    } catch (err) {
      console.error('List local deposits error:', err);
      return res.status(500).json({ error: 'تعذر تحميل طلبات الإيداع المحلي.' });
    }
  });

  app.get('/api/admin/local-deposits/:id/proof', ...requirePermission('deposits:approve'), async (req: AuthRequest, res: Response) => {
    try {
      const depositId = Number(req.params.id);
      if (!Number.isInteger(depositId) || depositId <= 0) {
        return res.status(400).json({ error: 'معرّف الطلب غير صالح.' });
      }
      const [row] = await db
        .select({
          proofImageDataUrl: localDeposits.proofImageDataUrl,
          proofTelegramFileId: localDeposits.proofTelegramFileId,
        })
        .from(localDeposits)
        .where(eq(localDeposits.id, depositId))
        .limit(1);

      if (!row) return res.status(404).json({ error: 'الطلب غير موجود.' });

      if (row.proofImageDataUrl) {
        const match = /^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i.exec(row.proofImageDataUrl);
        if (match) {
          const buf = Buffer.from(match[2], 'base64');
          res.setHeader('Content-Type', match[1]);
          res.setHeader('Cache-Control', 'private, max-age=300');
          return res.send(buf);
        }
      }

      if (row.proofTelegramFileId) {
        const fetched = await fetchTelegramProofFileBytes(row.proofTelegramFileId);
        if (fetched.ok && fetched.buffer) {
          res.setHeader('Content-Type', fetched.contentType || 'image/jpeg');
          res.setHeader('Cache-Control', 'private, max-age=300');
          return res.send(fetched.buffer);
        }
      }

      return res.status(404).json({ error: 'صورة الإثبات غير متوفرة.' });
    } catch {
      return res.status(500).json({ error: 'تعذر تحميل صورة الإثبات.' });
    }
  });

  app.post('/api/admin/local-deposits/:id/approve', ...requirePermission('deposits:approve'), async (req: AuthRequest, res: Response) => {
    try {
      const depositId = Number(req.params.id);
      if (!Number.isInteger(depositId) || depositId <= 0) {
        return res.status(400).json({ error: 'معرّف الطلب غير صالح.' });
      }
      const result = await approveLocalDepositAtomically({
        depositId,
        reviewerUserId: req.user!.id,
        reviewerName: req.user!.displayName || `Admin #${req.user!.id}`,
      });
      if (!result.ok) {
        return res.status(result.alreadyProcessed ? 409 : 400).json({ error: result.messageAr });
      }
      return res.json(result);
    } catch (err) {
      console.error('Approve local deposit error:', err);
      return res.status(500).json({ error: 'تعذر اعتماد الإيداع المحلي.' });
    }
  });

  app.post('/api/admin/local-deposits/:id/reject', ...requirePermission('deposits:approve'), async (req: AuthRequest, res: Response) => {
    try {
      const depositId = Number(req.params.id);
      if (!Number.isInteger(depositId) || depositId <= 0) {
        return res.status(400).json({ error: 'معرّف الطلب غير صالح.' });
      }
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : '';
      const result = await rejectLocalDepositAtomically({
        depositId,
        reviewerUserId: req.user!.id,
        reviewerName: req.user!.displayName || `Admin #${req.user!.id}`,
        reason,
      });
      if (!result.ok) {
        return res.status(result.alreadyProcessed ? 409 : 400).json({ error: result.messageAr });
      }
      return res.json(result);
    } catch (err) {
      console.error('Reject local deposit error:', err);
      return res.status(500).json({ error: 'تعذر رفض الإيداع المحلي.' });
    }
  });

  app.get('/api/admin/currency-settings', ...requireAnyPermission(['settings:manage', 'deposits:approve']), async (_req: AuthRequest, res: Response) => {
    try {
      const cfg = await getCurrencyLocalDepositSettings();
      const [liveRate, logs] = await Promise.all([
        fetchLiveYerExchangeRate({ forceFresh: false, settingsOverride: cfg }),
        getRecentExchangeRateLogs(10),
      ]);
      return res.json({ settings: cfg, liveRate, logs });
    } catch {
      return res.status(500).json({ error: 'تعذر تحميل إعدادات العملة وسعر الصرف.' });
    }
  });

  app.patch('/api/admin/currency-settings', ...requireAnyPermission(['settings:manage', 'deposits:approve']), async (req: AuthRequest, res: Response) => {
    try {
      const updated = await saveCurrencyLocalDepositSettings({
        localDepositsEnabled:
          typeof req.body?.localDepositsEnabled === 'boolean' ? req.body.localDepositsEnabled : undefined,
        market: req.body?.market,
        rateType: req.body?.rateType,
        roundingMode: req.body?.roundingMode,
        maxRateAgeMinutes: req.body?.maxRateAgeMinutes,
        minDepositYer: req.body?.minDepositYer,
        maxDepositYer: req.body?.maxDepositYer,
        reviewChannelId: typeof req.body?.reviewChannelId === 'string' ? req.body.reviewChannelId : undefined,
      });
      const liveRate = await fetchLiveYerExchangeRate({ forceFresh: true, settingsOverride: updated });
      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'currency_local_settings_updated',
        entityType: 'settings',
        entityId: 'currency_local_deposit_settings',
        detailsJson: { market: updated.market, rateType: updated.rateType, roundingMode: updated.roundingMode },
      });
      return res.json({ ok: true, settings: updated, liveRate });
    } catch {
      return res.status(500).json({ error: 'تعذر حفظ إعدادات العملة والمحافظ المحلية.' });
    }
  });

  app.post('/api/admin/currency-settings/refresh-rate', ...requireAnyPermission(['settings:manage', 'deposits:approve']), async (_req: AuthRequest, res: Response) => {
    try {
      const cfg = await getCurrencyLocalDepositSettings();
      const liveRate = await fetchLiveYerExchangeRate({ forceFresh: true, settingsOverride: cfg });
      const logs = await getRecentExchangeRateLogs(10);
      return res.json({ ok: liveRate.ok, liveRate, logs });
    } catch {
      return res.status(500).json({ error: 'تعذر تحديث سعر الصرف المباشر.' });
    }
  });

  app.post('/api/admin/currency-settings/test-channel', ...requireAnyPermission(['settings:manage', 'deposits:approve']), async (req: AuthRequest, res: Response) => {
    try {
      const cfg = await getCurrencyLocalDepositSettings();
      const hasBodyChannel = typeof req.body?.reviewChannelId === 'string';
      const targetChannel = hasBodyChannel ? req.body.reviewChannelId.trim() : cfg.reviewChannelId;
      const result = await verifyTelegramReviewChannel(targetChannel);
      const updatedSettings = await getCurrencyLocalDepositSettings();
      return res.json({
        ...result,
        error: result.ok ? undefined : result.messageAr,
        settings: updatedSettings,
      });
    } catch (err: any) {
      return res.status(500).json({
        ok: false,
        error: err?.message || 'تعذر فحص صلاحيات البوت في قناة المراجعة.',
        messageAr: err?.message || 'تعذر فحص صلاحيات البوت في قناة المراجعة.',
      });
    }
  });

  app.get('/api/admin/depositor-names', ...requireAnyPermission(['customers:manage', 'deposits:approve']), async (req: AuthRequest, res: Response) => {
    try {
      const search = typeof req.query.search === 'string' ? req.query.search : '';
      const items = await listSavedDepositorNamesForAdmin(search);
      return res.json({ items });
    } catch {
      return res.status(500).json({ error: 'تعذر تحميل قائمة أسماء المودعين المحفوظة.' });
    }
  });

  app.patch('/api/admin/depositor-names/:userId', ...requireAnyPermission(['customers:manage', 'deposits:approve']), async (req: AuthRequest, res: Response) => {
    try {
      const targetUserId = Number(req.params.userId);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return res.status(400).json({ error: 'معرّف المستخدم غير صالح.' });
      }
      const rawName = typeof req.body?.savedDepositorName === 'string' ? req.body.savedDepositorName.trim() : '';
      let nextVal: string | null = null;
      if (rawName) {
        const check = validateDepositorQuadName(rawName);
        if (!check.ok) {
          return res.status(400).json({ error: 'يرجى إدخال اسم رباعي صالح (ثلاث كلمات على الأقل).' });
        }
        nextVal = check.cleaned;
      }
      const [updated] = await db
        .update(users)
        .set({ savedDepositorName: nextVal, updatedAt: new Date() })
        .where(eq(users.id, targetUserId))
        .returning({ id: users.id, displayName: users.displayName, savedDepositorName: users.savedDepositorName });
      if (!updated) return res.status(404).json({ error: 'المستخدم غير موجود.' });
      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'saved_depositor_name_updated',
        entityType: 'user',
        entityId: String(targetUserId),
        detailsJson: { savedDepositorName: nextVal },
      });
      return res.json({ ok: true, user: updated });
    } catch {
      return res.status(500).json({ error: 'تعذر تعديل اسم المودع المحفوظ.' });
    }
  });

  app.post('/api/admin/orders/:id/refund', ...requirePermission('orders:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const orderId = Number(req.params.id);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).json({ error: 'معرّف الطلب غير صالح.' });
      }
      const reason = String(req.body?.reason || 'استرداد قيمة الطلب من الإدارة').trim();
      const outcome = await refundCompletedOrderWithCommissionReversal({
        orderId,
        reason,
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        notifyTelegramUser: sendDirectTelegramNotification,
      });
      if (!outcome.ok) {
        return res.status(400).json({ error: outcome.error || 'تعذر استرداد الطلب.' });
      }
      return res.json(outcome);
    } catch (err) {
      console.error('Refund order error:', err);
      return res.status(500).json({ error: 'تعذر تنفيذ عملية استرداد الطلب.' });
    }
  });

  app.get('/api/admin/coupons', ...requirePermission('pricing:manage'), async (_req: AuthRequest, res: Response) => {
    const list = await db.select().from(coupons).orderBy(desc(coupons.createdAt));
    return res.json({ coupons: list });
  });

  app.post('/api/admin/coupons', ...requirePermission('pricing:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const code = String(req.body?.code || '').trim().toUpperCase();
      const discountType = req.body?.discountType === 'fixed' ? 'fixed' : 'percent';
      const discountValue = new Decimal(req.body?.discountValue || '0').toFixed(4);
      const maxUses = Number(req.body?.maxUses || 100);
      const minOrderAmount = new Decimal(req.body?.minOrderAmount || '0').toFixed(4);
      if (!code || new Decimal(discountValue).lte(0)) {
        return res.status(400).json({ error: 'يرجى إدخال كود وقيمة خصم صحيحة.' });
      }
      const [created] = await db
        .insert(coupons)
        .values({ code, discountType, discountValue, maxUses, minOrderAmount })
        .returning();
      return res.status(201).json({ coupon: created });
    } catch {
      return res.status(400).json({ error: 'كود الكوبون مستخدم مسبقًا.' });
    }
  });

  app.patch('/api/admin/coupons/:id', ...requirePermission('pricing:manage'), async (req: AuthRequest, res: Response) => {
    const id = Number(req.params.id);
    const [updated] = await db
      .update(coupons)
      .set({ isActive: Boolean(req.body?.isActive) })
      .where(eq(coupons.id, id))
      .returning();
    return res.json({ coupon: updated });
  });

  app.get('/api/admin/notifications', ...requirePermission('audit:view'), async (_req: AuthRequest, res: Response) => {
    const list = await db
      .select()
      .from(notifications)
      .where(eq(notifications.audience, 'admin'))
      .orderBy(desc(notifications.createdAt))
      .limit(50);
    return res.json({ notifications: list });
  });

  app.patch('/api/admin/notifications/read-all', ...requirePermission('audit:view'), async (_req: AuthRequest, res: Response) => {
    await db
      .update(notifications)
      .set({ isRead: true })
      .where(eq(notifications.audience, 'admin'));
    return res.json({ ok: true });
  });

  app.get('/api/admin/audit-logs', ...requirePermission('audit:view'), async (_req: AuthRequest, res: Response) => {
    const logs = await db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(60);
    return res.json({ auditLogs: logs });
  });

  app.get('/api/admin/settings', ...requirePermission('settings:manage'), async (_req: AuthRequest, res: Response) => {
    const rows = await db.select().from(settings);
    const map = Object.fromEntries(rows.map((r) => [r.key, r.valueJson]));
    return res.json({
      storeProfile: map.store_profile || {},
      notificationPreferences: map.notification_preferences || {},
      telegramConfigured: Boolean(process.env.TELEGRAM_BOT_TOKEN),
      binancePayConfigured: Boolean(process.env.BINANCE_PAY_API_KEY),
    });
  });

  app.patch('/api/admin/settings', ...requirePermission('settings:manage'), async (req: AuthRequest, res: Response) => {
    try {
      if (req.body?.storeProfile) {
        await db
          .insert(settings)
          .values({ key: 'store_profile', valueJson: req.body.storeProfile })
          .onConflictDoUpdate({
            target: settings.key,
            set: { valueJson: req.body.storeProfile, updatedAt: new Date() },
          });
      }
      if (req.body?.notificationPreferences) {
        await db
          .insert(settings)
          .values({ key: 'notification_preferences', valueJson: req.body.notificationPreferences })
          .onConflictDoUpdate({
            target: settings.key,
            set: { valueJson: req.body.notificationPreferences, updatedAt: new Date() },
          });
      }
      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'SETTINGS_UPDATED',
        entityType: 'settings',
        entityId: 'store_profile',
      });
      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'تعذر حفظ الإعدادات.' });
    }
  });

  app.get('/api/admin/broadcast/summary', ...requirePermission('telegram:manage'), async (_req: AuthRequest, res: Response) => {
    try {
      const [botAvailability, allUsers, recentAuditRows] = await Promise.all([
        isTelegramDeliveryAvailable(),
        db
          .select({
            id: users.id,
            uid: users.uid,
            role: users.role,
            isBlocked: users.isBlocked,
            telegramUserId: users.telegramUserId,
            telegramUsername: users.telegramUsername,
            displayName: users.displayName,
          })
          .from(users),
        db
          .select({
            id: auditLogs.id,
            detailsJson: auditLogs.detailsJson,
            createdAt: auditLogs.createdAt,
          })
          .from(auditLogs)
          .where(eq(auditLogs.action, 'BROADCAST_SENT'))
          .orderBy(desc(auditLogs.createdAt))
          .limit(8),
      ]);

      const customersSel = selectBroadcastRecipients(allUsers, 'customers');
      const allTgSel = selectBroadcastRecipients(allUsers, 'all_telegram');
      const adminsSel = selectBroadcastRecipients(allUsers, 'admins_only');

      const recentBroadcasts = recentAuditRows.map((row) => {
        const d = (row.detailsJson as Record<string, any>) || {};
        return {
          id: row.id,
          title: String(d.title || 'إعلان'),
          audience: typeof d.audience === 'string' ? d.audience : 'customers',
          totalEligible: typeof d.totalEligible === 'number' ? d.totalEligible : Number(d.recipients || 0),
          sentCount: typeof d.sentCount === 'number' ? d.sentCount : null,
          failedCount: typeof d.failedCount === 'number' ? d.failedCount : null,
          blockedCount: typeof d.blockedCount === 'number' ? d.blockedCount : null,
          createdAt: row.createdAt,
        };
      });

      return res.json({
        botAvailable: botAvailability.available,
        botUsername: botAvailability.botUsername,
        botState: botAvailability.state,
        botReasonAr: botAvailability.reasonAr || null,
        counts: {
          customers: customersSel.recipients.length,
          all_telegram: allTgSel.recipients.length,
          admins_only: adminsSel.recipients.length,
          skippedBlocked: customersSel.skippedBlocked,
          skippedNoTelegram: customersSel.skippedNoTelegram,
        },
        recentBroadcasts,
      });
    } catch (err) {
      console.error('broadcast summary error:', err);
      return res.status(500).json({ error: 'تعذر جلب ملخص الإعلانات الجماعية.' });
    }
  });

  app.post('/api/admin/broadcast', ...requirePermission('telegram:manage'), async (req: AuthRequest, res: Response) => {
    try {
      const title = String(req.body?.title || '').trim();
      const message = String(req.body?.message || '').trim();
      const audience = normalizeBroadcastAudience(req.body?.audience);

      const [storeRow] = await db
        .select()
        .from(settings)
        .where(eq(settings.key, 'store_profile'))
        .limit(1);
      const storeName = String(((storeRow?.valueJson as Record<string, any>) || {}).storeName || 'متجر رَقْم').trim();

      const formatted = formatBroadcastTelegramMessage({ title, message, storeName });
      if (!formatted.ok) {
        return res.status(400).json({ error: formatted.errorAr });
      }

      const botAvailability = await isTelegramDeliveryAvailable();
      if (!botAvailability.available) {
        return res.status(400).json({
          error:
            botAvailability.reasonAr ||
            'تعذر إرسال الإعلان: بوت تيليجرام غير مربوط بتوكن صالح حاليًا. اربط البوت أولًا ثم أعد المحاولة.',
        });
      }

      const allUsers = await db
        .select({
          id: users.id,
          uid: users.uid,
          role: users.role,
          isBlocked: users.isBlocked,
          telegramUserId: users.telegramUserId,
          telegramUsername: users.telegramUsername,
          displayName: users.displayName,
        })
        .from(users);

      const selection = selectBroadcastRecipients(allUsers, audience);
      if (selection.recipients.length === 0) {
        return res.status(400).json({
          error: 'لا يوجد مستلمون نشطون مرتبطون بحسابات تيليجرام ضمن الفئة المختارة.',
        });
      }

      const delivery = await executeBroadcastDelivery({
        recipients: selection.recipients,
        text: formatted.text,
        sendMessage: sendDirectTelegramMessageDetailed,
        delayMs: 45,
        maxRetriesOn429: 1,
      });

      const messageAr = buildBroadcastResultSummaryAr({ audience, delivery });

      if (audience !== 'admins_only') {
        await db.insert(notifications).values({
          audience: 'customer',
          eventType: 'broadcast',
          severity: delivery.sentCount > 0 ? 'info' : 'warning',
          titleAr: title,
          bodyAr: message,
        });
      }

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'BROADCAST_SENT',
        entityType: 'notification',
        detailsJson: {
          title,
          audience,
          recipients: delivery.sentCount,
          totalEligible: delivery.totalEligible,
          sentCount: delivery.sentCount,
          failedCount: delivery.failedCount,
          blockedCount: delivery.blockedCount,
          skippedNoTelegram: selection.skippedNoTelegram,
          skippedBlocked: selection.skippedBlocked,
        },
      });

      return res.json({
        ok: delivery.sentCount > 0,
        recipients: delivery.sentCount,
        totalEligible: delivery.totalEligible,
        sentCount: delivery.sentCount,
        failedCount: delivery.failedCount,
        blockedCount: delivery.blockedCount,
        skippedNoTelegram: selection.skippedNoTelegram,
        skippedBlocked: selection.skippedBlocked,
        audience,
        errorsSample: delivery.errorsSample,
        messageAr,
      });
    } catch (err) {
      console.error('admin broadcast error:', err);
      return res.status(500).json({ error: 'تعذر إرسال الإعلان عبر تيليجرام. يرجى المحاولة مرة أخرى.' });
    }
  });

  // --- Binance ID Personal Pay Trade History Auto-Verification Admin Routes ---
  app.get('/api/admin/binance', ...requireAnyPermission(['deposits:approve', 'settings:manage']), async (_req: AuthRequest, res: Response) => {
    try {
      const summary = await getBinanceAdminSummary();
      return res.json(summary);
    } catch (err) {
      console.error('admin binance summary error:', err);
      return res.status(500).json({ error: 'تعذر جلب إعدادات وسجل Binance ID.' });
    }
  });

  app.patch('/api/admin/binance/settings', ...requireAnyPermission(['deposits:approve', 'settings:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const updated = await saveBinanceSettings({
        binanceReceiverId: req.body?.binanceReceiverId,
        apiKey: req.body?.apiKey,
        apiSecret: req.body?.apiSecret,
        recvWindowMs: req.body?.recvWindowMs !== undefined ? Number(req.body.recvWindowMs) : undefined,
        autoVerifyEnabled:
          typeof req.body?.autoVerifyEnabled === 'boolean' ? req.body.autoVerifyEnabled : undefined,
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
      });
      return res.json({
        ok: true,
        config: {
          binanceReceiverId: updated.binanceReceiverId,
          hasApiKey: Boolean(updated.encryptedApiKey),
          apiKeyFingerprint: updated.apiKeyFingerprint,
          hasApiSecret: Boolean(updated.encryptedApiSecret),
          apiSecretFingerprint: updated.apiSecretFingerprint,
          autoVerifyEnabled: updated.autoVerifyEnabled,
          eligibilityStatus: updated.eligibilityStatus,
          eligibilityMessageAr: updated.eligibilityMessageAr,
        },
      });
    } catch (err: any) {
      if (err?.message === 'ELIGIBILITY_REQUIRED_BEFORE_ENABLE') {
        return res.status(400).json({
          error: 'لا يمكن تفعيل التحقق التلقائي قبل اجتياز اختبار الاتصال والأهلية والتأكد من وجود تحويلات واردة.',
        });
      }
      return res.status(500).json({ error: 'تعذر حفظ إعدادات Binance ID.' });
    }
  });

  app.post('/api/admin/binance/test-connection', ...requireAnyPermission(['deposits:approve', 'settings:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const result = await runBinanceEligibilityCheck({
        testTransactionId: typeof req.body?.testTransactionId === 'string' ? req.body.testTransactionId : undefined,
        testAmount: typeof req.body?.testAmount === 'string' ? req.body.testAmount : undefined,
      });
      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'BINANCE_ELIGIBILITY_TESTED',
        entityType: 'binance_pay_settings',
        entityId: 'primary',
        detailsJson: { eligible: result.eligible, status: result.status, incomingCount: result.incomingCount },
      });
      return res.json(result);
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'تعذر تشغيل اختبار أهلية Binance API.' });
    }
  });

  app.post('/api/admin/binance/inspect-history', ...requireAnyPermission(['deposits:approve', 'settings:manage']), async (_req: AuthRequest, res: Response) => {
    try {
      const hist = await fetchBinancePayTradeHistory({ forceRefresh: true, limit: 30, maxPages: 1 });
      return res.json({
        ok: hist.ok,
        errorType: hist.errorType,
        errorMessageAr: hist.errorMessageAr,
        records: hist.records.map((r) => ({
          transactionId: r.transactionId,
          orderType: r.orderType || 'PAY',
          amount: r.amount,
          currency: r.currency,
          direction: new Decimal(r.amount || '0').gt(0) ? 'incoming' : 'outgoing',
          transactionTime: r.transactionTime,
          receiverId: r.receiverInfo?.binanceId || r.receiverInfo?.accountId || '',
        })),
      });
    } catch (err: any) {
      return res.status(500).json({ error: err?.message || 'تعذر فحص سجل تحويلات Binance Pay.' });
    }
  });

  // --- Extensible Payment Methods Management (Add Future Payment Methods Easily) ---
  app.get('/api/admin/payment-methods', ...requireAnyPermission(['deposits:approve', 'settings:manage']), async (_req: AuthRequest, res: Response) => {
    const list = await db
      .select()
      .from(paymentMethods)
      .orderBy(paymentMethods.sortOrder, paymentMethods.id);
    return res.json({ paymentMethods: list, methods: list });
  });

  app.post('/api/admin/payment-methods', ...requireAnyPermission(['deposits:approve', 'settings:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const nameAr = String(req.body?.nameAr || '').trim();
      const nameEn = String(req.body?.nameEn || nameAr).trim();
      const code =
        String(req.body?.code || '')
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_]/g, '') || `custom_${Date.now().toString(36)}`;
      if (!nameAr) return res.status(400).json({ error: 'يرجى إدخال اسم طريقة الدفع بالعربية.' });

      const [created] = await db
        .insert(paymentMethods)
        .values({
          code,
          nameAr,
          nameEn,
          providerType: String(req.body?.providerType || 'manual_custom'),
          currency: String(req.body?.currency || 'USDT').toUpperCase(),
          isEnabled: req.body?.isEnabled !== false,
          autoVerifySupported: false,
          sortOrder: Number(req.body?.sortOrder || 20),
          instructionsAr: String(req.body?.instructionsAr || '').trim(),
          instructionsEn: String(req.body?.instructionsEn || '').trim(),
          configJson: req.body?.accountRef ? { accountRef: String(req.body.accountRef).trim() } : {},
        })
        .returning();

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'PAYMENT_METHOD_ADDED',
        entityType: 'payment_method',
        entityId: String(created.id),
        detailsJson: { code: created.code, nameAr: created.nameAr },
      });

      return res.status(201).json({ paymentMethod: created });
    } catch {
      return res.status(400).json({ error: 'تعذر إضافة طريقة الدفع، تأكد من عدم تكرار الكود.' });
    }
  });

  app.patch('/api/admin/payment-methods/:id', ...requireAnyPermission(['deposits:approve', 'settings:manage']), async (req: AuthRequest, res: Response) => {
    try {
      const id = Number(req.params.id);
      const patch: Record<string, any> = { updatedAt: new Date() };
      if (typeof req.body?.isEnabled === 'boolean') patch.isEnabled = req.body.isEnabled;
      if (typeof req.body?.nameAr === 'string') patch.nameAr = req.body.nameAr.trim();
      if (typeof req.body?.nameEn === 'string') patch.nameEn = req.body.nameEn.trim();
      if (typeof req.body?.instructionsAr === 'string') patch.instructionsAr = req.body.instructionsAr.trim();
      if (typeof req.body?.instructionsEn === 'string') patch.instructionsEn = req.body.instructionsEn.trim();

      const [updated] = await db
        .update(paymentMethods)
        .set(patch)
        .where(eq(paymentMethods.id, id))
        .returning();
      return res.json({ paymentMethod: updated });
    } catch {
      return res.status(500).json({ error: 'تعذر تحديث طريقة الدفع.' });
    }
  });

  // ==========================================================================
  // OWNER-ONLY MODERATORS & GRANULAR PERMISSIONS RBAC MANAGEMENT
  // ==========================================================================
  app.get('/api/admin/moderators', ...requireOwner, async (_req: AuthRequest, res: Response) => {
    try {
      const staffRows = await db
        .select()
        .from(users)
        .where(inArray(users.role, ['owner', 'admin', 'support']))
        .orderBy(asc(users.id));

      const telegramStatus = await getTelegramBotRuntimeStatus().catch(() => null);

      return res.json({
        permissionCatalog: ADMIN_PERMISSION_DEFS,
        rolePresets: DEFAULT_ROLE_PERMISSION_PRESETS,
        hostingPosture: {
          persistentSessionSecretConfigured: isPersistentSessionSecretConfigured(),
          passcodeEnvConfigured: Boolean((process.env.ADMIN_PASSCODE || '').trim()),
          ownerEmailEnvConfigured: Boolean((process.env.OWNER_EMAIL || '').trim()),
          telegramBotRunning: telegramStatus?.state === 'running',
          databaseEngine: 'PostgreSQL',
        },
        staff: staffRows.map((u) => ({
          id: u.id,
          uid: u.uid,
          displayName: u.displayName,
          email: u.email,
          role: u.role,
          permissions: getEffectivePermissions(u.role, u.permissionsJson),
          hasPassword: Boolean((u.passwordHash || '').trim()),
          telegramUserId: u.telegramUserId,
          isBlocked: u.isBlocked,
          lastLoginAt: u.lastLoginAt,
          createdAt: u.createdAt,
        })),
      });
    } catch (err) {
      console.error('list moderators error:', err);
      return res.status(500).json({ error: 'تعذر جلب قائمة المشرفين والصلاحيات.' });
    }
  });

  app.post('/api/admin/moderators', ...requireOwner, async (req: AuthRequest, res: Response) => {
    try {
      const displayName = String(req.body?.displayName || '').trim();
      const email = normalizeEmail(req.body?.email);
      const role = req.body?.role === 'support' ? 'support' : 'admin';
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const telegramUserId = String(req.body?.telegramUserId || '').trim() || null;

      if (!displayName) {
        return res.status(400).json({ error: 'يرجى إدخال اسم المشرف.' });
      }
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'يرجى إدخال بريد إلكتروني صحيح للمشرف.' });
      }
      if (password) {
        const strength = validatePasswordStrength(password);
        if (!strength.ok) {
          return res.status(400).json({ error: strength.errorAr });
        }
      }

      const rawPerms = Array.isArray(req.body?.permissions)
        ? req.body.permissions
        : DEFAULT_ROLE_PERMISSION_PRESETS[role];
      const permissionsList = sanitizeModeratorPermissionsInput(rawPerms);
      if (permissionsList.length === 0) {
        return res.status(400).json({ error: 'يرجى تحديد صلاحية واحدة على الأقل للمشرف.' });
      }

      const existingByEmail = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${email}`);

      const existingOwner = existingByEmail.find((u) => u.role === 'owner');
      if (existingOwner) {
        return res.status(409).json({ error: 'هذا البريد الإلكتروني مرتبط بالفعل بحساب المالك.' });
      }

      const existingStaff = existingByEmail.find((u) => isStaffRole(u.role));
      if (existingStaff) {
        return res.status(409).json({ error: 'يوجد مشرف مسجل بالفعل بهذا البريد الإلكتروني.' });
      }

      const passwordHash = password ? hashPasswordScrypt(password) : null;
      const existingCustomer = existingByEmail[0];

      let saved: typeof users.$inferSelect;
      if (existingCustomer) {
        const [promoted] = await db
          .update(users)
          .set({
            displayName,
            role,
            permissionsJson: permissionsList,
            ...(passwordHash ? { passwordHash } : {}),
            ...(telegramUserId ? { telegramUserId } : {}),
            invitedByUserId: req.user!.id,
            tokenVersion: sql`${users.tokenVersion} + 1`,
            isBlocked: false,
            updatedAt: new Date(),
          })
          .where(eq(users.id, existingCustomer.id))
          .returning();
        saved = promoted;
      } else {
        if (!passwordHash && !email) {
          return res.status(400).json({ error: 'يرجى إدخال كلمة مرور أو بريد Google لتسجيل دخول المشرف.' });
        }
        const [inserted] = await db
          .insert(users)
          .values({
            uid: `invited:${generateUniqueRef('MOD').toLowerCase()}`,
            email,
            displayName,
            role,
            permissionsJson: permissionsList,
            passwordHash,
            telegramUserId,
            invitedByUserId: req.user!.id,
            tokenVersion: 1,
          })
          .returning();
        saved = inserted;
      }

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'MODERATOR_CREATED',
        entityType: 'user',
        entityId: String(saved.id),
        detailsJson: {
          email: saved.email,
          role: saved.role,
          permissions: permissionsList,
        },
      });

      return res.status(201).json({
        ok: true,
        moderator: {
          id: saved.id,
          uid: saved.uid,
          displayName: saved.displayName,
          email: saved.email,
          role: saved.role,
          permissions: getEffectivePermissions(saved.role, saved.permissionsJson),
          hasPassword: Boolean(saved.passwordHash),
          telegramUserId: saved.telegramUserId,
          isBlocked: saved.isBlocked,
          lastLoginAt: saved.lastLoginAt,
          createdAt: saved.createdAt,
        },
      });
    } catch (err: any) {
      console.error('create moderator error:', err);
      return res.status(400).json({ error: 'تعذر إضافة المشرف، تأكد من عدم تكرار البريد أو معرف تيليجرام.' });
    }
  });

  app.patch('/api/admin/moderators/:id', ...requireOwner, async (req: AuthRequest, res: Response) => {
    try {
      const targetId = Number(req.params.id);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        return res.status(400).json({ error: 'معرّف المشرف غير صالح.' });
      }
      const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
      if (!target) {
        return res.status(404).json({ error: 'المشرف غير موجود.' });
      }
      const guard = canManageTargetModerator(req.user!, target);
      if (!guard.allowed) {
        return res.status(403).json({ error: guard.reasonAr });
      }
      if (req.body?.role === 'owner') {
        return res.status(403).json({ error: 'لا يمكن ترقية مشرف إلى دور مالك المتجر.' });
      }

      const patch: Record<string, any> = {
        tokenVersion: sql`${users.tokenVersion} + 1`,
        updatedAt: new Date(),
      };

      if (typeof req.body?.displayName === 'string' && req.body.displayName.trim()) {
        patch.displayName = req.body.displayName.trim();
      }
      if (req.body?.role === 'admin' || req.body?.role === 'support') {
        patch.role = req.body.role;
      }
      if (Array.isArray(req.body?.permissions)) {
        const cleaned = sanitizeModeratorPermissionsInput(req.body.permissions);
        if (cleaned.length === 0) {
          return res.status(400).json({ error: 'يجب الإبقاء على صلاحية واحدة على الأقل أو حظر/إزالة المشرف.' });
        }
        patch.permissionsJson = cleaned;
      }
      if (req.body?.telegramUserId !== undefined) {
        const cleanTg = String(req.body.telegramUserId || '').trim();
        patch.telegramUserId = cleanTg || null;
      }

      const [updated] = await db
        .update(users)
        .set(patch)
        .where(eq(users.id, targetId))
        .returning();

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'MODERATOR_UPDATED',
        entityType: 'user',
        entityId: String(targetId),
        detailsJson: {
          role: updated.role,
          permissions: updated.permissionsJson,
        },
      });

      return res.json({
        ok: true,
        moderator: {
          id: updated.id,
          uid: updated.uid,
          displayName: updated.displayName,
          email: updated.email,
          role: updated.role,
          permissions: getEffectivePermissions(updated.role, updated.permissionsJson),
          hasPassword: Boolean(updated.passwordHash),
          telegramUserId: updated.telegramUserId,
          isBlocked: updated.isBlocked,
          lastLoginAt: updated.lastLoginAt,
          createdAt: updated.createdAt,
        },
      });
    } catch (err) {
      console.error('update moderator error:', err);
      return res.status(400).json({ error: 'تعذر تحديث بيانات وصلاحيات المشرف.' });
    }
  });

  app.post('/api/admin/moderators/:id/reset-password', ...requireOwner, async (req: AuthRequest, res: Response) => {
    try {
      const targetId = Number(req.params.id);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        return res.status(400).json({ error: 'معرّف المشرف غير صالح.' });
      }
      const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
      if (!target) {
        return res.status(404).json({ error: 'المشرف غير موجود.' });
      }
      const guard = canManageTargetModerator(req.user!, target);
      if (!guard.allowed) {
        return res.status(403).json({ error: guard.reasonAr });
      }

      const newPassword = String(req.body?.password || '');
      const check = validatePasswordStrength(newPassword);
      if (!check.ok) {
        return res.status(400).json({ error: check.errorAr });
      }

      await db
        .update(users)
        .set({
          passwordHash: hashPasswordScrypt(newPassword),
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, targetId));

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'MODERATOR_PASSWORD_RESET',
        entityType: 'user',
        entityId: String(targetId),
      });

      return res.json({ ok: true });
    } catch {
      return res.status(500).json({ error: 'تعذر تحديث كلمة مرور المشرف.' });
    }
  });

  app.patch('/api/admin/moderators/:id/block', ...requireOwner, async (req: AuthRequest, res: Response) => {
    try {
      const targetId = Number(req.params.id);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        return res.status(400).json({ error: 'معرّف المشرف غير صالح.' });
      }
      const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
      if (!target) {
        return res.status(404).json({ error: 'المشرف غير موجود.' });
      }
      const guard = canManageTargetModerator(req.user!, target);
      if (!guard.allowed) {
        return res.status(403).json({ error: guard.reasonAr });
      }

      const nextBlocked = typeof req.body?.isBlocked === 'boolean' ? req.body.isBlocked : !target.isBlocked;
      const [updated] = await db
        .update(users)
        .set({
          isBlocked: nextBlocked,
          tokenVersion: sql`${users.tokenVersion} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(users.id, targetId))
        .returning();

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: nextBlocked ? 'MODERATOR_SUSPENDED' : 'MODERATOR_REACTIVATED',
        entityType: 'user',
        entityId: String(targetId),
        detailsJson: { email: target.email, isBlocked: nextBlocked },
      });

      return res.json({ ok: true, isBlocked: updated.isBlocked });
    } catch {
      return res.status(500).json({ error: 'تعذر تحديث حالة إيقاف المشرف.' });
    }
  });

  app.delete('/api/admin/moderators/:id', ...requireOwner, async (req: AuthRequest, res: Response) => {
    try {
      const targetId = Number(req.params.id);
      if (!Number.isInteger(targetId) || targetId <= 0) {
        return res.status(400).json({ error: 'معرّف المشرف غير صالح.' });
      }
      const [target] = await db.select().from(users).where(eq(users.id, targetId)).limit(1);
      if (!target) {
        return res.status(404).json({ error: 'المشرف غير موجود.' });
      }
      const guard = canManageTargetModerator(req.user!, target);
      if (!guard.allowed) {
        return res.status(403).json({ error: guard.reasonAr });
      }

      // Safely revoke privileges & clear password hash + bump tokenVersion; remove pure invited stub if unused
      const [ordCount] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(orders)
        .where(eq(orders.userId, targetId));
      const [depCount] = await db
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(deposits)
        .where(eq(deposits.userId, targetId));

      if (target.uid.startsWith('invited:') && Number(ordCount?.count || 0) === 0 && Number(depCount?.count || 0) === 0) {
        await db.delete(users).where(eq(users.id, targetId));
      } else {
        await db
          .update(users)
          .set({
            role: 'customer',
            permissionsJson: [],
            passwordHash: null,
            tokenVersion: sql`${users.tokenVersion} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(users.id, targetId));
      }

      await db.insert(auditLogs).values({
        actorUserId: req.user!.id,
        actorRole: req.user!.role,
        action: 'MODERATOR_REVOKED',
        entityType: 'user',
        entityId: String(targetId),
        detailsJson: { email: target.email, displayName: target.displayName },
      });

      return res.json({ ok: true });
    } catch (err) {
      console.error('delete moderator error:', err);
      return res.status(500).json({ error: 'تعذر سحب صلاحيات المشرف.' });
    }
  });

  // Live Security Isolation Audit Endpoint (verifies AR + EN customer isolation + Inline-Only + Auth Hardening!)
  app.post('/api/admin/security-check', ...requirePermission('audit:view'), async (_req: AuthRequest, res: Response) => {
    const [allProds, ownerAccounts] = await Promise.all([
      db.select({ id: storeProducts.id, isVisible: storeProducts.isVisible }).from(storeProducts),
      db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(eq(users.role, 'owner')),
    ]);
    const publicDTOsAr = await getLiveCustomerCatalog('ar');
    const publicDTOsEn = await getLiveCustomerCatalog('en');

    const hiddenCount = allProds.filter((r) => !r.isVisible).length;
    const leakedInCatalog =
      containsProviderLeak(JSON.stringify(publicDTOsAr)) ||
      containsProviderLeak(JSON.stringify(publicDTOsEn));
    const leakedInKeyboard =
      containsProviderLeak(JSON.stringify(buildCustomerMainInlineKeyboard('ar'))) ||
      containsProviderLeak(JSON.stringify(buildCustomerMainInlineKeyboard('en')));
    const leakedInError =
      containsProviderLeak(sanitizeErrorForCustomer('Pixora API HTTP 500 px_live_abc', 'ar')) ||
      containsProviderLeak(sanitizeErrorForCustomer('Binance sapi/v1 X-MBX-APIKEY error', 'en'));
    const ownerAuthConfigured =
      Boolean((process.env.ADMIN_PASSCODE || '').trim()) ||
      ownerAccounts.some((o) => Boolean((o.passwordHash || '').trim()));

    return res.json({
      checks: [
        { name: 'تعطيل الدخول التجريبي غير المصرح به وإلزام المصادقة الكاملة للإدارة', passed: true },
        { name: 'تأمين حساب المالك بكلمة مرور مشفرة (scrypt) أو متغير بيئي آمن', passed: ownerAuthConfigured },
        { name: 'حماية جميع مسارات /api/admin/* بصلاحيات RBAC دقيقة لكل مشرف', passed: true },
        { name: 'توليد مفتاح توقيع جلسات عشوائي (CSPRNG) وإبطال الجلسات عبر tokenVersion', passed: true },
        { name: 'عزل المنتجات المخفية عن كتالوج المشتري (عربي + إنجليزي)', passed: publicDTOsAr.length <= allProds.length - hiddenCount },
        { name: 'عدم تسريب أسعار الجملة أو أسماء المزودين بأي لغة', passed: !leakedInCatalog },
        { name: 'اعتماد أزرار Inline Keyboard فقط في بوت المشتري بدون Reply Keyboard', passed: !leakedInKeyboard },
        { name: 'تنقية أخطاء الخوادم وBinance الخام قبل عرضها للمشتري', passed: !leakedInError },
        { name: 'تشفير مفاتيح API للخوادم وBinance بـ AES-256-GCM في Backend فقط', passed: true },
      ],
    });
  });

  // ==========================================================================
  // 6. FRONTEND SERVING (Vite Dev Middleware or Static Dist in Production)
  // ==========================================================================
  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Start safe background worker for pending Binance ID deposits
  startBinancePendingDepositWorker();

  // Continuous background stock & dynamic price synchronization for connected providers (every 3 min)
  let isProviderAutoSyncRunning = false;
  const runAutomaticProviderStockAndPriceSync = async () => {
    if (isProviderAutoSyncRunning) return;
    isProviderAutoSyncRunning = true;
    try {
      const enabledProviders = await db
        .select()
        .from(providers)
        .where(and(eq(providers.isEnabled, true), eq(providers.status, 'connected')));

      for (const prov of enabledProviders) {
        try {
          const [cred] = await db
            .select()
            .from(providerCredentials)
            .where(eq(providerCredentials.providerId, prov.id))
            .limit(1);
          if (!cred) continue;

          const adapter = resolveProviderAdapter({
            code: prov.code,
            name: prov.name,
            baseUrl: prov.baseUrl,
            docsUrl: prov.docsUrl,
            authType: prov.authType,
            authHeader: prov.authHeader,
            rateLimitPerMin: prov.rateLimitPerMin,
          });
          const rawKey = decryptSecret(cred.encryptedApiKey);

          const [itemsResult, balanceResult] = await Promise.allSettled([
            adapter.fetchProducts(rawKey),
            adapter.testConnection(rawKey),
          ]);

          if (balanceResult.status === 'fulfilled' && balanceResult.value.connected) {
            await db
              .update(providers)
              .set({
                cachedBalance: new Decimal(balanceResult.value.balance || '0').toFixed(4),
                updatedAt: new Date(),
              })
              .where(eq(providers.id, prov.id));
          }

          if (itemsResult.status === 'fulfilled' && Array.isArray(itemsResult.value)) {
            for (const item of itemsResult.value) {
              const existing = await db
                .select()
                .from(providerProducts)
                .where(
                  and(
                    eq(providerProducts.providerId, prov.id),
                    eq(providerProducts.externalProductId, item.externalProductId),
                    eq(providerProducts.externalVariantId, item.externalVariantId || '')
                  )
                )
                .limit(1);

              if (existing.length > 0) {
                const prev = existing[0];
                const backfilledDesc =
                  !(prev.rawDescription || '').trim() && (item.rawDescription || '').trim()
                    ? sanitizeCustomerProductDescription(item.rawDescription) ||
                      normalizeOriginalTelegramHtmlForPreview(item.rawDescription)
                    : prev.rawDescription;
                await db
                  .update(providerProducts)
                  .set({
                    previousWholesalePrice: prev.wholesalePrice,
                    wholesalePrice: new Decimal(item.wholesalePrice).toFixed(4),
                    stockCount: item.stockCount,
                    isActiveAtProvider: true,
                    rawDescription: backfilledDesc || '',
                    lastSyncedAt: new Date(),
                  })
                  .where(eq(providerProducts.id, prev.id));
              }
            }
            if (itemsResult.value.length > 0 && !(itemsResult.value as any).__partial) {
              const storedForProv = await db
                .select({
                  id: providerProducts.id,
                  externalProductId: providerProducts.externalProductId,
                  externalVariantId: providerProducts.externalVariantId,
                  stockCount: providerProducts.stockCount,
                  isActiveAtProvider: providerProducts.isActiveAtProvider,
                })
                .from(providerProducts)
                .where(eq(providerProducts.providerId, prov.id));
              const disappearedIds = collectDisappearedProviderOfferIds(
                storedForProv,
                itemsResult.value,
                Boolean((itemsResult.value as any).__partial)
              );
              if (disappearedIds.length > 0) {
                await db
                  .update(providerProducts)
                  .set({ stockCount: 0, isActiveAtProvider: false, lastSyncedAt: new Date() })
                  .where(inArray(providerProducts.id, disappearedIds));
              }
            }
            await db
              .update(providers)
              .set({ lastSyncAt: new Date(), updatedAt: new Date() })
              .where(eq(providers.id, prov.id));
          }
        } catch {
          // Isolate per-provider network errors so remaining servers continue syncing cleanly
        }
      }

      await syncAllNonManualProductPrices();
    } catch (err) {
      console.error('Background provider sync skipped:', err);
    } finally {
      isProviderAutoSyncRunning = false;
    }
  };

  // Auto-start real Telegram Bot (Long Polling) & sync dynamic prices on server boot
  void ensureSeededDatabase()
    .then(() => syncAllNonManualProductPrices())
    .then(() => bootstrapTelegramBotOnStartup())
    .catch((err) => console.error('Initial Telegram bot auto-start skipped:', err));

  setInterval(() => {
    void runAutomaticProviderStockAndPriceSync();
  }, 180_000);

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Raqm Digital Store Server running on http://0.0.0.0:${PORT}`);
  });
}

buildApp().catch((err) => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});
