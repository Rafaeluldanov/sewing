# Архитектура системы

> Источник истины. Если код расходится с этим документом — правим код.

---

## 1. Назначение системы

Система управления швейным производством на базе «Паспорта изделия» —
единого документа, сопровождающего партию изделий через все этапы
(раскрой → пошив → ОТК → ВТО → упаковка).

Ключевые функциональные блоки:

- выдача и маршрутизация паспортов через QR;
- учёт плана/факта (план не меняется);
- расчёт зарплат (сдельная и окладная);
- ОТК и учёт брака;
- упаковка как точка выпуска;
- ячейки как лёгкое WMS-упрощение;
- дашборды (агрегаты) и экран «Цех» (поток производства).

---

## 2. Архитектурные принципы

1. **Паспорт — агрегат-корень.** Всё крутится вокруг него.
2. **Событийная модель.** Все изменения состояния паспорта — это события
   (`PassportEvent`). Текущее состояние паспорта — денормализованная
   проекция событий.
3. **План иммутабелен.** После создания заказа `qty_plan` не меняется.
4. **Справочники — не хардкод.** Размеры, операции, продукты, ставки —
   таблицы БД, сидируемые на старте.
5. **Mobile-first, всё через QR.** Любое действие сотрудника на полу цеха
   инициируется сканированием.
6. **Realtime = polling (MVP).** Никаких WS/SSE на MVP — polling
   агрегатов каждые 2–5 сек.
7. **Единый язык.** В коде и БД — английские термины (см. `domain.md`),
   в UI — русские.

---

## 3. Технологический стек

| Слой           | Технология                                         |
| -------------- | -------------------------------------------------- |
| Язык           | TypeScript (strict)                                |
| Frontend       | Next.js 14 (App Router), React Server Components   |
| PWA            | next-pwa / Workbox, manifest, service worker       |
| Backend        | NestJS 10, REST (OpenAPI)                          |
| БД             | PostgreSQL 15+                                     |
| ORM            | Prisma 5                                           |
| Аутентификация | JWT (access + refresh), httpOnly cookie            |
| QR             | `qrcode` (генерация), `html5-qrcode` (сканирование)|
| PDF            | `pdfkit` или `@react-pdf/renderer` (серверно)     |
| Валидация      | Zod (shared) + class-validator (Nest DTO)          |
| Логи           | pino                                               |
| Тесты          | Vitest (unit), Playwright (e2e MVP smoke)          |

---

## 4. Структура репозитория (монорепо)

```
sewing/
├── apps/
│   ├── web/                    # Next.js 14 PWA (клиент)
│   │   ├── app/                # App Router
│   │   ├── components/
│   │   ├── lib/                # api client, qr, auth helpers
│   │   └── public/             # manifest, icons
│   └── api/                    # NestJS backend
│       ├── src/
│       │   ├── modules/
│       │   │   ├── auth/
│       │   │   ├── orders/
│       │   │   ├── passports/
│       │   │   ├── operations/
│       │   │   ├── movements/  # переходы между операциями
│       │   │   ├── cells/
│       │   │   ├── qc/
│       │   │   ├── packing/
│       │   │   ├── payroll/
│       │   │   ├── dashboard/
│       │   │   └── shopfloor/  # экран «Цех»
│       │   ├── common/         # guards, interceptors, pipes
│       │   ├── events/         # event bus, emitters
│       │   └── main.ts
│       └── test/
├── packages/
│   └── shared/                 # shared DTO/Zod-схемы/enums/types
├── prisma/
│   ├── schema.prisma
│   ├── seed.ts
│   └── migrations/
├── docs/
│   ├── index.md
│   ├── architecture.md
│   ├── domain.md
│   ├── erd.md
│   ├── flows.md
│   ├── events.md
│   ├── api.md
│   ├── screens.md
│   └── adr/
├── package.json                # workspaces
└── README.md
```

Обоснование — см. `adr/0001-monorepo-structure.md`.

---

## 5. Логическая архитектура

```
┌────────────────────────────────────────────────┐
│             Next.js 14 PWA (web)               │
│  ┌──────────┐ ┌──────────┐ ┌────────────────┐  │
│  │ Сотрудник │ │ Начальник │ │ Админ / ОТК /  │  │
│  │  (скан)   │ │ (дашборд) │ │ Упаковка        │  │
│  └─────┬────┘ └─────┬────┘ └────────┬────────┘  │
└────────┼────────────┼────────────────┼──────────┘
         │ REST + JWT │                │
┌────────┴────────────┴────────────────┴──────────┐
│                 NestJS API                      │
│                                                 │
│  Auth │ Orders │ Passports │ Movements │ QC │…  │
│     └──────────────┬──────────────────┘         │
│                    │ emits                      │
│            ┌───────▼────────┐                   │
│            │ EventBus       │                   │
│            │ (in-process)   │                   │
│            └───────┬────────┘                   │
│    Payroll ◀── Dashboard ◀── Cells ◀── …        │
└────────────────────┬────────────────────────────┘
                     │ Prisma
                ┌────▼──────┐
                │ PostgreSQL │
                └───────────┘
```

