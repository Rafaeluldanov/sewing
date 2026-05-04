# QR rendering regression — recon + hotfix log

Кратко: QR-коды разом перестали рендериться на frontend. Чинили
hotfix'ом — централизовали клиентский рендер через единый
[QrCodeView](../apps/web/components/qr/qr-code-view.tsx) и закрыли
регрессию [smoke-тестом](../tests/smoke/qr-rendering-regression.smoke.test.ts).

## 1. Где QR живёт в проекте

### 1a. Frontend render (видимый пользователю QR)
- [apps/web/components/employees/employee-qr-button.tsx](../apps/web/components/employees/employee-qr-button.tsx)
  — кнопка «Мой QR-код» + модалка. Пейлоад приходит через server
  action `getMyEmployeeQrAction` ([apps/web/app/employee-qr/actions.ts](../apps/web/app/employee-qr/actions.ts))
  из [GET /api/me/employee-qr](../apps/api/src/modules/me/me.controller.ts).
  Рендер делегирован QrCodeView.
- [apps/web/app/admin/employees/[id]/page.tsx](../apps/web/app/admin/employees/%5Bid%5D/page.tsx)
  — `<img src="/api/employees/:id/qr">`. Это бэкендовый PNG
  (`qrcode.toBuffer`), осознанно: админу нужен ровно тот же QR, что
  попадёт в печатную этикетку. Не трогаем.
- [apps/web/app/passports/[id]/page.tsx](../apps/web/app/passports/%5Bid%5D/page.tsx)
  — `<img src="/api/passports/:id/qr">` (бэкендовый PNG). Не трогаем.
- [apps/web/app/admin/warehouses/[id]/bulk-print-panel.tsx](../apps/web/app/admin/warehouses/%5Bid%5D/bulk-print-panel.tsx)
  — `<img src=...>` для preview этикеток ячеек, тоже backend PNG. Не трогаем.

### 1b. Frontend scan
- [apps/web/app/work/qr-scanner-modal.tsx](../apps/web/app/work/qr-scanner-modal.tsx)
  — динамический `await import('html5-qrcode')`. Не трогаем.

### 1c. Backend generation
- `qrcode.toDataURL` / `qrcode.toBuffer` в:
  - [apps/api/src/modules/employees/employees.controller.ts](../apps/api/src/modules/employees/employees.controller.ts)
  - [apps/api/src/modules/passports/passports.controller.ts](../apps/api/src/modules/passports/passports.controller.ts)
  - [apps/api/src/modules/passports/cells.controller.ts](../apps/api/src/modules/passports/cells.controller.ts)
  - [apps/api/src/modules/equipment/equipment.controller.ts](../apps/api/src/modules/equipment/equipment.controller.ts)
  - [apps/api/src/modules/packing/packing.controller.ts](../apps/api/src/modules/packing/packing.controller.ts)

### 1d. Payload helpers / token / signature
- [packages/shared/src/employee-qr.ts](../packages/shared/src/employee-qr.ts)
  — DTO + контракт ответа `/me/employee-qr`.
- [apps/api/src/modules/auth/employee-qr-token.ts](../apps/api/src/modules/auth/employee-qr-token.ts)
  — HMAC-токен. **Не трогали** (security boundary).
- [packages/shared/src/master-calls.ts](../packages/shared/src/master-calls.ts)
  — префиксы `EMPLOYEE:`, `passport:`, `cell:`. **Не трогали.**

## 2. Что было сломано / root cause

Сломанные места были **только клиентского рендера** (1a). Доминирующий
паттерн поломки — комбинация из нескольких:

1. `qrcode.react@^4` **не имеет default-экспорта**. Любой
   `import QRCode from 'qrcode.react'` — это `undefined`-default,
   и React падает на рендере с «Element type is invalid».
2. Прямой импорт `qrcode.react` в server-component (без `'use client'`)
   тоже валит сборку — пакет помечен как client-only.
3. `value={null}` / `value={undefined}` без нормализации заставляет
   `QRCodeSVG` бросить «expected string».
4. CSS-режим «белое на белом» (тёмная тема + дефолтные `currentColor`
   на SVG) делает QR невидимым, даже когда он успешно отрендерился.

Конкретное место, с которого началась регрессия — внутренние следы
[employee-qr-button.tsx](../apps/web/components/employees/employee-qr-button.tsx)
с `<QRCodeCanvas>`-импортом. На пилоте он мог быть случайно заменён
на default-импорт — и сразу легло везде, потому что эта кнопка
встраивается в `/work`, `/qc`, `/wto`, `/packing`, `/master`, `/`.

## 3. Hotfix

1. Создан единый клиентский рендер QR — [QrCodeView](../apps/web/components/qr/qr-code-view.tsx):
   - `'use client'`;
   - `import { QRCodeSVG } from 'qrcode.react'` (named, не default);
   - `value: string | null | undefined` нормализуется через `String#trim`;
   - пустой/невалидный value → fallback `«QR-код недоступен»` вместо
     краша;
   - `data-testid="qr-code-view"` на wrapper'е,
     `data-testid="qr-code-svg"` на самом SVG;
   - барель-экспорт через [components/qr/index.ts](../apps/web/components/qr/index.ts).
2. `EmployeeQrButton` переведён на QrCodeView, прямого `qrcode.react`
   в нём больше нет.
3. CSS добавлен в [globals.css](../apps/web/app/globals.css) —
   `.qr-code-view`, `.qr-code-view svg`, `.qr-code-view--empty`. Без
   inline-style, без `!important`.
4. Регрессионный smoke
   [tests/smoke/qr-rendering-regression.smoke.test.ts](../tests/smoke/qr-rendering-regression.smoke.test.ts)
   фиксирует:
   - наличие `'use client'` и named-импорта в QrCodeView;
   - запрет default- и `* as QRCode`-импортов;
   - наличие fallback'а и testid'ов;
   - что **никто кроме QrCodeView не импортирует `qrcode.react`** (через `git grep`);
   - что `html5-qrcode` живёт только в файле сканера;
   - что нет внешних QR-API (`api.qrserver.com`, `chart.googleapis.com`,
     `quickchart.io`);
   - что EmployeeQrButton сидит на QrCodeView.

## 4. Что осознанно не трогали

- Backend-PNG `<img src="/api/.../qr">` — это правильный паттерн для
  печатных этикеток / админских превью, и он НЕ был в числе сломанного.
- Сканер `html5-qrcode` — другая поверхность.
- HMAC-токен и payload-форматы (`EMPLOYEE:`, `passport:`, `cell:`) — security boundary.
- RBAC, маршруты, сессии — не меняли.
