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
| `QcService.completeQc` (idempotency) | `tests/integration/qc-shift-flow.test.ts` → `FINDING: completeQc × 2 пишет два QC_PASSED и два QC_COMPLETED audit` | По `docs/operations-test-recon.md §6 invariant 6` — повторный `completeQc` идемпотентен: ровно один `PassportEvent(QC_PASSED)` и одна запись `AuditLog(QC_COMPLETED)` на паспорт. | `QcService.completeQc` сознательно пишет НОВОЕ событие на каждый клик: «Каждое нажатие создаёт новое событие — это полезно, если ОТК после фиксации брака подтверждает повторно. Аудит видит всю историю, `qcCompletedAt` в карточке всегда соответствует последнему событию» (`apps/api/src/modules/qc/qc.service.ts:195-198`). Тест пинит count = 2 после × 2. | low | Решение продуктовое — текущая логика «история-как-источник-истины» намеренная (UI всегда читает последний `QC_PASSED` через `qcCompletedAt`). Достаточно обновить recon §6 invariant 6 и зафиксировать «idempotency = derived flag, not row count». Альтернатива (если потребуется): upsert по `(passportId, type=QC_PASSED, employeeId)` — но тогда теряется audit-история повторных подтверждений. |
| `WtoService.completeWto` (idempotency) | `tests/integration/wto-shift-flow.test.ts` → `FINDING: completeWto × 2 пишет два WTO_PASSED и два WTO_COMPLETED audit` | Аналогично QC — recon ожидал ровно одно событие/audit на паспорт. | Аналогично QC: `WtoService.completeWto` пишет новое событие на каждый клик («Каждое нажатие создаёт новое событие, как у QC. Аудит хранит всю историю, `wtoCompletedAt` — это всегда самое свежее `WTO_PASSED`», `apps/api/src/modules/wto/wto.service.ts:73-76`). Тест пинит count = 2 после × 2. | low | См. фикс выше. Симметричен QC: либо обновить recon §6, либо upsert; продуктовое решение пока — оставить как есть. |

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
