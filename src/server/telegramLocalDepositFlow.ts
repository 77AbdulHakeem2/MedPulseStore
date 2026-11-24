import Decimal from 'decimal.js';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { localDeposits, localWallets, users } from '../db/schema.ts';
import {
  buildCustomerNavFooter,
  type CustomerInlineButton,
} from './sanitizer.ts';
import {
  formatYerNumber,
  getCurrencyLocalDepositSettings,
  validateDepositorQuadName,
  validateLocalDepositAmountYer,
} from './currencyEngine.ts';
import {
  approveLocalDepositAtomically,
  createLocalDepositRequest,
  DEFAULT_LOCAL_REJECTION_REASON_AR,
  listLocalWallets,
  LOCAL_DEPOSIT_PRESET_AMOUNTS_YER,
  LOCAL_DEPOSIT_REJECTION_REASONS,
  rejectLocalDepositAtomically,
} from './localDepositEngine.ts';
import type { SupportedLang } from '../i18n/index.ts';

export interface LocalDepositDraftState {
  walletId?: number;
  amountYer?: string;
  depositorNameUsed?: string;
  depositorNameIsTemporary?: boolean;
  senderWalletNumber?: string;
  saveAsPermanent?: boolean;
}

export type LocalDepositFsmStep =
  | 'awaiting_local_depositor_name'
  | 'awaiting_local_custom_amount'
  | 'awaiting_local_temp_depositor_name'
  | 'awaiting_local_proof_photo'
  | 'awaiting_edit_saved_depositor_name'
  | 'awaiting_admin_local_reject_reason';

export interface LocalDepositReply {
  text: string;
  inlineKeyboard: CustomerInlineButton[][];
  mode: 'customer' | 'admin';
  lang: SupportedLang;
  editInPlace?: boolean;
  callbackAlertText?: string;
  keepChannelMessage?: boolean;
}

