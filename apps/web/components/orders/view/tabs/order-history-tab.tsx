/**
 * `OrderHistoryTab` — вкладка «История» управленческой карточки
 * `/admin/orders/[id]?tab=history`.
 *
 * Сознательно показывает ТОЛЬКО honest empty-state — пока у backend
 * нет публичного HTTP-API для журнала событий заказа.
 *
 * Что есть на backend, но НЕ выставлено наружу:
 *   - `AuditService.log()` пишет события (например,
 *     `ORDER_APPLICATIONS_REPLACED`, `ORDER_COST_ESTIMATE_CREATED`,
 *     `ORDER_MATERIAL_ARRIVAL_OVERRIDE_CREATED`,
 *     `ORDER_CALCULATION_COMPLETED`, `ORDER_CALCULATION_REOPENED`),
 *     контроллера у `audit`-модуля нет
 *     (`apps/api/src/modules/audit/`);
 *   - `PassportEvent` хранится в БД (см.
 *     `prisma/schema.prisma::PassportEvent`), но ни
 *     `passports.controller`, ни `order-passports.controller` не
 *     отдают `PassportEvent[]` агрегатом по заказу.
 *
 * Что мы НЕ делаем (см. комментарий ТЗ «не показывай derived/fake
 * history»):
 *   - не строим псевдо-таймлайн из текущих полей паспортов
 *     (`createdAt`, `cutDate`, `status`) — это снимок состояния, а не
 *     история переходов, и менеджер легко подумает, что видит
 *     настоящий audit log;
 *   - не показываем `Order.createdAt` / `updatedAt` как «события» —
 *     это тоже не события (особенно `updatedAt`, который может
 *     прыгать на любую правку поля «Основное»).
 *
 * Когда появится backend-эндпоинт — сюда вернётся server-fetch +
 * таблица «когда / кто / событие / payload» (подробности в TODO ниже).
 */
import { Clock } from 'lucide-react';
import {
  AdminCard,
  AdminEmptyState,
  AdminSectionHeader,
} from '@/components/admin';

// TODO(order-history-api): когда backend выставит публичный
// эндпоинт — заменить empty-state на реальный список. Ожидаемый
// контракт (один из двух вариантов, какой удобнее команде):
//
//   - GET /api/orders/:id/history → массив унифицированных событий
//     `{ id, occurredAt, actor: {employeeId, name} | null, event,
//        entityType, entityId, payload }` со склейкой `AuditLog`
//     (для самого заказа / OrderApplication / WorkshopNeed /
//     PurchaseOrder / PurchaseReceipt / OrderCostEstimate / …) и
//     `PassportEvent` для всех паспортов заказа;
//   - либо отдельные `GET /api/orders/:id/audit-log` +
//     `GET /api/orders/:id/passport-events` (тогда web сам сольёт и
//     отсортирует по `occurredAt DESC`).
//
// Web-side нужен `apps/web/lib/order-history-api.ts` (тонкая
// `apiFetch`-обёртка) и таблица в этом файле (нумерация / фильтры
// по `event` и `actor` + ссылки в карточку паспорта). До этого
// момента вкладка **сознательно** остаётся пустой, чтобы менеджер
// не путал «снимок состояния паспортов» с «историей событий».

export function OrderHistoryTab() {
  return (
    <div className="order-history-tab">
      <AdminCard>
        <AdminSectionHeader
          icon={<Clock size={18} strokeWidth={1.7} aria-hidden />}
          title="История заказа"
        />
        <AdminEmptyState
          icon={<Clock size={26} strokeWidth={1.6} aria-hidden />}
          title="История событий пока недоступна"
          hint="Нужен публичный API: GET /api/orders/:id/history (или пара /audit-log + /passport-events). Здесь появятся смены статуса заказа, выпуск паспортов и переходы по операциям с указанием, кто и когда сделал действие."
        />
      </AdminCard>
    </div>
  );
}
