# Packing Open Boxes RECON

Дата: 2026-05-08. Контракт: `docs/api.md §9`, `docs/flows.md §F7`,
ADR-0011. Связанный RECON: `docs/packing-close-ui-recon.md` (зафиксировал
post-close UX и состояние «свёрнутой» карточки).

Назначение — зафиксировать, **почему упаковщик в `/packing` видит
максимум одну коробку за раз**, и обосновать минимальный фикс: вывести
полный список открытых коробок прямо в скан-driven терминал.

## 1. Symptom

- Пользователь с ролью `PACKING` на `/packing` видит **только последнюю**
  коробку — ту, которую он сам только что создал (либо «активную» из
  `localStorage`).
- Все остальные открытые в БД коробки (например, созданные другим
  упаковщиком на параллельной смене или оставленные открытыми вчера)
  упаковщик не видит и не может в них попасть, не зная id.
- Ожидание — упаковщик видит **все незакрытые коробки** (`closedAt = null`),
  понимает, какие пакуются прямо сейчас, и может вернуться в нужную.

## 2. Backend behavior

| Method / endpoint | File | Returns all boxes? | Filters closed? | Sort/order | Notes |
|---|---|---|---|---|---|
| `PackingService.list({ status, page, pageSize })` | [apps/api/src/modules/packing/packing.service.ts:131-166](apps/api/src/modules/packing/packing.service.ts#L131-L166) | Да, постранично (`pageSize ≤ 200`, default 50, [packages/shared/src/packing.ts:83-89](packages/shared/src/packing.ts#L83-L89)). | Опционально: `status=OPEN` → `closedAt: null`, `status=CLOSED` → `closedAt: { not: null }`, иначе все. | `[{ closedAt: 'asc' }, { createdAt: 'desc' }]` — открытые сверху, среди них новые первее. | Возвращает `BoxesPage = { items, total, page, pageSize }`. |
| `GET /api/packing/boxes` | [apps/api/src/modules/packing/packing.controller.ts:56-61](apps/api/src/modules/packing/packing.controller.ts#L56-L61) | Тонкая обёртка над `PackingService.list`. | Тот же фильтр. | Тот же. | `@Roles('PACKING','SHOP_MANAGER')` — упаковщик имеет доступ. |
| `PackingService.getOne(id)` | [apps/api/src/modules/packing/packing.service.ts:172-175](apps/api/src/modules/packing/packing.service.ts#L172-L175) | Один box — для активной карточки. | — | — | Используется для restore коробки в терминале. |
| `PackingService.create / addPassport / close` | [apps/api/src/modules/packing/packing.service.ts](apps/api/src/modules/packing/packing.service.ts) | Точечные мутации. | — | — | На фикс никак не влияют — backend для ролей `PACKING` уже корректен. |

Итог: **backend list уже умеет отдавать все open boxes** через
`?status=OPEN&pageSize=100`. Никаких backend-изменений не требуется.

## 3. Frontend behavior

| Screen / component | File | Data source | Current rendering | Problem |
|---|---|---|---|---|
| `/packing` server page (роль `PACKING`) | [apps/web/app/packing/page.tsx:35-105](apps/web/app/packing/page.tsx#L35-L105) | Не вызывает `listBoxes`. Передаёт в терминал только `meta`/`shift`/`employee`. | Терминал получает 0 коробок и сам управляет одним «активным» box-DTO. | Список открытых коробок в `/packing` для PACKING-роли просто **не загружается**. |
| `PackingTerminal` → `PackingMainTerminal` | [apps/web/app/packing/packing-terminal.tsx:141-310](apps/web/app/packing/packing-terminal.tsx#L141-L310) | Локальный `useState<BoxDetailDto \| null>(null)` + восстановление по `localStorage` (`getActiveBoxAction`). | Один state `box`. Stage 1 (нет коробки) → CTA «Создать коробку». Stage 2 → карточка одной коробки + сканирование. После collapse/close — снова Stage 1 (теперь с баннером свёрнутой коробки и success-карточкой соответственно — см. `packing-close-ui-recon.md`). | Видна **ровно одна** коробка — та, что в state. Всё остальное упаковщик не видит. |
| `/packing` server page (роль `SHOP_MANAGER`/`ADMIN`) | [apps/web/app/packing/page.tsx:107-249](apps/web/app/packing/page.tsx#L107-L249) | `listBoxes({ status, page: 1, pageSize: 100 })` — управленческая таблица с явным фильтром. | Полная таблица с фильтром `OPEN/CLOSED/Все`. | Тут UX правильный, но это не для упаковщика. |
| API helper | [apps/web/lib/packing-api.ts:17-27](apps/web/lib/packing-api.ts#L17-L27) | `apiFetch('/packing/boxes', { searchParams })`. | Не зашит `pageSize=1`. | Хелпер нейтрален — никаких ограничений «один box». |
| Server actions | [apps/web/app/packing/actions.ts:120-235](apps/web/app/packing/actions.ts#L120-L235) | `createBoxTerminalAction` / `scanPassportToBoxAction` / `closeBoxTerminalAction` / `getActiveBoxAction`. | Все возвращают одиночный `BoxDetailDto`. Нет action для «список открытых коробок». | Терминалу неоткуда подтянуть полный список — только point-fetch одной коробки по id. |

## 4. Root cause

Терминал спроектирован как **single-active-box state-machine**, потому
что упаковка — это последовательность скан-событий по одной коробке.
В этом state-machine просто **нет места под список параллельных
коробок**: ни prop, ни state-поля, ни action для `listBoxes`. Backend
к этому не имеет отношения — он давно умеет отдавать `?status=OPEN`,
просто никто его об этом не просит со стороны `/packing` для роли
PACKING. См. таблицу §3, строки 1 и 2.

## 5. Required behavior

- **PACKING видит все boxes, у которых `closedAt = null`** (= status `OPEN`)
  на главном экране `/packing`, до того как «зашёл» в конкретную
  коробку.
- Каждая запись в списке: номер, totalQty/maxQty, бейдж «Открыта»,
  кто открыл и когда, кнопка «Продолжить упаковку» (= сделать активной
  в терминале).
- Сортировка повторяет backend: открытые по `createdAt desc` (новейшие
  сверху).
- **Создание новой коробки** не скрывает остальные: после
  `createBoxTerminalAction` → новая коробка становится активной (stage 2),
  но при возврате к stage 1 (collapse / start-new) — список уже
  пере-фечен и содержит и её, и старые открытые.
- **Закрытие коробки** убирает её из списка (потому что она больше не
  open). Остальные открытые коробки видны и доступны. Closed-success
  карточка по-прежнему рендерится из `box.status === 'CLOSED'` по
  `packing-close-ui-recon.md §7`.
- **Коробка, оставленная свёрнутой** (`collapsedBoxId`), показывается
  и в списке, и в баннере «Карточка свёрнута» — баннер выступает
  primary-CTA, список — равноправной альтернативой.
- Закрытые коробки в open-list **не должны** появляться. Если они
  нужны — управленческий вид `/packing` (SHOP_MANAGER/ADMIN) с
  фильтром `CLOSED` по-прежнему доступен.

## 6. Risks

- **Случайно показать closed boxes в open-list** → митигация: фильтр
  `status=OPEN` на backend (а не клиентский фильтр); статически
  фиксируем в smoke-тесте.
- **Сломать post-close UX** (`packing-close-ui-recon.md`) → митигация:
  не трогаем `handleClose` / `handleLeaveBox` / closed-success ветку,
  только добавляем фоновый refresh списка после них.
- **Сломать addPassport / close** → митигация: не правим backend и
  серверные actions мутаций (`scanPassportToBoxAction`,
  `closeBoxTerminalAction`); добавляется только новый read-only action
  `listOpenBoxesAction`.
- **Сломать payroll APPROVE-flow при close** → митигация: backend
  `PackingService.close` не меняется; он же покрыт
  [tests/integration/packing-close-idempotent.test.ts](tests/integration/packing-close-idempotent.test.ts).
- **Race-condition «другой упаковщик закрыл коробку»**: при клике
  «Продолжить упаковку» вызывается `getActiveBoxAction(id)`. Если
  коробка уже `CLOSED` — кладём её в state как closed (рендерится
  closed-success карточка, без эксепшнов). Если ушла в 404 — показываем
  ошибку и тихо чистим её из списка.
- **Перформанс на сотнях открытых коробок**: backend pageSize cap = 200,
  фактический pageSize запроса = 100; в реальном цеху открытых коробок
  единицы. Пагинацию терминала не вводим (не нужна для MVP).

## 7. Recommended fix

1. **Server action** [apps/web/app/packing/actions.ts](apps/web/app/packing/actions.ts):
   добавить `listOpenBoxesAction(): Promise<PackingTerminalResult<BoxListItemDto[]>>`
   — тонкая обёртка над `listBoxes({ status: 'OPEN', page: 1, pageSize: 100 })`.
2. **Server page** [apps/web/app/packing/page.tsx](apps/web/app/packing/page.tsx):
   для роли `PACKING` запросить `listBoxes({ status: 'OPEN', page: 1, pageSize: 100 })`
   рядом с `meta`/`shift` и передать `initialOpenBoxes={items}` в
   `<PackingTerminal>`. Для `SHOP_MANAGER`/`ADMIN` ничего не меняется.
3. **Terminal** [apps/web/app/packing/packing-terminal.tsx](apps/web/app/packing/packing-terminal.tsx):
   - `Props.initialOpenBoxes: BoxListItemDto[]`, прокидываем до
     `PackingMainTerminal`.
   - `useState<BoxListItemDto[]>(initialOpenBoxes)` — `openBoxes`.
   - Функция `refreshOpenBoxes()` — `listOpenBoxesAction()` → `setOpenBoxes`,
     fail-soft (если упало, оставляем прежний список).
   - На stage 1 (`!box`) рендерим компактный список открытых коробок
     **под** баннером collapsed-box (если есть) и над/под CTA
     «Создать коробку». Каждая строка — `scan-card`-стиль с
     номером, totalQty/maxQty, кнопкой «Продолжить упаковку»
     (`onClick={() => continueBox(item.id)}`), доп. ссылка
     «Карточка коробки» → `/packing/boxes/:id`.
   - `continueBox(id)` = `getActiveBoxAction(id)` → `setBox(res.data)`,
     обновляем `openBoxes` (refresh).
   - Хуки refresh после: `handleCreateBox` success, `handleClose`
     success (новая коробка стала CLOSED — её надо убрать из списка),
     `handleLeaveBox` (collapsed надо вернуть в видимость, хотя она и
     не уходила), `handleRestoreCollapsedBox` success.
4. **Smoke-тест** [tests/smoke/packing-open-boxes.smoke.test.ts](tests/smoke/packing-open-boxes.smoke.test.ts) —
   статически фиксирует контракты §5 + отсутствие `boxes[0]` /
   `slice(0, 1)` / `pageSize: 1` на пути PACKING-терминала.
5. **Никаких изменений** в:
   - `prisma/schema.prisma`;
   - `PackingService.create / list / addPassport / close`;
   - `EarningsService.approvePendingForPassport`;
   - `apps/web/app/packing/boxes/[id]/*` (управленческая карточка);
   - QC/WTO/shifts/auth/QR.