async function saveLocalFsm(
  userId: number,
  prevState: Record<string, any>,
  step: string,
  draft?: LocalDepositDraftState,
  extra?: Record<string, any>
) {
  const nextState = {
    ...prevState,
    step,
    localDepositDraft: draft,
    ...(extra || {}),
  };
  await db
    .update(users)
    .set({ botStateJson: nextState, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

async function renderAmountSelectionScreen(params: {
  walletRow: typeof localWallets.$inferSelect;
  lang: SupportedLang;
  minYer: number;
  maxYer: number;
  editInPlace: boolean;
}): Promise<LocalDepositReply> {
  const { walletRow, lang, minYer, maxYer, editInPlace } = params;
  const wName = lang === 'en' ? walletRow.nameEn || walletRow.nameAr : walletRow.nameAr;
  const wInstr =
    lang === 'en'
      ? walletRow.instructionsEn || walletRow.instructionsAr
      : walletRow.instructionsAr || walletRow.instructionsEn;

  const lines =
    lang === 'en'
      ? [
          `🇾🇪 Local Wallet Deposit — ${wName}`,
          '',
          `🏦 Wallet: ${wName}`,
          `🔢 Account Number: ${walletRow.accountNumber}`,
          `👤 Account Holder: ${walletRow.accountHolderName}`,
          ...(wInstr ? ['', `📌 Instructions:\n${wInstr}`] : []),
          '',
          `💡 Allowed range: ${formatYerNumber(minYer)} — ${formatYerNumber(maxYer)}`,
          '',
          'Select the deposit amount in Yemeni Rial (﷼) or enter a custom amount:',
        ]
      : [
          `🇾🇪 الإيداع عبر المحافظ المحلية — ${wName}`,
          '',
          `🏦 المحفظة: ${wName}`,
          `🔢 رقم الحساب/المحفظة: ${walletRow.accountNumber}`,
          `👤 اسم المستلم: ${walletRow.accountHolderName}`,
          ...(wInstr ? ['', `📌 تعليمات التحويل:\n${wInstr}`] : []),
          '',
          `💡 الحد المسموح: من ${formatYerNumber(minYer)} إلى ${formatYerNumber(maxYer)}`,
          '',
          'اختر مبلغ الإيداع بالريال اليمني (﷼) أو اضغط لإدخال مبلغ مخصص:',
        ];

  const row1: CustomerInlineButton[] = LOCAL_DEPOSIT_PRESET_AMOUNTS_YER.slice(0, 3).map((amt) => ({
    text: formatYerNumber(amt),
    callbackData: `c:local_dep:amt:${walletRow.id}:${amt}`,
    style: 'primary',
  }));
  const row2: CustomerInlineButton[] = LOCAL_DEPOSIT_PRESET_AMOUNTS_YER.slice(3, 5).map((amt) => ({
    text: formatYerNumber(amt),
    callbackData: `c:local_dep:amt:${walletRow.id}:${amt}`,
    style: 'primary',
  }));

  return {
    mode: 'customer',
    lang,
    editInPlace,
    text: lines.join('\n'),
    inlineKeyboard: [
      row1,
      row2,
      [
        {
          text: lang === 'en' ? '✍️ Enter Custom Amount' : '✍️ إدخال مبلغ مخصص',
          callbackData: `c:local_dep:custom_amt:${walletRow.id}`,
          style: 'success',
        },
      ],
      [
        { text: lang === 'en' ? '🏠 Home' : '🏠 الرئيسية', callbackData: 'c:home', style: 'primary' },
        { text: lang === 'en' ? '⬅️ Back' : '⬅️ رجوع', callbackData: 'c:local_dep:wallets', style: 'primary' },
      ],
    ],
  };
}

function renderOwnerIdentityConfirmScreen(params: {
  lang: SupportedLang;
  savedDepositorName: string;
  walletId: number;
  amountYer: string;
  editInPlace: boolean;
}): LocalDepositReply {
  const { lang, savedDepositorName, walletId, amountYer, editInPlace } = params;
  const text =
    lang === 'en'
      ? [
          '🪪 Confirm Wallet Owner',
          '',
          `Deposit Amount: ${formatYerNumber(amountYer)}`,
          '',
          'Will you transfer from your personal wallet registered under:',
          `📌 ${savedDepositorName}`,
        ].join('\n')
      : [
          '🪪 تأكيد بيانات المودع',
          '',
          `💰 مبلغ الإيداع المختار: ${formatYerNumber(amountYer)}`,
          '',
          'هل ستقوم بالتحويل من محفظتك الشخصية المسجلة باسم:',
          `📌 ${savedDepositorName}`,
        ].join('\n');

  return {
    mode: 'customer',
    lang,
    editInPlace,
    text,
    inlineKeyboard: [
      [
        { text: lang === 'en' ? '✅ Yes' : '✅ نعم', callbackData: 'c:local_dep:confirm_owner:yes', style: 'success' },
        { text: lang === 'en' ? '❌ No' : '❌ لا', callbackData: 'c:local_dep:confirm_owner:no', style: 'danger' },
      ],
      buildCustomerNavFooter(lang, `c:local_dep:wallet:${walletId}`),
    ],
  };
}

function renderTransferSummaryScreen(params: {
  walletRow: typeof localWallets.$inferSelect;
  amountYer: string;
  depositorNameUsed: string;
  depositorNameIsTemporary: boolean;
  lang: SupportedLang;
  editInPlace: boolean;
}): LocalDepositReply {
  const { walletRow, amountYer, depositorNameUsed, depositorNameIsTemporary, lang, editInPlace } = params;
  const wName = lang === 'en' ? walletRow.nameEn || walletRow.nameAr : walletRow.nameAr;
  const wInstr =
    lang === 'en'
      ? walletRow.instructionsEn || walletRow.instructionsAr
      : walletRow.instructionsAr || walletRow.instructionsEn;

  const text =
    lang === 'en'
      ? [
          '🏦 Transfer Instructions — Local Wallet Deposit',
          '━━━━━━━━━━━━━━━━━━━━',
          `• Wallet: ${wName}`,
          `• Recipient Account: ${walletRow.accountNumber}`,
          `• Account Holder: ${walletRow.accountHolderName}`,
          `• Exact Amount to Transfer: ${formatYerNumber(amountYer)}`,
          `• Depositor Name: ${depositorNameUsed}${depositorNameIsTemporary ? ' (This transaction only)' : ''}`,
          ...(wInstr ? ['', `📌 Instructions:\n${wInstr}`] : []),
          '',
          '⚠️ Please transfer the EXACT amount above. Once completed, tap "✅ I Completed the Transfer" below to attach your transfer screenshot.',
        ].join('\n')
      : [
          '🏦 تفاصيل التحويل — المحافظ المحلية',
          '━━━━━━━━━━━━━━━━━━━━',
          `• المحفظة: ${wName}`,
          `• رقم الحساب/المحفظة: ${walletRow.accountNumber}`,
          `• اسم المستلم: ${walletRow.accountHolderName}`,
          `• المبلغ المطلوب تحويله بدقة: ${formatYerNumber(amountYer)}`,
          `• اسم المرسل المعتمد للمطابقة: ${depositorNameUsed}${depositorNameIsTemporary ? ' (لهذه العملية فقط)' : ''}`,
          ...(wInstr ? ['', `📌 تعليمات الإدارة:\n${wInstr}`] : []),
          '',
          '⚠️ يرجى تحويل المبلغ المطلوب بالضبط، ثم الضغط على زر «✅ تحققت من التحويل» لإرسال صورة إثبات التحويل.',
        ].join('\n');

  return {
    mode: 'customer',
    lang,
    editInPlace,
    text,
    inlineKeyboard: [
      [
        {
          text: lang === 'en' ? '📋 Copy Account Number' : '📋 نسخ رقم الحساب',
          copyText: walletRow.accountNumber,
          style: 'primary',
        },
      ],
      [
        {
          text: lang === 'en' ? '✅ I Completed the Transfer' : '✅ تحققت من التحويل',
          callbackData: 'c:local_dep:transfer_done',
          style: 'success',
        },
      ],
      [
        {
          text: lang === 'en' ? '❌ Cancel' : '❌ إلغاء',
          callbackData: 'c:local_dep:cancel',
          style: 'danger',
        },
        {
          text: lang === 'en' ? '⬅️ Back' : '⬅️ رجوع',
          callbackData: `c:local_dep:wallet:${walletRow.id}`,
          style: 'primary',
        },
      ],
    ],
  };
}

/**
 * Handles all Customer Local Deposit callbacks (`c:local_dep:*`), text steps, and photo proof uploads.
 * Returns `null` if the interaction does not belong to the local deposit flow.
 */
export async function handleCustomerLocalDepositFlow(params: {
  user: typeof users.$inferSelect;
  fsm: Record<string, any>;
  input: string;
  isCallback: boolean;
  lang: SupportedLang;
  rawText?: string;
  photoFileId?: string;
  proofImageDataUrl?: string;
  photoCaption?: string;
}): Promise<LocalDepositReply | null> {
  const { user, fsm, input, isCallback, lang } = params;
  const draft: LocalDepositDraftState = (fsm.localDepositDraft as LocalDepositDraftState) || {};
  const cfg = await getCurrencyLocalDepositSettings();

  // --- Cancel Local Deposit Flow ---
  if (input === 'c:local_dep:cancel') {
    await saveLocalFsm(user.id, fsm, 'idle', undefined);
    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text:
        lang === 'en'
          ? '❌ Local deposit request cancelled.'
          : '❌ تم إلغاء عملية الإيداع المحلي.',
      inlineKeyboard: [buildCustomerNavFooter(lang, 'c:topup')],
    };
  }

  // --- STEP 1: List Enabled Local Yemeni Wallets ---
  if (input === 'c:local_dep:wallets') {
    await saveLocalFsm(user.id, fsm, 'idle', undefined);
    if (!cfg.localDepositsEnabled) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text:
          lang === 'en'
            ? '⚠️ Local Yemeni wallet deposits are temporarily disabled by store administration.'
            : '⚠️ الإيداع عبر المحافظ المحلية متوقف مؤقتًا من إدارة المتجر.',
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:topup')],
      };
    }

    const activeWallets = await listLocalWallets({ onlyEnabled: true });
    if (activeWallets.length === 0) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text:
          lang === 'en'
            ? '⚠️ No local wallets are configured yet. Please check back soon or contact support.'
            : '⚠️ لا توجد محافظ محلية مضافة حاليًا. يرجى التواصل مع الدعم الفني أو المحاولة لاحقًا.',
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:topup')],
      };
    }

    const buttons: CustomerInlineButton[][] = activeWallets.map((w) => [
      {
        text: `🏦 ${lang === 'en' ? w.nameEn || w.nameAr : w.nameAr}`,
        callbackData: `c:local_dep:wallet:${w.id}`,
        style: 'primary',
      },
    ]);

    if (user.savedDepositorName) {
      buttons.push([
        {
          text:
            lang === 'en'
              ? '✏️ Edit Saved Depositor Name'
              : '✏️ تعديل الاسم الرباعي المحفوظ',
          callbackData: 'c:local_dep:edit_name',
          style: 'primary',
        },
      ]);
    }
    buttons.push(buildCustomerNavFooter(lang, 'c:topup'));

    const savedLine = user.savedDepositorName
      ? lang === 'en'
        ? `\n🪪 Saved Depositor Name: ${user.savedDepositorName}`
        : `\n🪪 اسمك الرباعي المحفوظ: ${user.savedDepositorName}`
      : '';

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text:
        lang === 'en'
          ? `🇾🇪 Local Yemeni Wallets\n\nChoose the local wallet you want to transfer to:${savedLine}`
          : `🇾🇪 المحافظ المحلية اليمنية\n\nاختر المحفظة المحلية التي تود التحويل إليها:${savedLine}`,
      inlineKeyboard: buttons,
    };
  }

  // --- Edit Saved Permanent Depositor Name ---
  if (input === 'c:local_dep:edit_name') {
    await saveLocalFsm(user.id, fsm, 'awaiting_edit_saved_depositor_name', undefined);
    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text:
        lang === 'en'
          ? '✍️ Please enter your updated full quadruple name registered on your local wallet:'
          : '✍️ يرجى إدخال اسمك الرباعي الجديد المسجل في محفظتك الشخصية:',
      inlineKeyboard: [
        [
          {
            text: lang === 'en' ? '❌ Cancel' : '❌ إلغاء',
            callbackData: 'c:local_dep:wallets',
            style: 'danger',
          },
        ],
      ],
    };
  }

  // --- STEP 2: Wallet Chosen -> Request Quadruple Name (if first time) OR Show Amounts ---
  if (input.startsWith('c:local_dep:wallet:')) {
    const walletId = Number(input.split(':')[3]);
    const [walletRow] = await db
      .select()
      .from(localWallets)
      .where(eq(localWallets.id, walletId))
      .limit(1);

    if (!walletRow || !walletRow.isEnabled) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text:
          lang === 'en'
            ? '⚠️ This local wallet is no longer available.'
            : '⚠️ هذه المحفظة غير متاحة حاليًا.',
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:local_dep:wallets')],
      };
    }

    if (!user.savedDepositorName || !user.savedDepositorName.trim()) {
      await saveLocalFsm(user.id, fsm, 'awaiting_local_depositor_name', {
        walletId: walletRow.id,
        saveAsPermanent: true,
      });

      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text:
          lang === 'en'
            ? '🪪 Please enter your full quadruple name registered on the wallet you will transfer from:'
            : '🪪 يرجى إدخال اسمك الرباعي المسجل في المحفظة التي ستقوم بالتحويل منها:',
        inlineKeyboard: [
          [
            {
              text: lang === 'en' ? '⬅️ Back' : '⬅️ رجوع',
              callbackData: 'c:local_dep:wallets',
              style: 'primary',
            },
            {
              text: lang === 'en' ? '❌ Cancel' : '❌ إلغاء',
              callbackData: 'c:local_dep:cancel',
              style: 'danger',
            },
          ],
        ],
      };
    }

    await saveLocalFsm(user.id, fsm, 'idle', { walletId: walletRow.id });
    const minYer = walletRow.minAmountYer ? Number(walletRow.minAmountYer) : cfg.minDepositYer;
    const maxYer = walletRow.maxAmountYer ? Number(walletRow.maxAmountYer) : cfg.maxDepositYer;
    return renderAmountSelectionScreen({
      walletRow,
      lang,
      minYer,
      maxYer,
      editInPlace: isCallback,
    });
  }

  // --- STEP 3b: Custom YER Amount Button ---
  if (input.startsWith('c:local_dep:custom_amt:')) {
    const walletId = Number(input.split(':')[3]);
    const [walletRow] = await db
      .select()
      .from(localWallets)
      .where(eq(localWallets.id, walletId))
      .limit(1);

    if (!walletRow || !walletRow.isEnabled) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: lang === 'en' ? '⚠️ Wallet unavailable.' : '⚠️ المحفظة غير متاحة حاليًا.',
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:local_dep:wallets')],
      };
    }

    const minYer = walletRow.minAmountYer ? Number(walletRow.minAmountYer) : cfg.minDepositYer;
    const maxYer = walletRow.maxAmountYer ? Number(walletRow.maxAmountYer) : cfg.maxDepositYer;
    await saveLocalFsm(user.id, fsm, 'awaiting_local_custom_amount', {
      ...draft,
      walletId: walletRow.id,
    });

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text:
        lang === 'en'
          ? `✍️ Enter the deposit amount in Yemeni Rial (﷼):\nMinimum: ${formatYerNumber(minYer)} | Maximum: ${formatYerNumber(maxYer)}`
          : `✍️ أرسل الآن مبلغ الإيداع بالريال اليمني (﷼):\nالحد الأدنى: ${formatYerNumber(minYer)} | الحد الأقصى: ${formatYerNumber(maxYer)}`,
      inlineKeyboard: [
        [
          { text: lang === 'en' ? '⬅️ Back' : '⬅️ رجوع', callbackData: `c:local_dep:wallet:${walletRow.id}`, style: 'primary' },
          { text: lang === 'en' ? '❌ Cancel' : '❌ إلغاء', callbackData: 'c:local_dep:cancel', style: 'danger' },
        ],
      ],
    };
  }

  // --- STEP 3 -> 4: Preset Amount Chosen -> Confirm Wallet Owner Identity ---
  if (input.startsWith('c:local_dep:amt:')) {
    const parts = input.split(':');
    const walletId = Number(parts[3]);
    const rawAmount = parts[4] || '';
    const [walletRow] = await db
      .select()
      .from(localWallets)
      .where(eq(localWallets.id, walletId))
      .limit(1);

    if (!walletRow || !walletRow.isEnabled) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: lang === 'en' ? '⚠️ Wallet unavailable.' : '⚠️ المحفظة غير متاحة حاليًا.',
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:local_dep:wallets')],
      };
    }

    const minYer = walletRow.minAmountYer ? Number(walletRow.minAmountYer) : cfg.minDepositYer;
    const maxYer = walletRow.maxAmountYer ? Number(walletRow.maxAmountYer) : cfg.maxDepositYer;
    const amtCheck = validateLocalDepositAmountYer(rawAmount, minYer, maxYer);
    if (!amtCheck.ok) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text:
          lang === 'en'
            ? `⚠️ Amount must be between ${formatYerNumber(minYer)} and ${formatYerNumber(maxYer)}.`
            : `⚠️ يجب أن يكون المبلغ بين ${formatYerNumber(minYer)} و ${formatYerNumber(maxYer)}.`,
        inlineKeyboard: [buildCustomerNavFooter(lang, `c:local_dep:wallet:${walletRow.id}`)],
      };
    }

    const savedName = (user.savedDepositorName || '').trim();
    if (!savedName) {
      await saveLocalFsm(user.id, fsm, 'awaiting_local_depositor_name', {
        walletId: walletRow.id,
        amountYer: amtCheck.amountYer,
        saveAsPermanent: true,
      });
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text:
          lang === 'en'
            ? '🪪 Please enter your full quadruple name registered on your wallet:'
            : '🪪 يرجى إدخال اسمك الرباعي المسجل في المحفظة التي ستقوم بالتحويل منها:',
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:local_dep:wallets')],
      };
    }

    await saveLocalFsm(user.id, fsm, 'idle', {
      walletId: walletRow.id,
      amountYer: amtCheck.amountYer,
    });

    return renderOwnerIdentityConfirmScreen({
      lang,
      savedDepositorName: savedName,
      walletId: walletRow.id,
      amountYer: amtCheck.amountYer,
      editInPlace: isCallback,
    });
  }

  // --- STEP 4: Confirm Owner Identity (YES -> use saved name | NO -> ask one-time temp name) ---
  if (input === 'c:local_dep:confirm_owner:yes' || input === 'c:local_dep:confirm_owner:no') {
    if (!draft.walletId || !draft.amountYer) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text:
          lang === 'en'
            ? '⚠️ Deposit session expired. Please start again.'
            : '⚠️ انتهت جلسة الإيداع، يرجى البدء من جديد.',
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:local_dep:wallets')],
      };
    }

    const [walletRow] = await db
      .select()
      .from(localWallets)
      .where(eq(localWallets.id, draft.walletId))
      .limit(1);
    if (!walletRow || !walletRow.isEnabled) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text: lang === 'en' ? '⚠️ Wallet unavailable.' : '⚠️ المحفظة غير متاحة حاليًا.',
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:local_dep:wallets')],
      };
    }

    if (input === 'c:local_dep:confirm_owner:yes') {
      const savedName = (user.savedDepositorName || '').trim();
      await saveLocalFsm(user.id, fsm, 'idle', {
        ...draft,
        depositorNameUsed: savedName,
        depositorNameIsTemporary: false,
      });

      return renderTransferSummaryScreen({
        walletRow,
        amountYer: draft.amountYer,
        depositorNameUsed: savedName,
        depositorNameIsTemporary: false,
        lang,
        editInPlace: isCallback,
      });
    }

    // NO -> ask for one-time quadruple name WITHOUT overwriting users.savedDepositorName!
    await saveLocalFsm(user.id, fsm, 'awaiting_local_temp_depositor_name', {
      ...draft,
      depositorNameIsTemporary: true,
    });

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text:
        lang === 'en'
          ? '✍️ Enter the full quadruple name registered on the wallet you are transferring from for THIS transaction only (your permanently saved name will NOT be changed):'
          : '✍️ يرجى إدخال الاسم الرباعي لصاحب المحفظة التي ستحول منها لهذه العملية فقط:\n\n💡 ملاحظة: لن يتم تعديل اسمك الرباعي الدائم المحفوظ في حسابك.',
      inlineKeyboard: [
        [
          {
            text: lang === 'en' ? '❌ Cancel' : '❌ إلغاء',
            callbackData: 'c:local_dep:cancel',
            style: 'danger',
          },
        ],
      ],
    };
  }

  // --- STEP 5: User Clicked "✅ تحققت من التحويل" -> Ask for Proof Screenshot (NEVER credits!) ---
  if (input === 'c:local_dep:transfer_done') {
    if (!draft.walletId || !draft.amountYer || !draft.depositorNameUsed) {
      return {
        mode: 'customer',
        lang,
        editInPlace: isCallback,
        text:
          lang === 'en'
            ? '⚠️ Deposit session expired. Please choose the local wallet again.'
            : '⚠️ انتهت جلسة الإيداع، يرجى اختيار المحفظة المحلية من جديد.',
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:local_dep:wallets')],
      };
    }

    await saveLocalFsm(user.id, fsm, 'awaiting_local_proof_photo', draft);

    return {
      mode: 'customer',
      lang,
      editInPlace: isCallback,
      text:
        lang === 'en'
          ? '📸 Please send a clear screenshot/photo of your transfer proof showing the transaction details, amount, and sender info if possible.\n\nYour payment will be reviewed by administration, and the balance will be credited to your account after verification.'
          : '📸 يرجى إرسال صورة واضحة لإثبات التحويل، بحيث تظهر تفاصيل العملية والمبلغ وبيانات المرسل إن أمكن.\n\nسيتم مراجعة عملية الدفع من الإدارة، وإضافة الرصيد إلى حسابك بعد التحقق من صحة العملية.',
      inlineKeyboard: [
        [
          {
            text: lang === 'en' ? '❌ Cancel' : '❌ إلغاء الطلب',
            callbackData: 'c:local_dep:cancel',
            style: 'danger',
          },
          {
            text: lang === 'en' ? '🏠 Home' : '🏠 الرئيسية',
            callbackData: 'c:home',
            style: 'primary',
          },
        ],
      ],
    };
  }

  // --- PHOTO / PROOF UPLOAD HANDLER ---
  if (fsm.step === 'awaiting_local_proof_photo' && !isCallback) {
    if (!params.photoFileId && !params.proofImageDataUrl) {
      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text:
          lang === 'en'
            ? '⚠️ A clear transfer proof image is required. Please attach a photo/screenshot of your transfer (text messages alone are not accepted).'
            : '⚠️ لا يمكن إرسال الطلب بنص فقط — يرجى إرسال صورة واضحة لإثبات التحويل (لقطة شاشة للعملية).',
        inlineKeyboard: [
          [
            {
              text: lang === 'en' ? '❌ Cancel' : '❌ إلغاء الطلب',
              callbackData: 'c:local_dep:cancel',
              style: 'danger',
            },
          ],
        ],
      };
    }

    if (!draft.walletId || !draft.amountYer || !draft.depositorNameUsed) {
      await saveLocalFsm(user.id, fsm, 'idle', undefined);
      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text: lang === 'en' ? '⚠️ Session expired, please start again.' : '⚠️ انتهت الجلسة، يرجى البدء من جديد.',
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:local_dep:wallets')],
      };
    }

    const res = await createLocalDepositRequest({
      userId: user.id,
      localWalletId: draft.walletId,
      amountYer: draft.amountYer,
      depositorNameUsed: draft.depositorNameUsed,
      depositorNameIsTemporary: Boolean(draft.depositorNameIsTemporary),
      saveDepositorNameAsPermanent: false,
      senderWalletNumber: draft.senderWalletNumber || '',
      proofTelegramFileId: params.photoFileId || null,
      proofImageDataUrl: params.proofImageDataUrl || null,
      proofCaption: params.photoCaption || params.rawText || '',
    });

    if (!res.ok || !res.deposit) {
      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text: `⚠️ ${lang === 'en' ? res.errorEn || res.errorAr : res.errorAr}`,
        inlineKeyboard: [
          [
            { text: lang === 'en' ? '🏠 Home' : '🏠 الرئيسية', callbackData: 'c:home', style: 'primary' },
          ],
        ],
      };
    }

    await saveLocalFsm(user.id, fsm, 'idle', undefined);

    return {
      mode: 'customer',
      lang,
      editInPlace: false,
      text:
        lang === 'en'
          ? [
              '✅ Your local deposit request has been received and sent for manual review!',
              '',
              `🧾 Reference: ${res.deposit.depositRef}`,
              `🏦 Wallet: ${res.deposit.walletNameSnapshot}`,
              `💰 Amount: ${formatYerNumber(res.deposit.amountYer)}`,
              `🪪 Depositor Name: ${res.deposit.depositorNameUsed}`,
              `📌 Status: ⏳ Under Review`,
              '',
              'You will receive an automatic notification as soon as the administration verifies and approves your deposit.',
            ].join('\n')
          : [
              '✅ تم استلام إثبات التحويل وإرسال طلب الإيداع للمراجعة بنجاح!',
              '',
              `🧾 رقم العملية: ${res.deposit.depositRef}`,
              `🏦 المحفظة: ${res.deposit.walletNameSnapshot}`,
              `💰 المبلغ: ${formatYerNumber(res.deposit.amountYer)}`,
              `🪪 اسم المودع: ${res.deposit.depositorNameUsed}`,
              `📌 الحالة: ⏳ قيد المراجعة`,
              '',
              'سيتم إشعارك تلقائيًا فور تحقق الإدارة من العملية وإضافة الرصيد إلى حسابك.',
            ].join('\n'),
      inlineKeyboard: [
        [
          { text: lang === 'en' ? '📜 Deposit History' : '📜 سجل الإيداعات', callbackData: 'c:dep_history', style: 'primary' },
          { text: lang === 'en' ? '🏠 Home' : '🏠 الرئيسية', callbackData: 'c:home', style: 'success' },
        ],
      ],
    };
  }

  // --- TEXT FSM STEPS ---
  if (!isCallback && params.rawText) {
    const rawText = params.rawText.trim();

    // A) First-time permanent quadruple depositor name
    if (fsm.step === 'awaiting_local_depositor_name') {
      const check = validateDepositorQuadName(rawText);
      if (!check.ok) {
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text:
            lang === 'en'
              ? '⚠️ Please enter your full quadruple name (at least 3 words, without links or numbers).'
              : '⚠️ يرجى إدخال الاسم الرباعي بشكل صحيح وكامل (ثلاث كلمات على الأقل بدون روابط أو أرقام).',
          inlineKeyboard: [
            [{ text: lang === 'en' ? '❌ Cancel' : '❌ إلغاء', callbackData: 'c:local_dep:cancel', style: 'danger' }],
          ],
        };
      }

      await db
        .update(users)
        .set({ savedDepositorName: check.cleaned, updatedAt: new Date() })
        .where(eq(users.id, user.id));

      if (draft.walletId) {
        const [walletRow] = await db
          .select()
          .from(localWallets)
          .where(eq(localWallets.id, draft.walletId))
          .limit(1);

        if (walletRow && walletRow.isEnabled) {
          await saveLocalFsm(user.id, fsm, 'idle', { ...draft, walletId: walletRow.id });
          const minYer = walletRow.minAmountYer ? Number(walletRow.minAmountYer) : cfg.minDepositYer;
          const maxYer = walletRow.maxAmountYer ? Number(walletRow.maxAmountYer) : cfg.maxDepositYer;
          const screen = await renderAmountSelectionScreen({
            walletRow,
            lang,
            minYer,
            maxYer,
            editInPlace: false,
          });
          return {
            ...screen,
            text:
              (lang === 'en'
                ? `✅ Saved your depositor name: ${check.cleaned}\n\n`
                : `✅ تم حفظ اسمك الرباعي بنجاح: ${check.cleaned}\n\n`) + screen.text,
          };
        }
      }

      await saveLocalFsm(user.id, fsm, 'idle', undefined);
      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text:
          lang === 'en'
            ? `✅ Saved your depositor name: ${check.cleaned}`
            : `✅ تم حفظ اسمك الرباعي بنجاح: ${check.cleaned}`,
        inlineKeyboard: [buildCustomerNavFooter(lang, 'c:local_dep:wallets')],
      };
    }

    // B) Edit existing permanent saved depositor name
    if (fsm.step === 'awaiting_edit_saved_depositor_name') {
      const check = validateDepositorQuadName(rawText);
      if (!check.ok) {
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text:
            lang === 'en'
              ? '⚠️ Please enter a valid full name (at least 3 words).'
              : '⚠️ يرجى إدخال الاسم الرباعي بشكل صحيح (ثلاث كلمات على الأقل).',
          inlineKeyboard: [
            [{ text: lang === 'en' ? '❌ Cancel' : '❌ إلغاء', callbackData: 'c:local_dep:wallets', style: 'danger' }],
          ],
        };
      }

      await db
        .update(users)
        .set({ savedDepositorName: check.cleaned, updatedAt: new Date() })
        .where(eq(users.id, user.id));
      await saveLocalFsm(user.id, fsm, 'idle', undefined);

      return {
        mode: 'customer',
        lang,
        editInPlace: false,
        text:
          lang === 'en'
            ? `✅ Your saved depositor name has been updated to:\n${check.cleaned}`
            : `✅ تم تحديث اسمك الرباعي المحفوظ بنجاح إلى:\n${check.cleaned}`,
        inlineKeyboard: [
          [{ text: lang === 'en' ? '🇾🇪 Local Wallets' : '🇾🇪 المحافظ المحلية', callbackData: 'c:local_dep:wallets', style: 'success' }],
          buildCustomerNavFooter(lang, 'c:home'),
        ],
      };
    }

    // C) Custom YER Amount Text Input
    if (fsm.step === 'awaiting_local_custom_amount' && draft.walletId) {
      const [walletRow] = await db
        .select()
        .from(localWallets)
        .where(eq(localWallets.id, draft.walletId))
        .limit(1);
      if (!walletRow || !walletRow.isEnabled) {
        await saveLocalFsm(user.id, fsm, 'idle', undefined);
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text: lang === 'en' ? '⚠️ Wallet unavailable.' : '⚠️ المحفظة غير متاحة حاليًا.',
          inlineKeyboard: [buildCustomerNavFooter(lang, 'c:local_dep:wallets')],
        };
      }

      const minYer = walletRow.minAmountYer ? Number(walletRow.minAmountYer) : cfg.minDepositYer;
      const maxYer = walletRow.maxAmountYer ? Number(walletRow.maxAmountYer) : cfg.maxDepositYer;
      const amtCheck = validateLocalDepositAmountYer(rawText, minYer, maxYer);
      if (!amtCheck.ok) {
        const msg =
          amtCheck.reason === 'below_min'
            ? lang === 'en'
              ? `⚠️ Minimum allowed deposit is ${formatYerNumber(minYer)}.`
              : `⚠️ الحد الأدنى المسموح به هو ${formatYerNumber(minYer)}.`
            : amtCheck.reason === 'above_max'
            ? lang === 'en'
              ? `⚠️ Maximum allowed deposit is ${formatYerNumber(maxYer)}.`
              : `⚠️ الحد الأقصى المسموح به هو ${formatYerNumber(maxYer)}.`
            : lang === 'en'
            ? '⚠️ Invalid amount. Please enter numbers only in YER (e.g., 2500).'
            : '⚠️ المبلغ غير صالح. يرجى إدخال أرقام صحيحة بالريال اليمني فقط (مثال: 2500).';
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text: msg,
          inlineKeyboard: [
            [{ text: lang === 'en' ? '❌ Cancel' : '❌ إلغاء', callbackData: 'c:local_dep:cancel', style: 'danger' }],
          ],
        };
      }

      const savedName = (user.savedDepositorName || '').trim();
      await saveLocalFsm(user.id, fsm, 'idle', {
        ...draft,
        walletId: walletRow.id,
        amountYer: amtCheck.amountYer,
      });

      return renderOwnerIdentityConfirmScreen({
        lang,
        savedDepositorName: savedName || user.displayName,
        walletId: walletRow.id,
        amountYer: amtCheck.amountYer,
        editInPlace: false,
      });
    }

    // D) Temporary One-Time Depositor Name (DOES NOT OVERWRITE users.savedDepositorName!)
    if (fsm.step === 'awaiting_local_temp_depositor_name' && draft.walletId && draft.amountYer) {
      const check = validateDepositorQuadName(rawText);
      if (!check.ok) {
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text:
            lang === 'en'
              ? '⚠️ Please enter the sender’s full quadruple name (at least 3 words).'
              : '⚠️ يرجى إدخال الاسم الرباعي لصاحب المحفظة المرسلة بشكل صحيح (ثلاث كلمات على الأقل).',
          inlineKeyboard: [
            [{ text: lang === 'en' ? '❌ Cancel' : '❌ إلغاء', callbackData: 'c:local_dep:cancel', style: 'danger' }],
          ],
        };
      }

      const [walletRow] = await db
        .select()
        .from(localWallets)
        .where(eq(localWallets.id, draft.walletId))
        .limit(1);
      if (!walletRow || !walletRow.isEnabled) {
        await saveLocalFsm(user.id, fsm, 'idle', undefined);
        return {
          mode: 'customer',
          lang,
          editInPlace: false,
          text: lang === 'en' ? '⚠️ Wallet unavailable.' : '⚠️ المحفظة غير متاحة حاليًا.',
          inlineKeyboard: [buildCustomerNavFooter(lang, 'c:local_dep:wallets')],
        };
      }

      // Notice: we DO NOT update users.savedDepositorName! Only stored in this transaction draft.
      await saveLocalFsm(user.id, fsm, 'idle', {
        ...draft,
        depositorNameUsed: check.cleaned,
        depositorNameIsTemporary: true,
      });

      return renderTransferSummaryScreen({
        walletRow,
        amountYer: draft.amountYer,
        depositorNameUsed: check.cleaned,
        depositorNameIsTemporary: true,
        lang,
        editInPlace: false,
      });
    }
  }

  return null;
}

