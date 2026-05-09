# Migration 20260620100000_add_work_in_progress_drop_cell_content

## Что делает

Атомарно (в одной транзакции Prisma):

1. Создаёт таблицы `WorkInProgressBalance` и `WorkInProgressMovement`
   со всеми индексами и FK (см. `prisma/schema.prisma::WorkInProgressBalance`/`Movement`).
2. **Backfill**: переносит существующее содержимое ячеек из legacy
   `CellContent` (плюс контекст из `Passport`: `orderId` /
   `productId` / `color` / `warehouseId`) в новые WIP-таблицы:
   - `WorkInProgressBalance` — одна строка на каждую уникальную
     комбинацию `(orderId, productId, sizeId, color, warehouseId?,
     cellId)` с `qty = SUM(passport.qtyCut)`;
   - `WorkInProgressMovement` — одно `PLACE` `IN`-движение на каждый
     живой паспорт-в-ячейке с `sourceKey = WIP_PLACE_BACKFILL:<passportId>`,
     `sourceType = 'BACKFILL'`.
3. Дропает таблицу `CellContent`.

**Источник правды для backfill — `Passport`** (а не `CellContent`):
у `CellContent` нет `orderId`/`productId`/`color`, которые требуются
новой моделе. Для паспортов в `PACKED`/`CANCELLED` backfill не
выполняется (они логически не «лежат в ячейке»).

## Зачем

После этой миграции `WorkInProgressBalance` становится **единственным
источником истины** для «что лежит в ячейках» — в противоположность
legacy `CellContent`, у которой не было ни заказа, ни цвета. Это
открывает дорогу к фиче «промежуточный контроль расхода материала на
выпуске кроя» (привязка `MaterialIssue` к конкретному
`WorkInProgressMovement.PLACE`).

См. `docs/erd.md §2.7b`, `docs/api.md §29b`,
`docs/recon-soft-integration.md §«RESOLUTION 2026-05-09»`.

## План деплоя на прод

Прод: ~500 паспортов; backfill отрабатывает за ~50 мс. Окна простоя
не нужно, но рекомендуется деплоить в окне минимального трафика.

### Шаг 0 — бэкап БД (обязательно)

```bash
# На проде, под доступом к docker-инстансу БД:
bash scripts/backup-db.sh
# Должен создаться файл вида backup-prod-YYYYMMDD-HHmmss.sql.gz
```

Без свежего бэкапа дальше **не идти**. Если verification на шаге 3
покажет MISMATCH/FAIL — единственный путь отката это restore из
бэкапа, никаких «down»-миграций для DROP CellContent у нас нет.

### Шаг 1 — деплой кода + применение миграции

```bash
# На проде, в окне деплоя:
git pull origin main                # подтянуть свежий код
npm ci                              # установить зависимости
npx prisma generate                 # обновить Prisma client
npx prisma migrate deploy           # применить миграцию (атомарно)
# Перезапустить API/web (через ваш systemd / pm2 / docker compose).
```

`prisma migrate deploy` выполнит ровно ОДНУ новую миграцию
(`20260620100000_add_work_in_progress_drop_cell_content`). Внутри
неё — атомарный CREATE → backfill → DROP. Либо всё, либо ничего.

### Шаг 2 — verification (read-only)

```bash
# Сразу после успешного migrate deploy:
psql "$DATABASE_URL" -f scripts/migrations/20260620_verify_work_in_progress.sql
```

Должны увидеть **`verdict = OK`** на всех 5 проверках:
- (a) счёт паспортов-в-ячейках совпадает с числом WIP-балансов;
- (b) сумма `passport.qtyCut` совпадает с суммой
  `WorkInProgressBalance.qty`;
- (c) на каждый живой паспорт-в-ячейке создано ровно одно
  BACKFILL-PLACE-движение;
- (d) нет отрицательных WIP-балансов;
- (e) `CellContent` действительно дропнута.

Если **хоть один** verdict ≠ `OK`:
- НЕ продолжайте раскатку, остановите API.
- Восстановите БД из бэкапа шага 0
  (`gunzip -c backup-…sql.gz | psql "$DATABASE_URL"`).
- Откатите код к предыдущему коммиту (`git reset --hard <prev>` +
  redeploy).
