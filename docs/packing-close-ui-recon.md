# Packing Close UI RECON

Дата: 2026-05-07. Контракт `docs/api.md §9`, поток `docs/flows.md §F7`,
ADR-0011 §5, ADR-0005 §«Подтверждение».

Назначение документа — зафиксировать **фактическое поведение** UI после
закрытия / сворачивания коробки в `/packing` и обосновать минимальный
безопасный фикс. Backend-логика `PackingService.close` не меняется.

## 1. Symptom

Пользователь нажимает на `/packing` (сценарий упаковщика, scan-driven
терминал) кнопку «Закрыть коробку (N шт.)» **или** «Свернуть карточку».
В обоих случаях карточка коробки исчезает с экрана:

- большая success-кнопка пропадает;
- сводка партии (изделие/цвет/размер, заполнение) исчезает;
- упаковщик возвращается к stage «Создать коробку» — без явного
  подтверждения «коробка закрыта» и **без** способа открыть карточку
  только что закрытой коробки.

Дополнительно «Свернуть карточку» приводит к тому, что коробка ещё
открыта в БД, но в UI её больше не видно: ссылку на неё упаковщик
тоже теряет (см. §3 ниже про `localStorage`).

## 2. Current backend behavior

Источник истины — [apps/api/src/modules/packing/packing.service.ts:390-446](apps/api/src/modules/packing/packing.service.ts#L390-L446).

`PackingService.close(boxId, actorEmployeeId)` под `@Roles('PACKING','SHOP_MANAGER')`:

1. `assertPackingActor` — у actor должна быть активная смена категории
   `PACKING`, иначе `409 PACKING_SHIFT_REQUIRED`.
2. В транзакции:
   - `Box.findUnique({ id })` → `404 BOX_NOT_FOUND`, если нет;
   - `box.closedAt != null` → `409 BOX_CLOSED` (идемпотентность);
   - `box.totalQty <= 0` → `409 BOX_EMPTY`;
   - `box.update({ closedAt: new Date() })`;
   - для каждого `BoxItem.passportId` → `EarningsService.approvePendingForPassport(tx, passportId)`,
     которая переводит `OperationEntry.status` из `PENDING_RELEASE`
     (legacy `PENDING`) в `APPROVED` и проставляет `approvedAt`;
   - `AuditService.log({ event: 'BOX_CLOSED', entityType: 'PACKING', entityId: boxId, payload: { boxId, totalQty, passportIds } })`.
3. Возвращает свежий `BoxDetailDto` через `getOne(id)`. У ответа
   `status === 'CLOSED'`, `closedAt` — ISO-строка, `items[]` остаётся
   заполнен.

Покрытие тестами:
- [tests/integration/packing-close-idempotent.test.ts](tests/integration/packing-close-idempotent.test.ts)
  — `BOX_CLOSED` audit count ровно 1 после close × 2; `approvedAt`
  не перезаписывается; смешанные `PENDING_RELEASE/CANCELLED/REVERSED/APPROVED`
  обрабатываются корректно; `BOX_EMPTY`-ветка не пишет audit.
- `tests/integration/production-flow.test.ts §F` — close happy path
  + переход PENDING_RELEASE → APPROVED через endpoint.
- `tests/integration/e2e-production-flow.test.ts` — `BOX_CLOSED` audit ≥ 1.

**Backend корректен.** Все проверки пройдут и не требуют изменений.

## 3. Current frontend flow

Все маршруты живут в `apps/web/app/packing`. Доступ закрыт через
[apps/web/app/packing/layout.tsx](apps/web/app/packing/layout.tsx) и
`canSeePacking` (`PACKING | SHOP_MANAGER | ADMIN`).

| Screen | File | Action | API call | After success |
|--------|------|--------|----------|---------------|
| `/packing` (роль `PACKING`) — scan-driven терминал | [apps/web/app/packing/packing-terminal.tsx:277-301](apps/web/app/packing/packing-terminal.tsx#L277-L301) | Кнопка «Закрыть коробку (N шт.)» → `handleClose` | `closeBoxTerminalAction` → [apps/web/lib/packing-api.ts:50-55](apps/web/lib/packing-api.ts#L50-L55) `closeBox` → `POST /api/packing/boxes/:id/close` | `setBox(null)`, `setInfo("Коробка X закрыта…")`. Карточка коробки удаляется из state, терминал возвращается к stage «Создать коробку». Ссылки на закрытую коробку нет. |
| `/packing` (роль `PACKING`) — scan-driven терминал | [apps/web/app/packing/packing-terminal.tsx:313-321](apps/web/app/packing/packing-terminal.tsx#L313-L321) | Кнопка «Свернуть карточку» → `handleLeaveBox` | **никакого API** — только `setBox(null)` + `setInfo(null) + setError(null)` | Карточка пропадает **без** info-сообщения. Эффект [apps/web/app/packing/packing-terminal.tsx:193-204](apps/web/app/packing/packing-terminal.tsx#L193-L204) видит `box === null` и удаляет `sewing.packing.activeBoxId` из `localStorage` — упаковщик теряет даже механизм восстановления через перезагрузку. Коробка остаётся открытой в БД. |
| `/packing` (роль `SHOP_MANAGER` / `ADMIN`) — список | [apps/web/app/packing/page.tsx:181-247](apps/web/app/packing/page.tsx#L181-L247) | `<select name="status">` (Все / OPEN / CLOSED) → submit `<form method="get">` | `listBoxes({ status })` → `GET /api/packing/boxes?status=...` | Перерисовывает таблицу. Дефолт — `Все` (`status` undefined). |
| `/packing/boxes/:id` (управленческая карточка) | [apps/web/app/packing/boxes/[id]/close-box-form.tsx](apps/web/app/packing/boxes/[id]/close-box-form.tsx) → [apps/web/app/packing/actions.ts:99-111](apps/web/app/packing/actions.ts#L99-L111) `closeBoxAction` | Кнопка «Закрыть коробку» | `closeBox` → `POST /api/packing/boxes/:id/close` | `revalidateBox(box)` — revalidate `/packing`, `/packing/boxes/:id`, `/orders/*`, `/passports/*`, `/earnings`. Возвращает `info: 'Коробка закрыта, начисления подтверждены'`. Страница перерисовывается, видна закрытая карточка с бейджем «Закрыта» и баннером «Коробка закрыта — изменения недоступны.» — здесь UX уже корректный. |

## 4. Box list filtering

- **Backend** ([apps/api/src/modules/packing/packing.service.ts:131-166](apps/api/src/modules/packing/packing.service.ts#L131-L166))
  возвращает все коробки по умолчанию (`where = {}`). Фильтр опционален:
  `?status=OPEN` → `closedAt: null`, `?status=CLOSED` → `closedAt: { not: null }`.
  Сортировка: `closedAt asc, createdAt desc` (открытые сверху).
- **Frontend management** (SHOP_MANAGER / ADMIN, [page.tsx](apps/web/app/packing/page.tsx))
  по умолчанию показывает **все** коробки и имеет явный селектор статуса
  «Все / Открытые / Закрытые». То есть со стороны менеджера закрытые
  коробки никуда не пропадают.
- **Frontend packing-терминал** (роль PACKING) **не использует list**
  вообще: упаковщик видит только активную коробку из state +
  восстановленную из `localStorage`. Никакого фильтра «только открытые»
  нет — закрытая коробка просто не сохраняется в state и пропадает,
  потому что компонент локально дропает её ссылку.

**Вывод.** Backend list нейтрален (по умолчанию отдаёт всё). Менеджерский
вид показывает закрытые и фильтрует через явный select. Терминал
PACKING ничего не «фильтрует» — он просто очищает state без
visual confirmation и без ссылки на закрытую коробку.

## 5. Payroll side effect

После успешного `close`:

- backend в той же транзакции апрувит `OperationEntry.status` ←
  `APPROVED` для всех passport-ов из коробки, `approvedAt` ставится
  один раз и не перезаписывается на повторных вызовах (см. §2 +
  packing-close-idempotent.test.ts тесты 2 и 3);
- `closeBoxAction` (legacy form-action на `/packing/boxes/:id`) уже
  выполняет `revalidatePath('/earnings')` — earnings-экраны увидят
  свежие APPROVED начисления;
- `closeBoxTerminalAction` (через `revalidateBox`) тоже обновляет
  `/earnings` — на стороне ревалидации мы уже правильны;
- паспорта в коробке давно `PACKED` (выставляется при addPassport,
  не при close — см. ADR-0011 §5), в карточках `/passports/:id`
  /`/admin/passports/:id` тоже ревалидация уже сделана.

UI-экраны, которые ДОЛЖНЫ обновиться:

- активная коробка терминала (`box.status` `OPEN` → `CLOSED`,
  `closedAt` заполнен);
- этикетка/детальная карточка (`/packing/boxes/:id`) — уже корректна;
- управленческий список (`/packing`) — фильтр «Все»/«Закрытые» уже
  работает.

Что **никак не меняется** этим тикетом: backend `close`, ADR-0005,
ADR-0011, payroll формула, schema, audit, статусы паспортов.

## 6. UX decision from current code

Сценарии «упаковщик теряет коробку» — два, и они разные:

1. **Закрыта (DB-close).** Коробка перешла в `CLOSED`, начисления
   APPROVED, audit записан. UI должен зафиксировать «коробка закрыта»
   так, чтобы упаковщик мог:
   - убедиться, что нажатие сработало;
   - при необходимости открыть карточку этой коробки (этикетка,
     состав, проверка, что всё ушло);
   - быстро начать новую.
2. **Свёрнута (client-only collapse).** Коробка в БД ещё открыта.
   Текущий код тихо стирает её и из state, и из `localStorage` — это
   и есть UI-баг: упаковщик не сделал ничего деструктивного, но
   потерял возврат к работе. Минимальный фикс — **не трогать**
   `localStorage` при сворачивании и показать на пустом stage явный
   баннер «Активная коробка №X свёрнута» с кнопкой «Вернуться к коробке».

Список «закрытые коробки» (на роль PACKING) сознательно не вводим —
управленческий вид с фильтром уже есть для `SHOP_MANAGER`/`ADMIN`,
а упаковщику достаточно прямой ссылки на только что закрытую коробку.

## 7. Recommended fix

Только UI, только в `apps/web/app/packing/packing-terminal.tsx`.

1. **После `closeBoxTerminalAction` success:** не сбрасывать
   `box` в `null`. Сохранить вернувшийся `BoxDetailDto` (теперь со
   `status: 'CLOSED'`, `closedAt` заполнен) в state. Карточка
   перерисовывается в режим «Закрыта»:
   - status-бейдж переключается на «Закрыта» (тот же стиль `done`,
     что в детальной странице);
   - блок действий (Сканировать / Закрыть / Свернуть) скрывается;
   - вместо них primary-кнопка «Создать новую коробку» (`setBox(null)`)
     и secondary-кнопка-ссылка «Открыть карточку коробки» →
     `/packing/boxes/:id` (детальная карточка с этикеткой/составом,
     уже корректно показывает CLOSED).
   - `info`-баннер «Коробка X закрыта. Начислено всем участникам.»
     остаётся.
   - Поле `lastAddedPassportId` сбрасывается, потому что бейдж «✓ только что»
     к закрытой коробке не относится.
2. **«Свернуть карточку»** (`handleLeaveBox`):
   - Не удаляет `sewing.packing.activeBoxId` из `localStorage`
     (эффект `localStorage` сохранения переписан — он смотрит на
     **id** коробки в state и на отдельный «collapsed»-флаг).
   - Запоминает `collapsedBoxId` в state, чтобы на пустом stage
     показать info-баннер «Карточка коробки X свёрнута, она ещё
     открыта» и кнопку «Вернуться к коробке» (по факту — вызывает
     `getActiveBoxAction(collapsedBoxId)` и кладёт результат в `box`).
   - Если коробка успела закрыться чужими руками — баннер исчезнет
     при следующем `getActiveBoxAction` (он вернёт CLOSED и тогда
     терминал тихо забудет id, как и сегодня).
3. **Ошибки close** (например, `409 BOX_CLOSED` при дубликате клика
   из-за лагов сети) — `error.message` уже передаётся через
   `explainApiError` и попадает в `error-box`. Дополнительно
   ничего скрывать не надо — сообщение `[BOX_CLOSED] …` остаётся
   видимым.

Что не делаем:

- не меняем `apps/web/app/packing/boxes/[id]/page.tsx` и его форму
  «Закрыть коробку» — там UX уже правильный (страница
  перерисовывается, статус «Закрыта», блок действий скрыт);
- не правим backend, prisma, payroll, audit;
- не вводим новый list-эндпоинт «закрытые коробки для упаковщика» —
  ссылка на детальную карточку покрывает сценарий за один клик.
