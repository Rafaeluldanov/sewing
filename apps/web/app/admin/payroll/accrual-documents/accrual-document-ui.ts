/**
 * Вспомогательные форматтеры и label-функции для UI модуля
 * «PayrollAccrualDocument» (PHASE 3 STEP 6.3).
 *
 * Намеренно не импортирует React — чистые строковые утилиты,
 * пригодные как в RSC, так и в client-компонентах.
 */
import type { AdminStatusTone } from '@/lib/admin-labels';
import type {
  PayrollAccrualDocumentDto,
  PayrollAccrualDocumentListItemDto,
  PayrollAccrualDocumentStatus,
} from '@sewing/shared/payroll-accrual-documents';

export function formatRub(value: number): string {
  return `${value.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} ₽`;
}

export function formatSignedRub(value: number): string {
  if (value === 0) return '0 ₽';
  const prefix = value > 0 ? '+' : '';
  return `${prefix}${value.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })} ₽`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function getAccrualDocumentStatusLabel(
  status: PayrollAccrualDocumentStatus,
): string {
  switch (status) {
    case 'DRAFT':
      return 'Черновик';
    case 'PAID':
      return 'Выплачено';
    case 'CANCELLED':
      return 'Отменено';
  }
}

export function getAccrualDocumentStatusTone(
  status: PayrollAccrualDocumentStatus,
): AdminStatusTone {
  switch (status) {
    case 'DRAFT':
      return 'muted';
    case 'PAID':
      return 'success';
    case 'CANCELLED':
      return 'danger';
  }
}

export function hasManualAdjustments(
  doc: PayrollAccrualDocumentDto | PayrollAccrualDocumentListItemDto,
): boolean {
  return doc.totalAdjustRub !== 0;
}

/**
 * Может ли менеджер нажать «Выплатить» прямо сейчас.
 * В STEP 6.2 backend блокирует pay если есть manualAdjustRub != 0.
 */
export function canPayDocument(doc: PayrollAccrualDocumentDto): boolean {
  return doc.status === 'DRAFT' && !hasManualAdjustments(doc);
}

/**
 * Причина блокировки кнопки «Выплатить». `null` если кнопка разблокирована.
 */
export function getPayBlockedReason(
  doc: PayrollAccrualDocumentDto,
): string | null {
  if (doc.status !== 'DRAFT') return null;
  if (hasManualAdjustments(doc)) {
    return (
      'В документе есть корректировки. Выплата с корректировками будет доступна ' +
      'после расширения строк выплат. Сейчас уберите корректировки или дождитесь ' +
      'следующего шага.'
    );
  }
  return null;
}