В MVP `EventBus` — внутренний (`@nestjs/event-emitter`), без Kafka/RabbitMQ.
События пишутся в таблицу `PassportEvent` синхронно в той же транзакции,
что и изменение состояния паспорта.

---

## 6. Слои бэкенда

1. **Controller** — HTTP, DTO-валидация, auth-guards.
2. **Service (use-case)** — бизнес-операции (например, `MovePassportToNextOperation`).
3. **Domain** — чистые функции/классы без Prisma (расчёт зарплаты, валидация
   переходов).
4. **Repository** — обёртка над Prisma, инкапсулирует транзакции.
5. **Event handlers** — слушают доменные события и делают побочные эффекты
   (начисление зарплаты, обновление агрегатов).

---

## 7. Транзакционные границы

Операция «Перемещение паспорта на следующий этап» должна выполняться в
одной транзакции:

1. Записать `PassportEvent(OPERATION_FINISHED)` для текущей операции;
2. Записать `PassportEvent(OPERATION_STARTED)` для новой;
3. Создать `OperationEntry` (начисление) с нужным статусом;
4. Обновить `Passport.currentOperationId` и `currentEmployeeId`.

Упаковка в одной транзакции:

1. Создать `BoxItem`;
2. Обновить `Box.totalQty`;
3. Записать `PassportEvent(PACKED)`;
4. Апрувнуть все `OperationEntry{status=PENDING}` этого паспорта.

---

## 8. Безопасность и роли

- Аутентификация (MVP 1.1) — собственная подписанная HttpOnly cookie
  `sewing_session` (HMAC-SHA256 на `JWT_SECRET`, см.
  [ADR-0014](./adr/0014-auth-and-sessions.md)). JWT-библиотек не тянем,
  чтобы не плодить зависимости ради одной пары sign/verify.
- Глобальный `AuthGuard` валидирует cookie на каждом запросе,
  подгружает свежие `role`/`active` из БД и кладёт `AuthPrincipal`
  в `request.user`. Декоратор `@Roles(...)` выполняет RBAC поверх него
  (ADMIN — wildcard).
- Identity сотрудника всегда берётся из сессии; `employeeId` в body/query
  для state-changing endpoint-ов запрещён.
- Любое действие сотрудника цеха требует активной `ShiftSession`
  (сотрудник + оборудование + операция). Уникальность активной смены
  защищена partial unique index (см. `domain.md §13`, ADR-0015).
- Cookie в production — `Secure`, `SameSite=Lax`, `Domain=.teeon.ru`,
  чтобы web (`prod.teeon.ru`) и API (`api.prod.teeon.ru`) шарили сессию.
- CORS-список собирается из `APP_URL` / `NEXT_PUBLIC_APP_URL` /
  `CORS_ALLOWED_ORIGINS` с `credentials: true` (cookie cross-origin).

Роли — см. `domain.md §3`.

---

## 9. PWA

- `manifest.json`, иконки, `display: standalone`.
- Service Worker — cache-first для статики, network-first для API.
- Оффлайн-очередь действий **не делаем на MVP** (риск рассинхрона
  паспортов). Требуем стабильный Wi-Fi.
- Камера для QR — через getUserMedia + `html5-qrcode`.

---

## 10. PDF и QR

- QR-код генерируется при создании паспорта (и ячейки, и коробки, и
  оборудования). Значение = `{kind}:{id}` (например, `passport:clxxx`).
- PDF паспорта генерируется серверно (`/api/passports/:id/pdf`) и
  сохраняется в локальное файловое хранилище `storage/passports/{id}.pdf`.
- На MVP — локальный диск; в проде — S3-совместимое (см. ADR в будущем).

---

## 11. Деплой (MVP)

- Docker Compose: `web`, `api`, `postgres`, `nginx` (reverse-proxy).
- Миграции Prisma применяются перед стартом `api`.
  Дополнительно `PrismaService.onModuleInit` идемпотентно создаёт
  partial unique-индексы, которые нельзя описать в Prisma DSL
  (см. `prisma/invariants.ts`, ADR-0015).
- `.env` — отдельные для web и api; справочник переменных —
  `.env.example`.
- Health/Ready: `/api/health` (без БД) и `/api/ready` (`SELECT 1`)
  используются nginx-ом и docker liveness/readiness.
- Глобальный `GlobalExceptionFilter` нормализует ошибки и не отдаёт
  stack trace наружу (см. `api.md §12`).

---

## 12. Нефункциональные требования

- Отклик API ≤ 300 мс на операциях сотрудника (сканирование).
- Одновременные подключения: ~50 планшетов.
- Хранение событий: ≥ 1 года без архивирования.
- Консистентность > доступности — жертвуем временной недоступностью ради
  корректного учёта брака и зарплат.

---

## 13. Что вне скоупа MVP

- Интеграции (1С, маркетплейсы).
- Фото-фиксация брака.
- Оффлайн-режим.
- Push-уведомления.
- Мультискладирование / несколько цехов.
- Партионный учёт ткани по артикулам (пока только `rollNumber` строкой).
