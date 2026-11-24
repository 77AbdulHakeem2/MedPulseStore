import React, { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Check,
  CheckCircle2,
  Copy,
  Landmark,
  Upload,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { WebLang } from '../lib/webLocale';
import { FeedbackBanner } from './ui/AdminPrimitives';

interface StoreLocalWallet {
  id: number;
  nameAr: string;
  nameEn: string;
  accountNumber: string;
  accountHolderName: string;
  instructionsAr: string;
  instructionsEn: string;
  minAmountYer: string | null;
  maxAmountYer: string | null;
}

interface CustomerLocalDepositModalProps {
  open: boolean;
  webLang: WebLang;
  onClose: () => void;
  onSubmitted: () => Promise<void>;
}

const PRESET_YER = [1000, 2000, 3000, 4000, 5000] as const;

function fmtYer(n: number | string): string {
  return `${Math.round(Number(n || 0)).toLocaleString('en-US')} ﷼`;
}

export default function CustomerLocalDepositModal({
  open,
  webLang,
  onClose,
  onSubmitted,
}: CustomerLocalDepositModalProps) {
  const isEn = webLang === 'en';
  const [loading, setLoading] = useState(false);
  const [wallets, setWallets] = useState<StoreLocalWallet[]>([]);
  const [minYerGlobal, setMinYerGlobal] = useState(1000);
  const [maxYerGlobal, setMaxYerGlobal] = useState(500000);
  const [savedDepositorName, setSavedDepositorName] = useState('');
  const [liveRateNum, setLiveRateNum] = useState<number | null>(null);

  // 5-step wizard state
  const [step, setStep] = useState<'wallet' | 'first_name' | 'amount' | 'confirm_owner' | 'transfer' | 'proof' | 'done'>('wallet');
  const [selectedWallet, setSelectedWallet] = useState<StoreLocalWallet | null>(null);
  const [firstNameInput, setFirstNameInput] = useState('');
  const [amountYer, setAmountYer] = useState<string>('');
  const [customAmountMode, setCustomAmountMode] = useState(false);
  const [tempNameMode, setTempNameMode] = useState(false);
  const [tempNameInput, setTempNameInput] = useState('');
  const [depositorNameUsed, setDepositorNameUsed] = useState('');
  const [depositorNameIsTemporary, setDepositorNameIsTemporary] = useState(false);
  const [proofDataUrl, setProofDataUrl] = useState<string>('');
  const [proofFileName, setProofFileName] = useState<string>('');
  const [submitting, setSubmitting] = useState(false);
  const [copiedAcc, setCopiedAcc] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdRef, setCreatedRef] = useState<string>('');

  useEffect(() => {
    if (!open) return;
    setStep('wallet');
    setSelectedWallet(null);
    setAmountYer('');
    setCustomAmountMode(false);
    setTempNameMode(false);
    setTempNameInput('');
    setProofDataUrl('');
    setProofFileName('');
    setError(null);
    setCreatedRef('');

    setLoading(true);
    apiFetch<{
      wallets: StoreLocalWallet[];
      minDepositYer: number;
      maxDepositYer: number;
      savedDepositorName: string;
      exchangeRate?: { ok: boolean; rate: string | null };
    }>('/api/store/local-wallets')
      .then((res) => {
        setWallets(res.wallets || []);
        setMinYerGlobal(res.minDepositYer || 1000);
        setMaxYerGlobal(res.maxDepositYer || 500000);
        setSavedDepositorName(res.savedDepositorName || '');
        setLiveRateNum(res.exchangeRate?.ok && res.exchangeRate.rate ? Number(res.exchangeRate.rate) : null);
      })
      .catch((err: any) => {
        setError(err?.message || (isEn ? 'Unable to load local wallets.' : 'تعذر تحميل المحافظ المحلية.'));
      })
      .finally(() => setLoading(false));
  }, [open, isEn]);

  if (!open) return null;

  const activeMinYer = selectedWallet?.minAmountYer ? Number(selectedWallet.minAmountYer) : minYerGlobal;
  const activeMaxYer = selectedWallet?.maxAmountYer ? Number(selectedWallet.maxAmountYer) : maxYerGlobal;

  const handleSelectWallet = (w: StoreLocalWallet) => {
    setSelectedWallet(w);
    setError(null);
    if (!savedDepositorName.trim()) {
      setStep('first_name');
    } else {
      setStep('amount');
    }
  };

  const handleSaveFirstName = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleaned = firstNameInput.replace(/\s+/g, ' ').trim();
    if (cleaned.split(' ').filter((w) => w.length >= 2).length < 3) {
      setError(
        isEn
          ? 'Please enter your full quadruple name (at least 3 words).'
          : 'يرجى إدخال اسمك الرباعي الكامل المسجل في المحفظة (3 كلمات على الأقل).'
      );
      return;
    }
    try {
      const res = await apiFetch<{ savedDepositorName: string }>('/api/store/depositor-name', {
        method: 'PATCH',
        body: JSON.stringify({ savedDepositorName: cleaned }),
      });
      setSavedDepositorName(res.savedDepositorName);
      setStep('amount');
    } catch (err: any) {
      setError(err?.message || 'تعذر حفظ الاسم الرباعي.');
    }
  };

  const handleChooseAmount = (val: string) => {
    setError(null);
    const num = Number(val);
    if (!Number.isFinite(num) || num < activeMinYer || num > activeMaxYer) {
      setError(
        isEn
          ? `Amount must be between ${fmtYer(activeMinYer)} and ${fmtYer(activeMaxYer)}.`
          : `يجب أن يكون المبلغ بين ${fmtYer(activeMinYer)} و ${fmtYer(activeMaxYer)}.`
      );
      return;
    }
    setAmountYer(String(num));
    setTempNameMode(false);
    setStep('confirm_owner');
  };

  const handleConfirmOwnWallet = (yes: boolean) => {
    setError(null);
    if (yes) {
      setDepositorNameUsed(savedDepositorName);
      setDepositorNameIsTemporary(false);
      setStep('transfer');
    } else {
      setTempNameMode(true);
    }
  };

  const handleApplyTempName = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const cleaned = tempNameInput.replace(/\s+/g, ' ').trim();
    if (cleaned.split(' ').filter((w) => w.length >= 2).length < 3) {
      setError(
        isEn
          ? 'Please enter the sender’s full quadruple name (at least 3 words).'
          : 'يرجى إدخال الاسم الرباعي لصاحب المحفظة المرسلة (3 كلمات على الأقل).'
      );
      return;
    }
    setDepositorNameUsed(cleaned);
    setDepositorNameIsTemporary(true);
    setStep('transfer');
  };

  const handleProofFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
      setError(isEn ? 'Only JPG, PNG, or WEBP images are allowed.' : 'يرجى اختيار صورة بصيغة JPG أو PNG أو WEBP فقط.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError(isEn ? 'Image exceeds 5 MB limit.' : 'حجم الصورة يتجاوز 5 ميجابايت.');
      return;
    }
    setProofFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setProofDataUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSubmitProof = async () => {
    if (!selectedWallet || !amountYer || !depositorNameUsed || !proofDataUrl) {
      setError(isEn ? 'Please attach a clear transfer proof image first.' : 'يرجى إرفاق صورة واضحة لإثبات التحويل أولًا.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await apiFetch<{ deposit: { depositRef: string } }>('/api/store/local-deposits', {
        method: 'POST',
        body: JSON.stringify({
          localWalletId: selectedWallet.id,
          amountYer: Number(amountYer),
          depositorNameUsed,
          depositorNameIsTemporary,
          proofImageDataUrl: proofDataUrl,
        }),
      });
      setCreatedRef(res.deposit?.depositRef || '');
      setStep('done');
      await onSubmitted();
    } catch (err: any) {
      setError(err?.message || (isEn ? 'Unable to submit deposit request.' : 'تعذر إرسال طلب الإيداع المحلي.'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyAccount = () => {
    if (!selectedWallet) return;
    navigator.clipboard?.writeText(selectedWallet.accountNumber).catch(() => undefined);
    setCopiedAcc(true);
    setTimeout(() => setCopiedAcc(false), 1800);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/55 p-4 backdrop-blur-[2px]">
      <div className="w-full max-w-lg rounded-2xl bg-white shadow-2xl border border-slate-200 overflow-hidden max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-2">
            <Landmark className="h-4 w-4 text-emerald-700" />
            <h3 className="text-sm font-bold text-slate-900">
              {isEn ? '🇾🇪 Top Up — Local Yemeni Wallets (YER)' : '🇾🇪 شحن الرصيد — المحافظ المحلية (﷼)'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          {error && <FeedbackBanner type="err" text={error} onDismiss={() => setError(null)} />}

          {loading ? (
            <div className="py-10 text-center text-xs text-slate-500">
              {isEn ? 'Loading local wallets...' : 'جارٍ تحميل المحافظ المحلية...'}
            </div>
          ) : step === 'wallet' ? (
            <div className="space-y-3">
              <div className="text-xs text-slate-600">
                {isEn
                  ? 'Select the local wallet you want to transfer to in Yemeni Rial (﷼):'
                  : 'اختر المحفظة المحلية التي تود التحويل إليها بالريال اليمني (﷼):'}
              </div>
              {wallets.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-5 text-center text-xs text-slate-500">
                  {isEn
                    ? 'No local wallets are currently enabled. Please contact support.'
                    : 'لا توجد محافظ محلية مفعّلة حاليًا. يرجى التواصل مع الدعم الفني.'}
                </div>
              ) : (
                <div className="space-y-2">
                  {wallets.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      onClick={() => handleSelectWallet(w)}
                      className="w-full rounded-xl border border-slate-200 bg-white hover:border-emerald-500 hover:bg-emerald-50/40 p-3.5 text-start transition-all flex items-center justify-between gap-3"
                    >
                      <div>
                        <div className="text-sm font-bold text-slate-900">
                          {isEn ? w.nameEn || w.nameAr : w.nameAr}
                        </div>
                        <div className="mt-0.5 text-xs text-slate-500">
                          {w.accountHolderName} · <span className="font-mono-num">{w.accountNumber}</span>
                        </div>
                      </div>
                      <ArrowLeft className={`h-4 w-4 text-slate-400 ${isEn ? 'rotate-180' : ''}`} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : step === 'first_name' ? (
            <form onSubmit={(e) => void handleSaveFirstName(e)} className="space-y-4">
              <div className="text-xs text-slate-700 leading-relaxed">
                {isEn
                  ? 'Please enter your full quadruple name registered on the wallet you will transfer from:'
                  : 'يرجى إدخال اسمك الرباعي المسجل في المحفظة التي ستقوم بالتحويل منها:'}
              </div>
              <input
                type="text"
                required
                value={firstNameInput}
                onChange={(e) => setFirstNameInput(e.target.value)}
                placeholder={isEn ? 'Full quadruple name' : 'مثال: محمد أحمد علي صالح'}
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 focus:border-emerald-600 focus:outline-none"
              />
              <div className="flex items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={() => setStep('wallet')}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600"
                >
                  {isEn ? 'Back' : 'رجوع'}
                </button>
                <button
                  type="submit"
                  className="rounded-xl bg-emerald-700 px-5 py-2 text-xs font-bold text-white hover:bg-emerald-800"
                >
                  {isEn ? 'Save & Continue' : 'حفظ ومتابعة'}
                </button>
              </div>
            </form>
          ) : step === 'amount' && selectedWallet ? (
            <div className="space-y-4">
              <div className="rounded-xl bg-slate-50 border border-slate-200/80 p-3.5 text-xs space-y-1">
                <div className="font-bold text-slate-900">
                  {isEn ? selectedWallet.nameEn || selectedWallet.nameAr : selectedWallet.nameAr}
                </div>
                <div className="text-slate-600">
                  {isEn ? 'Allowed range:' : 'النطاق المسموح:'} {fmtYer(activeMinYer)} — {fmtYer(activeMaxYer)}
                </div>
                {liveRateNum && (
                  <div className="text-[11px] text-emerald-700 font-mono-num">
                    {isEn
                      ? `Live rate: 1 USD = ${liveRateNum.toFixed(0)} YER`
                      : `سعر الصرف الحي: 1 دولار = ${liveRateNum.toFixed(0)} ﷼`}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-3 gap-2">
                {PRESET_YER.map((amt) => (
                  <button
                    key={amt}
                    type="button"
                    onClick={() => handleChooseAmount(String(amt))}
                    className="rounded-xl bg-sky-600 hover:bg-sky-700 py-2.5 text-xs font-bold text-white font-mono-num"
                  >
                    {fmtYer(amt)}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setCustomAmountMode((p) => !p)}
                  className="rounded-xl bg-emerald-600 hover:bg-emerald-700 py-2.5 text-xs font-bold text-white"
                >
                  {isEn ? 'Custom' : 'مبلغ مخصص'}
                </button>
              </div>

              {customAmountMode && (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    value={amountYer}
                    onChange={(e) => setAmountYer(e.target.value)}
                    placeholder={isEn ? 'Amount in YER' : 'أدخل المبلغ بالريال (﷼)'}
                    className="flex-1 rounded-xl border border-slate-300 px-3 py-2 text-sm font-mono-num"
                  />
                  <button
                    type="button"
                    onClick={() => handleChooseAmount(amountYer)}
                    className="rounded-xl bg-slate-900 px-4 py-2 text-xs font-bold text-white"
                  >
                    {isEn ? 'Continue' : 'متابعة'}
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={() => setStep('wallet')}
                className="text-xs font-semibold text-slate-500 hover:text-slate-900"
              >
                {isEn ? '← Back to wallets' : '→ الرجوع لقائمة المحافظ'}
              </button>
            </div>
          ) : step === 'confirm_owner' ? (
            <div className="space-y-4">
              {!tempNameMode ? (
                <>
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2 text-center">
                    <div className="text-xs text-slate-600">
                      {isEn
                        ? 'Will you transfer from your personal wallet registered under:'
                        : 'هل ستقوم بالتحويل من محفظتك الشخصية المسجلة باسم:'}
                    </div>
                    <div className="text-base font-bold text-slate-900">{savedDepositorName}</div>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <button
                      type="button"
                      onClick={() => handleConfirmOwnWallet(true)}
                      className="rounded-xl bg-emerald-600 hover:bg-emerald-700 py-2.5 text-xs font-bold text-white"
                    >
                      {isEn ? '✅ Yes' : '✅ نعم'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleConfirmOwnWallet(false)}
                      className="rounded-xl bg-rose-600 hover:bg-rose-700 py-2.5 text-xs font-bold text-white"
                    >
                      {isEn ? '❌ No' : '❌ لا'}
                    </button>
                  </div>
                </>
              ) : (
                <form onSubmit={handleApplyTempName} className="space-y-3">
                  <div className="text-xs text-slate-700">
                    {isEn
                      ? 'Enter the sender’s full quadruple name for THIS transaction only (your permanently saved name will NOT change):'
                      : 'أدخل الاسم الرباعي لصاحب المحفظة التي ستحول منها لهذه العملية فقط (لن يتم تغيير اسمك الدائم المحفوظ):'}
                  </div>
                  <input
                    type="text"
                    required
                    value={tempNameInput}
                    onChange={(e) => setTempNameInput(e.target.value)}
                    placeholder={isEn ? 'Sender full quadruple name' : 'الاسم الرباعي للمرسل لهذه العملية فقط'}
                    className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
                  />
                  <div className="flex justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setTempNameMode(false)}
                      className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-600"
                    >
                      {isEn ? 'Back' : 'رجوع'}
                    </button>
                    <button
                      type="submit"
                      className="rounded-xl bg-emerald-700 px-5 py-2 text-xs font-bold text-white"
                    >
                      {isEn ? 'Continue' : 'متابعة'}
                    </button>
                  </div>
                </form>
              )}
            </div>
          ) : step === 'transfer' && selectedWallet ? (
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs space-y-2">
                <div className="flex justify-between">
                  <span className="text-slate-500">{isEn ? 'Wallet:' : 'المحفظة:'}</span>
                  <strong className="text-slate-900">
                    {isEn ? selectedWallet.nameEn || selectedWallet.nameAr : selectedWallet.nameAr}
                  </strong>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-slate-500">{isEn ? 'Account Number:' : 'رقم الحساب:'}</span>
                  <button
                    type="button"
                    onClick={handleCopyAccount}
                    className="inline-flex items-center gap-1.5 font-mono-num font-bold text-slate-900 hover:text-emerald-700"
                  >
                    <span>{selectedWallet.accountNumber}</span>
                    {copiedAcc ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5 text-slate-400" />}
                  </button>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">{isEn ? 'Recipient:' : 'اسم المستلم:'}</span>
                  <strong className="text-slate-900">{selectedWallet.accountHolderName}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">{isEn ? 'Exact Amount:' : 'المبلغ المطلوب:'}</span>
                  <strong className="font-mono-num text-emerald-700 text-sm">{fmtYer(amountYer)}</strong>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">{isEn ? 'Depositor Name:' : 'اسم المودع:'}</span>
                  <strong className="text-slate-900">{depositorNameUsed}</strong>
                </div>
                {(selectedWallet.instructionsAr || selectedWallet.instructionsEn) && (
                  <div className="border-t border-slate-200 pt-2 text-slate-600">
                    {isEn
                      ? selectedWallet.instructionsEn || selectedWallet.instructionsAr
                      : selectedWallet.instructionsAr || selectedWallet.instructionsEn}
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => setStep('proof')}
                className="w-full rounded-xl bg-emerald-600 hover:bg-emerald-700 py-3 text-xs font-bold text-white"
              >
                {isEn ? '✅ I Completed the Transfer' : '✅ تحققت من التحويل'}
              </button>
            </div>
          ) : step === 'proof' ? (
            <div className="space-y-4">
              <div className="text-xs text-slate-700 leading-relaxed">
                {isEn
                  ? '📸 Please upload a clear screenshot of your transfer proof. Administration will verify and credit your balance after review.'
                  : '📸 يرجى إرسال صورة واضحة لإثبات التحويل، بحيث تظهر تفاصيل العملية والمبلغ وبيانات المرسل إن أمكن. سيتم مراجعة عملية الدفع من الإدارة وإضافة الرصيد بعد التحقق.'}
              </div>

              <label className="flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 bg-slate-50/70 p-6 cursor-pointer hover:border-emerald-500 transition-colors">
                <Upload className="h-6 w-6 text-emerald-700" />
                <span className="text-xs font-semibold text-slate-700">
                  {proofFileName || (isEn ? 'Click to upload proof screenshot (JPG/PNG/WEBP)' : 'اضغط لاختيار صورة إثبات التحويل (JPG / PNG / WEBP)')}
                </span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleProofFileChange}
                  className="hidden"
                />
              </label>

              {proofDataUrl && (
                <div className="rounded-xl border border-slate-200 p-2 bg-slate-50 flex justify-center">
                  <img
                    src={proofDataUrl}
                    alt="Proof preview"
                    className="max-h-44 rounded-lg object-contain"
                  />
                </div>
              )}

              <button
                type="button"
                disabled={submitting || !proofDataUrl}
                onClick={() => void handleSubmitProof()}
                className="w-full rounded-xl bg-emerald-700 hover:bg-emerald-800 py-3 text-xs font-bold text-white disabled:opacity-50"
              >
                {submitting
                  ? isEn
                    ? 'Submitting...'
                    : 'جارٍ إرسال الطلب للمراجعة...'
                  : isEn
                  ? 'Submit Transfer Proof for Review'
                  : 'إرسال إثبات التحويل للمراجعة'}
              </button>
            </div>
          ) : (
            <div className="py-4 text-center space-y-3">
              <CheckCircle2 className="h-10 w-10 text-emerald-600 mx-auto" />
              <div className="text-base font-bold text-slate-900">
                {isEn ? 'Deposit Request Sent for Review!' : 'تم إرسال طلب الإيداع للمراجعة بنجاح!'}
              </div>
              <div className="text-xs text-slate-600">
                {isEn ? 'Reference:' : 'رقم العملية:'}{' '}
                <strong className="font-mono-num text-slate-900">{createdRef}</strong>
              </div>
              <div className="text-xs text-slate-500">
                {isEn
                  ? 'Your balance will be credited as soon as administration verifies the transfer.'
                  : 'سيتم إشعارك وإضافة الرصيد إلى حسابك فور تحقق الإدارة من التحويل.'}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="mt-2 rounded-xl bg-slate-900 px-6 py-2.5 text-xs font-bold text-white"
              >
                {isEn ? 'Done' : 'إغلاق'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
