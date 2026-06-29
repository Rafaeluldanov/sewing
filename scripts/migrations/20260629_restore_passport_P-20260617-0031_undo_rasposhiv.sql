-- 2026-06-29 Восстановление паспорта P-20260617-0031 в состоянии ДО распошива.
--
-- Предыстория: паспорт (id cmqhuz19400kmsv8v6l78lnah) заказа O-20260615-0004
-- ранее был удалён (см. 20260629_delete_passport_P-20260617-0031.sql), т.к.
-- по нему ОШИБОЧНО прошли распошив. Решение пользователя изменено: паспорт
-- нужно ВЕРНУТЬ в заказ, но именно операцию РАСПОШИВ ОТМЕНИТЬ (она была
-- пройдена случайно).
--
-- Целевое состояние = «до распошива» (снято из предеплойного дампа 19.06.2026
-- prod_20260619_085214_predeploy_ac9e331, где паспорт ещё не был распошит):
--   * Passport: status=CREATED, в ячейке F12 (cmp2ndmt801knmhp50v7y8o61),
--     currentOperation=Деление кроя (cmosgtt1q0003f3iciou4qucf), без работника,
--     currentRouteStepIndex=0.
--   * События: только CREATED + CELL_PLACED. Распошивные события
--     (ISSUED_TO_EMPLOYEE / OPERATION_FINISHED от 22.06) НЕ восстанавливаются.
--   * Начисление за распошив (OperationEntry 14×20=280 ₽ PENDING_RELEASE,
--     Эсенгелдиева Динара) НЕ восстанавливается — распошив отменён.
--
-- WIP: движения этого паспорта остались в БД с passportId=NULL после удаления.
--   * PLACE +14 (sourceKey WIP_PLACE:cmqi2d4jr...) — возвращаем привязку к паспорту.
--   * ISSUE -14 (sourceKey WIP_ISSUE:cmqpfq9tm...) — это выдача на распошив,
--     отменяем: удаляем движение и возвращаем баланс ячейки. ISSUE был
--     последним движением на балансе cmqi2736v..., поэтому откат чистый:
--     текущий qty=24, ISSUE.balanceBeforeQty=38 → возвращаем баланс к 38.

BEGIN;

-- 1. Паспорт в состоянии «до распошива».
INSERT INTO "Passport" (
  id, number, "qrCode", "orderId", "productId", "sizeId", color, "rollNumber",
  "cutDate", "qtyPlan", "qtyCut", "qtyDefect", "qtyGood", status,
  "currentOperationId", "currentEmployeeId", "currentCellId", "cutterId",
  "creatorId", "pdfUrl", "createdAt", "updatedAt", "currentRouteStepIndex",
  "sampleId", "rollOrdinal"
) VALUES (
  'cmqhuz19400kmsv8v6l78lnah', 'P-20260617-0031', 'passport:cmqhuz19400kmsv8v6l78lnah',
  'cmqfo4qkm06wz10exassgvfff', 'cmq9o9i4e00fs10exop0rirxn', 'cmord8234000j7ay5dmpxnl3s',
  'черный', 'Рулон 7', '2026-06-17 00:00:00', 14, 14, 0, 14, 'CREATED',
  'cmosgtt1q0003f3iciou4qucf', NULL, 'cmp2ndmt801knmhp50v7y8o61', 'cmorfqgb90010xazkrlo7hsei',
  'cmor7nlbf0001p9h9h84firrs', NULL, '2026-06-17 09:18:18.905', '2026-06-17 12:45:13.668', 0,
  NULL, 7
);

-- 2. Только до-распошивные события: CREATED + CELL_PLACED.
INSERT INTO "PassportEvent" (
  id, "passportId", type, "operationId", "fromOperationId", "employeeId",
  qty, "defectQty", "cellId", "boxId", payload, "createdAt", "equipmentId"
) VALUES
  ('cmqhuz19700kosv8vgeeu0oxc', 'cmqhuz19400kmsv8v6l78lnah', 'CREATED',
   'cmosgtt1q0003f3iciou4qucf', NULL, 'cmor7nlbf0001p9h9h84firrs', 14, NULL, NULL, NULL,
   '{"color": "черный", "rollNumber": "Рулон 7"}'::jsonb, '2026-06-17 09:18:18.907', NULL),
  ('cmqi2d4jr00dgy85syucv7qns', 'cmqhuz19400kmsv8v6l78lnah', 'CELL_PLACED',
   NULL, NULL, NULL, 14, NULL, 'cmp2ndmt801knmhp50v7y8o61', NULL, NULL,
   '2026-06-17 12:45:13.671', NULL);

-- 3. WIP: вернуть привязку PLACE, отменить распошивный ISSUE, поднять баланс.
UPDATE "WorkInProgressMovement"
  SET "passportId" = 'cmqhuz19400kmsv8v6l78lnah'
  WHERE "sourceKey" = 'WIP_PLACE:cmqi2d4jr00dgy85syucv7qns';

DELETE FROM "WorkInProgressMovement"
  WHERE "sourceKey" = 'WIP_ISSUE:cmqpfq9tm02n9dn8ak91c5h8s';

UPDATE "WorkInProgressBalance"
  SET qty = 38
  WHERE id = 'cmqi2736v00cwy85shdvo8dra';

-- 4. Аудит: снять запись об удалении, залогировать восстановление-без-распошива.
DELETE FROM "AuditLog" WHERE id = 'audit-manual-del-P-20260617-0031';

INSERT INTO "AuditLog" (id, event, "entityType", "entityId", payload, "employeeId")
VALUES (
  'audit-manual-restore-P-20260617-0031',
  'PASSPORT_RESTORED',
  'PASSPORT',
  'cmqhuz19400kmsv8v6l78lnah',
  '{"number":"P-20260617-0031","orderId":"cmqfo4qkm06wz10exassgvfff","restoredTo":"pre-rasposhiv","note":"manual data-fix: паспорт возвращён в заказ в состоянии CREATED/в ячейке F12; распошив (ISSUED/FINISHED 22.06) и начисление 280 RUB Динаре отменены; WIP ISSUE откатан, баланс ячейки 24->38"}'::jsonb,
  NULL
);

COMMIT;
