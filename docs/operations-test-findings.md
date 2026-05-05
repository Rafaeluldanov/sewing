# Operations Test Findings

Дата создания: 2026-05-04. Документ собирает несоответствия между
ожидаемым поведением (`docs/operations-test-recon.md` §6, плюс
`docs/test-gap-plan.md`) и реальным поведением кода, обнаруженные при
реализации dedicated тестов. Production-код в этих задачах **не
менялся** — каждое расхождение зафиксировано характеристическим
тестом и ждёт отдельного решения.

| Area | Test | Expected | Actual | Severity | Suggested fix |
|------|------|----------|--------|----------|---------------|
| `ShiftsService.start` | `tests/integration/shifts.test.ts` → `FINDING: start не проверяет Equipment.allowedOperations` | 4xx (например `OPERATION_NOT_ALLOWED_BY_EQUIPMENT`, 409) при попытке стартовать смену с парой `(equipmentId, operationId)`, отсутствующей в `EquipmentOperation`. Источник истины — `/shifts/meta`, который allow-list уже отдаёт правильно (см. `equipment-operations.test.ts §220..§272`). | `POST /api/shifts/start` создаёт `ShiftSession` без проверки `EquipmentOperation`. UI-gate работает, backend-gate отсутствует. Тест пинит текущее поведение `[201, 400, 409]` без падения CI. | medium | В `ShiftsService.start` после проверки `operation.active` добавить SELECT в `EquipmentOperation` и кинуть бизнес-исключение, если связь отсутствует или `isActive=false`. После фикса — заменить мягкий `expect(status).toBe(...)` в FINDING-тесте на жёсткий 4xx. |
| Frontend `/orders/[id]/passports/new` (P0-7) | `tests/smoke/orders-passports-new-cutter-assistant.smoke.test.ts` → `FINDING: page.tsx НЕ имеет safe-условия для CUTTER_ASSISTANT` | SSR-страница не должна вызывать admin-only `GET /api/employees` от имени CUTTER_ASSISTANT. Целевые варианты: (а) ветка `isCutter \|\| isCutterAssistant ? [] : ...`; (б) узкий `listActiveCutters()` → `GET /api/employees/cutters` с `@Roles('CUTTER_ASSISTANT','SHOP_MANAGER','ADMIN')`. | `apps/web/app/orders/[id]/passports/new/page.tsx:60-62` ветвится только на `isCutter`; для CUTTER_ASSISTANT (`isCutter === false`) выполняется `await listEmployees({active:true, role:'CUTTER'})`, который защищён `@Roles('SHOP_MANAGER','ADMIN')` на `EmployeesController`. CA получает 403 → server-side exception в Next.js. Catch-блока вокруг вызова нет. | **high** — пилотный CUTTER_ASSISTANT-flow «Выпустить паспорт» падает в production-исключение. | Бэкенд: добавить `@Get('cutters')` ВЫШЕ `@Get(':id')` в `EmployeesController`, отдельный `@Roles('CUTTER_ASSISTANT','SHOP_MANAGER','ADMIN')`, в service select только `id/fullName/login`. Frontend: `lib/employees-api.ts::listActiveCutters()` → `/api/employees/cutters`; в page.tsx заменить `listEmployees(...)` на `listActiveCutters()` ИЛИ добавить `isCutter \|\| isCutterAssistant ? [] : ...`. Shared: ввести `ActiveCutterListItemDto = { id, fullName, login }` без payroll-полей. После фикса 5 FINDING-тестов smoke падают и обновляются вместе с фиксом. |
| Frontend `lib/employees-api.ts` (P0-7) | `tests/smoke/orders-passports-new-cutter-assistant.smoke.test.ts` → `FINDING: lib/employees-api.ts пока не имеет узкого listActiveCutters helper` | Узкий helper `listActiveCutters(): Promise<ActiveCutterListItemDto[]>` для безопасного запроса от CA. | Helper отсутствует; единственная точка получения списка раскройщиков — широкий `listEmployees({role:'CUTTER'})`. | medium | См. фикс выше — добавляется в комплекте с `/cutters` endpoint. |
| Backend `EmployeesController` (P0-7) | `tests/smoke/orders-passports-new-cutter-assistant.smoke.test.ts` → `FINDING: /api/employees/cutters endpoint пока не существует` | Узкий `@Get('cutters')` с `@Roles('CUTTER_ASSISTANT','SHOP_MANAGER','ADMIN')` ВЫШЕ `@Get(':id')`, иначе wildcard перехватит запрос. Service отдаёт только `id/fullName/login` через явный `select`. | Endpoint не существует. Контроллер-level `@Roles('SHOP_MANAGER','ADMIN')` блокирует CUTTER_ASSISTANT на ВСЕХ маршрутах. | medium | См. фикс выше. Не забыть порядок методов: `@Get('cutters')` → `@Get(':id')`. |

## Severity

- `blocker` — данные/деньги повреждаются, безопасный production невозможен;
- `high` — ломает ожидаемый flow, легко обходимо вручную;
- `medium` — расхождение с документированным контрактом, риск ограничен
  одним прорывом (frontend-only enforcement обходится прямым POST);
- `low` — косметика/несогласованность сообщений.

## Process

1. Тест, обнаруживший расхождение, остаётся зелёным и помечается
   комментарием `FINDING:` + ссылкой на эту таблицу.
2. Production-код не правится в задаче, которая обнаружила finding.
3. Когда finding закрывается — соответствующий тест переписывается на
   жёсткое ожидание правильного поведения, строка из таблицы удаляется.

## Resolved

| Area | Resolved in | Test (now strict) | Notes |
|------|-------------|-------------------|-------|
| `QcService.completeQc` (idempotency) | `apps/api/src/modules/qc/qc.service.ts` — внутри `$transaction` добавлен check `passportEvent.findFirst({type: QC_PASSED})`; если существует — `return` без вставки event/audit. JSDoc обновлён («row-level idempotency»). | `tests/integration/qc-shift-flow.test.ts` → `completeQc × 2 идемпотентен: один QC_PASSED, один QC_COMPLETED, qcCompletedAt стабилен` (count=1, `qcCompletedAt` не сдвигается между вызовами). | Recon §6 invariant 6 теперь соблюдается row-level. Конкурентный «двойной POST» в одну миллисекунду в теории мог бы вписать второе событие — для production-сценария (двойной клик) это не воспроизводится; жёсткая защита потребовала бы partial unique index на `(passportId, type=QC_PASSED)` — отдельная задача с миграцией. |
| `WtoService.completeWto` (idempotency) | `apps/api/src/modules/wto/wto.service.ts` — симметричный fix: check `passportEvent.findFirst({type: WTO_PASSED})` в `$transaction`. | `tests/integration/wto-shift-flow.test.ts` → `completeWto × 2 идемпотентен: один WTO_PASSED, один WTO_COMPLETED, wtoCompletedAt стабилен`. | См. QC выше — те же замечания о partial unique index. |
