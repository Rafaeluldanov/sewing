/**
 * Вспомогательные форматтеры и label-функции для UI модуля
 * «PayrollPayout» (PHASE 3 STEP 4).
 *
 * Намеренно не импортирует React — чистые строковые утилиты,
 * пригодные как в RSC, так и в client-компонентах.
 */
import type { AdminStatusTone } from '@/lib/admin-labels';
import type {
  PayrollPayoutLineDto,
  PayrollPayoutLineKind,
  PayrollPayoutStatus,
} from '@sewing/shared/payroll-payouts';

export function formatRub(value: number): string {
  return `${value.toLocaleString('ru-RU', {
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

export function getPayoutStatusLabel(status: PayrollPayoutStatus): string {
  switch (status) {
    case 'DRAFT':
      return 'Черновик';
    case 'ISSUED':
      return 'Выдано';
    case 'ACKNOWLEDGED':
      return 'Получено';
    case 'CANCELLED':
      return 'Отменено';
  }
}

export function getPayoutStatusTone(
  status: PayrollPayoutStatus,
): AdminStatusTone {
  switch (status) {
    case 'DRAFT':
      return 'muted';
    case 'ISSUED':
      return 'info';
    case 'ACKNOWLEDGED':
      return 'success';
    case 'CANCELLED':
      return 'danger';
  }
}

export function getLineKindLabel(kind: PayrollPayoutLineKind): string {
  switch (kind) {
    case 'PIECEWORK':
      return 'Сдельно';
    case 'SALARY':
      return 'Оклад';
    case 'BONUS':
      return 'Бонус';
    case 'DEDUCTION':
      return 'Удержание';
    case 'ADVANCE':
      return 'Аванс';
    case 'ADJUSTMENT':
      return 'Корректировка';
  }
}

/**
 * Краткое текстовое описание снимка строки для колонки таблицы.
 *
 * PIECEWORK  — qty · ratePerUnit · operationId / passportId.
 * SALARY     — source · editedManually · managerComment.
 * ADJUSTMENT — manualComment из snapshot (STEP 6.4).
 */
export function summarizePayoutLineSnapshot(
  line: PayrollPayoutLineDto,
): string {
  const snap = line.snapshot;
  if (!snap || typeof snap !== 'object') return '—';
  const parts: string[] = [];
  if (line.kind === 'PIECEWORK') {
    if (snap.qty !== undefined) parts.push(`кол-во: ${snap.qty}`);
    if (snap.ratePerUnit !== undefined)
      parts.push(`ставка: ${snap.ratePerUnit} ₽`);
    if (snap.operationId) parts.push(`опер: ${String(snap.operationId).slice(0, 8)}`);
    if (snap.passportId) parts.push(`паспорт: ${String(snap.passportId).slice(0, 8)}`);
  } else if (line.kind === 'ADJUSTMENT') {
    if (snap.manualComment) parts.push(String(snap.manualComment));
  } else {
    if (snap.source) parts.push(`источник: ${snap.source}`);
    if (snap.editedManually) parts.push('ручная правка');
    if (snap.managerComment) parts.push(`коммент: ${snap.managerComment}`);
  }
  return parts.length > 0 ? parts.join(' · ') : '—';
}
