import Decimal from 'decimal.js';
import { asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '../db/index.ts';
import {
  users,
  wallets,
  walletLedger,
  storeProducts,
  productPrices,
  productProviderMappings,
  providerProducts,
  providers,
  categories,
  deposits,
  orders,
  orderItems,
  referrals,
  settings,
  auditLogs,
  botMenuButtons,
  serviceGuides,
} from '../db/schema.ts';
import {
  formatMoney,
  resolveProductEffectivePricingAndStock,
  type ProviderOfferCandidate,
  type SelectionStrategy,
} from './pricing.ts';
import { getLiveProductPricingMap } from './catalogService.ts';
import {
  adminAdjustWalletBalance,
  creditDepositAtomically,
  ensureUserWallet,
} from './walletEngine.ts';
import { resolveBinanceCredentials } from './binancePayHistory.ts';
import { matchProductToStoreCategory } from '../lib/offerClassifier.ts';
import { autoTranslateBilingual } from './translator.ts';
import { sanitizeCustomerProductDescription } from './sanitizer.ts';
import { collectDescendantButtonIds } from '../lib/buttonTreeUtils.ts';
import { getLiveBotUsername, type BotInlineButton, type BotReplyPayload, type StoreProfileSettings } from './telegramEngine.ts';
import {
  formatMoney2,
  formatRatePercentDisplay,
  getAdminReferralOverview,
  getReferralSettings,
  listAdminReferralCommissions,
  lookupAdminReferralUser,
  updateReferralSettings,
} from './referralEngine.ts';

export interface AdminFsmState {
  step:
    | 'idle'
    | 'btn_edit_field'
    | 'btn_add_label_ar'
    | 'btn_add_label_en'
    | 'btn_add_type'
    | 'btn_add_value'
    | 'cat_add_ar'
    | 'cat_add_en'
    | 'cat_add_emoji'
    | 'cat_edit_field'
    | 'prod_edit_field'
    | 'guide_add_ar'
    | 'guide_add_en'
    | 'guide_add_content_ar'
    | 'guide_edit_field'
    | 'user_search'
    | 'user_bal_amount'
    | 'user_bal_reason'
    | 'user_bal_confirm'
    | 'welcome_edit_ar'
    | 'welcome_edit_en'
    | 'ref_edit_rate'
    | 'ref_edit_cap'
    | 'ref_search_user';
  targetId?: number;
  field?: string;
  draft?: Record<string, any>;
}

async function saveAdminFsm(adminUserId: number, adminFsm: AdminFsmState | null) {
  const [row] = await db.select({ state: users.botStateJson }).from(users).where(eq(users.id, adminUserId)).limit(1);
  const prev = (row?.state as Record<string, any>) || {};
  await db
    .update(users)
    .set({
      botStateJson: { ...prev, adminFsm: adminFsm || { step: 'idle' } },
      updatedAt: new Date(),
    })
    .where(eq(users.id, adminUserId));
}

export function getAdminMainInline(store: StoreProfileSettings): BotInlineButton[][] {
  return [
    [
      { text: '🎛 إدارة أزرار البوت', callbackData: 'adm:buttons' },
      { text: '🗂 التصنيفات والعروض', callbackData: 'adm:cats' },
    ],
    [
      { text: '📖 إدارة الشروحات', callbackData: 'adm:guides' },
      { text: '👤 المستخدمون والرصيد', callbackData: 'adm:users' },
    ],
    [
      { text: '🛍 جميع المنتجات والأسعار', callbackData: 'adm:products:0' },
      { text: '🌐 الخوادم والمزودين', callbackData: 'adm:providers' },
    ],
    [
      { text: '💳 الإيداعات المعلقة', callbackData: 'adm:deposits' },
      { text: '📦 أحدث الطلبات', callbackData: 'adm:orders' },
    ],
    [
      { text: '🤝 إدارة الإحالات', callbackData: 'adm:referrals' },
      { text: '👋 رسالة الترحيب', callbackData: 'adm:welcome' },
    ],
    [
      {
        text: store.isStoreOpen ? '🔴 إيقاف المتجر مؤقتًا' : '🟢 تشغيل المتجر',
        callbackData: 'adm:togglestore',
      },
    ],
  ];
}

function slugify(text: string, prefix: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  return base || `${prefix}-${Date.now().toString(36)}`;
}

export async function handleTelegramAdminPanel(params: {
  adminUser: { id: number; displayName: string; role: string; botStateJson?: any };
  input: string;
  rawText?: string;
  entities?: any[];
  store: StoreProfileSettings;
  isCallback: boolean;
  notifyTelegramUser?: (telegramUserId: string, text: string) => Promise<void>;
}): Promise<BotReplyPayload> {
  const { adminUser, input, rawText, entities, store, isCallback, notifyTelegramUser } = params;
  const adminMainInline = getAdminMainInline(store);
  const adminFsm: AdminFsmState = (adminUser.botStateJson as any)?.adminFsm || { step: 'idle' };

  // Cancel any active Admin FSM
  if (input === 'adm:cancel') {
    await saveAdminFsm(adminUser.id, { step: 'idle' });
    return handleTelegramAdminPanel({
      adminUser: { ...adminUser, botStateJson: { ...(adminUser.botStateJson || {}), adminFsm: { step: 'idle' } } },
      input: 'adm:home',
      store,
      isCallback,
    });
  }

  // ==========================================================================
  // A. ADMIN FSM TEXT INPUT HANDLERS (Preserves Telegram Formatting & Entities!)
  // ==========================================================================
  if (!isCallback && rawText && adminFsm.step && adminFsm.step !== 'idle' && !input.startsWith('/admin') && !input.startsWith('سعر ') && !input.startsWith('/setprice')) {
    const trimmed = rawText.trim();
    const safeEntities = Array.isArray(entities) && entities.length > 0 ? entities : [];

    // 0. Referral Admin FSM inputs (commission rate, max cap, user lookup by Telegram ID)
    if (adminFsm.step === 'ref_edit_rate') {
      const normalized = trimmed.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/%/g, '');
      const num = Number(normalized);
      if (!Number.isFinite(num) || num < 0 || num > 100) {
        return {
          mode: 'admin',
          editInPlace: false,
          text: '⚠️ يرجى إدخال نسبة مئوية صحيحة بين 0 و 100 (مثال: 5 أو 7.5).',
          inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:ref_settings' }]],
        };
      }
      const updated = await updateReferralSettings({
        defaultCommissionPercent: num,
        actorUserId: adminUser.id,
        actorRole: adminUser.role,
      });
      await saveAdminFsm(adminUser.id, { step: 'idle' });
      return {
        mode: 'admin',
        editInPlace: false,
        text: `✅ تم تحديث نسبة عمولة الإحالة فورًا إلى ${formatRatePercentDisplay(updated.defaultCommissionPercent)}%.\n\n📌 تطبق النسبة الجديدة على الطلبات المستقبلية فقط ولا تعدّل العمولات السابقة.`,
        inlineKeyboard: [
          [{ text: '⚙️ إعدادات الإحالات', callbackData: 'adm:ref_settings' }],
          [{ text: '🤝 إدارة الإحالات', callbackData: 'adm:referrals' }],
        ],
      };
    }

    if (adminFsm.step === 'ref_edit_cap') {
      const normalized = trimmed.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/\$/g, '');
      const num = Number(normalized);
      if (!Number.isFinite(num) || num < 0) {
        return {
          mode: 'admin',
          editInPlace: false,
          text: '⚠️ يرجى إدخال مبلغ صحيح أكبر أو يساوي 0 (مثال: 100).',
          inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:ref_settings' }]],
        };
      }
      const updated = await updateReferralSettings({
        maxCommissionPerUserAmount: num,
        maxCommissionPerUserEnabled: num > 0,
        actorUserId: adminUser.id,
        actorRole: adminUser.role,
      });
      await saveAdminFsm(adminUser.id, { step: 'idle' });
      return {
        mode: 'admin',
        editInPlace: false,
        text: `✅ تم تحديث الحد الأقصى للعمولة لكل مستخدم: ${formatMoney2(updated.maxCommissionPerUserAmount)} ${updated.currency} (${updated.maxCommissionPerUserEnabled ? 'مفعّل' : 'غير محدود'}).`,
        inlineKeyboard: [
          [{ text: '⚙️ إعدادات الإحالات', callbackData: 'adm:ref_settings' }],
          [{ text: '🤝 إدارة الإحالات', callbackData: 'adm:referrals' }],
        ],
      };
    }

    if (adminFsm.step === 'ref_search_user') {
      await saveAdminFsm(adminUser.id, { step: 'idle' });
      const dossier = await lookupAdminReferralUser(trimmed, getLiveBotUsername());
      if (!dossier) {
        return {
          mode: 'admin',
          editInPlace: false,
          text: `❌ لم يتم العثور على مستخدم مطابق لـ: ${trimmed}`,
          inlineKeyboard: [
            [{ text: '🔎 بحث مرة أخرى', callbackData: 'adm:ref_search' }],
            [{ text: '🤝 إدارة الإحالات', callbackData: 'adm:referrals' }],
          ],
        };
      }
      const refListPreview = dossier.referredUsers
        .slice(0, 8)
        .map(
          (r, idx) =>
            `${idx + 1}. ${r.displayName} (${r.telegramUserId || '—'}) • طلبات: ${r.completedOrdersCount} • مشتريات: ${r.totalPurchased} USDT • عمولة: ${r.netCommissionGenerated} USDT`
        )
        .join('\n');

      return {
        mode: 'admin',
        editInPlace: false,
        text:
          `👤 ملف إحالات المستخدم\n\n` +
          `• الاسم: ${dossier.user.displayName}\n` +
          `• Telegram ID: ${dossier.user.telegramUserId || '—'}\n` +
          `• الحالة: ${dossier.user.isBlocked ? '🚫 محظور' : '🟢 نشط'} | الرصيد: ${dossier.user.walletBalance} USDT\n` +
          `• رابط الإحالة:\n${dossier.summary.referralLink}\n\n` +
          `📊 الإحصائيات:\n` +
          `• إجمالي المحالين: ${dossier.summary.totalReferredUsers} (الناجحون بمشتريات: ${dossier.summary.successfulReferrals})\n` +
          `• إجمالي مشتريات المحالين: ${dossier.summary.totalPurchases} ${dossier.summary.currency}\n` +
          `• إجمالي العمولات الممنوحة: ${dossier.summary.grossEarned} ${dossier.summary.currency}\n` +
          `• العمولات المعكوسة: ${dossier.summary.totalReversed} ${dossier.summary.currency}\n` +
          `• صافي الأرباح: ${dossier.summary.totalEarned} ${dossier.summary.currency}\n` +
          `• رصيد التسوية المعلق: ${dossier.summary.pendingRecoveryBalance} ${dossier.summary.currency}\n\n` +
          `👥 أحدث المحالين:\n${refListPreview || 'لا يوجد محالون بعد.'}`,
        inlineKeyboard: [
          [{ text: '🔎 بحث مستخدم آخر', callbackData: 'adm:ref_search' }],
          [{ text: '🤝 إدارة الإحالات', callbackData: 'adm:referrals' }],
        ],
      };
    }

    // 1. Edit existing button field
    if (adminFsm.step === 'btn_edit_field' && adminFsm.targetId && adminFsm.field) {
      const btnId = adminFsm.targetId;
      const field = adminFsm.field;
      const patch: Record<string, any> = { updatedAt: new Date() };

      if (field === 'label') {
        const tr = await autoTranslateBilingual(trimmed, 'button_label');
        patch.labelAr = tr.textAr;
        patch.labelEn = tr.textEn;
      } else if (field === 'content') {
        const tr = await autoTranslateBilingual(rawText, 'button_content');
        patch.contentAr = tr.textAr;
        patch.contentEn = tr.textEn;
        if (tr.sourceLang === 'ar') patch.contentEntitiesAr = safeEntities;
        else patch.contentEntitiesEn = safeEntities;
      } else if (field === 'labelAr') patch.labelAr = trimmed;
      else if (field === 'labelEn') patch.labelEn = trimmed;
      else if (field === 'actionValue') patch.actionValue = trimmed;
      else if (field === 'iconCustomEmojiId') patch.iconCustomEmojiId = trimmed === '-' || trimmed === 'none' ? null : trimmed;
      else if (field === 'contentAr') {
        patch.contentAr = rawText;
        patch.contentEntitiesAr = safeEntities;
      } else if (field === 'contentEn') {
        patch.contentEn = rawText;
        patch.contentEntitiesEn = safeEntities;
      }

      await db.update(botMenuButtons).set(patch).where(eq(botMenuButtons.id, btnId));
      await saveAdminFsm(adminUser.id, { step: 'idle' });

      const translationHint =
        field === 'label'
          ? `\n• عربي: ${patch.labelAr}\n• English: ${patch.labelEn}`
          : field === 'content'
            ? '\n(تمت الترجمة التلقائية وحفظ النسختين العربية والإنجليزية)'
            : '';

      return {
        mode: 'admin',
        editInPlace: false,
        text: `✅ تم حفظ التعديل بنجاح وسينعكس فورًا على بوت المشتري.${translationHint}`,
        inlineKeyboard: [
          [{ text: '🔙 العودة لإدارة الزر', callbackData: `adm:btn:${btnId}` }],
          [{ text: '🎛 قائمة الأزرار', callbackData: 'adm:buttons' }],
        ],
      };
    }

    // 2. Add new button / sub-button (Single-input auto-translation!)
    if (adminFsm.step === 'btn_add_label_ar') {
      const tr = await autoTranslateBilingual(trimmed, 'button_label');
      await saveAdminFsm(adminUser.id, {
        step: 'btn_add_type',
        draft: { ...(adminFsm.draft || {}), labelAr: tr.textAr, labelEn: tr.textEn },
      });
      return {
        mode: 'admin',
        editInPlace: false,
        text:
          `✅ تم حفظ الاسم والترجمة تلقائيًا:\n• عربي: ${tr.textAr}\n• English: ${tr.textEn}\n\nاختر وظيفة الزر الجديد:`,
        inlineKeyboard: [
          [{ text: '📂 قائمة فرعية (تضم أزرارًا فرعية)', callbackData: 'adm:btn_newtype:submenu' }],
          [{ text: '📝 رسالة مخصصة (مع ترجمة تلقائية)', callbackData: 'adm:btn_newtype:custom_text' }],
          [{ text: '🔗 رابط مباشر (URL / حساب تيليجرام)', callbackData: 'adm:btn_newtype:url' }],
          [{ text: '🗂 فتح تصنيف/برنامج محدد', callbackData: 'adm:btn_newtype:category' }],
          [{ text: '📖 فتح شرح محدد', callbackData: 'adm:btn_newtype:guide' }],
          [{ text: '❌ إلغاء', callbackData: 'adm:cancel' }],
        ],
      };
    }

    if (adminFsm.step === 'btn_add_value') {
      const draft = adminFsm.draft || {};
      const actionType = draft.actionType || 'custom_text';
      const parentId = draft.parentId ? Number(draft.parentId) : null;
      const existingBtns = await db
        .select()
        .from(botMenuButtons)
        .where(parentId === null ? isNull(botMenuButtons.parentId) : eq(botMenuButtons.parentId, parentId));
      const maxRow = existingBtns.reduce((m, b) => Math.max(m, b.rowOrder), 0);

      let contentAr = '';
      let contentEn = '';
      if (actionType === 'custom_text' || actionType === 'submenu') {
        const trC = await autoTranslateBilingual(rawText, 'button_content');
        contentAr = trC.textAr;
        contentEn = trC.textEn;
      }

      const code = `custom_${Date.now().toString(36)}`;
      const [created] = await db
        .insert(botMenuButtons)
        .values({
          parentId,
          code,
          labelAr: draft.labelAr || trimmed,
          labelEn: draft.labelEn || draft.labelAr || trimmed,
          buttonStyle: 'primary',
          actionType,
          actionValue: actionType === 'custom_text' || actionType === 'submenu' ? code : trimmed,
          contentAr,
          contentEntitiesAr: actionType === 'custom_text' || actionType === 'submenu' ? safeEntities : [],
          contentEn,
          contentEntitiesEn: [],
          rowOrder: maxRow + 1,
          colOrder: 1,
          buttonsPerRow: 2,
          isVisible: true,
          isEnabled: true,
        })
        .returning();

      await saveAdminFsm(adminUser.id, { step: 'idle' });
      return {
        mode: 'admin',
        editInPlace: false,
        text: `✅ تمت إضافة الزر "${created.labelAr} / ${created.labelEn}" بنجاح وظهر فورًا في بوت المشتري!`,
        inlineKeyboard: [
          [{ text: '⚙️ إدارة الزر وأزراره الفرعية', callbackData: `adm:btn:${created.id}` }],
          [{ text: '🎛 جميع الأزرار', callbackData: parentId ? `adm:btn_children:${parentId}` : 'adm:buttons' }],
        ],
      };
    }

    // 3. Add Category multi-step FSM
    if (adminFsm.step === 'cat_add_ar') {
      await saveAdminFsm(adminUser.id, { step: 'cat_add_en', draft: { nameAr: trimmed } });
      return {
        mode: 'admin',
        editInPlace: false,
        text: `✅ الاسم بالعربية: ${trimmed}\n\nأرسل اسم البرنامج/التصنيف بالإنجليزية (مثال: Claude أو Netflix):`,
        inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
      };
    }

    if (adminFsm.step === 'cat_add_en') {
      await saveAdminFsm(adminUser.id, {
        step: 'cat_add_emoji',
        draft: { ...(adminFsm.draft || {}), nameEn: trimmed },
      });
      return {
        mode: 'admin',
        editInPlace: false,
        text: `أرسل إيموجي اختياري يظهر بجانب الاسم (مثل 🎬 أو 💎) أو أرسل "-" بدون إيموجي:`,
        inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
      };
    }

    if (adminFsm.step === 'cat_add_emoji') {
      const draft = adminFsm.draft || {};
      const emoji = trimmed === '-' ? '' : trimmed.slice(0, 8);
      const existingCats = await db.select().from(categories);
      const maxSort = existingCats.reduce((m, c) => Math.max(m, c.sortOrder), 0);
      const slug = slugify(draft.nameEn || draft.nameAr || 'cat', 'cat');

      const [created] = await db
        .insert(categories)
        .values({
          slug,
          nameAr: draft.nameAr || draft.nameEn,
          nameEn: draft.nameEn || draft.nameAr,
          iconEmoji: emoji,
          buttonStyle: 'primary',
          showInStore: true,
          showInGuides: true,
          sortOrder: maxSort + 1,
          isActive: true,
        })
        .returning();

      await saveAdminFsm(adminUser.id, { step: 'idle' });
      return {
        mode: 'admin',
        editInPlace: false,
        text: `✅ تمت إضافة التصنيف «${created.iconEmoji ? created.iconEmoji + ' ' : ''}${created.nameAr}» بنجاح! يمكنك الآن تعيين العروض والمنتجات بداخله.`,
        inlineKeyboard: [
          [{ text: '➕ تعيين منتجات لهذا التصنيف', callbackData: `adm:cat_assign:${created.id}:0` }],
          [{ text: '🗂 جميع التصنيفات', callbackData: 'adm:cats' }],
        ],
      };
    }

    // 4. Edit Category Field
    if (adminFsm.step === 'cat_edit_field' && adminFsm.targetId && adminFsm.field) {
      const catId = adminFsm.targetId;
      const patch: Record<string, any> = {};
      if (adminFsm.field === 'nameAr') patch.nameAr = trimmed;
      else if (adminFsm.field === 'nameEn') patch.nameEn = trimmed;
      else if (adminFsm.field === 'iconEmoji') patch.iconEmoji = trimmed === '-' ? '' : trimmed.slice(0, 8);
      else if (adminFsm.field === 'iconCustomEmojiId') patch.iconCustomEmojiId = trimmed === '-' ? null : trimmed;

      await db.update(categories).set(patch).where(eq(categories.id, catId));
      await saveAdminFsm(adminUser.id, { step: 'idle' });
      return {
        mode: 'admin',
        editInPlace: false,
        text: '✅ تم تحديث التصنيف بنجاح وانعكس مباشرة في زر 🛍 Store.',
        inlineKeyboard: [[{ text: '🔙 العودة للتصنيف', callbackData: `adm:cat:${catId}` }]],
      };
    }

    // 5. Edit Product Field (Title AR/EN, Description AR/EN with entities, Retail Price)
    if (adminFsm.step === 'prod_edit_field' && adminFsm.targetId && adminFsm.field) {
      const prodId = adminFsm.targetId;
      const field = adminFsm.field;

      if (field === 'retailPrice') {
        let parsed: Decimal | null = null;
        try {
          const d = new Decimal(trimmed.replace(/[$,\s]/g, ''));
          if (d.isFinite() && d.gt(0)) parsed = d;
        } catch {
          parsed = null;
        }
        if (!parsed) {
          return {
            mode: 'admin',
            editInPlace: false,
            text: '⚠️ يرجى إرسال سعر صحيح أكبر من 0 (مثال: 3.50):',
            inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
          };
        }
        const [existingPrice] = await db
          .select()
          .from(productPrices)
          .where(eq(productPrices.storeProductId, prodId))
          .limit(1);
        if (existingPrice) {
          await db
            .update(productPrices)
            .set({ pricingMode: 'manual', retailPrice: parsed.toFixed(4), lockManualPrice: true, updatedAt: new Date() })
            .where(eq(productPrices.id, existingPrice.id));
        } else {
          await db.insert(productPrices).values({
            storeProductId: prodId,
            pricingMode: 'manual',
            retailPrice: parsed.toFixed(4),
            agentPrice: parsed.toFixed(4),
            lockManualPrice: true,
          });
        }
      } else {
        const patch: Record<string, any> = { updatedAt: new Date() };
        let summaryLines: string[] = [];

        if (field === 'title' || field === 'titleAr' || field === 'titleEn') {
          try {
            const tr = await autoTranslateBilingual(trimmed, 'product_title');
            patch.titleAr = tr.textAr || trimmed;
            patch.titleEn = tr.textEn || trimmed;
          } catch {
            patch.titleAr = trimmed;
            patch.titleEn = trimmed;
          }
          summaryLines = [
            '✅ تم تحديث اسم المنتج وترجمته تلقائيًا للغتين:',
            `🇸🇦 عربي: ${patch.titleAr}`,
            `🇬🇧 EN: ${patch.titleEn}`,
          ];
        } else if (field === 'description' || field === 'descriptionAr' || field === 'descriptionEn') {
          const cleanDesc = sanitizeCustomerProductDescription(rawText);
          try {
            const tr = await autoTranslateBilingual(cleanDesc, 'product_description');
            patch.descriptionAr = tr.textAr || cleanDesc;
            patch.descriptionEn = tr.textEn || cleanDesc;
            if (tr.sourceLang === 'en') {
              patch.descriptionEntitiesEn = safeEntities;
            } else {
              patch.descriptionEntitiesAr = safeEntities;
            }
          } catch {
            patch.descriptionAr = cleanDesc;
            patch.descriptionEn = cleanDesc;
            patch.descriptionEntitiesAr = safeEntities;
          }
          summaryLines = [
            '✅ تم تحديث وصف المنتج وترجمته تلقائيًا للغتين:',
            `🇸🇦 عربي: ${(patch.descriptionAr || '').slice(0, 120)}`,
            `🇬🇧 EN: ${(patch.descriptionEn || '').slice(0, 120)}`,
          ];
        }
        await db.update(storeProducts).set(patch).where(eq(storeProducts.id, prodId));

        await saveAdminFsm(adminUser.id, { step: 'idle' });
        return {
          mode: 'admin',
          editInPlace: false,
          text: summaryLines.length > 0 ? summaryLines.join('\n') : '✅ تم تحديث العرض بنجاح.',
          inlineKeyboard: [[{ text: '🔙 العودة لتفاصيل العرض', callbackData: `adm:prod:${prodId}` }]],
        };
      }

      await saveAdminFsm(adminUser.id, { step: 'idle' });
      return {
        mode: 'admin',
        editInPlace: false,
        text: '✅ تم تحديث العرض بنجاح.',
        inlineKeyboard: [[{ text: '🔙 العودة لتفاصيل العرض', callbackData: `adm:prod:${prodId}` }]],
      };
    }

    // 6. Add Service Guide multi-step FSM (preserving full Telegram formatting & custom emojis!)
    if (adminFsm.step === 'guide_add_ar') {
      await saveAdminFsm(adminUser.id, { step: 'guide_add_en', draft: { titleAr: trimmed } });
      return {
        mode: 'admin',
        editInPlace: false,
        text: `✅ اسم الشرح بالعربية: ${trimmed}\n\nأرسل اسم الشرح بالإنجليزية (مثال: Gemini):`,
        inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
      };
    }

    if (adminFsm.step === 'guide_add_en') {
      await saveAdminFsm(adminUser.id, {
        step: 'guide_add_content_ar',
        draft: { ...(adminFsm.draft || {}), titleEn: trimmed },
      });
      return {
        mode: 'admin',
        editInPlace: false,
        text:
          `📝 أرسل الآن نص الشرح كاملًا كما تريد أن يظهر للمشتري.\n\n` +
          `✨ جميع تنسيقات تيليجرام محفوظة 100%:\n` +
          `• العريض والمائل وتحته خط والمشطوب\n` +
          `• الروابط والكود والاقتباسات القابلة للطي\n` +
          `• الإيموجي العادي والمخصص/المتحرك (Telegram Custom Emoji)`,
        inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
      };
    }

    if (adminFsm.step === 'guide_add_content_ar') {
      const draft = adminFsm.draft || {};
      const existingGuides = await db.select().from(serviceGuides);
      const maxSort = existingGuides.reduce((m, g) => Math.max(m, g.sortOrder), 0);
      const slug = slugify(draft.titleEn || draft.titleAr || 'guide', 'guide');

      // Auto-link to category with same slug if exists
      const [matchingCat] = await db.select().from(categories).where(eq(categories.slug, slug)).limit(1);

      const [created] = await db
        .insert(serviceGuides)
        .values({
          slug,
          categoryId: matchingCat?.id || null,
          titleAr: draft.titleAr || draft.titleEn,
          titleEn: draft.titleEn || draft.titleAr,
          iconEmoji: matchingCat?.iconEmoji || '📘',
          contentAr: rawText,
          contentEntitiesAr: safeEntities,
          contentEn: rawText,
          contentEntitiesEn: safeEntities,
          sortOrder: maxSort + 1,
          isVisible: true,
        })
        .returning();

      await saveAdminFsm(adminUser.id, { step: 'idle' });
      return {
        mode: 'admin',
        editInPlace: false,
        text: `✅ تم حفظ الشرح «${created.titleAr}» بنجاح مع الحفاظ على ${safeEntities.length} عنصر تنسيق/إيموجي مخصص!`,
        inlineKeyboard: [
          [{ text: '👁 معاينة الشرح كما يراه المشتري', callbackData: `adm:guide_prev:${created.id}:ar` }],
          [{ text: '⚙️ إدارة هذا الشرح', callbackData: `adm:guide:${created.id}` }],
          [{ text: '📖 جميع الشروحات', callbackData: 'adm:guides' }],
        ],
      };
    }

    // 7. Edit existing Service Guide field (preserving entities!)
    if (adminFsm.step === 'guide_edit_field' && adminFsm.targetId && adminFsm.field) {
      const guideId = adminFsm.targetId;
      const field = adminFsm.field;
      const patch: Record<string, any> = { updatedAt: new Date() };

      if (field === 'titleAr') patch.titleAr = trimmed;
      else if (field === 'titleEn') patch.titleEn = trimmed;
      else if (field === 'iconEmoji') patch.iconEmoji = trimmed === '-' ? '' : trimmed.slice(0, 8);
      else if (field === 'contentAr') {
        patch.contentAr = rawText;
        patch.contentEntitiesAr = safeEntities;
      } else if (field === 'contentEn') {
        patch.contentEn = rawText;
        patch.contentEntitiesEn = safeEntities;
      }

      await db.update(serviceGuides).set(patch).where(eq(serviceGuides.id, guideId));
      await saveAdminFsm(adminUser.id, { step: 'idle' });
      return {
        mode: 'admin',
        editInPlace: false,
        text: `✅ تم حفظ الشرح بنجاح مع الاحتفاظ بجميع التنسيقات (${safeEntities.length} عنصر).`,
        inlineKeyboard: [
          [{ text: '👁 معاينة الشرح الآن', callbackData: `adm:guide_prev:${guideId}:${field === 'contentEn' ? 'en' : 'ar'}` }],
          [{ text: '🔙 العودة لإدارة الشرح', callbackData: `adm:guide:${guideId}` }],
        ],
      };
    }

    // 8. Edit Welcome Message AR / EN (preserving entities!)
    if (adminFsm.step === 'welcome_edit_ar' || adminFsm.step === 'welcome_edit_en') {
      const isEn = adminFsm.step === 'welcome_edit_en';
      const [profRow] = await db.select().from(settings).where(eq(settings.key, 'store_profile')).limit(1);
      const prev = (profRow?.valueJson as Record<string, any>) || {};
      const next = isEn
        ? { ...prev, welcomeMessageEn: rawText, welcomeEntitiesEn: safeEntities }
        : { ...prev, welcomeMessageAr: rawText, welcomeEntitiesAr: safeEntities };

      await db
        .insert(settings)
        .values({ key: 'store_profile', valueJson: next })
        .onConflictDoUpdate({ target: settings.key, set: { valueJson: next, updatedAt: new Date() } });

      await saveAdminFsm(adminUser.id, { step: 'idle' });
      return {
        mode: 'admin',
        editInPlace: false,
        text: `✅ تم تحديث رسالة الترحيب (${isEn ? 'EN' : 'AR'}) مع حفظ ${safeEntities.length} عنصر تنسيق.`,
        inlineKeyboard: [[{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }]],
      };
    }

    // 9. Search User by Telegram User ID or @username
    if (adminFsm.step === 'user_search') {
      const q = trimmed.replace(/^@/, '');
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
        .limit(8);

      await saveAdminFsm(adminUser.id, { step: 'idle' });
      if (found.length === 0) {
        return {
          mode: 'admin',
          editInPlace: false,
          text: `⚠️ لم يتم العثور على مستخدم يطابق «${trimmed}». تأكد من رقم Telegram User ID.`,
          inlineKeyboard: [
            [{ text: '🔎 بحث مجددًا', callbackData: 'adm:user_search' }],
            [{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }],
          ],
        };
      }
      if (found.length === 1) {
        return renderAdminUserDossier(found[0].id, false);
      }
      return {
        mode: 'admin',
        editInPlace: false,
        text: `👤 نتائج البحث عن «${trimmed}» (${found.length}):`,
        inlineKeyboard: [
          ...found.map((u) => [
            {
              text: `${u.displayName} (ID: ${u.telegramUserId || u.id})`,
              callbackData: `adm:user:${u.id}`,
            },
          ]),
          [{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }],
        ],
      };
    }

    // 10. User Balance Adjustment Step 1: Enter Decimal Amount
    if (adminFsm.step === 'user_bal_amount' && adminFsm.targetId) {
      let amountDec: Decimal | null = null;
      try {
        const d = new Decimal(trimmed.replace(/[$,+\-\s]/g, ''));
        if (d.isFinite() && d.gt(0) && d.lte(100000)) amountDec = d;
      } catch {
        amountDec = null;
      }

      if (!amountDec) {
        return {
          mode: 'admin',
          editInPlace: false,
          text: '⚠️ يرجى إدخال مبلغ صحيح أكبر من 0 (مثال: 10 أو 2.50):',
          inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
        };
      }

      const direction = adminFsm.draft?.direction === 'deduct' ? 'deduct' : 'add';
      await saveAdminFsm(adminUser.id, {
        step: 'user_bal_reason',
        targetId: adminFsm.targetId,
        draft: { direction, amount: amountDec.toFixed(4) },
      });

      return {
        mode: 'admin',
        editInPlace: false,
        text:
          `✅ المبلغ: ${direction === 'add' ? '+' : '-'}${amountDec.toFixed(2)} USDT\n\n` +
          `أرسل الآن سبب العملية (مطلوب للتوثيق في سجل المحفظة، مثال: تعويض طلب أو شحن يدوي):`,
        inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
      };
    }

    // 11. User Balance Adjustment Step 2: Enter Reason -> Show Before/After Confirmation with One-Time Token
    if (adminFsm.step === 'user_bal_reason' && adminFsm.targetId) {
      const reason = trimmed.slice(0, 180);
      if (reason.length < 2) {
        return {
          mode: 'admin',
          editInPlace: false,
          text: '⚠️ يرجى كتابة سبب واضح للتعديل:',
          inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
        };
      }

      const [targetUser] = await db.select().from(users).where(eq(users.id, adminFsm.targetId)).limit(1);
      if (!targetUser) {
        await saveAdminFsm(adminUser.id, { step: 'idle' });
        return { mode: 'admin', editInPlace: false, text: 'المستخدم غير موجود.', inlineKeyboard: adminMainInline };
      }

      const w = await ensureUserWallet(targetUser.id);
      const direction = adminFsm.draft?.direction === 'deduct' ? 'deduct' : 'add';
      const amtDec = new Decimal(adminFsm.draft?.amount || '0');
      const deltaDec = direction === 'deduct' ? amtDec.neg() : amtDec;
      const beforeDec = new Decimal(w.availableBalance);
      const afterDec = beforeDec.plus(deltaDec);

      if (afterDec.lt(0)) {
        await saveAdminFsm(adminUser.id, { step: 'idle' });
        return {
          mode: 'admin',
          editInPlace: false,
          text: `❌ لا يمكن الخصم لأن الرصيد سيصبح سالبًا!\nالرصيد الحالي: ${beforeDec.toFixed(2)} USDT | المطلوب خصمه: ${amtDec.toFixed(2)} USDT.`,
          inlineKeyboard: [[{ text: '🔙 ملف المستخدم', callbackData: `adm:user:${targetUser.id}` }]],
        };
      }

      const token = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      await saveAdminFsm(adminUser.id, {
        step: 'user_bal_confirm',
        targetId: targetUser.id,
        draft: {
          token,
          direction,
          deltaAmount: deltaDec.toFixed(4),
          reason,
        },
      });

      return {
        mode: 'admin',
        editInPlace: false,
        text:
          `⚠️ تأكيد عملية تعديل الرصيد\n\n` +
          `• المستخدم: ${targetUser.displayName} (ID: ${targetUser.telegramUserId || targetUser.id})\n` +
          `• العملية: ${direction === 'add' ? '➕ إضافة رصيد' : '➖ خصم رصيد'}\n` +
          `• المبلغ: ${deltaDec.gte(0) ? '+' : ''}${deltaDec.toFixed(2)} USDT\n` +
          `• الرصيد قبل: ${beforeDec.toFixed(2)} USDT\n` +
          `• الرصيد بعد: ${afterDec.toFixed(2)} USDT\n` +
          `• السبب: ${reason}\n\n` +
          `اضغط تأكيد للتنفيذ الفوري (محمي ضد التكرار):`,
        inlineKeyboard: [
          [
            { text: '✅ تأكيد وتنفيذ الآن', callbackData: `adm:ubal_exec:${token}` },
            { text: '❌ إلغاء', callbackData: 'adm:cancel' },
          ],
        ],
      };
    }
  }

  // ==========================================================================
  // B. ADMIN HOME / REAL DATABASE STATISTICS
  // ==========================================================================
  if (input === '/admin' || input === 'adm:home' || input === 'adm:stats') {
    if (adminFsm.step !== 'idle') await saveAdminFsm(adminUser.id, { step: 'idle' });

    const [orderStats] = await db
      .select({
        totalCount: sql<number>`count(*)`,
        revenue: sql<string>`coalesce(sum(${orders.totalRetail}), 0)`,
        profit: sql<string>`coalesce(sum(${orders.netProfitSnapshot}), 0)`,
      })
      .from(orders)
      .where(eq(orders.status, 'completed'));

    const pendingDeps = await db
      .select()
      .from(deposits)
      .where(or(eq(deposits.status, 'pending_review'), eq(deposits.status, 'pending')));
    const allProds = await db.select().from(storeProducts);
    const allCats = await db.select().from(categories);
    const allBtns = await db.select().from(botMenuButtons);
    const visibleCount = allProds.filter((p) => p.isVisible && !p.isPaused).length;
    const hiddenCount = allProds.length - visibleCount;
    const binanceCreds = await resolveBinanceCredentials();

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        `🛡️ لوحة إدارة ${store.storeName} (للمدير فقط)\n` +
        `مرحبًا ${adminUser.displayName}\n\n` +
        `• حالة المتجر: ${store.isStoreOpen ? '🟢 مفتوح ويعمل' : '🔴 متوقف للصيانة'}\n` +
        `• أزرار القائمة الرئيسية: ${allBtns.filter((b) => b.isVisible).length} ظاهر / ${allBtns.length} إجمالي\n` +
        `• أقسام البرامج في المتجر: ${allCats.filter((c) => c.isActive).length}\n` +
        `• العروض المنشورة: ${visibleCount} | المخفية: ${hiddenCount}\n` +
        `• المبيعات الفعلية: ${formatMoney(orderStats?.revenue || '0', 2)} USDT (${orderStats?.totalCount || 0} طلب)\n` +
        `• صافي الأرباح الفعلية: ${formatMoney(orderStats?.profit || '0', 2)} USDT\n` +
        `• التحقق التلقائي لـ Binance ID: ${binanceCreds.autoVerifyEnabled ? '🟢 مفعّل' : '🟡 بانتظار التفعيل'}\n` +
        `• إيداعات معلقة: ${pendingDeps.length}`,
      inlineKeyboard: adminMainInline,
    };
  }

  // ==========================================================================
  // C. DYNAMIC MAIN & SUB-MENU BUTTONS MANAGER (Auto-Translation + Confirmation)
  // ==========================================================================
  if (input === 'adm:buttons') {
    const allBtns = await db
      .select()
      .from(botMenuButtons)
      .orderBy(asc(botMenuButtons.rowOrder), asc(botMenuButtons.colOrder), asc(botMenuButtons.id));
    const rootBtns = allBtns.filter((b) => !b.parentId);
    const childCountByParent = new Map<number, number>();
    for (const b of allBtns) {
      if (b.parentId) childCountByParent.set(b.parentId, (childCountByParent.get(b.parentId) || 0) + 1);
    }

    const keyboard: BotInlineButton[][] = rootBtns.map((b) => {
      const subCount = childCountByParent.get(b.id) || 0;
      const subTag = subCount > 0 ? ` [${subCount} فرعي]` : '';
      return [
        {
          text: `${b.isVisible ? '🟢' : '🙈'}${b.isEnabled ? '' : '⏸'} ${b.labelAr} | ${b.labelEn}${subTag}`,
          callbackData: `adm:btn:${b.id}`,
        },
      ];
    });
    keyboard.push([{ text: '➕ إضافة زر جديد للقائمة الرئيسية', callbackData: 'adm:btn_add' }]);
    keyboard.push([{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }]);

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        `🎛 إدارة أزرار بوت المشتري (${rootBtns.length} زر رئيسي)\n\n` +
        `اختر أي زر لإدارة إعداداته وأزراره الفرعية. الترجمة العربية ↔ الإنجليزية تتم تلقائيًا عند الإدخال مرة واحدة:`,
      inlineKeyboard: keyboard,
    };
  }

  if (input === 'adm:btn_add' || input.startsWith('adm:btn_add_sub:')) {
    const parentId = input.startsWith('adm:btn_add_sub:') ? Number(input.split(':')[2]) : null;
    await saveAdminFsm(adminUser.id, { step: 'btn_add_label_ar', draft: { parentId } });
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: parentId
        ? '➕ إضافة زر فرعي جديد:\nأرسل اسم الزر بأي لغة (عربي أو إنجليزي) وسيتم ترجمته تلقائيًا:'
        : '➕ إضافة زر رئيسي جديد:\nأرسل اسم الزر بأي لغة (عربي أو إنجليزي) وسيتم ترجمته تلقائيًا (مثال: ⭐ عروض VIP):',
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
    };
  }

  if (input.startsWith('adm:btn_children:')) {
    const parentId = Number(input.split(':')[2]);
    const [parent] = await db.select().from(botMenuButtons).where(eq(botMenuButtons.id, parentId)).limit(1);
    if (!parent) return handleTelegramAdminPanel({ ...params, input: 'adm:buttons' });
    const children = await db
      .select()
      .from(botMenuButtons)
      .where(eq(botMenuButtons.parentId, parentId))
      .orderBy(asc(botMenuButtons.rowOrder), asc(botMenuButtons.colOrder), asc(botMenuButtons.id));

    const keyboard: BotInlineButton[][] = children.map((c) => [
      {
        text: `${c.isVisible ? '🟢' : '🙈'} ${c.labelAr} | ${c.labelEn}`,
        callbackData: `adm:btn:${c.id}`,
      },
    ]);
    keyboard.push([{ text: '➕ إضافة زر فرعي هنا', callbackData: `adm:btn_add_sub:${parent.id}` }]);
    keyboard.push([{ text: `🔙 العودة إلى ${parent.labelAr}`, callbackData: `adm:btn:${parent.id}` }]);

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: `📂 الأزرار الفرعية التابعة لـ «${parent.labelAr}» (${children.length}):`,
      inlineKeyboard: keyboard,
    };
  }

  if (input.startsWith('adm:btn_newtype:')) {
    const actionType = input.split(':')[2] || 'custom_text';
    await saveAdminFsm(adminUser.id, {
      step: 'btn_add_value',
      draft: { ...(adminFsm.draft || {}), actionType },
    });
    const promptMap: Record<string, string> = {
      submenu: '📂 أرسل النص الترحيبي الذي سيظهر فوق الأزرار الفرعية (بأي لغة — سيُترجم تلقائيًا):',
      custom_text: '📝 أرسل النص الذي سيظهر للمشتري عند الضغط على الزر (بأي لغة — سيُترجم تلقائيًا):',
      url: '🔗 أرسل الرابط الكامل أو معرّف تيليجرام (مثال: https://t.me/username أو @username):',
      category: '🗂 أرسل slug التصنيف المستهدف (مثال: gemini أو chatgpt أو canva):',
      guide: '📖 أرسل slug الشرح المستهدف (مثال: gemini أو chatgpt):',
    };
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: promptMap[actionType] || promptMap.custom_text,
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
    };
  }

  if (input.startsWith('adm:btn:')) {
    const btnId = Number(input.split(':')[2]);
    const [b] = await db.select().from(botMenuButtons).where(eq(botMenuButtons.id, btnId)).limit(1);
    if (!b) return handleTelegramAdminPanel({ ...params, input: 'adm:buttons' });
    const children = await db.select({ id: botMenuButtons.id }).from(botMenuButtons).where(eq(botMenuButtons.parentId, b.id));

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        `🎛 إدارة الزر #${b.id}${b.parentId ? ' (زر فرعي)' : ' (زر رئيسي)'}\n\n` +
        `• عربي: ${b.labelAr}\n` +
        `• English: ${b.labelEn}\n` +
        `• الوظيفة: ${b.actionType} → ${b.actionValue}\n` +
        `• الأزرار الفرعية: ${children.length}\n` +
        `• الصف: ${b.rowOrder} | بالصف: ${b.buttonsPerRow} | اللون: ${b.buttonStyle || 'افتراضي'}\n` +
        `• الظهور: ${b.isVisible ? '🟢 ظاهر' : '🙈 مخفي'} | الحالة: ${b.isEnabled ? '✅ مفعل' : '⏸ معطل'}`,
      inlineKeyboard: [
        [{ text: `📂 الأزرار الفرعية (${children.length})`, callbackData: `adm:btn_children:${b.id}` }],
        [
          { text: b.isVisible ? '🙈 إخفاء' : '👁 إظهار', callbackData: `adm:btn_vis:${b.id}` },
          { text: b.isEnabled ? '⏸ تعطيل' : '✅ تفعيل', callbackData: `adm:btn_en:${b.id}` },
        ],
        [
          { text: '✏️ تعديل الاسم (ترجمة تلقائية)', callbackData: `adm:btn_edit:${b.id}:label` },
          { text: '📝 تعديل المحتوى (ترجمة تلقائية)', callbackData: `adm:btn_edit:${b.id}:content` },
        ],
        [
          { text: '⬆️ صف أعلى', callbackData: `adm:btn_up:${b.id}` },
          { text: '⬇️ صف أسفل', callbackData: `adm:btn_dn:${b.id}` },
          { text: `📐 بالصف (${b.buttonsPerRow})`, callbackData: `adm:btn_cols:${b.id}` },
        ],
        [
          { text: '🎨 لون الزر', callbackData: `adm:btn_style:${b.id}` },
          { text: '🔗 الرابط/الهدف', callbackData: `adm:btn_edit:${b.id}:actionValue` },
        ],
        [
          { text: '✨ Custom Emoji ID', callbackData: `adm:btn_edit:${b.id}:iconCustomEmojiId` },
          { text: '🗑 حذف الزر', callbackData: `adm:btn_del:${b.id}` },
        ],
        [{ text: b.parentId ? '🔙 العودة للأزرار الفرعية' : '🔙 قائمة الأزرار الرئيسية', callbackData: b.parentId ? `adm:btn_children:${b.parentId}` : 'adm:buttons' }],
      ],
    };
  }

  if (input.startsWith('adm:btn_vis:')) {
    const id = Number(input.split(':')[2]);
    const [b] = await db.select().from(botMenuButtons).where(eq(botMenuButtons.id, id)).limit(1);
    if (b) await db.update(botMenuButtons).set({ isVisible: !b.isVisible, updatedAt: new Date() }).where(eq(botMenuButtons.id, id));
    return handleTelegramAdminPanel({ ...params, input: `adm:btn:${id}` });
  }

  if (input.startsWith('adm:btn_en:')) {
    const id = Number(input.split(':')[2]);
    const [b] = await db.select().from(botMenuButtons).where(eq(botMenuButtons.id, id)).limit(1);
    if (b) await db.update(botMenuButtons).set({ isEnabled: !b.isEnabled, updatedAt: new Date() }).where(eq(botMenuButtons.id, id));
    return handleTelegramAdminPanel({ ...params, input: `adm:btn:${id}` });
  }

  if (input.startsWith('adm:btn_up:') || input.startsWith('adm:btn_dn:')) {
    const isUp = input.startsWith('adm:btn_up:');
    const id = Number(input.split(':')[2]);
    const [b] = await db.select().from(botMenuButtons).where(eq(botMenuButtons.id, id)).limit(1);
    if (b) {
      const nextRow = Math.max(1, b.rowOrder + (isUp ? -1 : 1));
      await db.update(botMenuButtons).set({ rowOrder: nextRow, updatedAt: new Date() }).where(eq(botMenuButtons.id, id));
    }
    return handleTelegramAdminPanel({ ...params, input: `adm:btn:${id}` });
  }

  if (input.startsWith('adm:btn_cols:')) {
    const id = Number(input.split(':')[2]);
    const [b] = await db.select().from(botMenuButtons).where(eq(botMenuButtons.id, id)).limit(1);
    if (b) {
      const nextCols = b.buttonsPerRow === 2 ? 1 : b.buttonsPerRow === 1 ? 3 : 2;
      await db.update(botMenuButtons).set({ buttonsPerRow: nextCols, updatedAt: new Date() }).where(eq(botMenuButtons.id, id));
    }
    return handleTelegramAdminPanel({ ...params, input: `adm:btn:${id}` });
  }

  if (input.startsWith('adm:btn_style:')) {
    const id = Number(input.split(':')[2]);
    const [b] = await db.select().from(botMenuButtons).where(eq(botMenuButtons.id, id)).limit(1);
    if (b) {
      const cycle = ['primary', 'success', 'danger', null] as const;
      const idx = cycle.indexOf((b.buttonStyle as any) || null);
      const nextStyle = cycle[(idx + 1) % cycle.length];
      await db.update(botMenuButtons).set({ buttonStyle: nextStyle, updatedAt: new Date() }).where(eq(botMenuButtons.id, id));
    }
    return handleTelegramAdminPanel({ ...params, input: `adm:btn:${id}` });
  }

  if (input.startsWith('adm:btn_del:')) {
    const id = Number(input.split(':')[2]);
    const [b] = await db.select().from(botMenuButtons).where(eq(botMenuButtons.id, id)).limit(1);
    if (!b) return handleTelegramAdminPanel({ ...params, input: 'adm:buttons' });
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: `⚠️ تأكيد الحذف\nهل أنت متأكد من حذف الزر «${b.labelAr}» مع جميع أزراره الفرعية نهائيًا؟`,
      inlineKeyboard: [
        [
          { text: '✅ تأكيد التنفيذ', callbackData: `adm:btn_del_ok:${b.id}`, style: 'danger' },
          { text: '↩️ التراجع عن العملية', callbackData: `adm:btn:${b.id}`, style: 'primary' },
        ],
      ],
    };
  }

  if (input.startsWith('adm:btn_del_ok:')) {
    const id = Number(input.split(':')[2]);
    const allBtns = await db.select().from(botMenuButtons);
    const idsToDelete = collectDescendantButtonIds(allBtns as any, id);
    if (idsToDelete.length > 0) {
      await db.delete(botMenuButtons).where(inArray(botMenuButtons.id, idsToDelete));
    }
    return handleTelegramAdminPanel({ ...params, input: 'adm:buttons' });
  }

  if (input.startsWith('adm:btn_edit:')) {
    const [, , idStr, field] = input.split(':');
    const id = Number(idStr);
    await saveAdminFsm(adminUser.id, { step: 'btn_edit_field', targetId: id, field });
    const labels: Record<string, string> = {
      label: 'أرسل الاسم الجديد للزر بأي لغة (عربي أو إنجليزي) وسيتم ترجمته وحفظ اللغتين تلقائيًا:',
      content: 'أرسل المحتوى الجديد بأي لغة (عربي أو إنجليزي) وسيتم ترجمته وحفظ اللغتين تلقائيًا:',
      labelAr: 'أرسل الاسم الجديد للزر بالعربية (مع الإيموجي):',
      labelEn: 'Send the new English button label:',
      contentAr: 'أرسل المحتوى الجديد بالعربية:',
      contentEn: 'Send the new English content:',
      actionValue: 'أرسل الرابط أو القيمة المستهدفة الجديدة (مثال: https://t.me/support أو support_link):',
      iconCustomEmojiId: 'أرسل معرّف الإيموجي المخصص (custom_emoji_id الرقمي) أو أرسل "-" لإزالته:',
    };
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: labels[field] || 'أرسل القيمة الجديدة:',
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
    };
  }

  // ==========================================================================
  // D. PROGRAM CATEGORIES & OFFERS MANAGER (Gemini, ChatGPT, Canva, Adobe...)
  // ==========================================================================
  if (input === 'adm:cats') {
    const cats = await db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id));
    const allProds = await db.select().from(storeProducts);

    const keyboard: BotInlineButton[][] = [];
    for (let i = 0; i < cats.length; i += 2) {
      const row = cats.slice(i, i + 2).map((c) => {
        const cnt = allProds.filter((p) => p.categoryId === c.id).length;
        const visCnt = allProds.filter((p) => p.categoryId === c.id && p.isVisible && !p.isPaused).length;
        return {
          text: `${c.isActive ? '🟢' : '🙈'} ${c.iconEmoji ? c.iconEmoji + ' ' : ''}${c.nameAr} (${visCnt}/${cnt})`,
          callbackData: `adm:cat:${c.id}`,
        };
      });
      keyboard.push(row);
    }
    keyboard.push([{ text: '➕ إضافة تصنيف / برنامج جديد', callbackData: 'adm:cat_add' }]);
    keyboard.push([{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }]);

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        `🗂 إدارة تصنيفات البرامج والخدمات في 🛍 Store\n\n` +
        `الرقم (الظاهر/الإجمالي) يوضح العروض المنشورة داخل كل برنامج. اختر برنامجًا لإدارته أو تعيين منتجات مستوردة بداخله:`,
      inlineKeyboard: keyboard,
    };
  }

  if (input === 'adm:cat_add') {
    await saveAdminFsm(adminUser.id, { step: 'cat_add_ar', draft: {} });
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: '➕ إضافة برنامج/تصنيف جديد إلى المتجر:\nأرسل اسم البرنامج بالعربية (مثال: Claude أو Perplexity):',
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
    };
  }

  if (input.startsWith('adm:cat:')) {
    const catId = Number(input.split(':')[2]);
    const [cat] = await db.select().from(categories).where(eq(categories.id, catId)).limit(1);
    if (!cat) return handleTelegramAdminPanel({ ...params, input: 'adm:cats' });

    const prods = await db
      .select({ product: storeProducts, price: productPrices })
      .from(storeProducts)
      .leftJoin(productPrices, eq(productPrices.storeProductId, storeProducts.id))
      .where(eq(storeProducts.categoryId, catId))
      .orderBy(asc(storeProducts.sortOrder), asc(storeProducts.id));

    const liveMap = await getLiveProductPricingMap();
    const prodButtons: BotInlineButton[][] = prods.slice(0, 15).map((r) => {
      const live = liveMap.get(r.product.id);
      const price = live
        ? live.effectiveUnitRetailFormatted
        : formatMoney(r.price?.promoPrice || r.price?.retailPrice || '0', 2);
      const stock = live ? live.totalStock : 0;
      const short = r.product.titleAr.length > 28 ? r.product.titleAr.slice(0, 28) + '…' : r.product.titleAr;
      return [
        {
          text: `${r.product.isVisible && !r.product.isPaused ? '🟢' : '🙈'} ${short} - $${price} - [${stock}]`,
          callbackData: `adm:prod:${r.product.id}`,
        },
      ];
    });

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        `🗂 إدارة قسم: ${cat.iconEmoji ? cat.iconEmoji + ' ' : ''}${cat.nameAr} (${cat.nameEn || cat.nameAr})\n` +
        `• الحالة: ${cat.isActive ? '🟢 ظاهر في المتجر' : '🙈 مخفي'}\n` +
        `• الترتيب: #${cat.sortOrder}\n` +
        `• العروض المرتبطة: ${prods.length} (منشور: ${prods.filter((p) => p.product.isVisible && !p.product.isPaused).length})`,
      inlineKeyboard: [
        ...prodButtons,
        [{ text: '➕ تعيين منتج مستورد لهذا القسم', callbackData: `adm:cat_assign:${cat.id}:0` }],
        [
          { text: '✏️ الاسم AR', callbackData: `adm:cat_edit:${cat.id}:nameAr` },
          { text: '✏️ الاسم EN', callbackData: `adm:cat_edit:${cat.id}:nameEn` },
          { text: '✨ الإيموجي', callbackData: `adm:cat_edit:${cat.id}:iconEmoji` },
        ],
        [
          { text: '⬆️ تقديم', callbackData: `adm:cat_up:${cat.id}` },
          { text: '⬇️ تأخير', callbackData: `adm:cat_dn:${cat.id}` },
          { text: cat.isActive ? '🙈 إخفاء' : '👁 إظهار', callbackData: `adm:cat_vis:${cat.id}` },
        ],
        [
          { text: '🗑 حذف القسم', callbackData: `adm:cat_del:${cat.id}` },
          { text: '🔙 التصنيفات', callbackData: 'adm:cats' },
        ],
      ],
    };
  }

  if (input.startsWith('adm:cat_assign:')) {
    const [, , catIdStr, pageStr] = input.split(':');
    const catId = Number(catIdStr);
    const page = Math.max(0, Number(pageStr) || 0);
    const pageSize = 8;

    const [cat] = await db.select().from(categories).where(eq(categories.id, catId)).limit(1);
    const allProds = await db
      .select({ product: storeProducts, price: productPrices })
      .from(storeProducts)
      .leftJoin(productPrices, eq(productPrices.storeProductId, storeProducts.id))
      .orderBy(desc(storeProducts.id));

    const slice = allProds.slice(page * pageSize, (page + 1) * pageSize);
    const buttons: BotInlineButton[][] = slice.map((r) => {
      const inThis = r.product.categoryId === catId;
      const short = r.product.titleAr.length > 34 ? r.product.titleAr.slice(0, 34) + '…' : r.product.titleAr;
      return [
        {
          text: `${inThis ? '✅' : '➕'} #${r.product.id} ${short}`,
          callbackData: `adm:cat_setprod:${catId}:${r.product.id}:${page}`,
        },
      ];
    });

    const navRow: BotInlineButton[] = [];
    if (page > 0) navRow.push({ text: '⬅️ السابق', callbackData: `adm:cat_assign:${catId}:${page - 1}` });
    if ((page + 1) * pageSize < allProds.length) {
      navRow.push({ text: 'التالي ➡️', callbackData: `adm:cat_assign:${catId}:${page + 1}` });
    }
    if (navRow.length > 0) buttons.push(navRow);
    buttons.push([{ text: '🔙 العودة للقسم', callbackData: `adm:cat:${catId}` }]);

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: `➕ اختر المنتجات المستوردة لضمّها إلى قسم «${cat?.nameAr || ''}» (صفحة ${page + 1} من ${Math.max(1, Math.ceil(allProds.length / pageSize))}):`,
      inlineKeyboard: buttons,
    };
  }

  if (input.startsWith('adm:cat_setprod:')) {
    const [, , catIdStr, prodIdStr, pageStr] = input.split(':');
    const catId = Number(catIdStr);
    const prodId = Number(prodIdStr);
    await db.update(storeProducts).set({ categoryId: catId, updatedAt: new Date() }).where(eq(storeProducts.id, prodId));
    return handleTelegramAdminPanel({ ...params, input: `adm:cat_assign:${catId}:${pageStr || '0'}` });
  }

  if (input.startsWith('adm:cat_vis:')) {
    const id = Number(input.split(':')[2]);
    const [c] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
    if (c) await db.update(categories).set({ isActive: !c.isActive }).where(eq(categories.id, id));
    return handleTelegramAdminPanel({ ...params, input: `adm:cat:${id}` });
  }

  if (input.startsWith('adm:cat_up:') || input.startsWith('adm:cat_dn:')) {
    const isUp = input.startsWith('adm:cat_up:');
    const id = Number(input.split(':')[2]);
    const [c] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
    if (c) {
      await db.update(categories).set({ sortOrder: Math.max(1, c.sortOrder + (isUp ? -1 : 1)) }).where(eq(categories.id, id));
    }
    return handleTelegramAdminPanel({ ...params, input: `adm:cat:${id}` });
  }

  if (input.startsWith('adm:cat_del:')) {
    const id = Number(input.split(':')[2]);
    await db.delete(categories).where(eq(categories.id, id));
    return handleTelegramAdminPanel({ ...params, input: 'adm:cats' });
  }

  if (input.startsWith('adm:cat_edit:')) {
    const [, , idStr, field] = input.split(':');
    await saveAdminFsm(adminUser.id, { step: 'cat_edit_field', targetId: Number(idStr), field });
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: `✏️ أرسل القيمة الجديدة للحقل (${field}):`,
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
    };
  }

  // ==========================================================================
  // E. SERVICE GUIDES MANAGER ("📖 How to Use" — Preserves Telegram Entities!)
  // ==========================================================================
  if (input === 'adm:guides') {
    const guides = await db.select().from(serviceGuides).orderBy(asc(serviceGuides.sortOrder), asc(serviceGuides.id));
    const keyboard: BotInlineButton[][] = guides.map((g) => [
      {
        text: `${g.isVisible ? '🟢' : '🙈'} ${g.iconEmoji ? g.iconEmoji + ' ' : ''}${g.titleAr} (${g.titleEn})`,
        callbackData: `adm:guide:${g.id}`,
      },
    ]);
    keyboard.push([{ text: '➕ إضافة شرح خدمة جديد', callbackData: 'adm:guide_add' }]);
    keyboard.push([{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }]);

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        `📖 إدارة الشروحات (How to Use & Guides)\n\n` +
        `تظهر هذه الشروحات في زر «📖 طريقة الاستخدام» وأيضًا قبل الشراء عند فتح التطبيق من «🛍 المتجر». يدعم النظام كامل تنسيقات تيليجرام والإيموجي المخصص/المتحرك.`,
      inlineKeyboard: keyboard,
    };
  }

  if (input === 'adm:guide_add') {
    await saveAdminFsm(adminUser.id, { step: 'guide_add_ar', draft: {} });
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: '➕ إضافة شرح جديد:\nأرسل اسم الخدمة بالعربية (مثال: Gemini):',
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
    };
  }

  if (input.startsWith('adm:guide_prev:')) {
    const [, , idStr, gLang] = input.split(':');
    const id = Number(idStr);
    const [g] = await db.select().from(serviceGuides).where(eq(serviceGuides.id, id)).limit(1);
    if (!g) return handleTelegramAdminPanel({ ...params, input: 'adm:guides' });

    const text = gLang === 'en' ? g.contentEn || g.contentAr : g.contentAr || g.contentEn;
    const savedEntities = gLang === 'en' ? g.contentEntitiesEn : g.contentEntitiesAr;
    return {
      mode: 'admin',
      editInPlace: false,
      text: text || '(فارغ)',
      entities: Array.isArray(savedEntities) && savedEntities.length > 0 ? savedEntities : undefined,
      inlineKeyboard: [[{ text: '🔙 العودة لإدارة الشرح', callbackData: `adm:guide:${g.id}` }]],
    };
  }

  if (input.startsWith('adm:guide:')) {
    const id = Number(input.split(':')[2]);
    const [g] = await db.select().from(serviceGuides).where(eq(serviceGuides.id, id)).limit(1);
    if (!g) return handleTelegramAdminPanel({ ...params, input: 'adm:guides' });

    const arEntCount = Array.isArray(g.contentEntitiesAr) ? g.contentEntitiesAr.length : 0;
    const enEntCount = Array.isArray(g.contentEntitiesEn) ? g.contentEntitiesEn.length : 0;

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        `📖 إدارة الشرح: ${g.iconEmoji ? g.iconEmoji + ' ' : ''}${g.titleAr} | ${g.titleEn}\n` +
        `• الحالة: ${g.isVisible ? '🟢 ظاهر' : '🙈 مخفي'} | الترتيب: #${g.sortOrder}\n` +
        `• عناصر التنسيق المحفوظة: AR (${arEntCount}) · EN (${enEntCount})`,
      inlineKeyboard: [
        [
          { text: '👁 معاينة عربي', callbackData: `adm:guide_prev:${g.id}:ar` },
          { text: '👁 Preview EN', callbackData: `adm:guide_prev:${g.id}:en` },
        ],
        [
          { text: '📝 تعديل المحتوى AR (بالتنسيق)', callbackData: `adm:guide_edit:${g.id}:contentAr` },
          { text: '📝 تعديل المحتوى EN (Formatted)', callbackData: `adm:guide_edit:${g.id}:contentEn` },
        ],
        [
          { text: '✏️ الاسم AR', callbackData: `adm:guide_edit:${g.id}:titleAr` },
          { text: '✏️ الاسم EN', callbackData: `adm:guide_edit:${g.id}:titleEn` },
        ],
        [
          { text: '⬆️ تقديم', callbackData: `adm:guide_up:${g.id}` },
          { text: '⬇️ تأخير', callbackData: `adm:guide_dn:${g.id}` },
          { text: g.isVisible ? '🙈 إخفاء' : '👁 إظهار', callbackData: `adm:guide_vis:${g.id}` },
        ],
        [
          { text: '🗑 حذف الشرح', callbackData: `adm:guide_del:${g.id}` },
          { text: '🔙 الشروحات', callbackData: 'adm:guides' },
        ],
      ],
    };
  }

  if (input.startsWith('adm:guide_vis:')) {
    const id = Number(input.split(':')[2]);
    const [g] = await db.select().from(serviceGuides).where(eq(serviceGuides.id, id)).limit(1);
    if (g) await db.update(serviceGuides).set({ isVisible: !g.isVisible, updatedAt: new Date() }).where(eq(serviceGuides.id, id));
    return handleTelegramAdminPanel({ ...params, input: `adm:guide:${id}` });
  }

  if (input.startsWith('adm:guide_up:') || input.startsWith('adm:guide_dn:')) {
    const isUp = input.startsWith('adm:guide_up:');
    const id = Number(input.split(':')[2]);
    const [g] = await db.select().from(serviceGuides).where(eq(serviceGuides.id, id)).limit(1);
    if (g) await db.update(serviceGuides).set({ sortOrder: Math.max(1, g.sortOrder + (isUp ? -1 : 1)), updatedAt: new Date() }).where(eq(serviceGuides.id, id));
    return handleTelegramAdminPanel({ ...params, input: `adm:guide:${id}` });
  }

  if (input.startsWith('adm:guide_del:')) {
    const id = Number(input.split(':')[2]);
    await db.delete(serviceGuides).where(eq(serviceGuides.id, id));
    return handleTelegramAdminPanel({ ...params, input: 'adm:guides' });
  }

  if (input.startsWith('adm:guide_edit:')) {
    const [, , idStr, field] = input.split(':');
    await saveAdminFsm(adminUser.id, { step: 'guide_edit_field', targetId: Number(idStr), field });
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        field === 'contentAr' || field === 'contentEn'
          ? `📝 أرسل الآن نص الشرح (${field === 'contentEn' ? 'English' : 'عربي'}) بالتنسيق الذي تريده (عريض، مائل، روابط، كود، اقتباسات قابلة للطي، إيموجي مخصص/متحرك) وسيتم حفظه حرفيًا 100%:`
          : `✏️ أرسل القيمة الجديدة للحقل (${field}):`,
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
    };
  }

  // ==========================================================================
  // F. USER SEARCH, BALANCE ADJUSTMENT (IDEMPOTENT) & FULL OPERATIONS AUDIT
  // ==========================================================================
  if (input === 'adm:users') {
    const recentUsers = await db.select().from(users).orderBy(desc(users.updatedAt)).limit(8);
    const buttons: BotInlineButton[][] = [
      [{ text: '🔎 بحث بمعرّف المستخدم (Telegram User ID)', callbackData: 'adm:user_search' }],
      ...recentUsers.map((u) => [
        {
          text: `👤 ${u.displayName} — ID: ${u.telegramUserId || u.id} (${u.role})`,
          callbackData: `adm:user:${u.id}`,
        },
      ]),
      [{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }],
    ];
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: '👤 إدارة المستخدمين، الرصيد، ومراجعة العمليات:\nابحث برقم Telegram User ID أو اختر مستخدمًا من القائمة:',
      inlineKeyboard: buttons,
    };
  }

  if (input === 'adm:user_search') {
    await saveAdminFsm(adminUser.id, { step: 'user_search' });
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: '🔎 أرسل معرّف المستخدم في تيليجرام (مثال: 793179862) أو اسم المستخدم (@username):',
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
    };
  }

  if (input.startsWith('adm:user:')) {
    const userId = Number(input.split(':')[2]);
    return renderAdminUserDossier(userId, isCallback);
  }

  if (input.startsWith('adm:ubal_add:') || input.startsWith('adm:ubal_sub:')) {
    const isDeduct = input.startsWith('adm:ubal_sub:');
    const targetUserId = Number(input.split(':')[2]);
    await saveAdminFsm(adminUser.id, {
      step: 'user_bal_amount',
      targetId: targetUserId,
      draft: { direction: isDeduct ? 'deduct' : 'add' },
    });
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: isDeduct
        ? '➖ خصم رصيد من المستخدم:\nأرسل المبلغ المطلوب خصمه بالـ USDT (مثال: 5 أو 1.50):'
        : '➕ إضافة رصيد للمستخدم:\nأرسل المبلغ المطلوب إضافته بالـ USDT (مثال: 10 أو 2.50):',
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
    };
  }

  if (input.startsWith('adm:ubal_exec:')) {
    const token = input.slice('adm:ubal_exec:'.length);
    if (adminFsm.step !== 'user_bal_confirm' || adminFsm.draft?.token !== token || !adminFsm.targetId) {
      return {
        mode: 'admin',
        editInPlace: isCallback,
        text: 'ℹ️ تم تنفيذ هذه العملية مسبقًا أو انتهت صلاحية رمز التأكيد (محمي ضد التنفيذ المكرر).',
        inlineKeyboard: [[{ text: '👤 قائمة المستخدمين', callbackData: 'adm:users' }]],
      };
    }

    const targetUserId = adminFsm.targetId;
    const deltaAmount = String(adminFsm.draft.deltaAmount);
    const reason = String(adminFsm.draft.reason || 'تعديل إداري من بوت تيليجرام');
    const refCode = `ADJ-TG-${token}`;

    try {
      const res = await adminAdjustWalletBalance({
        targetUserId,
        deltaAmount,
        note: reason,
        referenceCode: refCode,
      });

      await saveAdminFsm(adminUser.id, { step: 'idle' });

      await db.insert(auditLogs).values({
        actorUserId: adminUser.id,
        actorRole: adminUser.role,
        action: 'ADMIN_TG_BALANCE_ADJUSTED',
        entityType: 'wallet',
        entityId: String(targetUserId),
        detailsJson: {
          deltaAmount,
          reason,
          referenceCode: res.referenceCode,
          balanceBefore: res.balanceBefore,
          balanceAfter: res.newBalance,
          alreadyProcessed: res.alreadyProcessed,
        },
      });

      const [targetUser] = await db.select().from(users).where(eq(users.id, targetUserId)).limit(1);
      if (targetUser?.telegramUserId && notifyTelegramUser && !res.alreadyProcessed) {
        const uLang = targetUser.languageCode === 'en' ? 'en' : 'ar';
        const dDec = new Decimal(deltaAmount);
        const msg =
          uLang === 'en'
            ? `💰 Wallet Balance Updated\n\n• Change: ${dDec.gte(0) ? '+' : ''}${dDec.toFixed(2)} USDT\n• New Balance: ${formatMoney(res.newBalance, 2)} USDT\n• Note: ${reason}`
            : `💰 تم تحديث رصيد محفظتك\n\n• التعديل: ${dDec.gte(0) ? '+' : ''}${dDec.toFixed(2)} USDT\n• الرصيد الجديد: ${formatMoney(res.newBalance, 2)} USDT\n• السبب: ${reason}`;
        await notifyTelegramUser(targetUser.telegramUserId, msg).catch(() => undefined);
      }

      return {
        mode: 'admin',
        editInPlace: isCallback,
        text:
          `✅ تم تعديل الرصيد وتوثيقه في سجل المحفظة بنجاح!\n\n` +
          `• رقم المرجع: ${res.referenceCode}\n` +
          `• الرصيد قبل: ${formatMoney(res.balanceBefore, 2)} USDT\n` +
          `• الرصيد بعد: ${formatMoney(res.newBalance, 2)} USDT\n` +
          `• السبب: ${reason}`,
        inlineKeyboard: [
          [{ text: '👤 العودة لملف المستخدم', callbackData: `adm:user:${targetUserId}` }],
          [{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }],
        ],
      };
    } catch (err: any) {
      await saveAdminFsm(adminUser.id, { step: 'idle' });
      return {
        mode: 'admin',
        editInPlace: isCallback,
        text: `❌ تعذر تنفيذ التعديل: ${err?.message === 'NEGATIVE_BALANCE_FORBIDDEN' ? 'الرصيد لا يكفي للخصم.' : err?.message || 'خطأ غير معروف'}`,
        inlineKeyboard: [[{ text: '👤 ملف المستخدم', callbackData: `adm:user:${targetUserId}` }]],
      };
    }
  }

  if (input.startsWith('adm:uorders:')) {
    const userId = Number(input.split(':')[2]);
    const userOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.createdAt))
      .limit(12);
    const items = await db.select().from(orderItems);

    const lines = userOrders.map((o) => {
      const it = items.find((i) => i.orderId === o.id);
      const dt = new Date(o.createdAt).toISOString().slice(0, 16).replace('T', ' ');
      return `• ${o.orderNumber} | ${it?.productTitleSnapshot || 'منتج'} x${it?.quantity || 1}\n  المبلغ: ${formatMoney(o.totalRetail, 2)} USDT | الحالة: ${o.status} | ${dt}`;
    });

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: `📦 سجل مشتريات المستخدم (${userOrders.length}):\n\n${lines.join('\n\n') || 'لا توجد مشتريات لهذا المستخدم.'}`,
      inlineKeyboard: [[{ text: '🔙 ملف المستخدم', callbackData: `adm:user:${userId}` }]],
    };
  }

  if (input.startsWith('adm:udeposits:')) {
    const userId = Number(input.split(':')[2]);
    const userDeps = await db
      .select()
      .from(deposits)
      .where(eq(deposits.userId, userId))
      .orderBy(desc(deposits.createdAt))
      .limit(12);

    const lines = userDeps.map((d) => {
      const dt = new Date(d.createdAt).toISOString().slice(0, 16).replace('T', ' ');
      const tx = d.binanceTransactionId || d.txHash || '—';
      return `• ${d.depositRef} | ${formatMoney(d.expectedAmount, 2)} ${d.currency} | ${d.status}\n  الوسيلة: ${d.method} | المرجع: ${tx.slice(0, 24)} | ${dt}`;
    });

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: `💳 سجل إيداعات المستخدم (${userDeps.length}):\n\n${lines.join('\n\n') || 'لا توجد إيداعات لهذا المستخدم.'}`,
      inlineKeyboard: [[{ text: '🔙 ملف المستخدم', callbackData: `adm:user:${userId}` }]],
    };
  }

  if (input.startsWith('adm:uledger:')) {
    const userId = Number(input.split(':')[2]);
    const ledger = await db
      .select()
      .from(walletLedger)
      .where(eq(walletLedger.userId, userId))
      .orderBy(desc(walletLedger.createdAt))
      .limit(15);

    const lines = ledger.map((l) => {
      const dt = new Date(l.createdAt).toISOString().slice(0, 16).replace('T', ' ');
      const sign = new Decimal(l.amount).gte(0) ? '+' : '';
      return `• [${l.entryType}] ${sign}${formatMoney(l.amount, 2)} USDT (${formatMoney(l.balanceBefore, 2)} → ${formatMoney(l.balanceAfter, 2)})\n  ${l.note} | ${dt}`;
    });

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: `🧾 سجل حركات المحفظة والتعديلات (${ledger.length}):\n\n${lines.join('\n\n') || 'لا توجد حركات مسجلة.'}`,
      inlineKeyboard: [[{ text: '🔙 ملف المستخدم', callbackData: `adm:user:${userId}` }]],
    };
  }

  // ==========================================================================
  // G. WELCOME MESSAGE EDITOR
  // ==========================================================================
  if (input === 'adm:welcome') {
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        `👋 إدارة رسالة الترحيب (تظهر عند /start)\n\n` +
        `• العربية الحالية:\n${store.welcomeMessageAr}\n\n` +
        `• English Current:\n${store.welcomeMessageEn}`,
      inlineKeyboard: [
        [
          { text: '✏️ تعديل الترحيب (AR بالتنسيق)', callbackData: 'adm:welcome_ar' },
          { text: '✏️ Edit Welcome (EN)', callbackData: 'adm:welcome_en' },
        ],
        [{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }],
      ],
    };
  }

  if (input === 'adm:welcome_ar' || input === 'adm:welcome_en') {
    await saveAdminFsm(adminUser.id, { step: input === 'adm:welcome_en' ? 'welcome_edit_en' : 'welcome_edit_ar' });
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: '📝 أرسل رسالة الترحيب الجديدة الآن (بكل تنسيقات تيليجرام والإيموجي المخصص):',
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
    };
  }

  // ==========================================================================
  // H. STORE OPEN/CLOSE, PRODUCTS, PROVIDERS, DEPOSITS & ORDERS
  // ==========================================================================
  if (input === 'adm:togglestore') {
    const nextOpen = !store.isStoreOpen;
    const [profRow] = await db.select().from(settings).where(eq(settings.key, 'store_profile')).limit(1);
    const prev = (profRow?.valueJson as Record<string, any>) || {};
    await db
      .update(settings)
      .set({ valueJson: { ...prev, isStoreOpen: nextOpen }, updatedAt: new Date() })
      .where(eq(settings.key, 'store_profile'));
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: nextOpen ? '🟢 تم تشغيل المتجر بنجاح وأصبح متاحًا للعملاء.' : '🔴 تم إيقاف المتجر مؤقتًا لوضع الصيانة.',
      inlineKeyboard: [[{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }]],
    };
  }

  if (input === 'adm:products' || input.startsWith('adm:products:')) {
    const page = Math.max(0, Number(input.split(':')[2]) || 0);
    const pageSize = 10;
    const rows = await db
      .select({ product: storeProducts, price: productPrices })
      .from(storeProducts)
      .leftJoin(productPrices, eq(productPrices.storeProductId, storeProducts.id))
      .orderBy(desc(storeProducts.isVisible), asc(storeProducts.sortOrder), asc(storeProducts.id));

    const liveMap = await getLiveProductPricingMap();
    const slice = rows.slice(page * pageSize, (page + 1) * pageSize);
    const buttons: BotInlineButton[][] = slice.map((r) => {
      const live = liveMap.get(r.product.id);
      const activePrice = live
        ? live.effectiveUnitRetailFormatted
        : formatMoney(r.price?.promoPrice || r.price?.retailPrice || '0', 2);
      const stock = live ? live.totalStock : 0;
      const shortTitle = r.product.titleAr.length > 26 ? `${r.product.titleAr.slice(0, 26).trim()}…` : r.product.titleAr;
      return [
        {
          text: `${r.product.isVisible && !r.product.isPaused ? '🟢' : '🙈'} #${r.product.id} ${shortTitle} - $${activePrice} - [${stock}]`,
          callbackData: `adm:prod:${r.product.id}`,
        },
      ];
    });

    const nav: BotInlineButton[] = [];
    if (page > 0) nav.push({ text: '⬅️ السابق', callbackData: `adm:products:${page - 1}` });
    if ((page + 1) * pageSize < rows.length) nav.push({ text: 'التالي ➡️', callbackData: `adm:products:${page + 1}` });
    if (nav.length > 0) buttons.push(nav);
    buttons.push([{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }]);

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: `🛍 إدارة المنتجات والعروض (إجمالي ${rows.length} — صفحة ${page + 1} من ${Math.max(1, Math.ceil(rows.length / pageSize))}):`,
      inlineKeyboard: buttons,
    };
  }

  if (input.startsWith('adm:prod_cat:')) {
    const prodId = Number(input.split(':')[2]);
    const cats = await db.select().from(categories).orderBy(asc(categories.sortOrder));
    const buttons: BotInlineButton[][] = [];
    for (let i = 0; i < cats.length; i += 2) {
      buttons.push(
        cats.slice(i, i + 2).map((c) => ({
          text: `${c.iconEmoji ? c.iconEmoji + ' ' : ''}${c.nameAr}`,
          callbackData: `adm:prod_movecat:${prodId}:${c.id}`,
        }))
      );
    }
    buttons.push([{ text: '🔙 العودة للعرض', callbackData: `adm:prod:${prodId}` }]);
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: `🗂 اختر التصنيف الذي تريد نقل المنتج #${prodId} إليه:`,
      inlineKeyboard: buttons,
    };
  }

  if (input.startsWith('adm:prod_movecat:')) {
    const [, , prodIdStr, catIdStr] = input.split(':');
    await db
      .update(storeProducts)
      .set({ categoryId: Number(catIdStr), updatedAt: new Date() })
      .where(eq(storeProducts.id, Number(prodIdStr)));
    return handleTelegramAdminPanel({ ...params, input: `adm:prod:${prodIdStr}` });
  }

  if (input.startsWith('adm:prod_edit:')) {
    const [, , prodIdStr, field] = input.split(':');
    await saveAdminFsm(adminUser.id, { step: 'prod_edit_field', targetId: Number(prodIdStr), field });
    const promptMap: Record<string, string> = {
      title: '✏️ أرسل اسم المنتج الجديد (بالعربية أو الإنجليزية — سيُترجم تلقائيًا للغتين):',
      description:
        '📝 أرسل وصف المنتج للعميل (بالعربية أو الإنجليزية — سيُترجم تلقائيًا للغتين مع الحفاظ على التنسيق):',
      titleAr: '✏️ أرسل اسم المنتج الجديد (سيُترجم تلقائيًا للغتين):',
      titleEn: '✏️ Send the new product title (auto-translated to both Arabic & English):',
      descriptionAr: '📝 أرسل وصف المنتج للعميل (سيُترجم تلقائيًا للغتين):',
      descriptionEn: '📝 Send the customer product description (auto-translated to both languages):',
      retailPrice: '💵 أرسل سعر البيع الجديد للعميل بالـ USDT (مثال: 3.50):',
    };
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: promptMap[field] || 'أرسل القيمة الجديدة:',
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:cancel' }]],
    };
  }

  if (input.startsWith('adm:prod_up:') || input.startsWith('adm:prod_dn:')) {
    const isUp = input.startsWith('adm:prod_up:');
    const prodId = Number(input.split(':')[2]);
    const [p] = await db.select().from(storeProducts).where(eq(storeProducts.id, prodId)).limit(1);
    if (p) {
      await db
        .update(storeProducts)
        .set({ sortOrder: Math.max(1, p.sortOrder + (isUp ? -1 : 1)), updatedAt: new Date() })
        .where(eq(storeProducts.id, prodId));
    }
    return handleTelegramAdminPanel({ ...params, input: `adm:prod:${prodId}` });
  }

  if (input.startsWith('adm:prod:')) {
    const prodId = Number(input.split(':')[2]);
    const [row] = await db
      .select({ product: storeProducts, price: productPrices, category: categories })
      .from(storeProducts)
      .leftJoin(productPrices, eq(productPrices.storeProductId, storeProducts.id))
      .leftJoin(categories, eq(storeProducts.categoryId, categories.id))
      .where(eq(storeProducts.id, prodId))
      .limit(1);

    if (!row) {
      return { mode: 'admin', editInPlace: isCallback, text: 'المنتج غير موجود.', inlineKeyboard: adminMainInline };
    }

    const allMappings = await db
      .select({ mapping: productProviderMappings, provProd: providerProducts, prov: providers })
      .from(productProviderMappings)
      .innerJoin(providerProducts, eq(productProviderMappings.providerProductId, providerProducts.id))
      .innerJoin(providers, eq(providerProducts.providerId, providers.id))
      .where(eq(productProviderMappings.storeProductId, prodId))
      .orderBy(asc(productProviderMappings.priority), asc(productProviderMappings.id));

    const candidates: ProviderOfferCandidate[] = allMappings.map((m) => ({
      mappingId: m.mapping.id,
      providerId: m.prov.id,
      providerCode: m.prov.code,
      providerName: m.prov.name,
      providerStatus: m.prov.status,
      providerEnabled: m.prov.isEnabled,
      providerBalance: m.prov.cachedBalance,
      providerProductId: m.provProd.id,
      externalProductId: m.provProd.externalProductId,
      externalVariantId: m.provProd.externalVariantId,
      wholesalePrice: m.provProd.wholesalePrice,
      stockCount: m.provProd.stockCount,
      roleType: m.mapping.roleType,
      priority: m.mapping.priority,
      isVerifiedCompatible: m.mapping.isVerifiedCompatible,
      isActive: m.mapping.isActive && m.provProd.isActiveAtProvider,
      durationLabel: m.provProd.durationLabel || '',
      deliveryType: m.provProd.deliveryType,
      warrantyDays: m.provProd.warrantyDays,
    }));

    const resolved = resolveProductEffectivePricingAndStock({
      rule: row.price
        ? {
            pricingMode: (row.price.pricingMode as any) || 'manual',
            retailPrice: row.price.retailPrice || '0',
            fixedMargin: row.price.fixedMargin || '0',
            percentMargin: row.price.percentMargin || '0',
            paymentFeePercent: row.price.paymentFeePercent || '1.5',
            extraFixedCost: row.price.extraFixedCost || '0',
            promoPrice: row.price.promoPrice || null,
            promoEndsAt: row.price.promoEndsAt || null,
            bulkTiersJson: row.price.bulkTiersJson || null,
            lockManualPrice: row.price.lockManualPrice ?? true,
          }
        : null,
      candidates,
      strategy: (allMappings[0]?.mapping.selectionStrategy as SelectionStrategy) || 'priority',
      quantity: 1,
    });

    const wholesale = resolved.referenceWholesale;
    const breakdown = resolved.breakdown;

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        `📦 إدارة العرض #${row.product.id}\n` +
        `• عربي: ${row.product.titleAr}\n` +
        (row.product.titleEn ? `• EN: ${row.product.titleEn}\n` : '') +
        `• القسم: ${row.category?.nameAr || 'غير مصنف'} | الترتيب: #${row.product.sortOrder}\n` +
        `• الحالة للعميل: ${row.product.isVisible ? (row.product.isPaused ? '⏸ متوقف مؤقتًا' : '🟢 ظاهر ومنشور') : '🙈 مخفي'}\n` +
        `• الخادم النشط (سري): ${resolved.referenceProvider?.providerName || 'غير مربوط'} (المزودون: ${allMappings.length})\n` +
        `• إجمالي المخزون المجمع: [${resolved.totalStock}]\n` +
        `• سعر الجملة (سري): $${formatMoney(wholesale, 2)}\n` +
        `• سعر البيع للعميل: $${resolved.effectiveUnitRetailFormatted} USDT\n` +
        `• صافي الربح المتوقع: $${formatMoney(breakdown.netProfit, 2)} (${breakdown.marginPercent}%)`,
      inlineKeyboard: [
        [
          {
            text: row.product.isVisible ? '🙈 إخفاء العرض' : '👁 إظهار ونشر العرض',
            callbackData: `adm:togglevis:${row.product.id}`,
          },
          {
            text: row.product.isPaused ? '▶️ استئناف' : '⏸ إيقاف مؤقت',
            callbackData: `adm:togglepause:${row.product.id}`,
          },
        ],
        [
          { text: '💵 تعديل السعر', callbackData: `adm:prod_edit:${row.product.id}:retailPrice` },
          { text: '🗂 نقل لتصنيف آخر', callbackData: `adm:prod_cat:${row.product.id}` },
        ],
        [
          { text: '✏️ تعديل الاسم (ترجمة تلقائية)', callbackData: `adm:prod_edit:${row.product.id}:title` },
          { text: '📝 تعديل الوصف (ترجمة تلقائية)', callbackData: `adm:prod_edit:${row.product.id}:description` },
        ],
        [
          { text: '⬆️ تقديم', callbackData: `adm:prod_up:${row.product.id}` },
          { text: '⬇️ تأخير', callbackData: `adm:prod_dn:${row.product.id}` },
        ],
        [
          ...(row.category ? [{ text: `🔙 قسم ${row.category.nameAr}`, callbackData: `adm:cat:${row.category.id}` }] : []),
          { text: '🛍 كل المنتجات', callbackData: 'adm:products:0' },
        ],
      ],
    };
  }

  if (input.startsWith('adm:togglevis:')) {
    const prodId = Number(input.split(':')[2]);
    const [p] = await db.select().from(storeProducts).where(eq(storeProducts.id, prodId)).limit(1);
    if (p) {
      const nextVis = !p.isVisible;
      const patch: Record<string, any> = { isVisible: nextVis, updatedAt: new Date() };
      if (nextVis && p.categoryId === null) {
        const allCats = await db.select().from(categories);
        const matched = matchProductToStoreCategory(`${p.titleAr} ${p.titleEn || ''}`, p.descriptionAr || '', allCats);
        if (matched) patch.categoryId = matched.categoryId;
      }
      await db.update(storeProducts).set(patch).where(eq(storeProducts.id, prodId));
    }
    return handleTelegramAdminPanel({ ...params, input: `adm:prod:${prodId}` });
  }

  if (input.startsWith('adm:togglepause:')) {
    const prodId = Number(input.split(':')[2]);
    const [p] = await db.select().from(storeProducts).where(eq(storeProducts.id, prodId)).limit(1);
    if (p) {
      await db.update(storeProducts).set({ isPaused: !p.isPaused, updatedAt: new Date() }).where(eq(storeProducts.id, prodId));
    }
    return handleTelegramAdminPanel({ ...params, input: `adm:prod:${prodId}` });
  }

  if (input.startsWith('adm:price:') || input.startsWith('adm:priceinc:') || input.startsWith('سعر ') || input.startsWith('/setprice ')) {
    let prodId = 0;
    let newPrice = new Decimal(0);

    if (input.startsWith('adm:price:')) {
      const [, , idStr, priceStr] = input.split(':');
      prodId = Number(idStr);
      newPrice = new Decimal(priceStr);
    } else if (input.startsWith('adm:priceinc:')) {
      const [, , idStr, deltaStr] = input.split(':');
      prodId = Number(idStr);
      const [pr] = await db.select().from(productPrices).where(eq(productPrices.storeProductId, prodId)).limit(1);
      newPrice = Decimal.max('0.10', new Decimal(pr?.retailPrice || '1').plus(deltaStr));
    } else {
      const parts = input.split(/\s+/);
      prodId = Number(parts[1]);
      newPrice = new Decimal(parts[2] || '0');
    }

    if (prodId > 0 && newPrice.gt(0)) {
      await db
        .update(productPrices)
        .set({ pricingMode: 'manual', retailPrice: newPrice.toFixed(4), lockManualPrice: true, updatedAt: new Date() })
        .where(eq(productPrices.storeProductId, prodId));
      return handleTelegramAdminPanel({ ...params, input: `adm:prod:${prodId}` });
    }
  }

  if (input === 'adm:providers') {
    const provs = await db.select().from(providers).orderBy(providers.priority);
    const lines = provs.map(
      (p) => `• ${p.name} | ${p.isEnabled && p.status === 'connected' ? '🟢 متصل' : '🔴 غير متصل'} | الرصيد: $${formatMoney(p.cachedBalance, 2)}`
    );
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: `🌐 الخوادم والمزودون (سري للإدارة فقط):\n\n${lines.join('\n')}`,
      inlineKeyboard: [
        ...provs.map((p) => [
          { text: `${p.isEnabled ? '⏸ تعطيل' : '▶️ تفعيل'} ${p.name}`, callbackData: `adm:toggleprov:${p.id}` },
        ]),
        [{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }],
      ],
    };
  }

  if (input.startsWith('adm:toggleprov:')) {
    const provId = Number(input.split(':')[2]);
    const [p] = await db.select().from(providers).where(eq(providers.id, provId)).limit(1);
    if (p) {
      await db
        .update(providers)
        .set({ isEnabled: !p.isEnabled, status: !p.isEnabled ? 'connected' : 'disabled', updatedAt: new Date() })
        .where(eq(providers.id, provId));
    }
    return handleTelegramAdminPanel({ ...params, input: 'adm:providers' });
  }

  if (input === 'adm:deposits') {
    const pending = await db
      .select({ dep: deposits, user: users })
      .from(deposits)
      .innerJoin(users, eq(deposits.userId, users.id))
      .where(or(eq(deposits.status, 'pending_review'), eq(deposits.status, 'pending')))
      .orderBy(desc(deposits.createdAt))
      .limit(8);

    if (pending.length === 0) {
      return {
        mode: 'admin',
        editInPlace: isCallback,
        text: '✅ لا توجد إيداعات معلقة بانتظار المراجعة حاليًا.',
        inlineKeyboard: [[{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }]],
      };
    }

    const lines = pending.map(
      (r) =>
        `• ${r.dep.depositRef} | ${r.user.displayName} | ${formatMoney(r.dep.expectedAmount, 2)} USDT (${r.dep.method})\n  المرجع: ${(r.dep.binanceTransactionId || r.dep.txHash || 'بانتظار الإرسال').slice(0, 22)}`
    );
    const buttons: BotInlineButton[][] = pending.map((r) => [
      { text: `✅ اعتماد ${r.dep.depositRef} (${formatMoney(r.dep.expectedAmount, 2)})`, callbackData: `adm:depok:${r.dep.id}` },
      { text: `❌ رفض`, callbackData: `adm:depno:${r.dep.id}` },
    ]);
    buttons.push([{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }]);

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: `💳 الإيداعات المعلقة (${pending.length}):\n\n${lines.join('\n\n')}`,
      inlineKeyboard: buttons,
    };
  }

  if (input.startsWith('adm:depok:')) {
    const depId = Number(input.split(':')[2]);
    const [dep] = await db.select().from(deposits).where(eq(deposits.id, depId)).limit(1);
    if (dep && dep.status !== 'confirmed' && dep.status !== 'paid') {
      await creditDepositAtomically({
        depositId: dep.id,
        creditedAmount: dep.expectedAmount,
        reviewedByUserId: adminUser.id,
        note: `اعتماد إيداع من بوت الإدارة (${dep.depositRef})`,
      });
    }
    return handleTelegramAdminPanel({ ...params, input: 'adm:deposits' });
  }

  if (input.startsWith('adm:depno:')) {
    const depId = Number(input.split(':')[2]);
    await db
      .update(deposits)
      .set({ status: 'rejected', rejectionReason: 'REJECTED_BY_ADMIN_TG', reviewedByUserId: adminUser.id, updatedAt: new Date() })
      .where(eq(deposits.id, depId));
    return handleTelegramAdminPanel({ ...params, input: 'adm:deposits' });
  }

  if (input === 'adm:orders') {
    const recent = await db
      .select({ order: orders, user: users })
      .from(orders)
      .innerJoin(users, eq(orders.userId, users.id))
      .orderBy(desc(orders.createdAt))
      .limit(8);

    const lines = recent.map(
      (r) =>
        `• ${r.order.orderNumber} | ${r.user.displayName}\n  البيع: ${formatMoney(r.order.totalRetail, 2)} USDT | الجملة: $${formatMoney(r.order.totalWholesaleSnapshot, 2)} | صافي الربح: $${formatMoney(r.order.netProfitSnapshot, 2)} | ${r.order.status}`
    );

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: `📦 أحدث الطلبات (تفاصيل الربح سرية للإدارة):\n\n${lines.join('\n\n') || 'لا توجد طلبات مسجلة بعد.'}`,
      inlineKeyboard: [[{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }]],
    };
  }

  // ==========================================================================
  // REFERRAL & COMMISSION MANAGEMENT (Admin Telegram Bot Section)
  // ==========================================================================
  if (input === 'adm:referrals') {
    await saveAdminFsm(adminUser.id, { step: 'idle' });
    const overview = await getAdminReferralOverview();
    const s = overview.settings;
    const st = overview.stats;
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        `🤝 إدارة نظام الإحالات والعمولات\n\n` +
        `• الحالة: ${s.isEnabled ? '🟢 مفعّل' : '🔴 معطّل'}\n` +
        `• نسبة العمولة الحالية: ${formatRatePercentDisplay(s.defaultCommissionPercent)}%\n` +
        `• الحد الأقصى لكل مستخدم: ${s.maxCommissionPerUserEnabled ? `${formatMoney2(s.maxCommissionPerUserAmount)} ${s.currency}` : 'غير محدود'}\n\n` +
        `📊 ملخص الأداء (من السجل المالي):\n` +
        `• المحالون: ${st.totalReferredUsers} (ناجحون بمشتريات: ${st.successfulReferrals})\n` +
        `• المحيلون النشطون: ${st.activeReferrers}\n` +
        `• حجم مشتريات المحالين: ${st.totalReferredPurchases} ${s.currency}\n` +
        `• صافي العمولات المدفوعة: ${st.netCommissionsPaid} ${s.currency} (معكوسة: ${st.totalReversedCommissions})`,
      inlineKeyboard: [
        [
          { text: '⚙️ إعدادات الإحالات', callbackData: 'adm:ref_settings' },
          { text: '📊 الإحصائيات العامة', callbackData: 'adm:ref_stats' },
        ],
        [
          { text: '🔎 استعلام مستخدم (ID)', callbackData: 'adm:ref_search' },
          { text: '📜 سجل العمولات', callbackData: 'adm:ref_ledger:0' },
        ],
        [{ text: '🔙 القائمة الإدارية', callbackData: 'adm:home' }],
      ],
    };
  }

  if (input === 'adm:ref_settings') {
    await saveAdminFsm(adminUser.id, { step: 'idle' });
    const s = await getReferralSettings();
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        `⚙️ إعدادات نظام الإحالات\n\n` +
        `• حالة النظام: ${s.isEnabled ? '🟢 مفعّل' : '🔴 معطّل'}\n` +
        `• نسبة العمولة الافتراضية: ${formatRatePercentDisplay(s.defaultCommissionPercent)}%\n` +
        `• الحد الأقصى لكل مستخدم: ${s.maxCommissionPerUserEnabled ? `🟢 مفعّل (${formatMoney2(s.maxCommissionPerUserAmount)} ${s.currency})` : '⚪ غير محدود'}\n\n` +
        `📌 التعديلات تسري فورًا على الطلبات المستقبلية دون إعادة تشغيل البوت ولا تغير السجلات السابقة.`,
      inlineKeyboard: [
        [
          {
            text: s.isEnabled ? '🔴 تعطيل نظام الإحالات' : '🟢 تفعيل نظام الإحالات',
            callbackData: 'adm:ref_toggle',
          },
        ],
        [{ text: '📊 تعديل نسبة العمولة (%)', callbackData: 'adm:ref_rate' }],
        [
          {
            text: s.maxCommissionPerUserEnabled ? '🔓 إلغاء الحد الأقصى' : '🔒 تفعيل الحد الأقصى',
            callbackData: 'adm:ref_cap_toggle',
          },
          { text: '💵 تحديد سقف العمولة', callbackData: 'adm:ref_cap_amount' },
        ],
        [{ text: '🔙 إدارة الإحالات', callbackData: 'adm:referrals' }],
      ],
    };
  }

  if (input === 'adm:ref_toggle') {
    const current = await getReferralSettings();
    await updateReferralSettings({
      isEnabled: !current.isEnabled,
      actorUserId: adminUser.id,
      actorRole: adminUser.role,
    });
    return handleTelegramAdminPanel({ ...params, input: 'adm:ref_settings' });
  }

  if (input === 'adm:ref_cap_toggle') {
    const current = await getReferralSettings();
    await updateReferralSettings({
      maxCommissionPerUserEnabled: !current.maxCommissionPerUserEnabled,
      actorUserId: adminUser.id,
      actorRole: adminUser.role,
    });
    return handleTelegramAdminPanel({ ...params, input: 'adm:ref_settings' });
  }

  if (input === 'adm:ref_rate') {
    await saveAdminFsm(adminUser.id, { step: 'ref_edit_rate' });
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: '📊 أرسل الآن نسبة العمولة الجديدة كنسبة مئوية (من 0 إلى 100، مثال: 5 أو 7.5):',
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:ref_settings' }]],
    };
  }

  if (input === 'adm:ref_cap_amount') {
    await saveAdminFsm(adminUser.id, { step: 'ref_edit_cap' });
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: '💵 أرسل الآن الحد الأقصى للعمولة لكل مستخدم بعملة USDT (أدخل 0 لإلغاء السقف):',
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:ref_settings' }]],
    };
  }

  if (input === 'adm:ref_stats') {
    const overview = await getAdminReferralOverview();
    const st = overview.stats;
    const cur = overview.settings.currency;
    const topLines = overview.topReferrers
      .slice(0, 5)
      .map(
        (r, i) =>
          `${i + 1}. ${r.displayName} (${r.telegramUserId || '—'}) — محالون: ${r.referredCount} | صافي الربح: ${r.netEarned} ${cur}`
      )
      .join('\n');

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        `📊 الإحصائيات العامة لنظام الإحالات\n\n` +
        `• إجمالي المستخدمين المحالين: ${st.totalReferredUsers}\n` +
        `• الإحالات الناجحة (بمشتريات مكتملة): ${st.successfulReferrals}\n` +
        `• المحيلون النشطون: ${st.activeReferrers}\n` +
        `• الطلبات المُولّدة للعمولة: ${st.commissionOrdersCount} (معكوسة: ${st.reversalsCount})\n` +
        `• إجمالي قيمة المشتريات المحالة: ${st.totalReferredPurchases} ${cur}\n` +
        `• إجمالي العمولات الممنوحة: ${st.totalGrossCommissions} ${cur}\n` +
        `• إجمالي العمولات المعكوسة: ${st.totalReversedCommissions} ${cur}\n` +
        `• صافي العمولات المدفوعة: ${st.netCommissionsPaid} ${cur}\n` +
        `• رصيد التسوية المعلق: ${st.totalPendingRecovery} ${cur} (${st.accountsWithRecovery} حساب)\n\n` +
        `🏆 أبرز المحيلين:\n${topLines || 'لا توجد بيانات بعد.'}`,
      inlineKeyboard: [
        [{ text: '🔄 تحديث الإحصائيات', callbackData: 'adm:ref_stats' }],
        [{ text: '🔙 إدارة الإحالات', callbackData: 'adm:referrals' }],
      ],
    };
  }

  if (input === 'adm:ref_search') {
    await saveAdminFsm(adminUser.id, { step: 'ref_search_user' });
    return {
      mode: 'admin',
      editInPlace: isCallback,
      text: '🔎 أرسل الآن Telegram ID أو اسم المستخدم للاستعلام الكامل عن إحالاته وأرباحه:',
      inlineKeyboard: [[{ text: '❌ إلغاء', callbackData: 'adm:referrals' }]],
    };
  }

  if (input.startsWith('adm:ref_ledger:')) {
    const page = Math.max(0, Number(input.split(':')[2] || '0') || 0);
    const ledger = await listAdminReferralCommissions({ page, pageSize: 6 });
    const lines = ledger.items.map((item) => {
      const icon = item.entryType === 'reversal' ? '↩️' : '💰';
      const sign = item.entryType === 'reversal' ? '-' : '+';
      const dt = new Date(item.createdAt).toISOString().slice(0, 16).replace('T', ' ');
      return (
        `${icon} ${item.operationRef} | طلب ${item.orderNumber}\n` +
        `   المحيل: ${item.referrerName} (${item.referrerTelegramId || '—'}) ← المحال: ${item.referredName}\n` +
        `   الشراء: ${item.purchaseAmount} ${item.currency} × ${item.commissionRatePercent}% = ${sign}${item.grossCommissionAmount} ${item.currency}\n` +
        `   الرصيد: ${item.balanceBefore} → ${item.balanceAfter} | ${dt}`
      );
    });

    const nav: BotInlineButton[] = [];
    if (ledger.page > 0) {
      nav.push({ text: '⬅️ السابق', callbackData: `adm:ref_ledger:${ledger.page - 1}` });
    }
    if (ledger.page + 1 < ledger.totalPages) {
      nav.push({ text: 'التالي ➡️', callbackData: `adm:ref_ledger:${ledger.page + 1}` });
    }
    const kb: BotInlineButton[][] = [];
    if (nav.length > 0) kb.push(nav);
    kb.push([{ text: '🔙 إدارة الإحالات', callbackData: 'adm:referrals' }]);

    return {
      mode: 'admin',
      editInPlace: isCallback,
      text:
        `📜 سجل العمولات والمرتجعات (الإجمالي: ${ledger.total} • صفحة ${ledger.page + 1}/${ledger.totalPages})\n\n` +
        `${lines.length > 0 ? lines.join('\n\n') : 'لا توجد عمليات عمولات مسجلة بعد.'}`,
      inlineKeyboard: kb,
    };
  }

  return handleTelegramAdminPanel({ ...params, input: 'adm:home' });
}

