/**
 * Рантайм-фиче-флаги веба (читаются server-side, не build-time
 * `NEXT_PUBLIC_*`).
 *
 * `FEATURE_COLORWAYS` — фича «Расцветки» (разные цвета для разных
 * размеров, у каждого цвета своя техкарта). Задумана как обратимый
 * прод-эксперимент: на проде OFF по умолчанию (включается
 * `FEATURE_COLORWAYS=1`), на dev — ON, чтобы можно было щупать.
 * Явное `FEATURE_COLORWAYS=0` выключает и на dev.
 */
export function isColorwaysEnabled(): boolean {
  const raw = process.env.FEATURE_COLORWAYS;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

/**
 * `FEATURE_ORDER_CALCULATIONS` — фича «Варианты просчёта заказа»
 * (несколько альтернативных расчётов на заказ, вкладки над окном
 * заказа; см. `@sewing/shared/order-calculations`,
 * `apps/api/src/modules/order-calculations/*`). Как и colorways:
 * на проде OFF по умолчанию (включается `FEATURE_ORDER_CALCULATIONS=1`),
 * на dev — ON. Явное `=0` выключает везде.
 */
export function isOrderCalculationsEnabled(): boolean {
  const raw = process.env.FEATURE_ORDER_CALCULATIONS;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

/**
 * `FEATURE_ORDER_AMENDMENTS` — фича «Правка заказа в производстве»
 * (второй ярус редактируемости поверх заморозки плана: количество по
 * размерам, дальше — размерность и операции; см.
 * `@sewing/shared/amendments`, `apps/api/src/modules/order-amendments/*`).
 * Как и colorways: на проде OFF по умолчанию (включается
 * `FEATURE_ORDER_AMENDMENTS=1`), на dev — ON. Явное `=0` выключает везде.
 */
export function isOrderAmendmentsEnabled(): boolean {
  const raw = process.env.FEATURE_ORDER_AMENDMENTS;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

/**
 * `FEATURE_QTY_CORRECTION` — фича «Корректировка фактического количества
 * по паспорту» (ОТК на `/qc` предлагает новое количество, мастер цеха на
 * `/master` подтверждает; см. `@sewing/shared/passport-qty-corrections`,
 * `apps/api/src/modules/passport-qty-corrections/*`). Как и colorways:
 * на проде OFF по умолчанию (включается `FEATURE_QTY_CORRECTION=1`),
 * на dev — ON. Явное `=0` выключает везде.
 */
export function isQtyCorrectionEnabled(): boolean {
  const raw = process.env.FEATURE_QTY_CORRECTION;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}

/**
 * `FEATURE_ERP_INTEGRATION` — раздел «Интеграции» в настройках компании
 * (связь с внешним ERP upgifts, см. `docs/upgifts-integration.md`).
 * Как и colorways: на проде OFF по умолчанию (включается
 * `FEATURE_ERP_INTEGRATION=1`), на dev — ON. Явное `=0` выключает везде.
 */
export function isErpIntegrationEnabled(): boolean {
  const raw = process.env.FEATURE_ERP_INTEGRATION;
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return process.env.NODE_ENV !== 'production';
}
