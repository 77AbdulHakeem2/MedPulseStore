import React, { useEffect, useMemo, useState } from 'react';
import {
  LayoutGrid,
  Plus,
  ChevronLeft,
  Eye,
  EyeOff,
  Power,
  Trash2,
  ArrowUp,
  ArrowDown,
  Save,
  Languages,
  AlertTriangle,
  CheckCircle2,
  FolderTree,
  ExternalLink,
  BookOpen,
  ShoppingBag,
  Sparkles,
  RotateCcw,
  Edit3,
  Layers,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
  buildButtonBreadcrumb,
  buildInlinePreviewRows,
  buildSubMenuPreviewRows,
  collectDescendantButtonIds,
  computeSwappedButtonLayoutUpdates,
  computeSwappedSortOrderUpdates,
  sortButtonsByLayout,
  type AdminBotButtonItem,
  type SubMenuPreviewTile,
} from '../lib/buttonTreeUtils';
import {
  FeedbackBanner,
  KpiCard,
  ModalShell,
  PageHeader,
  SectionHeader,
  SegmentedTabs,
  SemanticStatus,
  SurfacePanel,
} from './ui/AdminPrimitives';

export interface AdminCategorySubItem {
  id: number;
  nameAr: string;
  nameEn: string;
  slug: string;
  iconEmoji: string;
  buttonStyle: string | null;
  sortOrder: number;
  isActive: boolean;
  showInStore: boolean;
}

export interface AdminGuideSubItem {
  id: number;
  slug: string;
  categoryId: number | null;
  titleAr: string;
  titleEn: string;
  iconEmoji: string;
  contentAr: string;
  contentEn: string;
  sortOrder: number;
  isVisible: boolean;
}

interface ButtonsManagerViewProps {
  buttons: AdminBotButtonItem[];
  categories: AdminCategorySubItem[];
  guides: AdminGuideSubItem[];
  products: Array<{ id: number; categoryId: number | null }>;
  onRefresh: () => Promise<void>;
}

interface PendingConfirmation {
  title: string;
  description: string;
  details?: string[];
  tone: 'confirm' | 'warning' | 'danger';
  confirmLabel?: string;
  execute: () => Promise<void>;
}

type ModalEditorState =
  | null
  | {
      kind: 'create_button';
      parentId: number | null;
      parentLabel?: string;
    }
  | {
      kind: 'create_category';
    }
  | {
      kind: 'edit_category';
      category: AdminCategorySubItem;
    }
  | {
      kind: 'create_guide';
    }
  | {
      kind: 'edit_guide';
      guide: AdminGuideSubItem;
    };

const ACTION_TYPE_OPTIONS: Array<{ value: string; label: string; hint: string }> = [
  { value: 'submenu', label: 'قائمة فرعية (تفتح أزرارًا فرعية)', hint: 'يعرض رسالة ترحيبية وأسفلها جميع الأزرار الفرعية التابعة له' },
  { value: 'custom_text', label: 'رسالة نصية / محتوى مخصص', hint: 'يعرض نصًا أو معلومات للعميل (ويمكن إضافة أزرار فرعية تحته أيضًا)' },
  { value: 'url', label: 'رابط مباشر (URL أو حساب تيليجرام)', hint: 'يفتح رابطًا خارجيًا أو محادثة تيليجرام مباشرة' },
  { value: 'category', label: 'فتح قسم منتجات محدد', hint: 'ينقل العميل مباشرة إلى منتجات أحد أقسام المتجر' },
  { value: 'guide', label: 'فتح شرح محدد', hint: 'يفتح أحد شروحات الاستخدام المسجلة في النظام' },
];

const STYLE_OPTIONS: Array<{ value: string; label: string; swatch: string }> = [
  { value: 'primary', label: 'أزرق أساسي', swatch: 'bg-sky-600 text-white' },
  { value: 'success', label: 'أخضر مميز', swatch: 'bg-emerald-600 text-white' },
  { value: 'danger', label: 'أحمر تنبيه', swatch: 'bg-rose-600 text-white' },
  { value: '', label: 'افتراضي محايد', swatch: 'bg-slate-700 text-white' },
];

function getStylePreviewClasses(style?: string | null, disabled?: boolean): string {
  if (disabled) return 'bg-slate-700/60 text-slate-400 border border-slate-600/50';
  if (style === 'success') return 'bg-emerald-600 hover:bg-emerald-500 text-white';
  if (style === 'danger') return 'bg-rose-600 hover:bg-rose-500 text-white';
  if (style === 'primary') return 'bg-sky-600 hover:bg-sky-500 text-white';
  return 'bg-slate-700 hover:bg-slate-600 text-white';
}

function getActionTypeLabel(actionType: string, actionValue?: string): string {
  if (actionType === 'builtin') {
    const map: Record<string, string> = {
      store: 'قسم المتجر الرئيسي (يضم أقسام المنتجات)',
      wallet: 'محفظة العميل والشحن',
      orders: 'طلبات العميل',
      refer: 'نظام الإحالة والعمولات',
      profile: 'الملف الشخصي',
      how_to_use: 'دليل الاستخدام والشروحات',
      support: 'رابط الدعم الفني المباشر',
      lang_toggle: 'تبديل اللغة (عربي / English)',
    };
    return map[actionValue || ''] || 'وظيفة أساسية للنظام';
  }
  const found = ACTION_TYPE_OPTIONS.find((o) => o.value === actionType);
  return found ? found.label : actionType;
}

