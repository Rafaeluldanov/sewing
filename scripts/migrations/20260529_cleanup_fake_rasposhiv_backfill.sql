-- 2026-05-29: чистка фейк-OPERATION_FINISHED РАСПОШИВ + бэкфилл Распошив
-- рукав для P-0058.
--
-- Контекст. Накануне (см. 20260529_unblock_5_passports_stuck_at_otk.sql)
-- на пяти паспортах был записан фейк OPERATION_FINISHED на РАСПОШИВ (04)
-- от мастера Урмановой, чтобы пройти AND-гейт параллельной группы
-- старого шаблона 01.
--
-- После того как все 8 чёрных заказов переведены на шаблон 02
-- (см. 20260529_swap_black_orders_to_split_route.sql), РАСПОШИВ (04)
-- не является шагом маршрута, а реальная работа учтена событиями на
-- Подгиб низа (0001) + Распошив рукав (16) от швей. Фейк РАСПОШИВ стал
-- лишним.
--
-- Особенность P-20260506-0058: у него реально НЕТ OPERATION_FINISHED на
-- «Распошив рукав» (Кисембаева Перизат его не закрывала). Если просто
-- удалить фейк РАСПОШИВ — паспорт всё равно уже прошёл ВТО (WTO_PASSED от
-- Токтогулова Жениша 2026-05-29 05:32 UTC, ещё на старом маршруте 01).
-- Дальнейший флоу — PackingService.addPassport — не дёргает AND-гейт,
-- а только QC_PASSED/WTO_PASSED. Однако для чистоты данных дозаписываем
-- ретроспективный Распошив рукав от Кисембаевой, чтобы параллельная группа
-- на новом маршруте 02 была формально полной.
--
-- Уже применено на проде 2026-05-29 ~09:35 UTC.

BEGIN;

CREATE TEMP TABLE _removed AS
SELECT e.id AS event_id, p.number AS passport_number, p.id AS passport_id, e.qty
FROM "PassportEvent" e
JOIN "Passport" p ON p.id = e."passportId"
WHERE p.number IN ('P-20260506-0044','P-20260506-0046','P-20260506-0058','P-20260506-0072','P-20260506-0076')
  AND e.type = 'OPERATION_FINISHED'
  AND e."operationId" = 'cmorgh5oh000310sv7nyr7fve'  -- РАСПОШИВ (04)
  AND e."employeeId" = 'cmoraoxno0007tjnvx91aasrt'   -- Урманова Гульзафира
  AND e.payload->>'backfill' = 'parallel-group-gate-unblock';

DELETE FROM "PassportEvent" WHERE id IN (SELECT event_id FROM _removed);

INSERT INTO "PassportEvent" (id, "passportId", type, "operationId", "employeeId", qty, payload, "createdAt")
SELECT
  'pe_' || substring(md5(random()::text || p.id) for 24),
  p.id,
  'OPERATION_FINISHED',
  'cmppcv3sz01vra82gmurd3fe3',  -- Распошив рукав (16, post-merge canonical)
  'cmorj1tz9003snwz8m14befvc',  -- Кисембаева Перизат
  p."qtyGood",
  jsonb_build_object(
    'backfill','missing-rasposhiv-rukav-by-perizat',
    'reason','seamstress Перизат did the sleeve coverstitch physically but did not scan; recorded retroactively to keep parallel-group AND-gate satisfied on split route 02',
    'by','master:Urmanova'
  ),
  now()
FROM "Passport" p
WHERE p.number = 'P-20260506-0058';

INSERT INTO "AuditLog" (id, event, "entityType", "entityId", "employeeId", payload, "createdAt")
SELECT
  'al_' || substring(md5(random()::text || r.passport_id) for 24),
  'BACKFILL_REVERTED',
  'PASSPORT',
  r.passport_id,
  'cmoraoxno0007tjnvx91aasrt',
  jsonb_build_object(
    'reason','CLEANUP_AFTER_ROUTE_02_SWAP',
    'comment','Удалён вчерашний бэкфилл OPERATION_FINISHED на РАСПОШИВ (04) от Урмановой (использовался для прохода старого AND-гейта параллельной группы шаблона 01). На новом маршруте 02 РАСПОШИВ не является шагом, а реальная работа уже зафиксирована событиями на Подгиб низа + Распошив рукав от швей.',
    'removedEventId', r.event_id,
    'replacedWith', CASE
      WHEN r.passport_number = 'P-20260506-0058'
        THEN jsonb_build_object(
          'type','OPERATION_FINISHED',
          'operationId','cmppcv3sz01vra82gmurd3fe3',
          'operationName','Распошив рукав',
          'employeeId','cmorj1tz9003snwz8m14befvc',
          'employeeName','Кисембаева Перизат',
          'qty', r.qty,
          'note','sleeve work physically done but not scanned; recorded retroactively'
        )
      ELSE NULL
    END
  ),
  now()
FROM _removed r;

COMMIT;