/**
 * Handles Telegram Admin Review Channel interactive button clicks (`adm_ch:*`)
 * AND admin DM custom rejection reason entry.
 * STRICTLY checks `isPrivilegedAdmin` before executing any decision!
 */
export async function handleAdminChannelLocalDepositAction(params: {
  adminUser: typeof users.$inferSelect;
  isPrivilegedAdmin: boolean;
  callbackData?: string;
  rawText?: string;
  fsm: Record<string, any>;
}): Promise<{
  handled: boolean;
  alertText?: string;
  replyText?: string;
  updateChannelKeyboard?: CustomerInlineButton[][] | null;
}> {
  const { adminUser, isPrivilegedAdmin, callbackData, rawText, fsm } = params;

  // 1. Admin DM custom rejection reason text entry
  if (!callbackData && rawText && fsm.step === 'awaiting_admin_local_reject_reason' && fsm.pendingLocalRejectId) {
    if (!isPrivilegedAdmin) {
      return { handled: true, replyText: '⛔ غير مصرح لك بهذا الإجراء.' };
    }
    const depositId = Number(fsm.pendingLocalRejectId);
    const reason = rawText.trim() === '-' ? DEFAULT_LOCAL_REJECTION_REASON_AR : rawText.trim();
    await saveLocalFsm(adminUser.id, fsm, 'idle', undefined, { pendingLocalRejectId: undefined });
    const res = await rejectLocalDepositAtomically({
      depositId,
      reviewerUserId: adminUser.id,
      reviewerName: adminUser.displayName || adminUser.telegramUsername || `Admin #${adminUser.id}`,
      reason,
    });
    return {
      handled: true,
      replyText: res.messageAr,
    };
  }

  if (!callbackData || !callbackData.startsWith('adm_ch:')) {
    return { handled: false };
  }

  // STRICT RBAC VERIFICATION
  if (!isPrivilegedAdmin) {
    return {
      handled: true,
      alertText: '⛔ غير مصرح لك بتنفيذ هذا الإجراء. هذه الأزرار مخصصة لإدارة المتجر فقط.',
    };
  }

  const reviewerName = adminUser.displayName || (adminUser.telegramUsername ? `@${adminUser.telegramUsername}` : `Admin #${adminUser.id}`);

  // Approve Deposit
  if (callbackData.startsWith('adm_ch:approve_local:')) {
    const depositId = Number(callbackData.split(':')[2]);
    const res = await approveLocalDepositAtomically({
      depositId,
      reviewerUserId: adminUser.id,
      reviewerName,
    });
    return {
      handled: true,
      alertText: res.messageAr.slice(0, 190),
    };
  }

  // Open Rejection Reason Picker right on the channel message
  if (callbackData.startsWith('adm_ch:reject_local:')) {
    const depositId = Number(callbackData.split(':')[2]);
    const [dep] = await db
      .select({ id: localDeposits.id, status: localDeposits.status })
      .from(localDeposits)
      .where(eq(localDeposits.id, depositId))
      .limit(1);

    if (!dep) {
      return { handled: true, alertText: 'طلب الإيداع غير موجود.' };
    }
    if (dep.status !== 'pending_review') {
      return {
        handled: true,
        alertText:
          dep.status === 'approved'
            ? 'تمت الموافقة على هذا الإيداع مسبقًا ولا يمكن رفضه.'
            : 'تمت معالجة هذا الطلب مسبقًا.',
      };
    }

    const reasonButtons: CustomerInlineButton[][] = LOCAL_DEPOSIT_REJECTION_REASONS.map((r) => [
      {
        text: `❌ ${r.labelAr}`,
        callbackData: `adm_ch:reject_reason:${depositId}:${r.code}`,
        style: 'danger',
      },
    ]);
    reasonButtons.push([
      {
        text: '❌ رفض بالسبب الافتراضي',
        callbackData: `adm_ch:reject_reason:${depositId}:default`,
        style: 'danger',
      },
      {
        text: '↩️ تراجع',
        callbackData: `adm_ch:reject_back:${depositId}`,
        style: 'primary',
      },
    ]);

    return {
      handled: true,
      alertText: 'اختر سبب الرفض من الأزرار أدناه لإتمام الرفض وإشعار المستخدم.',
      updateChannelKeyboard: reasonButtons,
    };
  }

  // Restore original Approve / Reject buttons
  if (callbackData.startsWith('adm_ch:reject_back:')) {
    const depositId = Number(callbackData.split(':')[2]);
    return {
      handled: true,
      alertText: 'تم التراجع عن الرفض.',
      updateChannelKeyboard: [
        [
          { text: '✅ موافقة على الإيداع', callbackData: `adm_ch:approve_local:${depositId}`, style: 'success' },
          { text: '❌ رفض الإيداع', callbackData: `adm_ch:reject_local:${depositId}`, style: 'danger' },
        ],
      ],
    };
  }

  // Execute Rejection with Selected Reason
  if (callbackData.startsWith('adm_ch:reject_reason:')) {
    const parts = callbackData.split(':');
    const depositId = Number(parts[2]);
    const code = parts[3] || 'default';
    const matched = LOCAL_DEPOSIT_REJECTION_REASONS.find((r) => r.code === code);
    const reason = matched ? matched.labelAr : DEFAULT_LOCAL_REJECTION_REASON_AR;

    const res = await rejectLocalDepositAtomically({
      depositId,
      reviewerUserId: adminUser.id,
      reviewerName,
      reason,
    });

    return {
      handled: true,
      alertText: res.messageAr.slice(0, 190),
    };
  }

  return { handled: false };
}

export function formatLocalDepositHistoryLine(
  d: typeof localDeposits.$inferSelect,
  lang: SupportedLang
): string {
  const icon =
    d.status === 'approved'
      ? '✅'
      : d.status === 'rejected'
      ? '❌'
      : '⏳';
  const statusLabel =
    d.status === 'approved'
      ? lang === 'en'
        ? 'Approved'
        : 'تمت الموافقة'
      : d.status === 'rejected'
      ? lang === 'en'
        ? 'Rejected'
        : 'مرفوض'
      : lang === 'en'
      ? 'Under Review'
      : 'قيد المراجعة';
  const dt = new Date(d.createdAt).toISOString().slice(0, 16).replace('T', ' ');
  const usdStr = new Decimal(d.equivalentUsd || 0).toFixed(2);
  const reasonLine =
    d.status === 'rejected' && d.rejectionReason
      ? `\n📝 ${lang === 'en' ? 'Reason' : 'السبب'}: ${d.rejectionReason}`
      : '';
  return `${icon} ${d.depositRef} — ${formatYerNumber(d.amountYer)} ($${usdStr})\n🏦 ${d.walletNameSnapshot} | ${statusLabel}\n📅 ${dt}${reasonLine}`;
}