export default function ButtonsManagerView({
  buttons,
  categories,
  guides,
  products,
  onRefresh,
}: ButtonsManagerViewProps) {
  const [previewLang, setPreviewLang] = useState<'ar' | 'en'>('ar');
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [focusedSubTileKey, setFocusedSubTileKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [translatingPreview, setTranslatingPreview] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  // Mandatory 2-choice Confirmation Modal before EVERY mutating action
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirmation | null>(null);

  // Add/Edit Modal for new buttons, store categories, and guides
  const [modalState, setModalState] = useState<ModalEditorState>(null);
  const [modalSingleName, setModalSingleName] = useState('');
  const [modalEmoji, setModalEmoji] = useState('');
  const [modalActionType, setModalActionType] = useState('custom_text');
  const [modalActionValue, setModalActionValue] = useState('');
  const [modalSingleContent, setModalSingleContent] = useState('');
  const [modalStyle, setModalStyle] = useState('primary');
  const [modalCols, setModalCols] = useState(2);

  // Active button single-input edit form state
  const [editLabel, setEditLabel] = useState('');
  const [editContent, setEditContent] = useState('');
  const [editActionType, setEditActionType] = useState('custom_text');
  const [editActionValue, setEditActionValue] = useState('');
  const [editStyle, setEditStyle] = useState('primary');
  const [editRowOrder, setEditRowOrder] = useState(1);
  const [editCols, setEditCols] = useState(2);
  const [liveTranslatedLabel, setLiveTranslatedLabel] = useState<{ textAr: string; textEn: string } | null>(null);
  const [liveTranslatedContent, setLiveTranslatedContent] = useState<{ textAr: string; textEn: string } | null>(null);

  const rootButtons = useMemo(
    () => sortButtonsByLayout(buttons.filter((b) => !b.parentId)),
    [buttons]
  );

  const selectedButton = useMemo(
    () => buttons.find((b) => b.id === selectedId) || rootButtons[0] || null,
    [buttons, selectedId, rootButtons]
  );

  useEffect(() => {
    if (!selectedId && rootButtons.length > 0) {
      setSelectedId(rootButtons[0].id);
    } else if (selectedId && !buttons.some((b) => b.id === selectedId) && rootButtons.length > 0) {
      setSelectedId(rootButtons[0].id);
    }
  }, [selectedId, buttons, rootButtons]);

  // Sync form fields whenever the selected button changes
  useEffect(() => {
    if (!selectedButton) return;
    setEditLabel(previewLang === 'en' ? selectedButton.labelEn || selectedButton.labelAr : selectedButton.labelAr || selectedButton.labelEn);
    setEditContent(previewLang === 'en' ? selectedButton.contentEn || selectedButton.contentAr : selectedButton.contentAr || selectedButton.contentEn);
    setEditActionType(selectedButton.actionType || 'custom_text');
    setEditActionValue(selectedButton.actionValue || '');
    setEditStyle(selectedButton.buttonStyle || '');
    setEditRowOrder(selectedButton.rowOrder || 1);
    setEditCols(selectedButton.buttonsPerRow || 2);
    setLiveTranslatedLabel(null);
    setLiveTranslatedContent(null);
  }, [selectedButton?.id, selectedButton?.labelAr, selectedButton?.labelEn, selectedButton?.contentAr, selectedButton?.contentEn, selectedButton?.rowOrder, selectedButton?.buttonsPerRow, selectedButton?.buttonStyle, selectedButton?.actionType, selectedButton?.actionValue, previewLang]);

  const childButtonsMap = useMemo(() => {
    const map = new Map<number, AdminBotButtonItem[]>();
    for (const b of buttons) {
      if (b.parentId) {
        const list = map.get(b.parentId) || [];
        list.push(b);
        map.set(b.parentId, list);
      }
    }
    for (const [k, list] of map.entries()) {
      map.set(k, sortButtonsByLayout(list));
    }
    return map;
  }, [buttons]);

  const productCountByCategory = useMemo(() => {
    const map = new Map<number, number>();
    for (const p of products) {
      if (p.categoryId) {
        map.set(p.categoryId, (map.get(p.categoryId) || 0) + 1);
      }
    }
    return map;
  }, [products]);

  const breadcrumb = useMemo(
    () => buildButtonBreadcrumb(buttons, selectedButton?.id || null),
    [buttons, selectedButton?.id]
  );

  const selectedCustomChildren = useMemo(
    () => (selectedButton ? childButtonsMap.get(selectedButton.id) || [] : []),
    [selectedButton, childButtonsMap]
  );

  const sortedCategories = useMemo(
    () => [...categories].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    [categories]
  );

  const sortedGuides = useMemo(
    () => [...guides].sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id),
    [guides]
  );

  const childCountsByButtonId = useMemo(() => {
    const map = new Map<number, number>();
    for (const [parentId, list] of childButtonsMap.entries()) {
      map.set(parentId, list.length);
    }
    return map;
  }, [childButtonsMap]);

  const isStoreButton = selectedButton?.actionType === 'builtin' && selectedButton?.actionValue === 'store';
  const isGuidesButton = selectedButton?.actionType === 'builtin' && selectedButton?.actionValue === 'how_to_use';

  const getSubButtonTotalCount = (btn: AdminBotButtonItem): number => {
    const customCount = (childButtonsMap.get(btn.id) || []).length;
    if (btn.actionType === 'builtin' && btn.actionValue === 'store') {
      return categories.length + customCount;
    }
    if (btn.actionType === 'builtin' && btn.actionValue === 'how_to_use') {
      return guides.length + customCount;
    }
    return customCount;
  };

  // Preview rows for the Telegram Main Menu Screen
  const previewRows = useMemo(() => buildInlinePreviewRows(rootButtons), [rootButtons]);

  // Live Preview rows for the Selected Button's Sub-Buttons Screen (1-to-1 with Telegram!)
  const subPreviewRows = useMemo(
    () =>
      buildSubMenuPreviewRows({
        isStoreButton,
        isGuidesButton,
        categories: sortedCategories,
        guides: sortedGuides,
        customChildren: selectedCustomChildren,
        lang: previewLang,
        childCountsByButtonId,
      }),
    [isStoreButton, isGuidesButton, sortedCategories, sortedGuides, selectedCustomChildren, previewLang, childCountsByButtonId]
  );

  const flatSubPreviewTiles = useMemo(() => subPreviewRows.flat(), [subPreviewRows]);

  const focusedSubTile: SubMenuPreviewTile | null = useMemo(() => {
    if (flatSubPreviewTiles.length === 0) return null;
    return flatSubPreviewTiles.find((t) => t.key === focusedSubTileKey) || flatSubPreviewTiles[0];
  }, [flatSubPreviewTiles, focusedSubTileKey]);

  useEffect(() => {
    setFocusedSubTileKey(null);
  }, [selectedButton?.id]);

  // Execute confirmed action safely
  const runConfirmedAction = async () => {
    if (!pendingConfirm) return;
    setBusy(true);
    setFeedback(null);
    try {
      await pendingConfirm.execute();
      setPendingConfirm(null);
      await onRefresh();
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر تنفيذ العملية.' });
      setPendingConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  // Live translation preview helper
  const handlePreviewTranslation = async () => {
    if (!editLabel.trim() && !editContent.trim()) return;
    setTranslatingPreview(true);
    try {
      if (editLabel.trim()) {
        const res = await apiFetch<{ textAr: string; textEn: string }>('/api/admin/translate', {
          method: 'POST',
          body: JSON.stringify({ text: editLabel.trim(), context: 'button_label' }),
        });
        setLiveTranslatedLabel({ textAr: res.textAr, textEn: res.textEn });
      }
      if (editContent.trim()) {
        const resC = await apiFetch<{ textAr: string; textEn: string }>('/api/admin/translate', {
          method: 'POST',
          body: JSON.stringify({ text: editContent.trim(), context: 'button_content' }),
        });
        setLiveTranslatedContent({ textAr: resC.textAr, textEn: resC.textEn });
      }
    } catch (err: any) {
      setFeedback({ type: 'err', text: err?.message || 'تعذر معاينة الترجمة التلقائية.' });
    } finally {
      setTranslatingPreview(false);
    }
  };

  // Request Confirmation for Saving Selected Button Edits
  const requestSaveButtonEdits = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedButton) return;
    if (!editLabel.trim()) {
      setFeedback({ type: 'err', text: 'يرجى إدخال اسم الزر.' });
      return;
    }

    const originalLabel = previewLang === 'en' ? selectedButton.labelEn : selectedButton.labelAr;
    const labelChanged = editLabel.trim() !== (originalLabel || '').trim();
    const originalContent = previewLang === 'en' ? selectedButton.contentEn : selectedButton.contentAr;
    const contentChanged = editContent.trim() !== (originalContent || '').trim();

    const details: string[] = [
      `الزر المستهدف: ${selectedButton.labelAr} (${selectedButton.labelEn})`,
    ];
    if (labelChanged) {
      details.push(`الاسم الجديد: «${editLabel.trim()}» — سيتم ترجمته تلقائيًا وحفظ النسختين العربية والإنجليزية.`);
    }
    if (contentChanged) {
      details.push(`سيتم تحديث محتوى الرسالة وترجمته تلقائيًا بين العربية والإنجليزية.`);
    }
    if (editRowOrder !== selectedButton.rowOrder || editCols !== selectedButton.buttonsPerRow) {
      details.push(`التخطيط: الصف ${editRowOrder} · عدد الأزرار في الصف: ${editCols}`);
    }

    setPendingConfirm({
      title: 'تأكيد حفظ تعديلات الزر',
      description: 'هل أنت متأكد من تطبيق هذه التعديلات؟ ستنعكس فورًا على واجهة بوت المشتري باللغتين العربية والإنجليزية.',
      details,
      tone: 'confirm',
      confirmLabel: 'تأكيد التنفيذ وحفظ التعديلات',
      execute: async () => {
        const body: Record<string, any> = {
          buttonStyle: editStyle || null,
          rowOrder: Math.max(1, Number(editRowOrder || 1)),
          buttonsPerRow: Math.max(1, Math.min(3, Number(editCols || 2))),
        };
        if (labelChanged) body.label = editLabel.trim();
        if (contentChanged) body.content = editContent.trim();
        if (selectedButton.actionType !== 'builtin') {
          body.actionType = editActionType;
          body.actionValue = editActionValue.trim();
        } else if (selectedButton.actionValue === 'support' && editActionValue.trim()) {
          body.actionValue = editActionValue.trim();
        }

        const res = await apiFetch<{ button: AdminBotButtonItem }>(`/api/admin/bot-buttons/${selectedButton.id}`, {
          method: 'PATCH',
          body: JSON.stringify(body),
        });
        setFeedback({
          type: 'ok',
          text: `تم حفظ التعديلات والترجمة التلقائية للزر «${res.button.labelAr} / ${res.button.labelEn}» بنجاح.`,
        });
      },
    });
  };

  // Request Confirmation for Toggling Visibility
  const requestToggleVisible = (btn: AdminBotButtonItem) => {
    const next = !btn.isVisible;
    setPendingConfirm({
      title: next ? 'تأكيد إظهار الزر' : 'تأكيد إخفاء الزر',
      description: next
        ? `سيتم إظهار الزر «${btn.labelAr}» فورًا للمستخدمين في بوت تيليجرام.`
        : `سيتم إخفاء الزر «${btn.labelAr}» عن المستخدمين في بوت تيليجرام دون حذفه.`,
      tone: 'warning',
      confirmLabel: next ? 'تأكيد الإظهار' : 'تأكيد الإخفاء',
      execute: async () => {
        await apiFetch(`/api/admin/bot-buttons/${btn.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ isVisible: next }),
        });
        setFeedback({
          type: 'ok',
          text: next ? `تم إظهار الزر «${btn.labelAr}» بنجاح.` : `تم إخفاء الزر «${btn.labelAr}» عن المشتري.`,
        });
      },
    });
  };

  // Request Confirmation for Toggling Enabled
  const requestToggleEnabled = (btn: AdminBotButtonItem) => {
    const next = !btn.isEnabled;
    setPendingConfirm({
      title: next ? 'تأكيد تفعيل الزر' : 'تأكيد تعطيل الزر مؤقتًا',
      description: next
        ? `سيتم تفعيل الزر «${btn.labelAr}» ليعمل بشكل طبيعي عند ضغط العملاء عليه.`
        : `سيبقى الزر «${btn.labelAr}» ظاهرًا لكنه سيعرض رسالة تنبيه بالتوقف المؤقت عند الضغط عليه.`,
      tone: 'warning',
      confirmLabel: next ? 'تأكيد التفعيل' : 'تأكيد التعطيل',
      execute: async () => {
        await apiFetch(`/api/admin/bot-buttons/${btn.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ isEnabled: next }),
        });
        setFeedback({
          type: 'ok',
          text: next ? `تم تفعيل الزر «${btn.labelAr}».` : `تم تعطيل الزر «${btn.labelAr}» مؤقتًا.`,
        });
      },
    });
  };

  // Request Confirmation for Moving Main Button or Nested Sub-Button Position (Clean Neighbor Swap)
  const requestMoveButton = (
    btn: AdminBotButtonItem,
    direction: 'up' | 'down',
    siblingsOverride?: AdminBotButtonItem[],
    visibleOnly = false
  ) => {
    const siblings =
      siblingsOverride ||
      (btn.parentId ? childButtonsMap.get(btn.parentId) || [] : rootButtons);
    const swapPlan = computeSwappedButtonLayoutUpdates(siblings, btn.id, direction, visibleOnly);
    if (!swapPlan) return;
    const neighbor = siblings.find((s) => s.id === swapPlan.swappedWithId);
    const btnLabel = previewLang === 'en' ? btn.labelEn || btn.labelAr : btn.labelAr || btn.labelEn;
    const neighborLabel = neighbor
      ? previewLang === 'en'
        ? neighbor.labelEn || neighbor.labelAr
        : neighbor.labelAr || neighbor.labelEn
      : '';

    setPendingConfirm({
      title: btn.parentId ? 'تأكيد تغيير موقع الزر الفرعي' : 'تأكيد تغيير موقع الزر الرئيسي',
      description: `سيتم نقل الزر «${btnLabel}» من الموقع #${swapPlan.fromPos} إلى الموقع #${swapPlan.toPos}${
        neighborLabel ? ` وتبديل مكانه مع «${neighborLabel}»` : ''
      }.`,
      details: [
        'سيظهر الترتيب الجديد فورًا في شاشة المعاينة المباشرة وفي بوت تيليجرام للعملاء.',
      ],
      tone: 'confirm',
      confirmLabel: 'تأكيد تغيير الترتيب',
      execute: async () => {
        await apiFetch('/api/admin/bot-buttons/reorder', {
          method: 'POST',
          body: JSON.stringify({ items: swapPlan.updates }),
        });
        setFeedback({
          type: 'ok',
          text: `تم نقل الزر «${btnLabel}» إلى الموقع #${swapPlan.toPos} بنجاح.`,
        });
      },
    });
  };

  // Request Confirmation for Moving Store Category Sub-Button Position
  const requestMoveCategory = (cat: AdminCategorySubItem, direction: 'up' | 'down', visibleOnly = false) => {
    const swapPlan = computeSwappedSortOrderUpdates(
      sortedCategories,
      cat.id,
      direction,
      visibleOnly ? (c) => c.isActive && c.showInStore : undefined
    );
    if (!swapPlan) return;
    const neighbor = sortedCategories.find((c) => c.id === swapPlan.swappedWithId);
    const catLabel = previewLang === 'en' ? cat.nameEn || cat.nameAr : cat.nameAr || cat.nameEn;
    const neighborLabel = neighbor
      ? previewLang === 'en'
        ? neighbor.nameEn || neighbor.nameAr
        : neighbor.nameAr || neighbor.nameEn
      : '';

    setPendingConfirm({
      title: 'تأكيد تغيير موقع زر القسم في المتجر',
      description: `سيتم نقل زر «${cat.iconEmoji || '✨'} ${catLabel}» من الموقع #${swapPlan.fromPos} إلى الموقع #${swapPlan.toPos}${
        neighborLabel ? ` وتبديل مكانه مع «${neighborLabel}»` : ''
      } داخل قائمة المتجر (🛍 Store).`,
      details: ['سيتم تحديث مواقع الأزرار الفرعية في شاشة المعاينة المباشرة وفي بوت تيليجرام فورًا.'],
      tone: 'confirm',
      confirmLabel: 'تأكيد تغيير الموقع',
      execute: async () => {
        await apiFetch('/api/admin/categories/reorder', {
          method: 'POST',
          body: JSON.stringify({ items: swapPlan.updates }),
        });
        setFocusedSubTileKey(`cat-${cat.id}`);
        setFeedback({
          type: 'ok',
          text: `تم نقل زر القسم «${catLabel}» إلى الموقع #${swapPlan.toPos} داخل المتجر.`,
        });
      },
    });
  };

  // Request Confirmation for Moving Service Guide Sub-Button Position
  const requestMoveGuide = (guide: AdminGuideSubItem, direction: 'up' | 'down', visibleOnly = false) => {
    const swapPlan = computeSwappedSortOrderUpdates(
      sortedGuides,
      guide.id,
      direction,
      visibleOnly ? (g) => g.isVisible : undefined
    );
    if (!swapPlan) return;
    const neighbor = sortedGuides.find((g) => g.id === swapPlan.swappedWithId);
    const guideLabel = previewLang === 'en' ? guide.titleEn || guide.titleAr : guide.titleAr || guide.titleEn;
    const neighborLabel = neighbor
      ? previewLang === 'en'
        ? neighbor.titleEn || neighbor.titleAr
        : neighbor.titleAr || neighbor.titleEn
      : '';

    setPendingConfirm({
      title: 'تأكيد تغيير موقع زر الشرح الفرعي',
      description: `سيتم نقل زر «${guide.iconEmoji || '📘'} ${guideLabel}» من الموقع #${swapPlan.fromPos} إلى الموقع #${swapPlan.toPos}${
        neighborLabel ? ` وتبديل مكانه مع «${neighborLabel}»` : ''
      } داخل قائمة طريقة الاستخدام.`,
      tone: 'confirm',
      confirmLabel: 'تأكيد تغيير الموقع',
      execute: async () => {
        await apiFetch('/api/admin/guides/reorder', {
          method: 'POST',
          body: JSON.stringify({ items: swapPlan.updates }),
        });
        setFocusedSubTileKey(`guide-${guide.id}`);
        setFeedback({
          type: 'ok',
          text: `تم نقل زر الشرح «${guideLabel}» إلى الموقع #${swapPlan.toPos}.`,
        });
      },
    });
  };

  // Request Confirmation for Deleting Button (and descendants)
  const requestDeleteButton = (btn: AdminBotButtonItem) => {
    const descendants = collectDescendantButtonIds(buttons, btn.id);
    const subCount = Math.max(0, descendants.length - 1);
    setPendingConfirm({
      title: 'تأكيد حذف الزر نهائيًا',
      description:
        subCount > 0
          ? `سيتم حذف الزر «${btn.labelAr}» ومعه (${subCount}) زر فرعي تابع له نهائيًا ولا يمكن التراجع عن هذا الإجراء.`
          : `سيتم حذف الزر «${btn.labelAr}» نهائيًا من قائمة البوت ولا يمكن التراجع عن هذا الإجراء.`,
      tone: 'danger',
      confirmLabel: 'تأكيد الحذف النهائي',
      execute: async () => {
        await apiFetch(`/api/admin/bot-buttons/${btn.id}`, { method: 'DELETE' });
        if (selectedId === btn.id) {
          setSelectedId(btn.parentId || rootButtons.find((r) => r.id !== btn.id)?.id || null);
        }
        setFeedback({ type: 'ok', text: `تم حذف الزر «${btn.labelAr}» بنجاح.` });
      },
    });
  };

  // Open Create/Edit Modal helpers
  const openCreateButtonModal = (parentId: number | null, parentLabel?: string) => {
    setModalSingleName('');
    setModalEmoji('');
    setModalActionType(parentId ? 'custom_text' : 'submenu');
    setModalActionValue('');
    setModalSingleContent('');
    setModalStyle('primary');
    setModalCols(2);
    setModalState({ kind: 'create_button', parentId, parentLabel });
  };

  const openCreateCategoryModal = () => {
    setModalSingleName('');
    setModalEmoji('✨');
    setModalStyle('primary');
    setModalState({ kind: 'create_category' });
  };

  const openEditCategoryModal = (cat: AdminCategorySubItem) => {
    setModalSingleName(previewLang === 'en' ? cat.nameEn || cat.nameAr : cat.nameAr || cat.nameEn);
    setModalEmoji(cat.iconEmoji || '✨');
    setModalStyle(cat.buttonStyle || 'primary');
    setModalState({ kind: 'edit_category', category: cat });
  };

  const openCreateGuideModal = () => {
    setModalSingleName('');
    setModalEmoji('📘');
    setModalSingleContent('');
    setModalState({ kind: 'create_guide' });
  };

  const openEditGuideModal = (guide: AdminGuideSubItem) => {
    setModalSingleName(previewLang === 'en' ? guide.titleEn || guide.titleAr : guide.titleAr || guide.titleEn);
    setModalEmoji(guide.iconEmoji || '📘');
    setModalSingleContent(previewLang === 'en' ? guide.contentEn || guide.contentAr : guide.contentAr || guide.contentEn);
    setModalState({ kind: 'edit_guide', guide });
  };

  // Submit Modal -> routes through Mandatory Confirmation Dialog!
  const handleModalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!modalState) return;
    if (!modalSingleName.trim()) {
      setFeedback({ type: 'err', text: 'يرجى إدخال الاسم أولاً.' });
      return;
    }

    if (modalState.kind === 'create_button') {
      const labelWithEmoji = modalEmoji.trim()
        ? modalSingleName.trim().startsWith(modalEmoji.trim())
          ? modalSingleName.trim()
          : `${modalEmoji.trim()} ${modalSingleName.trim()}`
        : modalSingleName.trim();
      const targetParentId = modalState.parentId;
      const targetParentLabel = modalState.parentLabel;
      const actionTypeSnap = modalActionType;
      const actionValueSnap = modalActionValue.trim();
      const contentSnap = modalSingleContent.trim();
      const styleSnap = modalStyle || null;
      const colsSnap = modalCols;

      setPendingConfirm({
        title: targetParentId ? 'تأكيد إضافة زر فرعي جديد' : 'تأكيد إضافة زر رئيسي جديد',
        description: targetParentId
          ? `سيتم إضافة الزر الفرعي «${labelWithEmoji}» داخل «${targetParentLabel}» مع ترجمته تلقائيًا للعربية والإنجليزية.`
          : `سيتم إضافة الزر الرئيسي «${labelWithEmoji}» إلى القائمة الرئيسية للبوت مع ترجمته تلقائيًا للعربية والإنجليزية.`,
        details: [
          `الوظيفة: ${getActionTypeLabel(actionTypeSnap)}`,
          contentSnap ? 'سيتم ترجمة محتوى الرسالة تلقائيًا وحفظ اللغتين.' : 'بدون محتوى نصي إضافي.',
        ],
        tone: 'confirm',
        confirmLabel: 'تأكيد الإضافة والترجمة التلقائية',
        execute: async () => {
          const res = await apiFetch<{ button: AdminBotButtonItem }>('/api/admin/bot-buttons', {
            method: 'POST',
            body: JSON.stringify({
              parentId: targetParentId,
              label: labelWithEmoji,
              content: contentSnap,
              actionType: actionTypeSnap,
              actionValue: actionValueSnap,
              buttonStyle: styleSnap,
              buttonsPerRow: colsSnap,
            }),
          });
          setModalState(null);
          if (!targetParentId) {
            setSelectedId(res.button.id);
          }
          setFeedback({
            type: 'ok',
            text: `تمت إضافة الزر «${res.button.labelAr} / ${res.button.labelEn}» وترجمته تلقائيًا بنجاح.`,
          });
        },
      });
      return;
    }

    if (modalState.kind === 'create_category') {
      const nameSnap = modalSingleName.trim();
      const emojiSnap = modalEmoji.trim() || '✨';
      const styleSnap = modalStyle || 'primary';
      setPendingConfirm({
        title: 'تأكيد إضافة قسم فرعي داخل المتجر',
        description: `سيتم إضافة زر القسم «${emojiSnap} ${nameSnap}» داخل قائمة المتجر (🛍 Store) مع ترجمته تلقائيًا للغتين.`,
        tone: 'confirm',
        confirmLabel: 'تأكيد الإضافة',
        execute: async () => {
          const res = await apiFetch<{ category: AdminCategorySubItem }>('/api/admin/categories', {
            method: 'POST',
            body: JSON.stringify({ name: nameSnap, iconEmoji: emojiSnap, buttonStyle: styleSnap }),
          });
          setModalState(null);
          setFeedback({
            type: 'ok',
            text: `تمت إضافة زر القسم «${res.category.nameAr} / ${res.category.nameEn}» داخل المتجر بنجاح.`,
          });
        },
      });
      return;
    }

    if (modalState.kind === 'edit_category') {
      const cat = modalState.category;
      const nameSnap = modalSingleName.trim();
      const emojiSnap = modalEmoji.trim();
      const styleSnap = modalStyle || 'primary';
      setPendingConfirm({
        title: 'تأكيد تعديل زر القسم داخل المتجر',
        description: `سيتم تحديث زر القسم «${cat.nameAr}» إلى «${emojiSnap} ${nameSnap}» مع ترجمته تلقائيًا وحفظ اللغتين.`,
        tone: 'confirm',
        confirmLabel: 'تأكيد التعديل',
        execute: async () => {
          const res = await apiFetch<{ category: AdminCategorySubItem }>(`/api/admin/categories/${cat.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: nameSnap, iconEmoji: emojiSnap, buttonStyle: styleSnap }),
          });
          setModalState(null);
          setFeedback({
            type: 'ok',
            text: `تم تحديث القسم «${res.category.nameAr} / ${res.category.nameEn}» بنجاح.`,
          });
        },
      });
      return;
    }

    if (modalState.kind === 'create_guide') {
      const titleSnap = modalSingleName.trim();
      const emojiSnap = modalEmoji.trim() || '📘';
      const contentSnap = modalSingleContent.trim();
      setPendingConfirm({
        title: 'تأكيد إضافة زر شرح فرعي جديد',
        description: `سيتم إضافة زر الشرح «${emojiSnap} ${titleSnap}» داخل «📖 طريقة الاستخدام» مع ترجمة العنوان والمحتوى تلقائيًا.`,
        tone: 'confirm',
        confirmLabel: 'تأكيد الإضافة',
        execute: async () => {
          const res = await apiFetch<{ guide: AdminGuideSubItem }>('/api/admin/guides', {
            method: 'POST',
            body: JSON.stringify({ title: titleSnap, iconEmoji: emojiSnap, content: contentSnap }),
          });
          setModalState(null);
          setFeedback({
            type: 'ok',
            text: `تمت إضافة الشرح «${res.guide.titleAr} / ${res.guide.titleEn}» بنجاح.`,
          });
        },
      });
      return;
    }

    if (modalState.kind === 'edit_guide') {
      const g = modalState.guide;
      const titleSnap = modalSingleName.trim();
      const emojiSnap = modalEmoji.trim();
      const contentSnap = modalSingleContent.trim();
      setPendingConfirm({
        title: 'تأكيد تعديل الشرح الفرعي',
        description: `سيتم تحديث الشرح «${g.titleAr}» وترجمة العنوان والمحتوى تلقائيًا للغتين العربية والإنجليزية.`,
        tone: 'confirm',
        confirmLabel: 'تأكيد الحفظ',
        execute: async () => {
          const res = await apiFetch<{ guide: AdminGuideSubItem }>(`/api/admin/guides/${g.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ title: titleSnap, iconEmoji: emojiSnap, content: contentSnap }),
          });
          setModalState(null);
          setFeedback({
            type: 'ok',
            text: `تم تحديث الشرح «${res.guide.titleAr} / ${res.guide.titleEn}» بنجاح.`,
          });
        },
      });
    }
  };

  // Store Category Quick Visibility Toggle / Delete (both guarded by Confirmation Modal)
  const requestToggleCategoryVisible = (cat: AdminCategorySubItem) => {
    const nextVisible = !(cat.isActive && cat.showInStore);
    setPendingConfirm({
      title: nextVisible ? 'تأكيد إظهار القسم في المتجر' : 'تأكيد إخفاء القسم من المتجر',
      description: nextVisible
        ? `سيظهر زر القسم «${cat.nameAr}» للمشترين عند الضغط على 🛍 Store.`
        : `سيتم إخفاء زر القسم «${cat.nameAr}» من شاشة المتجر دون حذف منتجاته.`,
      tone: 'warning',
      confirmLabel: nextVisible ? 'تأكيد الإظهار' : 'تأكيد الإخفاء',
      execute: async () => {
        await apiFetch(`/api/admin/categories/${cat.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ isActive: nextVisible, showInStore: nextVisible }),
        });
        setFeedback({ type: 'ok', text: `تم تحديث حالة ظهور القسم «${cat.nameAr}».` });
      },
    });
  };

  const requestDeleteCategory = (cat: AdminCategorySubItem) => {
    setPendingConfirm({
      title: 'تأكيد حذف زر القسم من المتجر',
      description: `سيتم حذف القسم «${cat.nameAr}» نهائيًا من قائمة المتجر (ستبقى المنتجات محفوظة دون تصنيف ويمكن نقلها لاحقًا).`,
      tone: 'danger',
      confirmLabel: 'تأكيد الحذف',
      execute: async () => {
        await apiFetch(`/api/admin/categories/${cat.id}`, { method: 'DELETE' });
        setFeedback({ type: 'ok', text: `تم حذف القسم «${cat.nameAr}» بنجاح.` });
      },
    });
  };

  const requestToggleGuideVisible = (g: AdminGuideSubItem) => {
    const next = !g.isVisible;
    setPendingConfirm({
      title: next ? 'تأكيد إظهار الشرح' : 'تأكيد إخفاء الشرح',
      description: next
        ? `سيظهر زر الشرح «${g.titleAr}» داخل قائمة طريقة الاستخدام.`
        : `سيتم إخفاء زر الشرح «${g.titleAr}» عن المشترين مؤقتًا.`,
      tone: 'warning',
      confirmLabel: next ? 'تأكيد الإظهار' : 'تأكيد الإخفاء',
      execute: async () => {
        await apiFetch(`/api/admin/guides/${g.id}`, {
          method: 'PATCH',
          body: JSON.stringify({ isVisible: next }),
        });
        setFeedback({ type: 'ok', text: `تم تحديث ظهور الشرح «${g.titleAr}».` });
      },
    });
  };

  const requestDeleteGuide = (g: AdminGuideSubItem) => {
    setPendingConfirm({
      title: 'تأكيد حذف الشرح الفرعي',
      description: `سيتم حذف الشرح «${g.titleAr}» نهائيًا من قائمة طريقة الاستخدام.`,
      tone: 'danger',
      confirmLabel: 'تأكيد الحذف',
      execute: async () => {
        await apiFetch(`/api/admin/guides/${g.id}`, { method: 'DELETE' });
        setFeedback({ type: 'ok', text: `تم حذف الشرح «${g.titleAr}» بنجاح.` });
      },
    });
  };

  const visibleRootCount = useMemo(
    () => rootButtons.filter((b) => b.isVisible && b.isEnabled).length,
    [rootButtons]
  );
  const hiddenOrDisabledCount = useMemo(
    () => buttons.filter((b) => !b.isVisible || !b.isEnabled).length,
    [buttons]
  );
  const totalSubItemsCount = useMemo(
    () => buttons.filter((b) => b.parentId).length + categories.length + guides.length,
    [buttons, categories.length, guides.length]
  );

  return (
    <div className="space-y-6">
      {/* Unified Executive PageHeader */}
      <PageHeader
        title="إدارة أزرار البوت والقوائم الفرعية"
        subtitle="تنظيم وترتيب الأزرار الرئيسية والفرعية مع معاينة فورية وترجمة تلقائية وتأكيد قبل التنفيذ"
        actions={
          <div className="flex flex-wrap items-center gap-2.5">
            <SegmentedTabs
              value={previewLang}
              onChange={setPreviewLang}
              items={[
                { id: 'ar', label: 'معاينة: العربية' },
                { id: 'en', label: 'Preview: English' },
              ]}
            />
            <button
              type="button"
              onClick={() => openCreateButtonModal(null)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-slate-900 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-700 transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="h-4 w-4" />
              إضافة زر رئيسي
            </button>
          </div>
        }
      />

      {/* Executive KPI Summary Strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          icon={LayoutGrid}
          label="الأزرار الرئيسية"
          value={rootButtons.length}
          tone={rootButtons.length > 0 ? 'positive' : 'neutral'}
          indicatorText={`${previewRows.length} صفوف`}
        />
        <KpiCard
          icon={Eye}
          label="ظاهر ومفعّل للمشتري"
          value={visibleRootCount}
          valueTone="positive"
          tone={visibleRootCount > 0 ? 'positive' : 'warning'}
          indicatorText={`من ${rootButtons.length}`}
        />
        <KpiCard
          icon={Layers}
          label="الأزرار الفرعية والأقسام"
          value={totalSubItemsCount}
          tone="neutral"
          indicatorText={`${categories.length} أقسام · ${guides.length} شروحات`}
        />
        <KpiCard
          icon={EyeOff}
          label="مخفي أو معطّل"
          value={hiddenOrDisabledCount}
          valueTone={hiddenOrDisabledCount > 0 ? 'warning' : 'positive'}
          tone={hiddenOrDisabledCount > 0 ? 'warning' : 'positive'}
          indicatorText={hiddenOrDisabledCount > 0 ? 'قيد الإخفاء' : 'الكل نشط'}
        />
      </div>

      {/* Unified Feedback Banner */}
      {feedback && (
        <FeedbackBanner
          type={feedback.type}
          text={feedback.text}
          onDismiss={() => setFeedback(null)}
        />
      )}

      {/* Main Master-Detail Studio Grid */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 items-start">
        {/* MASTER COLUMN: Live Telegram Preview + Main Buttons Directory */}
        <div className="lg:col-span-5 space-y-5">
          {/* Card 1: Interactive Live Telegram Main Keyboard Preview */}
          <div className="rounded-2xl border border-slate-800 bg-[#0f172a] p-4.5 text-white shadow-[0_1px_3px_rgba(15,23,42,0.12)] space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 text-xs font-bold text-slate-100">
                <LayoutGrid className="h-4 w-4 text-emerald-400 shrink-0" />
                <span>المعاينة الحية للقائمة الرئيسية ({previewLang === 'ar' ? 'عربي' : 'EN'})</span>
              </div>
              <span className="text-[11px] text-slate-400 whitespace-nowrap">اضغط لتحديد زر</span>
            </div>

            <div className="rounded-xl bg-slate-800/90 p-2.5 space-y-1.5" dir={previewLang === 'en' ? 'ltr' : 'rtl'}>
              {previewRows.map((row, idx) => (
                <div
                  key={`prev-row-${idx}`}
                  className="grid gap-1.5"
                  style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
                >
                  {row.map((btn) => {
                    const isSelected = selectedButton?.id === btn.id || breadcrumb[0]?.id === btn.id;
                    const label = previewLang === 'en' ? btn.labelEn || btn.labelAr : btn.labelAr || btn.labelEn;
                    const subCount = getSubButtonTotalCount(btn);
                    return (
                      <button
                        key={btn.id}
                        type="button"
                        onClick={() => setSelectedId(btn.id)}
                        className={`relative rounded-lg px-2.5 py-2 text-xs font-bold transition-all truncate ${getStylePreviewClasses(
                          btn.buttonStyle,
                          !btn.isEnabled
                        )} ${isSelected ? 'ring-2 ring-amber-300 ring-offset-1 ring-offset-slate-900' : ''}`}
                      >
                        <span>{label}</span>
                        {subCount > 0 && (
                          <span className="ms-1.5 inline-block rounded bg-black/25 px-1.5 py-0.5 text-[10px] font-mono-num">
                            {subCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
              {previewRows.length === 0 && (
                <div className="py-5 text-center text-xs text-slate-400">
                  لا توجد أزرار ظاهرة حاليًا في القائمة الرئيسية.
                </div>
              )}
            </div>
          </div>

          {/* Card 2: Structured Main Buttons Directory */}
          <SurfacePanel className="overflow-hidden">
            <SectionHeader
              title={`الأزرار الرئيسية (${rootButtons.length})`}
              subtitle="اختر زرًا لإدارة أزراره الفرعية أو رتّب مواقعه مباشرة"
              icon={LayoutGrid}
            />

            <div className="divide-y divide-slate-100">
              {rootButtons.map((btn, btnIndex) => {
                const isSelected = selectedButton?.id === btn.id || breadcrumb[0]?.id === btn.id;
                const subCount = getSubButtonTotalCount(btn);
                const primaryText = previewLang === 'en' ? btn.labelEn || btn.labelAr : btn.labelAr || btn.labelEn;
                const secondaryText = previewLang === 'en' ? btn.labelAr : btn.labelEn;

                return (
                  <div
                    key={btn.id}
                    className={`flex items-center justify-between gap-2 px-4 py-3 transition-colors ${
                      isSelected
                        ? 'bg-emerald-50/70 ring-1 ring-inset ring-emerald-500/20'
                        : 'hover:bg-slate-50/80'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedId(btn.id)}
                      className="flex-1 text-start min-w-0"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-mono-num text-[11px] font-bold text-slate-400 shrink-0">
                          #{btnIndex + 1}
                        </span>
                        <span className="font-semibold text-sm text-slate-900 truncate">{primaryText}</span>
                        {!btn.isVisible && <SemanticStatus tone="neutral" label="مخفي" />}
                        {!btn.isEnabled && <SemanticStatus tone="warning" label="معطل" />}
                      </div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                        <span className="truncate max-w-[160px]">{secondaryText}</span>
                        <span className="text-slate-300">·</span>
                        <span className="font-mono-num">صف {btn.rowOrder}</span>
                        {subCount > 0 && (
                          <>
                            <span className="text-slate-300">·</span>
                            <span className="inline-flex items-center gap-1 font-semibold text-emerald-700">
                              <FolderTree className="h-3 w-3" />
                              {subCount} فرعي
                            </span>
                          </>
                        )}
                      </div>
                    </button>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        disabled={busy || btnIndex === 0}
                        title="تقديم الموقع (لأعلى)"
                        aria-label={`تقديم الزر الرئيسي ${primaryText}`}
                        onClick={() => requestMoveButton(btn, 'up', rootButtons)}
                        className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-35 transition-colors"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={busy || btnIndex === rootButtons.length - 1}
                        title="تأخير الموقع (لأسفل)"
                        aria-label={`تأخير الزر الرئيسي ${primaryText}`}
                        onClick={() => requestMoveButton(btn, 'down', rootButtons)}
                        className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-35 transition-colors"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setSelectedId(btn.id)}
                        title="فتح الإعدادات والأزرار الفرعية"
                        aria-label={`فتح إعدادات ${primaryText}`}
                        className={`rounded-lg p-1.5 transition-colors ${
                          isSelected ? 'bg-slate-900 text-white' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700'
                        }`}
                      >
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </SurfacePanel>
        </div>

        {/* DETAIL WORKSPACE: Breadcrumb + Sub-Buttons Manager + Single-Input Button Settings */}
        <div className="lg:col-span-7 space-y-5">
          {selectedButton ? (
            <>
              {/* Breadcrumb Hierarchy Navigation Bar */}
              <SurfacePanel className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold">
                  <button
                    type="button"
                    onClick={() => {
                      if (rootButtons[0]) setSelectedId(rootButtons[0].id);
                    }}
                    className="text-slate-500 hover:text-slate-900 transition-colors"
                  >
                    القائمة الرئيسية
                  </button>
                  {breadcrumb.map((node, index) => {
                    const isLast = index === breadcrumb.length - 1;
                    const label = previewLang === 'en' ? node.labelEn || node.labelAr : node.labelAr || node.labelEn;
                    return (
                      <React.Fragment key={node.id}>
                        <ChevronLeft className="h-3.5 w-3.5 text-slate-400" />
                        <button
                          type="button"
                          onClick={() => setSelectedId(node.id)}
                          className={`rounded-lg px-2.5 py-1 transition-colors ${
                            isLast
                              ? 'bg-slate-900 text-white font-semibold'
                              : 'text-emerald-700 hover:bg-emerald-50'
                          }`}
                        >
                          {label}
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>

                <span className="text-[11px] font-semibold text-slate-500">
                  {selectedButton.parentId ? 'مستوى فرعي' : 'مستوى رئيسي'}
                </span>
              </SurfacePanel>

              {/* ================================================================= */}
              {/* SECTION A: SUB-BUTTONS MANAGER (Always front-and-center!)         */}
              {/* ================================================================= */}
              <SurfacePanel className="overflow-hidden">
                <div className="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700">
                      <Layers className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0">
                      <h2 className="text-sm font-bold text-slate-900 truncate">
                        الأزرار الفرعية داخل «
                        {previewLang === 'en' ? selectedButton.labelEn : selectedButton.labelAr}»
                      </h2>
                      <p className="text-[11px] text-slate-500 truncate mt-0.5">
                        {isStoreButton
                          ? 'رتّب وعدّل أقسام المتجر والأزرار الفرعية الإضافية مباشرة'
                          : isGuidesButton
                            ? 'رتّب وعدّل الشروحات التعليمية والأزرار الفرعية التابعة لها'
                            : 'أضف ورتّب الأزرار الفرعية التي تظهر عند فتح هذا الزر'}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 shrink-0">
                    {isStoreButton && (
                      <button
                        type="button"
                        onClick={openCreateCategoryModal}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-800 whitespace-nowrap"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        إضافة قسم للمتجر
                      </button>
                    )}
                    {isGuidesButton && (
                      <button
                        type="button"
                        onClick={openCreateGuideModal}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-800 whitespace-nowrap"
                      >
                        <Plus className="h-3.5 w-3.5" />
                        إضافة شرح فرعي
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        openCreateButtonModal(
                          selectedButton.id,
                          previewLang === 'en' ? selectedButton.labelEn : selectedButton.labelAr
                        )
                      }
                      className={`inline-flex items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-bold whitespace-nowrap ${
                        isStoreButton || isGuidesButton
                          ? 'border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                          : 'bg-emerald-700 text-white hover:bg-emerald-800'
                      }`}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      إضافة زر فرعي
                    </button>
                  </div>
                </div>

                <div className="p-4 space-y-5">
                  {/* =============================================================== */}
                  {/* LIVE SUB-BUTTONS POSITION SCREEN (Exact Telegram Layout Preview) */}
                  {/* =============================================================== */}
                  <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-white shadow-xs space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-xs font-bold text-slate-100">
                        <LayoutGrid className="h-4 w-4 text-emerald-400" />
                        <span>
                          المعاينة المباشرة لمواقع الأزرار الفرعية داخل «
                          {previewLang === 'en' ? selectedButton.labelEn : selectedButton.labelAr}» (
                          {previewLang === 'ar' ? 'عربي' : 'EN'})
                        </span>
                      </div>
                      <span className="text-[11px] text-slate-400">
                        اضغط على أي زر فرعي لتحريك موقعه فورًا
                      </span>
                    </div>

                    <div
                      className="rounded-lg bg-slate-800/90 p-2.5 space-y-1.5"
                      dir={previewLang === 'en' ? 'ltr' : 'rtl'}
                    >
                      {subPreviewRows.length > 0 ? (
                        <>
                          {subPreviewRows.map((row, rowIdx) => (
                            <div
                              key={`sub-prev-row-${rowIdx}`}
                              className="grid gap-1.5"
                              style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
                            >
                              {row.map((tile) => {
                                const isFocused = focusedSubTile?.key === tile.key;
                                return (
                                  <button
                                    key={tile.key}
                                    type="button"
                                    onClick={() => setFocusedSubTileKey(tile.key)}
                                    className={`relative flex items-center justify-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-bold transition-all truncate ${getStylePreviewClasses(
                                      tile.buttonStyle,
                                      !tile.isEnabled
                                    )} ${
                                      isFocused
                                        ? 'ring-2 ring-amber-300 ring-offset-1 ring-offset-slate-900'
                                        : ''
                                    }`}
                                  >
                                    <span className="rounded bg-black/25 px-1.5 py-0.5 text-[10px] font-mono-num shrink-0">
                                      #{tile.orderIndex + 1}
                                    </span>
                                    <span className="truncate">{tile.label}</span>
                                    {tile.subCount > 0 && (
                                      <span className="rounded bg-black/25 px-1.5 py-0.5 text-[10px] font-mono-num shrink-0">
                                        +{tile.subCount}
                                      </span>
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          ))}
                          {/* Telegram bottom navigation footer preview */}
                          <div className="grid grid-cols-2 gap-1.5 pt-1 border-t border-slate-700/70">
                            <div className="rounded-lg bg-slate-700/60 px-2 py-1.5 text-center text-[11px] font-semibold text-slate-300">
                              {previewLang === 'en' ? '🔙 Back' : '🔙 رجوع'}
                            </div>
                            <div className="rounded-lg bg-slate-700/60 px-2 py-1.5 text-center text-[11px] font-semibold text-slate-300">
                              {previewLang === 'en' ? '🏠 Main Menu' : '🏠 القائمة الرئيسية'}
                            </div>
                          </div>
                        </>
                      ) : (
                        <div className="py-5 text-center text-xs text-slate-400">
                          لا توجد أزرار فرعية ظاهرة بعد داخل «
                          {previewLang === 'en' ? selectedButton.labelEn : selectedButton.labelAr}». أضف زرًا فرعيًا لعرض موقعه مباشرة هنا.
                        </div>
                      )}
                    </div>

                    {/* Direct Live-Position Controls Bar for the Focused Sub-Button */}
                    {focusedSubTile && (() => {
                      const targetCat =
                        focusedSubTile.kind === 'category'
                          ? sortedCategories.find((c) => c.id === focusedSubTile.entityId)
                          : undefined;
                      const targetGuide =
                        focusedSubTile.kind === 'guide'
                          ? sortedGuides.find((g) => g.id === focusedSubTile.entityId)
                          : undefined;
                      const targetCustom =
                        focusedSubTile.kind === 'custom_button'
                          ? selectedCustomChildren.find((b) => b.id === focusedSubTile.entityId)
                          : undefined;

                      const canMoveUp = focusedSubTile.orderIndex > 0;
                      const canMoveDown = focusedSubTile.orderIndex < focusedSubTile.groupSize - 1;

                      const handleFocusedMove = (dir: 'up' | 'down') => {
                        if (targetCat) requestMoveCategory(targetCat, dir, true);
                        else if (targetGuide) requestMoveGuide(targetGuide, dir, true);
                        else if (targetCustom) requestMoveButton(targetCustom, dir, selectedCustomChildren, true);
                      };

                      return (
                        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700/90 bg-slate-800/75 px-3 py-2 text-xs">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-bold font-mono-num text-amber-300">
                              الموقع #{focusedSubTile.orderIndex + 1} / {focusedSubTile.groupSize}
                            </span>
                            <span className="font-bold text-white truncate">{focusedSubTile.label}</span>
                          </div>

                          <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              disabled={busy || !canMoveUp}
                              onClick={() => handleFocusedMove('up')}
                              className="inline-flex items-center gap-1 rounded-md bg-slate-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-slate-600 disabled:opacity-35"
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                              تقديم
                            </button>
                            <button
                              type="button"
                              disabled={busy || !canMoveDown}
                              onClick={() => handleFocusedMove('down')}
                              className="inline-flex items-center gap-1 rounded-md bg-slate-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-slate-600 disabled:opacity-35"
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                              تأخير
                            </button>
                            {targetCat && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => openEditCategoryModal(targetCat)}
                                className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-600"
                              >
                                <Edit3 className="h-3 w-3" />
                                تعديل
                              </button>
                            )}
                            {targetGuide && (
                              <button
                                type="button"
                                disabled={busy}
                                onClick={() => openEditGuideModal(targetGuide)}
                                className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-600"
                              >
                                <Edit3 className="h-3 w-3" />
                                تعديل
                              </button>
                            )}
                            {targetCustom && (
                              <button
                                type="button"
                                onClick={() => setSelectedId(targetCustom.id)}
                                className="inline-flex items-center gap-1 rounded-md bg-emerald-700 px-2.5 py-1 text-[11px] font-bold text-white hover:bg-emerald-600"
                              >
                                إدارة وتعديل
                                <ChevronLeft className="h-3 w-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })()}
                  </div>

                  {/* A1. Store Category Sub-Buttons (when 🛍 Store is selected) */}
                  {isStoreButton && (
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                        <span className="inline-flex items-center gap-1.5">
                          <ShoppingBag className="h-3.5 w-3.5 text-emerald-700" />
                          أزرار أقسام المتجر ({sortedCategories.length})
                        </span>
                        <span className="text-[11px] font-normal text-slate-500">
                          استخدم أسهم ▲ و ▼ لترتيب مواقع الأقسام بنفس أسلوب الأزرار الرئيسية
                        </span>
                      </div>

                      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 overflow-hidden">
                        {sortedCategories.map((cat, catIdx) => {
                          const visible = cat.isActive && cat.showInStore;
                          const prodCount = productCountByCategory.get(cat.id) || 0;
                          const isFocused = focusedSubTile?.key === `cat-${cat.id}`;
                          const catPrimary = previewLang === 'en' ? cat.nameEn || cat.nameAr : cat.nameAr || cat.nameEn;
                          return (
                            <div
                              key={cat.id}
                              onClick={() => setFocusedSubTileKey(`cat-${cat.id}`)}
                              className={`flex flex-wrap items-center justify-between gap-2 px-4 py-3 transition-colors cursor-pointer ${
                                isFocused
                                  ? 'bg-emerald-50/70 ring-1 ring-inset ring-emerald-500/20'
                                  : visible
                                    ? 'bg-white hover:bg-slate-50/80'
                                    : 'bg-slate-50/90 opacity-75'
                              }`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono-num text-[11px] font-bold text-slate-400">
                                    #{catIdx + 1}
                                  </span>
                                  <span className="text-sm">{cat.iconEmoji || '✨'}</span>
                                  <span className="font-semibold text-xs text-slate-900 truncate">
                                    {catPrimary}
                                  </span>
                                  {!visible && <SemanticStatus tone="neutral" label="مخفي" />}
                                </div>
                                <div className="mt-0.5 text-[11px] text-slate-500 truncate">
                                  {previewLang === 'en' ? cat.nameAr : cat.nameEn} · {prodCount} منتج · الصف{' '}
                                  {Math.floor(catIdx / 2) + 1}
                                </div>
                              </div>

                              <div
                                className="flex items-center gap-1 shrink-0"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  disabled={busy || catIdx === 0}
                                  title="تقديم موقع القسم (لأعلى)"
                                  aria-label={`تقديم قسم ${catPrimary}`}
                                  onClick={() => requestMoveCategory(cat, 'up')}
                                  className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-35"
                                >
                                  <ArrowUp className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={busy || catIdx === sortedCategories.length - 1}
                                  title="تأخير موقع القسم (لأسفل)"
                                  aria-label={`تأخير قسم ${catPrimary}`}
                                  onClick={() => requestMoveCategory(cat, 'down')}
                                  className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-35"
                                >
                                  <ArrowDown className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  title="تعديل الاسم والمظهر (مع ترجمة تلقائية)"
                                  aria-label={`تعديل قسم ${catPrimary}`}
                                  onClick={() => openEditCategoryModal(cat)}
                                  className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
                                >
                                  <Edit3 className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  title={visible ? 'إخفاء من المتجر' : 'إظهار في المتجر'}
                                  aria-label={`${visible ? 'إخفاء' : 'إظهار'} قسم ${catPrimary}`}
                                  onClick={() => requestToggleCategoryVisible(cat)}
                                  className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-amber-50 hover:text-amber-700"
                                >
                                  {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  title="حذف القسم"
                                  aria-label={`حذف قسم ${catPrimary}`}
                                  onClick={() => requestDeleteCategory(cat)}
                                  className="rounded-lg border border-rose-200 bg-white p-1.5 text-rose-600 hover:bg-rose-50"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* A2. Service Guide Sub-Buttons (when 📖 How to Use is selected) */}
                  {isGuidesButton && (
                    <div className="space-y-2.5">
                      <div className="flex items-center justify-between text-xs font-bold text-slate-700">
                        <span className="inline-flex items-center gap-1.5">
                          <BookOpen className="h-3.5 w-3.5 text-emerald-700" />
                          أزرار الشروحات الفرعية ({sortedGuides.length})
                        </span>
                        <span className="text-[11px] font-normal text-slate-500">
                          استخدم أسهم ▲ و ▼ لترتيب مواقع الشروحات
                        </span>
                      </div>

                      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 overflow-hidden">
                        {sortedGuides.map((g, gIdx) => {
                          const isFocused = focusedSubTile?.key === `guide-${g.id}`;
                          const guidePrimary = previewLang === 'en' ? g.titleEn || g.titleAr : g.titleAr || g.titleEn;
                          return (
                            <div
                              key={g.id}
                              onClick={() => setFocusedSubTileKey(`guide-${g.id}`)}
                              className={`flex flex-wrap items-center justify-between gap-2 px-4 py-3 transition-colors cursor-pointer ${
                                isFocused
                                  ? 'bg-emerald-50/70 ring-1 ring-inset ring-emerald-500/20'
                                  : g.isVisible
                                    ? 'bg-white hover:bg-slate-50/80'
                                    : 'bg-slate-50/90 opacity-75'
                              }`}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono-num text-[11px] font-bold text-slate-400">
                                    #{gIdx + 1}
                                  </span>
                                  <span className="text-sm">{g.iconEmoji || '📘'}</span>
                                  <span className="font-semibold text-xs text-slate-900 truncate">
                                    {guidePrimary}
                                  </span>
                                  {!g.isVisible && <SemanticStatus tone="neutral" label="مخفي" />}
                                </div>
                                <div className="mt-0.5 text-[11px] text-slate-500 truncate">
                                  {previewLang === 'en' ? g.titleAr : g.titleEn} · الصف {Math.floor(gIdx / 2) + 1}
                                </div>
                              </div>
                              <div
                                className="flex items-center gap-1 shrink-0"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  disabled={busy || gIdx === 0}
                                  title="تقديم موقع الشرح (لأعلى)"
                                  aria-label={`تقديم شرح ${guidePrimary}`}
                                  onClick={() => requestMoveGuide(g, 'up')}
                                  className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-35"
                                >
                                  <ArrowUp className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={busy || gIdx === sortedGuides.length - 1}
                                  title="تأخير موقع الشرح (لأسفل)"
                                  aria-label={`تأخير شرح ${guidePrimary}`}
                                  onClick={() => requestMoveGuide(g, 'down')}
                                  className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-35"
                                >
                                  <ArrowDown className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  title="تعديل الشرح (ترجمة تلقائية)"
                                  aria-label={`تعديل شرح ${guidePrimary}`}
                                  onClick={() => openEditGuideModal(g)}
                                  className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-emerald-50 hover:text-emerald-700"
                                >
                                  <Edit3 className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  title={g.isVisible ? 'إخفاء الشرح' : 'إظهار الشرح'}
                                  aria-label={`${g.isVisible ? 'إخفاء' : 'إظهار'} شرح ${guidePrimary}`}
                                  onClick={() => requestToggleGuideVisible(g)}
                                  className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-700 hover:bg-amber-50 hover:text-amber-700"
                                >
                                  {g.isVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  title="حذف الشرح"
                                  aria-label={`حذف شرح ${guidePrimary}`}
                                  onClick={() => requestDeleteGuide(g)}
                                  className="rounded-lg border border-rose-200 bg-white p-1.5 text-rose-600 hover:bg-rose-50"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* A3. Custom Nested Sub-Buttons attached to this button */}
                  <div className="space-y-2.5">
                    {(isStoreButton || isGuidesButton) && (
                      <div className="flex items-center justify-between border-t border-slate-100 pt-3 text-xs font-bold text-slate-700">
                        <span className="inline-flex items-center gap-1.5">
                          <FolderTree className="h-3.5 w-3.5 text-sky-600" />
                          أزرار فرعية مخصصة إضافية ({selectedCustomChildren.length})
                        </span>
                      </div>
                    )}

                    {selectedCustomChildren.length > 0 ? (
                      <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 overflow-hidden">
                        {selectedCustomChildren.map((child, childIdx) => {
                          const nestedCount = (childButtonsMap.get(child.id) || []).length;
                          const label = previewLang === 'en' ? child.labelEn || child.labelAr : child.labelAr || child.labelEn;
                          const otherLabel = previewLang === 'en' ? child.labelAr : child.labelEn;
                          const isFocused = focusedSubTile?.key === `btn-${child.id}`;
                          return (
                            <div
                              key={child.id}
                              onClick={() => setFocusedSubTileKey(`btn-${child.id}`)}
                              className={`flex flex-wrap items-center justify-between gap-2 px-4 py-3 transition-colors cursor-pointer ${
                                isFocused
                                  ? 'bg-emerald-50/70 ring-1 ring-inset ring-emerald-500/20'
                                  : 'bg-white hover:bg-slate-50/80'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedId(child.id);
                                }}
                                className="flex-1 text-start min-w-[160px]"
                              >
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="font-mono-num text-[11px] font-bold text-slate-400">
                                    #{childIdx + 1}
                                  </span>
                                  <span className="font-semibold text-xs text-slate-900">{label}</span>
                                  {!child.isVisible && <SemanticStatus tone="neutral" label="مخفي" />}
                                  {nestedCount > 0 && (
                                    <span className="text-[11px] font-semibold text-emerald-700">
                                      +{nestedCount} فرعي
                                    </span>
                                  )}
                                </div>
                                <div className="mt-0.5 text-[11px] text-slate-500">
                                  {getActionTypeLabel(child.actionType)} · {otherLabel} · صف {child.rowOrder}
                                </div>
                              </button>

                              <div
                                className="flex items-center gap-1 shrink-0"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  disabled={busy || childIdx === 0}
                                  title="تقديم موقع الزر الفرعي (لأعلى)"
                                  aria-label={`تقديم الزر الفرعي ${label}`}
                                  onClick={() => requestMoveButton(child, 'up', selectedCustomChildren)}
                                  className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-35"
                                >
                                  <ArrowUp className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={busy || childIdx === selectedCustomChildren.length - 1}
                                  title="تأخير موقع الزر الفرعي (لأسفل)"
                                  aria-label={`تأخير الزر الفرعي ${label}`}
                                  onClick={() => requestMoveButton(child, 'down', selectedCustomChildren)}
                                  className="rounded-md border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-100 disabled:opacity-35"
                                >
                                  <ArrowDown className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setSelectedId(child.id)}
                                  className="inline-flex items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-bold text-emerald-800 hover:bg-emerald-100"
                                >
                                  إدارة
                                  <ChevronLeft className="h-3 w-3" />
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  title={child.isVisible ? 'إخفاء' : 'إظهار'}
                                  aria-label={`${child.isVisible ? 'إخفاء' : 'إظهار'} الزر الفرعي ${label}`}
                                  onClick={() => requestToggleVisible(child)}
                                  className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-600 hover:bg-slate-50"
                                >
                                  {child.isVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                                </button>
                                <button
                                  type="button"
                                  disabled={busy}
                                  title="حذف الزر الفرعي"
                                  aria-label={`حذف الزر الفرعي ${label}`}
                                  onClick={() => requestDeleteButton(child)}
                                  className="rounded-lg border border-rose-200 bg-white p-1.5 text-rose-600 hover:bg-rose-50"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-5 text-center text-xs text-slate-500">
                        {isStoreButton || isGuidesButton
                          ? 'لا توجد أزرار فرعية مخصصة إضافية بعد. يمكنك إضافة زر مخصص (مثل العروض أو الضمان) ليظهر مباشرة داخل هذه القائمة.'
                          : 'لا توجد أزرار فرعية تابعة لهذا الزر بعد. اضغط «إضافة زر فرعي» لإضافة خيارات فرعية منظمة تحته.'}
                      </div>
                    )}
                  </div>
                </div>
              </SurfacePanel>

              {/* ================================================================= */}
              {/* SECTION B: SELECTED BUTTON EDITOR (SINGLE-INPUT AUTO-TRANSLATE!)  */}
              {/* ================================================================= */}
              <SurfacePanel className="overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2.5 border-b border-slate-100 px-5 py-4">
                  <div>
                    <h2 className="text-sm font-bold text-slate-900">
                      إعدادات الزر: {previewLang === 'en' ? selectedButton.labelEn : selectedButton.labelAr}
                    </h2>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      {getActionTypeLabel(selectedButton.actionType, selectedButton.actionValue)}
                    </p>
                  </div>

                  {/* Quick Toggle Controls (All guarded by Confirmation Modal!) */}
                  <div className="flex flex-wrap items-center gap-1.5">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => requestToggleVisible(selectedButton)}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors ${
                        selectedButton.isVisible
                          ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                          : 'border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200'
                      }`}
                    >
                      {selectedButton.isVisible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      {selectedButton.isVisible ? 'ظاهر' : 'مخفي'}
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => requestToggleEnabled(selectedButton)}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-bold transition-colors ${
                        selectedButton.isEnabled
                          ? 'border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100'
                          : 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
                      }`}
                    >
                      <Power className="h-3.5 w-3.5" />
                      {selectedButton.isEnabled ? 'مفعّل' : 'معطّل'}
                    </button>

                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => requestDeleteButton(selectedButton)}
                      className="inline-flex items-center gap-1 rounded-lg border border-rose-200 bg-white px-2.5 py-1.5 text-xs font-bold text-rose-700 hover:bg-rose-50"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      حذف
                    </button>
                  </div>
                </div>

                <form onSubmit={requestSaveButtonEdits} className="p-5 space-y-4">
                  {/* Single-Input Name Field with Automatic Bidirectional Translation */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-xs font-bold text-slate-800">
                        اسم الزر (أدخل الاسم مرة واحدة بالعربية أو الإنجليزية)
                      </label>
                      <button
                        type="button"
                        disabled={translatingPreview || (!editLabel.trim() && !editContent.trim())}
                        onClick={() => void handlePreviewTranslation()}
                        className="inline-flex items-center gap-1 rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-bold text-emerald-800 hover:bg-emerald-100 disabled:opacity-50"
                      >
                        <Languages className="h-3.5 w-3.5" />
                        {translatingPreview ? 'جارٍ الترجمة...' : 'معاينة الترجمة التلقائية'}
                      </button>
                    </div>
                    <input
                      type="text"
                      required
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      placeholder="مثال: 🛍 المتجر أو 🛍 Store — تُترجم اللغة الأخرى تلقائيًا"
                      className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-900 focus:border-emerald-600 focus:outline-none"
                    />
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-slate-50 border border-slate-200/80 px-3 py-2 text-[11px] text-slate-600">
                      <span className="inline-flex items-center gap-1 font-bold text-emerald-700">
                        <Sparkles className="h-3 w-3" />
                        ترجمة تلقائية مفعّلة:
                      </span>
                      <span>
                        <strong>العربية:</strong> {liveTranslatedLabel?.textAr || selectedButton.labelAr}
                      </span>
                      <span>
                        <strong>English:</strong> {liveTranslatedLabel?.textEn || selectedButton.labelEn}
                      </span>
                    </div>
                  </div>

                  {/* Action Type (for non-builtin buttons) */}
                  {selectedButton.actionType !== 'builtin' && (
                    <div className="space-y-1.5">
                      <label className="block text-xs font-bold text-slate-800">وظيفة الزر عند الضغط عليه</label>
                      <select
                        value={editActionType}
                        onChange={(e) => setEditActionType(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 focus:border-emerald-600 focus:outline-none"
                      >
                        {ACTION_TYPE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Conditional Target Field (URL / Category / Guide) */}
                  {((selectedButton.actionType !== 'builtin' && editActionType === 'url') ||
                    (selectedButton.actionType === 'builtin' && selectedButton.actionValue === 'support')) && (
                    <div className="space-y-1.5">
                      <label className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
                        <ExternalLink className="h-3.5 w-3.5 text-sky-600" />
                        الرابط المباشر أو معرّف تيليجرام
                      </label>
                      <input
                        type="text"
                        value={editActionValue}
                        onChange={(e) => setEditActionValue(e.target.value)}
                        placeholder="https://t.me/username أو @support_handle"
                        className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-mono-num text-slate-900 focus:border-emerald-600 focus:outline-none"
                      />
                    </div>
                  )}

                  {selectedButton.actionType !== 'builtin' && editActionType === 'category' && (
                    <div className="space-y-1.5">
                      <label className="block text-xs font-bold text-slate-800">اختر قسم المنتجات المستهدف</label>
                      <select
                        value={editActionValue}
                        onChange={(e) => setEditActionValue(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900"
                      >
                        <option value="">-- اختر القسم --</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.slug}>
                            {c.iconEmoji} {c.nameAr} ({c.nameEn})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {selectedButton.actionType !== 'builtin' && editActionType === 'guide' && (
                    <div className="space-y-1.5">
                      <label className="block text-xs font-bold text-slate-800">اختر الشرح المستهدف</label>
                      <select
                        value={editActionValue}
                        onChange={(e) => setEditActionValue(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900"
                      >
                        <option value="">-- اختر الشرح --</option>
                        {guides.map((g) => (
                          <option key={g.id} value={g.slug}>
                            {g.iconEmoji} {g.titleAr} ({g.titleEn})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Single-Input Message Content Field with Automatic Translation */}
                  {(selectedButton.actionType !== 'builtin' &&
                    (editActionType === 'custom_text' || editActionType === 'submenu')) ||
                  isStoreButton ? (
                    <div className="space-y-1.5">
                      <label className="block text-xs font-bold text-slate-800">
                        {isStoreButton
                          ? 'نص الرسالة الترحيبية داخل المتجر (اختياري — اكتب بلغة واحدة فقط)'
                          : 'محتوى الرسالة عند الضغط على الزر (اكتب مرة واحدة بالعربية أو الإنجليزية)'}
                      </label>
                      <textarea
                        rows={4}
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        placeholder="اكتب المحتوى بأي لغة وسيتولى النظام ترجمته وحفظ اللغتين تلقائيًا..."
                        className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 focus:border-emerald-600 focus:outline-none"
                      />
                      {(liveTranslatedContent || selectedButton.contentAr || selectedButton.contentEn) && (
                        <div className="rounded-lg bg-slate-50 border border-slate-200/80 p-3 text-[11px] text-slate-600 space-y-1">
                          <div>
                            <strong className="text-slate-800">النسخة العربية المحفوظة:</strong>{' '}
                            <span className="whitespace-pre-line">
                              {liveTranslatedContent?.textAr || selectedButton.contentAr || '—'}
                            </span>
                          </div>
                          <div className="border-t border-slate-200/70 pt-1">
                            <strong className="text-slate-800">Saved English Translation:</strong>{' '}
                            <span className="whitespace-pre-line">
                              {liveTranslatedContent?.textEn || selectedButton.contentEn || '—'}
                            </span>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : null}

                  {/* Appearance & Grid Layout Controls */}
                  <div className="grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-3">
                    <div className="sm:col-span-3 space-y-1.5">
                      <label className="block text-xs font-bold text-slate-800">لون الزر في تيليجرام</label>
                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {STYLE_OPTIONS.map((st) => (
                          <button
                            key={st.value || 'default'}
                            type="button"
                            onClick={() => setEditStyle(st.value)}
                            className={`flex items-center justify-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-bold transition-all ${
                              editStyle === st.value
                                ? 'border-slate-900 ring-2 ring-slate-900/15 bg-slate-50 text-slate-900'
                                : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                            }`}
                          >
                            <span className={`h-3 w-3 rounded-full ${st.swatch.split(' ')[0]}`} />
                            {st.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <label className="block text-xs font-bold text-slate-800">رقم الصف</label>
                      <input
                        type="number"
                        min={1}
                        max={50}
                        value={editRowOrder}
                        onChange={(e) => setEditRowOrder(Number(e.target.value) || 1)}
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-num"
                      />
                    </div>

                    <div className="sm:col-span-2 space-y-1.5">
                      <label className="block text-xs font-bold text-slate-800">توزيع الأزرار في الصف</label>
                      <select
                        value={editCols}
                        onChange={(e) => setEditCols(Number(e.target.value))}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                      >
                        <option value={1}>زر واحد بالصف (عرض كامل)</option>
                        <option value={2}>زران في كل صف (قياسي)</option>
                        <option value={3}>3 أزرار في كل صف (مضغوط)</option>
                      </select>
                    </div>
                  </div>

                  {/* Save CTA -> Opens Confirmation Modal */}
                  <div className="flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
                    <button
                      type="submit"
                      disabled={busy}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-700 px-5 py-2.5 text-xs font-bold text-white hover:bg-emerald-800 disabled:opacity-50"
                    >
                      <Save className="h-4 w-4" />
                      حفظ التعديلات والترجمة التلقائية
                    </button>
                  </div>
                </form>
              </SurfacePanel>
            </>
          ) : (
            <SurfacePanel className="p-10 text-center text-sm text-slate-500">
              اختر زرًا من القائمة أو أضف زرًا رئيسيًا جديدًا للبدء.
            </SurfacePanel>
          )}
        </div>
      </div>

      {/* ===================================================================== */}
      {/* CREATE / EDIT MODAL (Single-Input Auto-Translation — Zero Redundancy) */}
      {/* ===================================================================== */}
      {modalState !== null && (
        <ModalShell
          title={
            modalState.kind === 'create_button'
              ? modalState.parentId
                ? `إضافة زر فرعي داخل «${modalState.parentLabel}»`
                : 'إضافة زر رئيسي جديد للقائمة'
              : modalState.kind === 'create_category'
                ? 'إضافة زر قسم جديد داخل المتجر (🛍 Store)'
                : modalState.kind === 'edit_category'
                  ? `تعديل زر القسم «${modalState.category.nameAr}»`
                  : modalState.kind === 'create_guide'
                    ? 'إضافة زر شرح فرعي جديد'
                    : `تعديل الشرح «${modalState.guide.titleAr}»`
          }
          subtitle="أدخل النص مرة واحدة فقط بالعربية أو الإنجليزية وسيتم ترجمته تلقائيًا وحفظ اللغتين."
          onClose={() => setModalState(null)}
        >
          <form onSubmit={handleModalSubmit} className="space-y-4">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
                <div className="sm:col-span-3 space-y-1">
                  <label className="block text-xs font-bold text-slate-800">
                    الاسم (اكتب بلغة واحدة فقط — عربي أو إنجليزي)
                  </label>
                  <input
                    type="text"
                    required
                    value={modalSingleName}
                    onChange={(e) => setModalSingleName(e.target.value)}
                    placeholder="مثال: عروض VIP أو Special Deals"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-xs font-bold text-slate-800">أيقونة (Emoji)</label>
                  <input
                    type="text"
                    value={modalEmoji}
                    onChange={(e) => setModalEmoji(e.target.value)}
                    placeholder="✨"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-center text-sm"
                  />
                </div>
              </div>

              {modalState.kind === 'create_button' && (
                <>
                  <div className="space-y-1">
                    <label className="block text-xs font-bold text-slate-800">وظيفة الزر</label>
                    <select
                      value={modalActionType}
                      onChange={(e) => setModalActionType(e.target.value)}
                      className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                    >
                      {ACTION_TYPE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {modalActionType === 'url' && (
                    <div className="space-y-1">
                      <label className="block text-xs font-bold text-slate-800">الرابط المباشر أو حساب تيليجرام</label>
                      <input
                        type="text"
                        required
                        value={modalActionValue}
                        onChange={(e) => setModalActionValue(e.target.value)}
                        placeholder="https://t.me/username"
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono-num"
                      />
                    </div>
                  )}

                  {modalActionType === 'category' && (
                    <div className="space-y-1">
                      <label className="block text-xs font-bold text-slate-800">القسم المستهدف</label>
                      <select
                        required
                        value={modalActionValue}
                        onChange={(e) => setModalActionValue(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                      >
                        <option value="">-- اختر القسم --</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.slug}>
                            {c.iconEmoji} {c.nameAr}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {modalActionType === 'guide' && (
                    <div className="space-y-1">
                      <label className="block text-xs font-bold text-slate-800">الشرح المستهدف</label>
                      <select
                        required
                        value={modalActionValue}
                        onChange={(e) => setModalActionValue(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                      >
                        <option value="">-- اختر الشرح --</option>
                        {guides.map((g) => (
                          <option key={g.id} value={g.slug}>
                            {g.iconEmoji} {g.titleAr}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {(modalActionType === 'custom_text' || modalActionType === 'submenu') && (
                    <div className="space-y-1">
                      <label className="block text-xs font-bold text-slate-800">
                        محتوى الرسالة (اكتب بلغة واحدة — يُترجم تلقائيًا)
                      </label>
                      <textarea
                        rows={3}
                        value={modalSingleContent}
                        onChange={(e) => setModalSingleContent(e.target.value)}
                        placeholder="مثال: اختر أحد الخيارات الفرعية بالأسفل..."
                        className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                      />
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <label className="block text-xs font-bold text-slate-800">لون الزر</label>
                      <select
                        value={modalStyle}
                        onChange={(e) => setModalStyle(e.target.value)}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                      >
                        {STYLE_OPTIONS.map((st) => (
                          <option key={st.value || 'default'} value={st.value}>
                            {st.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs font-bold text-slate-800">الأزرار بالصف</label>
                      <select
                        value={modalCols}
                        onChange={(e) => setModalCols(Number(e.target.value))}
                        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs"
                      >
                        <option value={1}>زر واحد</option>
                        <option value={2}>زران بالصف</option>
                        <option value={3}>3 أزرار بالصف</option>
                      </select>
                    </div>
                  </div>
                </>
              )}

              {(modalState.kind === 'create_category' || modalState.kind === 'edit_category') && (
                <div className="space-y-1">
                  <label className="block text-xs font-bold text-slate-800">لون الزر في المتجر</label>
                  <select
                    value={modalStyle}
                    onChange={(e) => setModalStyle(e.target.value)}
                    className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                  >
                    {STYLE_OPTIONS.map((st) => (
                      <option key={st.value || 'default'} value={st.value}>
                        {st.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {(modalState.kind === 'create_guide' || modalState.kind === 'edit_guide') && (
                <div className="space-y-1">
                  <label className="block text-xs font-bold text-slate-800">
                    نص الشرح (اكتب بلغة واحدة — يُترجم تلقائيًا)
                  </label>
                  <textarea
                    rows={5}
                    required
                    value={modalSingleContent}
                    onChange={(e) => setModalSingleContent(e.target.value)}
                    placeholder="اكتب خطوات الاستخدام والتفعيل..."
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              )}

              <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => setModalState(null)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  إلغاء
                </button>
                <button
                  type="submit"
                  className="rounded-lg bg-emerald-700 px-4 py-2 text-xs font-bold text-white hover:bg-emerald-800"
                >
                  متابعة للتأكيد
                </button>
              </div>
            </form>
        </ModalShell>
      )}

      {/* ===================================================================== */}
      {/* MANDATORY 2-CHOICE CONFIRMATION DIALOG (Confirm vs Rollback/Cancel)   */}
      {/* ===================================================================== */}
      {pendingConfirm !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-[2px] p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-action-title"
            className={`w-full max-w-md rounded-2xl border bg-white p-6 shadow-[0_24px_48px_-12px_rgba(15,23,42,0.28)] space-y-4 ${
              pendingConfirm.tone === 'danger'
                ? 'border-rose-200'
                : pendingConfirm.tone === 'warning'
                  ? 'border-amber-200'
                  : 'border-emerald-200'
            }`}
          >
            <div className="flex items-start gap-3">
              <div
                className={`rounded-xl p-2.5 shrink-0 ${
                  pendingConfirm.tone === 'danger'
                    ? 'bg-rose-100 text-rose-700'
                    : pendingConfirm.tone === 'warning'
                      ? 'bg-amber-100 text-amber-700'
                      : 'bg-emerald-100 text-emerald-700'
                }`}
              >
                {pendingConfirm.tone === 'danger' || pendingConfirm.tone === 'warning' ? (
                  <AlertTriangle className="h-5 w-5" />
                ) : (
                  <CheckCircle2 className="h-5 w-5" />
                )}
              </div>

              <div className="space-y-1.5">
                <h3 id="confirm-action-title" className="text-base font-bold text-slate-900">
                  {pendingConfirm.title}
                </h3>
                <p className="text-xs leading-relaxed text-slate-600">{pendingConfirm.description}</p>
                {pendingConfirm.details && pendingConfirm.details.length > 0 && (
                  <ul className="mt-2 space-y-1 rounded-lg bg-slate-50 border border-slate-200/80 p-2.5 text-[11px] text-slate-700">
                    {pendingConfirm.details.map((d, i) => (
                      <li key={i}>• {d}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 border-t border-slate-100 pt-4">
              <button
                type="button"
                disabled={busy}
                onClick={() => void runConfirmedAction()}
                className={`inline-flex items-center justify-center gap-1.5 rounded-xl px-4 py-2.5 text-xs font-bold text-white transition-colors disabled:opacity-50 ${
                  pendingConfirm.tone === 'danger'
                    ? 'bg-rose-700 hover:bg-rose-800'
                    : pendingConfirm.tone === 'warning'
                      ? 'bg-amber-600 hover:bg-amber-700'
                      : 'bg-emerald-700 hover:bg-emerald-800'
                }`}
              >
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                {busy ? 'جارٍ التنفيذ...' : pendingConfirm.confirmLabel || 'تأكيد التنفيذ'}
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() => setPendingConfirm(null)}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-bold text-slate-700 hover:bg-slate-50 transition-colors disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4 shrink-0" />
                التراجع عن العملية
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
