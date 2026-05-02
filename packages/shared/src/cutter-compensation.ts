/**
 * Контракты «схема начисления закройщика».
 *
 * Здесь живёт единый источник истины «как платим закройщику» — и
 * для backend (`apps/api/src/modules/earnings/earnings.service.ts`),
 * и для UI (`/admin/employees/[id]`, формы заказа и т.п.). Реальный
 * расчёт сумм — backend, но выбор схемы по `CompanyDivision.code`
 * детерминирован и должен совпадать на обоих концах.
 *
 * Бизнес-модель (см. `docs/payroll-cutter-compensation-recon.md`):
 *
 *   - `MARKETPLACE_FIXED` — фиксированная схема для маркетплейса:
 *     `amount = Operation(CUT_CUT).fixedRate × passport.qtyCut`.
 *
 *   - `B2B_SEWING_PERCENT` — схема для B2B-заказов и любых других
 *     подразделений: `amount = base × percent / 100`, где
 *     `base = Σ rate(SEWING-операция, размер) × qtyForCompensation`,
 *     а `percent` — `Employee.cutterB2bSewingPercent` (или fallback из
 *     ENV `CUTTER_B2B_SEWING_PERCENT`, см. backend).
 *
 * Маппинг идёт по `CompanyDivision.code`: `MARKETPLACE` —
 * единственный whitelist под marketplace-схему, всё остальное
 * (`OTHER`, любой пользовательский код, `null` — отсутствие
 * привязки) идёт через B2B-схему.
 */

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
 * заказа (`CompanyDivision.code`). Источник истины маппинга
 * «code → scheme».
 *
 * - `MARKETPLACE` → `MARKETPLACE_FIXED` (фиксированная схема,
 *   marketplace-flow);
 * - `OTHER` → `B2B_SEWING_PERCENT` (B2B-flow);
 * - любой другой непустой `CompanyDivision.code` →
 *   `B2B_SEWING_PERCENT` как безопасный default;
 * - `null` / `undefined` (заказ без привязки к подразделению) →
 *   `B2B_SEWING_PERCENT` (тоже B2B-default).
 *
 * Контракт по входу — строка-код `CompanyDivision.code`. Backend
 * передаёт `passport.order.companyDivision?.code` напрямую (см.
 * `EarningsService.createImmediateForCutter`,
 * `docs/payroll-cutter-compensation-recon.md §4`).
 *
 * `CompanyDivision.code` может содержать произвольное значение
 * (`MAIN_SHOP`, `SEWING_FLOOR_2`, …) — менеджер расширяет
 * справочник через UI без миграций. Marketplace — единственный
 * whitelist под фиксированную схему, всё остальное идёт по
 * B2B-проценту от пошива.
 */
export function getCutterCompensationSchemeForDivision(
  divisionCode: string | null | undefined,
): CutterCompensationScheme {
  if (divisionCode === 'MARKETPLACE') return 'MARKETPLACE_FIXED';
  return 'B2B_SEWING_PERCENT';
}
