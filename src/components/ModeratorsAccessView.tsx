import React, { useCallback, useEffect, useState } from 'react';
import {
  UserPlus,
  ShieldCheck,
  KeyRound,
  Ban,
  CheckCircle2,
  Trash2,
  Edit3,
  Server,
  Lock,
  RefreshCw,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
  PageHeader,
  KpiCard,
  SurfacePanel,
  SectionHeader,
  SemanticStatus,
  FeedbackBanner,
} from './ui/AdminPrimitives';

interface PermissionDef {
  key: string;
  labelAr: string;
  labelEn: string;
  descriptionAr: string;
  ownerOnly?: boolean;
}

interface StaffMember {
  id: number;
  uid: string;
  displayName: string;
  email: string | null;
  role: 'owner' | 'admin' | 'support';
  permissions: string[];
  hasPassword: boolean;
  telegramUserId: string | null;
  isBlocked: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

interface HostingPosture {
  persistentSessionSecretConfigured: boolean;
  passcodeEnvConfigured: boolean;
  ownerEmailEnvConfigured: boolean;
  telegramBotRunning: boolean;
  databaseEngine: string;
}

interface ModeratorsResponse {
  permissionCatalog: PermissionDef[];
  rolePresets: Record<'admin' | 'support', string[]>;
  hostingPosture: HostingPosture;
  staff: StaffMember[];
}

export default function ModeratorsAccessView() {
  const [data, setData] = useState<ModeratorsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Create moderator form state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'support'>('support');
  const [newPassword, setNewPassword] = useState('');
  const [newTelegramId, setNewTelegramId] = useState('');
  const [newPermissions, setNewPermissions] = useState<string[]>([]);

  // Edit permissions modal state
  const [editingMod, setEditingMod] = useState<StaffMember | null>(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState<'admin' | 'support'>('support');
  const [editTelegramId, setEditTelegramId] = useState('');
  const [editPermissions, setEditPermissions] = useState<string[]>([]);

  // Reset password modal state
  const [resetTarget, setResetTarget] = useState<StaffMember | null>(null);
  const [resetPasswordVal, setResetPasswordVal] = useState('');

  // Confirm revoke state (inline — no window.confirm)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const loadModerators = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch<ModeratorsResponse>('/api/admin/moderators');
      setData(res);
      if (newPermissions.length === 0 && res.rolePresets?.support) {
        setNewPermissions(res.rolePresets.support);
      }
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحميل بيانات المشرفين والصلاحيات.' });
    } finally {
      setLoading(false);
    }
  }, [newPermissions.length]);

  useEffect(() => {
    void loadModerators();
  }, [loadModerators]);

  const assignablePermissions = (data?.permissionCatalog || []).filter((p) => !p.ownerOnly);

  const handleRolePresetChange = (role: 'admin' | 'support', isCreate: boolean) => {
    const preset = data?.rolePresets?.[role] || [];
    if (isCreate) {
      setNewRole(role);
      setNewPermissions(preset);
    } else {
      setEditRole(role);
      setEditPermissions(preset);
    }
  };

  const togglePermission = (
    permKey: string,
    current: string[],
    setter: React.Dispatch<React.SetStateAction<string[]>>
  ) => {
    if (current.includes(permKey)) {
      setter(current.filter((p) => p !== permKey));
    } else {
      setter([...current, permKey]);
    }
  };

  const handleCreateModerator = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch('/api/admin/moderators', {
        method: 'POST',
        body: JSON.stringify({
          displayName: newName.trim(),
          email: newEmail.trim(),
          role: newRole,
          password: newPassword,
          telegramUserId: newTelegramId.trim() || undefined,
          permissions: newPermissions,
        }),
      });
      setFeedback({ type: 'ok', text: `تمت إضافة المشرف «${newName.trim()}» وحفظ صلاحياته في قاعدة البيانات.` });
      setShowCreateForm(false);
      setNewName('');
      setNewEmail('');
      setNewPassword('');
      setNewTelegramId('');
      setNewRole('support');
      setNewPermissions(data?.rolePresets?.support || []);
      await loadModerators();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر إضافة المشرف.' });
    } finally {
      setBusy(false);
    }
  };

  const openEditModal = (mod: StaffMember) => {
    setEditingMod(mod);
    setEditName(mod.displayName);
    setEditRole(mod.role === 'admin' ? 'admin' : 'support');
    setEditTelegramId(mod.telegramUserId || '');
    setEditPermissions(mod.permissions.filter((p) => p !== 'moderators:manage'));
  };

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingMod) return;
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/moderators/${editingMod.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          displayName: editName.trim(),
          role: editRole,
          telegramUserId: editTelegramId.trim() || null,
          permissions: editPermissions,
        }),
      });
      setFeedback({
        type: 'ok',
        text: `تم تحديث صلاحيات المشرف «${editName.trim()}» وإبطال جلساته السابقة فورًا.`,
      });
      setEditingMod(null);
      await loadModerators();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تحديث صلاحيات المشرف.' });
    } finally {
      setBusy(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTarget) return;
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/moderators/${resetTarget.id}/reset-password`, {
        method: 'POST',
        body: JSON.stringify({ password: resetPasswordVal }),
      });
      setFeedback({
        type: 'ok',
        text: `تم تعيين كلمة مرور جديدة للمشرف «${resetTarget.displayName}» وإبطال جلساته القديمة.`,
      });
      setResetTarget(null);
      setResetPasswordVal('');
      await loadModerators();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تغيير كلمة مرور المشرف.' });
    } finally {
      setBusy(false);
    }
  };

  const handleToggleBlock = async (mod: StaffMember) => {
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/moderators/${mod.id}/block`, {
        method: 'PATCH',
        body: JSON.stringify({ isBlocked: !mod.isBlocked }),
      });
      setFeedback({
        type: 'ok',
        text: !mod.isBlocked
          ? `تم إيقاف المشرف «${mod.displayName}» وإنهاء جميع جلساته النشطة فورًا.`
          : `تمت إعادة تفعيل المشرف «${mod.displayName}».`,
      });
      await loadModerators();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تغيير حالة المشرف.' });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteModerator = async (mod: StaffMember) => {
    setBusy(true);
    setFeedback(null);
    try {
      await apiFetch(`/api/admin/moderators/${mod.id}`, { method: 'DELETE' });
      setConfirmDeleteId(null);
      setFeedback({
        type: 'ok',
        text: `تم سحب جميع الصلاحيات من «${mod.displayName}» نهائيًا.`,
      });
      await loadModerators();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر سحب صلاحيات المشرف.' });
    } finally {
      setBusy(false);
    }
  };

  const staff = data?.staff || [];
  const moderatorsOnly = staff.filter((s) => s.role !== 'owner');
  const activeModerators = moderatorsOnly.filter((s) => !s.isBlocked);
  const posture = data?.hostingPosture;

  const permLabelMap = new Map<string, string>(
    (data?.permissionCatalog || []).map((p) => [p.key, p.labelAr])
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="المشرفون والصلاحيات (RBAC)"
        subtitle="حصرية للمالك: تعيين المشرفين، تحديد صلاحيات دقيقة لكل قسم، ومراقبة جاهزية التشغيل الدائم 24/7."
        actions={
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={loading || busy}
              onClick={() => void loadModerators()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
              تحديث
            </button>
            <button
              type="button"
              onClick={() => setShowCreateForm((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-slate-800 transition-colors"
            >
              <UserPlus className="h-3.5 w-3.5 text-emerald-400" />
              إضافة مشرف جديد
            </button>
          </div>
        }
      />

      {feedback && (
        <FeedbackBanner
          type={feedback.type}
          text={feedback.text}
          onDismiss={() => setFeedback(null)}
        />
      )}

      {/* KPI Summary */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <KpiCard
          label="إجمالي الطاقم المصرح له"
          value={staff.length}
          tone="neutral"
          meta={<span>المالك + {moderatorsOnly.length} مشرفين</span>}
        />
        <KpiCard
          label="المشرفون النشطون"
          value={activeModerators.length}
          tone={activeModerators.length > 0 ? 'positive' : 'neutral'}
          valueTone={activeModerators.length > 0 ? 'positive' : 'default'}
          meta={<span>موقوفون: {moderatorsOnly.length - activeModerators.length}</span>}
        />
        <KpiCard
          label="وضع التشغيل المستمر 24/7"
          value={posture?.telegramBotRunning ? 'نشط 24/7' : 'جاهز'}
          tone={posture?.telegramBotRunning ? 'positive' : 'warning'}
          valueTone={posture?.telegramBotRunning ? 'positive' : 'warning'}
          meta={<span>{posture?.databaseEngine || 'PostgreSQL'} · محفوظ دائمًا</span>}
        />
      </div>

      {/* 24/7 Server & Security Posture Panel */}
      {posture && (
        <SurfacePanel className="overflow-hidden">
          <SectionHeader
            title="جاهزية الاستضافة الدائمة 24/7 وحماية الجلسات"
            subtitle="تستمر الصلاحيات والمحافظ وتشغيل البوت على الخادم بشكل مستقل عن المتصفح"
            icon={Server}
          />
          <div className="p-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4 text-xs">
            <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3.5 space-y-1.5">
              <div className="font-semibold text-slate-800">قاعدة البيانات الدائمة</div>
              <SemanticStatus tone="positive" label={`${posture.databaseEngine} متصل`} />
              <div className="text-[11px] text-slate-500">الأدوار والصلاحيات محفوظة بعد كل إعادة تشغيل</div>
            </div>

            <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3.5 space-y-1.5">
              <div className="font-semibold text-slate-800">خدمة بوت تيليجرام 24/7</div>
              <SemanticStatus
                tone={posture.telegramBotRunning ? 'positive' : 'warning'}
                label={posture.telegramBotRunning ? 'يعمل من الخادم' : 'بانتظار ضبط التوكن'}
              />
              <div className="text-[11px] text-slate-500">لا يعتمد على بقاء جهازك أو المتصفح مفتوحًا</div>
            </div>

            <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3.5 space-y-1.5">
              <div className="font-semibold text-slate-800">مفتاح توقيع الجلسات</div>
              <SemanticStatus
                tone={posture.persistentSessionSecretConfigured ? 'positive' : 'warning'}
                label={
                  posture.persistentSessionSecretConfigured
                    ? 'SESSION_SIGNING_SECRET مضبوط'
                    : 'عشوائي مؤقت لكل تشغيل'
                }
              />
              <div className="text-[11px] text-slate-500">
                {posture.persistentSessionSecretConfigured
                  ? 'تبقى جلسات الموظفين صالحة بعد النشر'
                  : 'يمكنك توليده من «الإعدادات ← خزينة الأسرار»'}
              </div>
            </div>

            <div className="rounded-xl border border-slate-200/80 bg-slate-50/70 p-3.5 space-y-1.5">
              <div className="font-semibold text-slate-800">بوابة Google للمالك</div>
              <SemanticStatus
                tone={posture.ownerEmailEnvConfigured ? 'positive' : 'neutral'}
                label={posture.ownerEmailEnvConfigured ? 'OWNER_EMAIL محدد' : 'الافتراضي مفعل'}
              />
              <div className="text-[11px] text-slate-500">حسابات Google غير المعينة تحصل على دور عميل فقط</div>
            </div>
          </div>
        </SurfacePanel>
      )}

      {/* Create New Moderator Form */}
      {showCreateForm && (
        <SurfacePanel className="overflow-hidden border-emerald-200">
          <SectionHeader
            title="إضافة مشرف جديد وتحديد صلاحياته"
            subtitle="يتم حفظ المشرف وصلاحياته في قاعدة البيانات فورًا مع كلمة مرور مشفرة بـ scrypt"
            icon={UserPlus}
            action={
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              >
                <X className="h-4 w-4" />
              </button>
            }
          />
          <form onSubmit={handleCreateModerator} className="p-5 space-y-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">اسم المشرف *</label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="مثال: أحمد — دعم العملاء"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">البريد الإلكتروني *</label>
                <input
                  type="email"
                  required
                  dir="ltr"
                  value={newEmail}
                  onChange={(e) => setNewEmail(e.target.value)}
                  placeholder="mod@example.com"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">الدور الأساسي</label>
                <select
                  value={newRole}
                  onChange={(e) => handleRolePresetChange(e.target.value as 'admin' | 'support', true)}
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                >
                  <option value="support">دعم ومراجعة (Support)</option>
                  <option value="admin">مشرف عام (Admin)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  كلمة مرور الدخول (8 أحرف على الأقل)
                </label>
                <input
                  type="password"
                  dir="ltr"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="اتركه فارغًا للدخول عبر Google فقط"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  معرف تيليجرام Telegram ID (اختياري)
                </label>
                <input
                  type="text"
                  dir="ltr"
                  value={newTelegramId}
                  onChange={(e) => setNewTelegramId(e.target.value)}
                  placeholder="123456789"
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono-num focus:border-emerald-600 focus:outline-none"
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="text-xs font-bold text-slate-700">الصلاحيات الممنوحة لهذا المشرف:</div>
              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {assignablePermissions.map((perm) => {
                  const checked = newPermissions.includes(perm.key);
                  return (
                    <label
                      key={perm.key}
                      className={`flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer transition-colors ${
                        checked
                          ? 'border-emerald-500 bg-emerald-50/50'
                          : 'border-slate-200 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePermission(perm.key, newPermissions, setNewPermissions)}
                        className="mt-0.5 h-4 w-4 accent-emerald-700"
                      />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-900">{perm.labelAr}</div>
                        <div className="text-[11px] text-slate-500 leading-snug mt-0.5">
                          {perm.descriptionAr}
                        </div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setShowCreateForm(false)}
                className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                إلغاء
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-xl bg-emerald-700 px-5 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                حفظ وإضافة المشرف
              </button>
            </div>
          </form>
        </SurfacePanel>
      )}

      {/* Staff List */}
      <SurfacePanel className="overflow-hidden">
        <SectionHeader
          title="قائمة المالك والمشرفين المصرح لهم"
          subtitle="أي مستخدم خارج هذه القائمة يُمنع تلقائيًا من الوصول إلى واجهات ومسارات الإدارة"
          icon={ShieldCheck}
        />
        <div className="divide-y divide-slate-100">
          {staff.map((member) => {
            const isOwner = member.role === 'owner';
            return (
              <div
                key={member.id}
                className="p-5 flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="space-y-2 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-sm text-slate-900">{member.displayName}</span>
                    {isOwner ? (
                      <SemanticStatus tone="positive" label="المالك (صلاحيات كاملة)" />
                    ) : (
                      <SemanticStatus
                        tone={member.isBlocked ? 'negative' : 'neutral'}
                        label={
                          member.isBlocked
                            ? 'موقوف مؤقتًا'
                            : member.role === 'admin'
                              ? 'مشرف عام (Admin)'
                              : 'دعم ومراجعة (Support)'
                        }
                      />
                    )}
                    {member.hasPassword && (
                      <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-600">
                        <Lock className="h-3 w-3 text-emerald-700" />
                        كلمة مرور مشفرة
                      </span>
                    )}
                    {member.telegramUserId && (
                      <span className="inline-flex items-center rounded-md bg-sky-50 px-2 py-0.5 text-[11px] font-mono-num text-sky-800">
                        TG: {member.telegramUserId}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
                    <span dir="ltr" className="font-mono-num">
                      {member.email || member.uid}
                    </span>
                    {member.lastLoginAt && (
                      <span>
                        آخر دخول: {new Date(member.lastLoginAt).toLocaleString('ar-EG')}
                      </span>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {isOwner ? (
                      <span className="rounded-lg bg-emerald-50 border border-emerald-200/80 px-2.5 py-1 text-[11px] font-semibold text-emerald-800">
                        جميع الصلاحيات الإدارية والأمنية + إدارة المشرفين
                      </span>
                    ) : (
                      member.permissions.map((perm) => (
                        <span
                          key={perm}
                          className="rounded-lg bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700"
                        >
                          {permLabelMap.get(perm) || perm}
                        </span>
                      ))
                    )}
                  </div>
                </div>

                {!isOwner && (
                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => openEditModal(member)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                      الصلاحيات
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setResetTarget(member);
                        setResetPasswordVal('');
                      }}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      كلمة المرور
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void handleToggleBlock(member)}
                      className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-xs font-semibold ${
                        member.isBlocked
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                          : 'border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100'
                      }`}
                    >
                      {member.isBlocked ? (
                        <>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          تفعيل
                        </>
                      ) : (
                        <>
                          <Ban className="h-3.5 w-3.5" />
                          إيقاف
                        </>
                      )}
                    </button>

                    {confirmDeleteId === member.id ? (
                      <div className="inline-flex items-center gap-1.5">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void handleDeleteModerator(member)}
                          className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-rose-700"
                        >
                          تأكيد السحب
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(null)}
                          className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-50"
                        >
                          تراجع
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDeleteId(member.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-rose-50 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-100"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        سحب الصلاحيات
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {!loading && staff.length === 0 && (
            <div className="p-8 text-center text-xs text-slate-400">لا توجد حسابات إدارية مسجلة.</div>
          )}
        </div>
      </SurfacePanel>

      {/* Edit Moderator Modal */}
      {editingMod && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white border border-slate-200 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  تعديل صلاحيات المشرف: {editingMod.displayName}
                </h3>
                <p className="text-xs text-slate-500 mt-0.5" dir="ltr">
                  {editingMod.email || editingMod.uid}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingMod(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleSaveEdit} className="p-5 space-y-5">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">الاسم</label>
                  <input
                    type="text"
                    required
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">الدور</label>
                  <select
                    value={editRole}
                    onChange={(e) => handleRolePresetChange(e.target.value as 'admin' | 'support', false)}
                    className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                  >
                    <option value="support">دعم ومراجعة (Support)</option>
                    <option value="admin">مشرف عام (Admin)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">معرف تيليجرام</label>
                  <input
                    type="text"
                    dir="ltr"
                    value={editTelegramId}
                    onChange={(e) => setEditTelegramId(e.target.value)}
                    className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-mono-num focus:border-emerald-600 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {assignablePermissions.map((perm) => {
                  const checked = editPermissions.includes(perm.key);
                  return (
                    <label
                      key={perm.key}
                      className={`flex items-start gap-2.5 rounded-xl border p-3 cursor-pointer ${
                        checked ? 'border-emerald-500 bg-emerald-50/50' : 'border-slate-200 hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => togglePermission(perm.key, editPermissions, setEditPermissions)}
                        className="mt-0.5 h-4 w-4 accent-emerald-700"
                      />
                      <div>
                        <div className="text-xs font-semibold text-slate-900">{perm.labelAr}</div>
                        <div className="text-[11px] text-slate-500">{perm.descriptionAr}</div>
                      </div>
                    </label>
                  );
                })}
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={() => setEditingMod(null)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-xl bg-slate-900 px-5 py-2 text-xs font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  حفظ الصلاحيات
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white border border-slate-200 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
              <h3 className="text-sm font-bold text-slate-900">
                تعيين كلمة مرور جديدة: {resetTarget.displayName}
              </h3>
              <button
                type="button"
                onClick={() => setResetTarget(null)}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleResetPassword} className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  كلمة المرور الجديدة (8 أحرف على الأقل)
                </label>
                <input
                  type="password"
                  required
                  minLength={8}
                  dir="ltr"
                  value={resetPasswordVal}
                  onChange={(e) => setResetPasswordVal(e.target.value)}
                  className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setResetTarget(null)}
                  className="rounded-xl border border-slate-200 px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-xl bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  حفظ وتحديث الجلسات
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
