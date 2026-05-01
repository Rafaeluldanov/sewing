/**
 * Контракты «схема начисления закройщика».
 *
 * Здесь живёт единый источник истины «как платим закройщику» — и
 * для backend (`apps/api/src/modules/earnings/earnings.service.ts`),
 * и для UI (`/admin/employees/[id]`, формы заказа и т.п.). Реальный
 * расчёт сумм — backend, но выбор схемы по `OrderDivision`
 * детерминирован и должен совпадать на обоих концах.
 *
 * Бизнес-модель (см. `docs/payroll-cutter-compensation-recon.md`):
 *
 *   - `MARKETPLACE_FIXED` — старая фиксированная схема:
 *     `amount = Operation(CUT_CUT).fixedRate × passport.qtyCut`.
 *     Поведение прежнее, на marketplace-flow ничего не меняется.
 *
 *   - `B2B_SEWING_PERCENT` — новая схема для B2B-заказов:
 *     `amount = base × percent / 100`, где
 *     `base = Σ rate(SEWING-операция, размер) × qtyForCompensation`,
 *     а `percent` — `Employee.cutterB2bSewingPercent` (или fallback из
 *     ENV `CUTTER_B2B_SEWING_PERCENT`, см. backend).
 *
 * Сознательно НЕ переименовываем `OrderDivision.OTHER` → `B2B`
 * destructive-миграцией: technical value `OTHER` остаётся, в UI
 * лейбл показываем как «B2B». Для будущего, если/когда появится
 * явное `OrderDivision.B2B`, helper уже умеет с ним работать.
 */

import type { OrderDivision } from './orders';

// ---------------------------------------------------------------------------
// Schemes
// ---------------------------------------------------------------------------

/**
 * Список схем начисления закройщика. Расширяется добавлением значения
 * сюда + лейбла в `CUTTER_COMPENSATION_SCHEME_LABELS` + ветки в
 * `getCutterCompensationSchemeForDivision` и в backend
 * `EarningsService.createImmediateForCutter`.
 */
export const CUTTER_COMPENSATION_SCHEMES = [
  'MARKETPLACE_FIXED',
  'B2B_SEWING_PERCENT',
] as const;
export type CutterCompensationScheme =
  (typeof CUTTER_COMPENSATION_SCHEMES)[number];

/**
 * Человекочитаемые лейблы схем — для admin-UI / audit-payload /
 * сообщений в логах. Соответствие 1-в-1 с
 * `CUTTER_COMPENSATION_SCHEMES`, чтобы lint/typecheck подсветил
 * пропавший case.
 */
export const CUTTER_COMPENSATION_SCHEME_LABELS: Record<
  CutterCompensationScheme,
  string
> = {
  MARKETPLACE_FIXED: 'Фиксированная схема Marketplace',
  B2B_SEWING_PERCENT: 'Процент от операций пошива B2B',
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Возвращает схему начисления закройщика по коду подразделения
 * заказа. Источник истины маппинга «code → scheme».
 *
 * - `MARKETPLACE` → `MARKETPLACE_FIXED` (старая фиксированная схема,
 *   marketplace-flow не меняется);
 * - `OTHER` → `B2B_SEWING_PERCENT` (legacy technical value для B2B,
 *   см. recon §4: Prisma enum мы сознательно не переименовываем);
 * - `B2B` → `B2B_SEWING_PERCENT` (на случай, если в будущем появится
 *   явное значение `B2B` в Prisma enum / shared `ORDER_DIVISIONS`);
 * - любое другое непустое значение (произвольный
 *   `CompanyDivision.code`) → `B2B_SEWING_PERCENT` как безопасный
 *   default — все «новые» подразделения по-умолчанию идут по
 *   B2B-схеме, marketplace остаётся единственным whitelist'ом.
 *
 * Контракт по входу — строка-код. Это либо `OrderDivision` legacy
 * enum, либо `CompanyDivision.code` (PHASE 1 «CompanyDivision как
 * master-справочник», см. `docs/payroll-cutter-compensation-recon.md
 * §4`, `EarningsService.createImmediateForCutter`). Backend
 * предпочитает `passport.order.companyDivision?.code`, fallback —
 * legacy `Order.division` (узкий перечень `MARKETPLACE`/`OTHER`).
 *
 * Перебираем строкой, а не `OrderDivision`-narrow'ом, потому что
 * `CompanyDivision.code` может содержать произвольное значение
 * (`MAIN_SHOP`, `SEWING_FLOOR_2`, …), и Prisma может прислать
 * `Order.division`-значение, которого ещё нет в `ORDER_DIVISIONS`.
 * В таком случае даём безопасный fallback на `B2B_SEWING_PERCENT` —
 * это корректнее, чем тихо считать всё marketplace-ом.
 */
export function getCutterCompensationSchemeForDivision(
  division: OrderDivision | string | null | undefined,
): CutterCompensationScheme {
  if (division === 'MARKETPLACE') return 'MARKETPLACE_FIXED';
  // Все остальные значения (`OTHER`, будущий `B2B`, любой свой
  // `CompanyDivision.code`, неизвестные — см. JSDoc) трактуются
  // как B2B. Marketplace — единственный «whitelist» из этого правила.
  return 'B2B_SEWING_PERCENT';
}
