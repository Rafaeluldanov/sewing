-- 2026-06-29 Удаление ошибочно обработанного паспорта P-20260617-0031.
--
-- Паспорт (id cmqhuz19400kmsv8v6l78lnah) заказа O-20260615-0004
-- (id cmqfo4qkm06wz10exassgvfff), размер cmord8234000j7ay5dmpxnl3s,
-- цвет «черный», Рулон 7, qtyCut=14. Статус был IN_PROGRESS.
--
-- Контекст: паспорт был выпущен и по нему ОШИБОЧНО закрыли распошив —
-- ISSUED_TO_EMPLOYEE + OPERATION_FINISHED на «РАСПОШИВ ФУТБОЛКА»
-- (Эсенгелдиева Динара, 22.06.2026). За это висело начисление
-- OperationEntry 14×20=280 ₽ в статусе PENDING_RELEASE (НЕ выплачено).
-- По решению пользователя паспорт удаляется целиком вместе с начислением.
--
-- Зеркалит PassportsService.delete (менеджерская ветка): сносим
-- defects -> entries -> events -> сам паспорт. WIP-движения этого
-- паспорта (PLACE +14 / ISSUE -14, баланс уже нулевой) занулятся
-- автоматически по FK onDelete: SET NULL — исторический след сохраняется.
-- FG/MaterialIssue/Box/CostSnapshot по паспорту отсутствуют.

BEGIN;

DELETE FROM "PassportDefect" WHERE "passportId" = 'cmqhuz19400kmsv8v6l78lnah';
DELETE FROM "OperationEntry" WHERE "passportId" = 'cmqhuz19400kmsv8v6l78lnah';
DELETE FROM "PassportEvent"  WHERE "passportId" = 'cmqhuz19400kmsv8v6l78lnah';

INSERT INTO "AuditLog" (id, event, "entityType", "entityId", payload, "employeeId")
VALUES (
  'audit-manual-del-P-20260617-0031',
  'PASSPORT_DELETED',
  'PASSPORT',
  'cmqhuz19400kmsv8v6l78lnah',
  '{"number":"P-20260617-0031","orderId":"cmqfo4qkm06wz10exassgvfff","sizeId":"cmord8234000j7ay5dmpxnl3s","qtyCut":14,"cellId":null,"actorRole":null,"note":"manual data-fix: ошибочно обработанный паспорт; снято начисление PENDING_RELEASE 280 RUB (Эсенгелдиева Динара, РАСПОШИВ ФУТБОЛКА)"}'::jsonb,
  NULL
);

DELETE FROM "Passport" WHERE id = 'cmqhuz19400kmsv8v6l78lnah';

COMMIT;
