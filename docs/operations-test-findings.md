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