- Свяжитесь с автором миграции (см. git blame по
  `prisma/migrations/20260620100000_…`).

### Шаг 3 — функциональный smoke в UI

После зелёного verification:
1. Открыть `/admin/warehouses` → вкладку «Остатки» → выбрать «склад
   кроя» → должны появиться все ~500 паспортов с полным контекстом
   (заказ, размер, цвет).
2. Открыть `/admin/warehouses/[id]` любого склада → ячейки должны
   показывать содержимое (читается через `loadCellContentsFromWip`).
3. Выпустить тестовый паспорт через `/passports/[id]/place`,
   убедиться, что строка появилась в WIP `Остатки`.
4. Швея забирает этот паспорт → строка обнулилась, движение `ISSUE`
   появилось в `Движения`.
5. Master `returnToCell` → `RETURN` появилось.
6. Удалить ещё один тестовый паспорт-в-ячейке через UI → `DELETE`-
   движение появилось, баланс ушёл в 0.

## Откат миграции (если что-то пошло не так)

«Down»-миграции **нет**. Восстановление — только из бэкапа шага 0:

```bash
# 1. Остановить API, чтобы никто не писал в БД:
systemctl stop sewing-api    # или ваша команда

# 2. Восстановить дамп:
gunzip -c backup-prod-YYYYMMDD-HHmmss.sql.gz | psql "$DATABASE_URL"

# 3. Откатить код:
git reset --hard <commit-before-this-migration>
npm ci && npx prisma generate

# 4. Перезапустить API:
systemctl start sewing-api
```

После отката код снова видит `CellContent`, миграция в
`_prisma_migrations` отсутствует — следующий `migrate deploy`
попробует применить её заново. Это нормально: либо чините миграцию,
либо удаляете строку с её именем из `_prisma_migrations`, если
успели частично применить.

## Что не нужно делать

- ❌ Не запускать `prisma migrate reset` на проде — это убьёт
  данные.
- ❌ Не запускать `prisma db push` на проде — игнорирует историю
  миграций.
- ❌ Не редактировать `migration.sql` после того, как миграция
  применилась хоть на одном окружении — Prisma ругнётся checksum'ом.
- ❌ Не пропускать verification (шаг 2) — это единственная
  гарантия, что данные перенеслись корректно.

## Связанные изменения кода

- `prisma/schema.prisma` — добавлены модели `WorkInProgressBalance`,
  `WorkInProgressMovement`; удалена `CellContent`; обновлены
  back-relations на `Order`/`Product`/`Size`/`Warehouse`/`Cell`/
  `Passport`.
- `apps/api/src/modules/work-in-progress/` — новый модуль с
  сервисом, контроллером и DTO.
- `apps/api/src/modules/passports/passports.service.ts` —
  `place`/`issueToEmployee`/`delete` пишут WIP вместо CellContent;
  `listCells`/`getCell`/`findCellByCode` читают `cell.contents` из
  WIP через хелпер `loadCellContentsFromWip`.
- `apps/api/src/modules/master-actions/master-actions.service.ts` —
  `returnToCell` и `setRouteStep` (backward + cell) пишут `RETURN`
  IN-движение.
- `apps/api/src/modules/packing/packing.service.ts` — defensive
  `PACK_OUT`-движение если паспорт пакуется прямо из ячейки.
- `apps/api/src/modules/warehouses/warehouses.service.ts` —
  `deleteLine` проверяет занятость ячеек через
  `workInProgressBalances.qty > 0` вместо `_count.contents`.
- `apps/api/src/modules/diagnostics/diagnostics.service.ts` —
  диагностика `WORK_IN_PROGRESS_NEGATIVE` вместо
  `CELL_CONTENT_NEGATIVE`.
- Frontend: добавлен `lib/work-in-progress-api.ts`, mappers в
  `components/warehouses/stock/unified-rows.ts`, third source в
  `app/admin/warehouses/page.tsx`.
- Тесты: 155 integration green; ~6 файлов с прямым `prisma.cellContent.*`
  переписаны на `prisma.workInProgressBalance.*`.

## Контакты

См. git blame на этой миграции; вопросы по модели — в
`docs/erd.md §2.7b`, по бизнес-флоу — в
`docs/flows.md §F3` / `§F-Master`.