async function renderAdminUserDossier(userId: number, editInPlace: boolean): Promise<BotReplyPayload> {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u) {
    return {
      mode: 'admin',
      editInPlace,
      text: 'المستخدم غير موجود.',
      inlineKeyboard: [[{ text: '🔙 المستخدمون', callbackData: 'adm:users' }]],
    };
  }

  const w = await ensureUserWallet(u.id);
  const [ordAgg] = await db
    .select({
      totalOrders: sql<number>`count(*)`,
      completedOrders: sql<number>`count(*) filter (where ${orders.status} = 'completed')`,
      totalSpent: sql<string>`coalesce(sum(${orders.totalRetail}) filter (where ${orders.status} = 'completed'), 0)`,
    })
    .from(orders)
    .where(eq(orders.userId, u.id));

  const [depAgg] = await db
    .select({
      totalDeps: sql<number>`count(*)`,
      confirmedSum: sql<string>`coalesce(sum(${deposits.receivedAmount}) filter (where ${deposits.status} in ('confirmed', 'paid')), 0)`,
    })
    .from(deposits)
    .where(eq(deposits.userId, u.id));

  const [refAgg] = await db
    .select({
      count: sql<number>`count(*)`,
      totalCommission: sql<string>`coalesce(sum(${referrals.commissionAmount}), 0)`,
    })
    .from(referrals)
    .where(eq(referrals.referrerUserId, u.id));

  return {
    mode: 'admin',
    editInPlace,
    text:
      `👤 ملف ومراجعة عمليات المستخدم\n\n` +
      `• الاسم: ${u.displayName}\n` +
      `• Telegram ID: ${u.telegramUserId || '—'}\n` +
      `• المعرّف: ${u.telegramUsername ? '@' + u.telegramUsername : '—'} | الصلاحية: ${u.role}\n` +
      `• اللغة: ${u.languageCode}\n\n` +
      `👛 الرصيد المتاح: ${formatMoney(w.availableBalance, 2)} USDT\n` +
      `🔒 الرصيد المحجوز: ${formatMoney(w.reservedBalance, 2)} USDT\n` +
      `📦 الطلبات: ${ordAgg?.completedOrders || 0} مكتمل (إجمالي ${ordAgg?.totalOrders || 0})\n` +
      `💰 إجمالي الإنفاق: ${formatMoney(ordAgg?.totalSpent || '0', 2)} USDT\n` +
      `💳 الإيداعات المؤكدة: ${formatMoney(depAgg?.confirmedSum || '0', 2)} USDT (${depAgg?.totalDeps || 0} عملية)\n` +
      `👥 الإحالات: ${refAgg?.count || 0} (مكافآت: ${formatMoney(refAgg?.totalCommission || '0', 2)} USDT)`,
    inlineKeyboard: [
      [
        { text: '➕ إضافة رصيد', callbackData: `adm:ubal_add:${u.id}` },
        { text: '➖ خصم رصيد', callbackData: `adm:ubal_sub:${u.id}` },
      ],
      [
        { text: '📦 سجل المشتريات', callbackData: `adm:uorders:${u.id}` },
        { text: '💳 سجل الإيداعات', callbackData: `adm:udeposits:${u.id}` },
      ],
      [{ text: '🧾 سجل التعديلات والمحفظة', callbackData: `adm:uledger:${u.id}` }],
      [
        { text: '🔎 بحث مستخدم آخر', callbackData: 'adm:user_search' },
        { text: '🔙 القائمة الإدارية', callbackData: 'adm:home' },
      ],
    ],
  };
}
