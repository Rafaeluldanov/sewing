-- Импорт справочника заказчиков из выгрузки TEEON (PDF «TEEON — Заказчики»,
-- 19 строк, 1 страница). Применено на прод 29.06.2026 по просьбе пользователя
-- «есть список заказчиков: можешь их добавить в базу?».
--
-- Маппинг колонок PDF → model Client (см. prisma/schema.prisma::Client):
--   «Наименование»                → name (= официальное юр-имя, первично в UI).
--   «Внутренне название для нас»  → comment (как есть; пусто → NULL).
-- phone/email в выгрузке нет → NULL. isActive по умолчанию true.
-- Названия сохранены дословно (форма собственности где спереди, где сзади).
--
-- Идемпотентно: id — реальные cuid, сгенерированные Prisma при первой
-- заливке (createMany через sewing-prod-api-1), поэтому повторный прогон
-- ничего не дублирует (ON CONFLICT (id) DO NOTHING). Существующая карточка
-- «ИП ПЕТРОВ» не затрагивается.
--
-- Первая заливка шла через Prisma createMany (не этим SQL); файл —
-- журнальная фиксация применённого на прод изменения, replayable на dev.

BEGIN;

INSERT INTO "Client" (id, name, phone, email, comment, "isActive", "createdAt", "updatedAt")
SELECT
  src.id,
  src.name,
  NULL,
  NULL,
  NULLIF(src.comment, ''),
  true,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM (VALUES
  ('cmqyvbrcv000dmojlw43ujshj', 'АГРО-АЛЬЯНС ООО',                          ''),
  ('cmqyvbrcv0006mojlvczvnwgu', 'АКЦИОНЕРНОЕ ОБЩЕСТВО "БРИКСО"',            ''),
  ('cmqyvbrcv0007mojln2l8rqh2', 'АО РОСАГРОЛИЗИНГ',                         ''),
  ('cmqyvbrcv0004mojl85jqs7gh', 'ВВПОД «ЮНАРМИЯ»',                          ''),
  ('cmqyvbrcv000gmojlvgjz19l0', 'В/ОИЗОТОП АО',                             'РосАтом'),
  ('cmqyvbrcv0000mojlmlcj88io', 'ЗАЛА АЭРО АО',                             ''),
  ('cmqyvbrcv000emojlgnuf2bz1', 'КАЗАНЬОРГСИНТЕЗ ПАО',                      'Сибур'),
  ('cmqyvbrcv000fmojlzgnq13j7', 'КАРДАН АО',                               'Кардан Самара (скоро встанут Худи)'),
  ('cmqyvbrcv000hmojldww4yag1', 'КОНСИСТ ООО',                              ''),
  ('cmqyvbrcv0002mojl22pl5f37', 'К-ФЛЕКС ООО',                              ''),
  ('cmqyvbrcv000imojlkp1uq95k', 'МИЛМОНД АО',                               'Хаме Фудс'),
  ('cmqyvbrcv0008mojll6hon4xd', 'МИСТРАЛЬ ТРЕЙДИНГ ООО',                    ''),
  ('cmqyvbrcv000cmojlyysyifcc', 'МИШЕЛЬ И К ООО',                           'Молочные жилеты (подразделение Мистраля)'),
  ('cmqyvbrcv0001mojlxytf54mu', 'НОВЫЕ СТРОИТЕЛЬНЫЕ МАТЕРИАЛЫ ООО',         'Steingot'),
  ('cmqyvbrcv0009mojl6lrvhtnx', 'НПП ИТЭЛМА ООО',                           ''),
  ('cmqyvbrcv0005mojl285kdyws', 'ООО "ТД-ВИК"',                            ''),
  ('cmqyvbrcv000amojlfdq8yj49', 'РОССИЯ - СТРАНА ВОЗМОЖНОСТЕЙ АНО РСВ АНО', ''),
  ('cmqyvbrcv000bmojliuu4p2of', 'СИСТЕМА АЛЕАН ООО',                        ''),
  ('cmqyvbrcv0003mojlftdjdtk2', 'СПОРТИВНЫЙ КОМПЛЕКС ОЛИМПИЙСКИЙ АО',       'Жилеты Бархат')
) AS src(id, name, comment)
ON CONFLICT (id) DO NOTHING;

COMMIT;
