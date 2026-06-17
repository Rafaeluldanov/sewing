/**
 * Человекочитаемые лейблы для админки (Admin UI Polish).
 *
 * Это маленький слой презентации поверх enum'ов из `@sewing/shared`.
 * Цель — убрать «технический шум» (`SEAMSTRESS`, `IRONING`,
 * `BY_SIZE`, …) из таблиц и карточек, не меняя при этом backend и DTO.
 *
 * Все формулы держим тут, чтобы:
 *   - один раз поправить — отразилось во всей админке;
 *   - smoke-тест мог проверить: лейбл `Швея` берётся из этого файла,
 *     а не повторяется по pages-ам копи-пастой;
 *   - lint / typecheck подсветил пропавший case (`Record<…, string>`
 *     заставит указать каждое значение enum).
 *
 * Ничего сюда не возвращаем, кроме строк — никаких ReactNode, никаких
 * иконок. Иконки — отдельно в `lucide-react`, чтобы лейбл-функции
 * можно было звать и из server-, и из client-компонентов без оверхеда.
 */

import type { CompensationType, EmployeeRole } from '@sewing/shared/employees';
import {
  getOperationCategoryLabel,
  type PricingMode,
  type TimeNormMode,
} from '@sewing/shared/operations';
import type { OrderStatus } from '@sewing/shared/orders';
import type { ShopfloorEquipmentKind } from '@sewing/shared/shopfloor';

/** Подмножество ролей, которое может появиться в admin UI. */
export type AdminVisibleRole = EmployeeRole;

const ROLE_LABELS: Record<AdminVisibleRole, string> = {
  ADMIN: 'Администратор',
  SHOP_MANAGER: 'Начальник цеха',
  SHOPFLOOR_MASTER: 'Мастер цеха',
  CUTTER: 'Раскройщик',
  CUTTER_ASSISTANT: 'Помощник раскройщика',
  SEAMSTRESS: 'Швея',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
  CONSTRUCTOR: 'Конструктор',
};

/**
 * Понятное название роли для админки. Если на вход прилетела роль,
 * которой нет в `EMPLOYEE_ROLES` (например, легаси `DISPLAY`), —
 * возвращаем строку без транслитерации, чтобы UI не рухнул.
 */
export function formatRole(role: string | null | undefined): string {
  if (!role) return '—';
  return ROLE_LABELS[role as AdminVisibleRole] ?? role;
}

/**
 * Лейбл категории операции для admin-UI. Источник истины —
 * `OPERATION_CATEGORY_LABELS` в `@sewing/shared/operations`,
 * это **единый словарь** для всех экранов (см. ТЗ «Единая
 * группировка»). Дублировать локально нельзя.
 *
 * Для значений вне `OPERATION_CATEGORIES` (старые строки, `null`)
 * возвращается «Без категории», как в shared-helper'ах группировки.
 */
export function formatOperationCategory(
  category: string | null | undefined,
): string {
  return getOperationCategoryLabel(category);
}

const PRICING_MODE_LABELS: Record<PricingMode, string> = {
  FIXED: 'Фиксированная',
  BY_SIZE: 'По размерам',
  SALARY_ONLY: 'Оклад',
};

export function formatPricingMode(mode: string | null | undefined): string {
  if (!mode) return '—';
  return PRICING_MODE_LABELS[mode as PricingMode] ?? mode;
}

const TIME_NORM_MODE_LABELS: Record<TimeNormMode, string> = {
  FIXED: 'Единая норма',
  BY_SIZE: 'По размерам',
};

export function formatTimeNormMode(
  mode: string | null | undefined,
): string {
  if (!mode) return '—';
  return TIME_NORM_MODE_LABELS[mode as TimeNormMode] ?? mode;
}

const COMPENSATION_LABELS: Record<CompensationType, string> = {
  PIECEWORK: 'Сдельная',
  SALARY: 'Оклад',
  MIXED: 'Смешанная',
};

export function formatCompensation(
  type: string | null | undefined,
): string {
  if (!type) return '—';
  return COMPENSATION_LABELS[type as CompensationType] ?? type;
}

/**
 * «Тип» оборудования — берём из основной разрешённой операции.
 * Совпадает с `ShopfloorEquipmentKind`, плюс fallback на «Прочее».
 */
const EQUIPMENT_KIND_LABELS: Record<ShopfloorEquipmentKind, string> = {
  CUTTING: 'Раскрой',
  SEWING: 'Пошив',
  QC: 'ОТК',
  IRONING: 'ВТО',
  PACKING: 'Упаковка',
  OTHER: 'Прочее',
};

export function formatEquipmentKind(
  kind: string | null | undefined,
): string {
  if (!kind) return 'Прочее';
  return (
    EQUIPMENT_KIND_LABELS[kind as ShopfloorEquipmentKind] ?? kind
  );
}

/**
 * Универсальный человекочитаемый статус.
 *
 * В админке встречается боль `enum`-ов: orders.status, passport.status,
 * shift.status, masterCall.status — у каждого свой набор. Эта функция
 * собирает их все в один словарь — чтобы в таблицах писать одинаково:
 * «Активен», «Архив», «В работе» — а не `IN_PROGRESS` или `active=true`.
 *
 * Возвращает `«Активен»` / `«Архив»` для булевых значений (часто хочется
 * звать `formatStatus(item.active)` и не думать).
 */
export function formatStatus(
  status: string | boolean | null | undefined,
): string {
  if (status === null || status === undefined || status === '') return '—';
  if (typeof status === 'boolean') return status ? 'Активен' : 'Архив';
  switch (status) {
    case 'DRAFT':
      return 'Черновик';
    case 'CALCULATION':
      return 'Расчёт';
    case 'CALCULATION_DONE':
      return 'Расчёт завершён';
    case 'SAMPLE_PRODUCTION':
      return 'Производство сигнального образца';
    case 'IN_PRODUCTION':
      return 'В работе';
    case 'IN_PROGRESS':
      return 'В работе';
    case 'CREATED':
      return 'Создан';
    case 'DONE':
      return 'Завершён';
    case 'PACKED':
      return 'Упакован';
    case 'CANCELLED':
      return 'Отменён';
    case 'OPEN':
      return 'Открыт';
    case 'CLOSED':
      return 'Закрыт';
    case 'ACTIVE':
      return 'Активен';
    case 'ARCHIVED':
      return 'Архив';
    case 'REQUESTED':
      return 'Запрошен';
    case 'APPROVED':
      return 'Подтверждён';
    case 'REJECTED':
      return 'Отклонён';
    case 'ONLINE':
      return 'Онлайн';
    case 'OFFLINE':
      return 'Офлайн';
    default:
      return status;
  }
}

/**
 * Лейблы статуса заказа специально для admin-UI: список заказов,
 * карточка заказа, форма создания. Совпадают с `ORDER_STATUS_LABELS`
 * из `lib/orders-api.ts` по DRAFT / IN_PRODUCTION / CANCELLED, но
 * дают «короткое» «Готов» вместо нейтрального «Завершён» — так
 * статус читается одинаково и в бейдже на header, и в таблице.
 *
 * Используется в:
 *   - `/admin/orders` (badge статуса в таблице и фильтр);
 *   - `/admin/orders/[id]` (badge в шапке + карточка «1. Заказ»);
 *   - `/admin/orders/new` (visual «Статус заказа» в карточке «1. Заказ»).
 *
 * Backend / DTO не меняем — это только presentation layer.
 */
const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  DRAFT: 'Черновик',
  // Этап «Расчёт»: между DRAFT и IN_PRODUCTION.
  // Лейбл выбран как «Расчёт» (короткий бейдж) — совпадает с
  // shared `ORDER_STATUS_LABELS` в `@sewing/shared/orders`.
  CALCULATION: 'Расчёт',
  // Этап «Себестоимость заказа»: расчёт зафиксирован, готов к запуску
  // в производство либо к возврату на пересчёт.
  CALCULATION_DONE: 'Расчёт завершён',
  // Этап «Производство сигнального образца»: образец запущен без
  // запуска тиража (см. `OrderSamplesService.start`).
  SAMPLE_PRODUCTION: 'Сигнальный образец',
  IN_PRODUCTION: 'В производстве',
  DONE: 'Готов',
  CANCELLED: 'Отменён',
};

/**
 * Лейбл статуса заказа для admin-UI. Если на вход прилетел
 * неизвестный enum (новые статусы появляются в shared, но ещё не
 * заведён лейбл) — fallback на `formatStatus`, чтобы UI не падал.
 */
export function formatOrderStatus(
  status: string | null | undefined,
): string {
  if (!status) return '—';
  const known = ORDER_STATUS_LABELS[status as OrderStatus];
  return known ?? formatStatus(status);
}

/**
 * Тон бейджа статуса заказа (см. `AdminStatusBadge`).
 *   - DRAFT         → muted (это «черновик», нейтральный фон);
 *   - CALCULATION   → warning (жёлтый — заказ в расчёте, ждёт
 *     проверки потребностей закупщиком);
 *   - IN_PRODUCTION → info  (синий — «в работе»);
 *   - DONE          → success (зелёный — «готов»);
 *   - CANCELLED     → danger  (красный — «отменён»).
 *
 * Совпадает с тоном из общего `statusTone`, но зафиксирован
 * отдельно, чтобы случайные правки общего словаря не изменили
 * цвета именно карточки заказа (бейдж в header — основной
 * визуальный индикатор управленческого состояния заказа).
 */
export function getOrderStatusTone(
  status: string | null | undefined,
): AdminStatusTone {
  if (!status) return 'muted';
  switch (status as OrderStatus) {
    case 'DRAFT':
      return 'muted';
    case 'CALCULATION':
      return 'warning';
    case 'CALCULATION_DONE':
      return 'info';
    // «Производство сигнального образца» — промежуточный этап до
    // полного запуска тиража, помечаем янтарным (warning), чтобы
    // визуально отличался от синего IN_PRODUCTION.
    case 'SAMPLE_PRODUCTION':
      return 'warning';
    case 'IN_PRODUCTION':
      return 'info';
    case 'DONE':
      return 'success';
    case 'CANCELLED':
      return 'danger';
    default:
      return statusTone(status);
  }
}

/**
 * Тон для `<AdminStatusBadge tone={…}>` по «смыслу» статуса.
 * Тоже строго из строк — компонент уже сам приклеит CSS-класс.
 */
export type AdminStatusTone = 'success' | 'info' | 'warning' | 'danger' | 'muted';

export function statusTone(
  status: string | boolean | null | undefined,
): AdminStatusTone {
  if (status === null || status === undefined || status === '') return 'muted';
  if (typeof status === 'boolean') return status ? 'success' : 'muted';
  switch (status) {
    case 'IN_PRODUCTION':
    case 'IN_PROGRESS':
    case 'OPEN':
    case 'REQUESTED':
    case 'ONLINE':
      return 'info';
    case 'DONE':
    case 'PACKED':
    case 'APPROVED':
    case 'ACTIVE':
      return 'success';
    case 'CALCULATION':
    case 'SAMPLE_PRODUCTION':
      return 'warning';
    case 'CALCULATION_DONE':
      return 'info';
    case 'DRAFT':
    case 'CREATED':
      return 'muted';
    case 'CANCELLED':
    case 'REJECTED':
      return 'danger';
    case 'ARCHIVED':
    case 'CLOSED':
    case 'OFFLINE':
      return 'muted';
    default:
      return 'muted';
  }
}
