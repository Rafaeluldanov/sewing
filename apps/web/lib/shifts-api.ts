/**
 * Серверные обёртки над Nest API для модуля смен и выдачи кроя.
 *
 * Рассчитаны на использование из RSC / server actions. Клиентские
 * компоненты ходят сюда через server actions в `app/work/actions.ts`.
 *
 * С MVP 1.1 (ADR-0014) `employeeId` нигде явно не передаётся —
 * сервер берёт владельца действия из session-cookie.
 */

import type {
  BatchCompleteOperationsResultDto,
  CurrentWorkPassportDto,
  ReworkPassportDto,
  ShiftMetaDto,
  ShiftSessionDto,
  StartShiftDto,
  SwitchShiftOperationDto,
} from '@sewing/shared/shifts';
import type { OrderCutIssueRuleBannerDto } from '@sewing/shared';
import type { PassportDetailDto } from '@sewing/shared/passports';
import { apiFetch } from './api';

export function getShiftMeta(): Promise<ShiftMetaDto> {
  return apiFetch<ShiftMetaDto>('/shifts/meta', { cache: 'no-store' });
}

export function getCurrentShift(): Promise<ShiftSessionDto | null> {
  return apiFetch<ShiftSessionDto | null>('/shifts/current');
}

/**
 * Активные кройи, закреплённые за текущим сотрудником прямо сейчас.
 * Backend сам вырезает по сессии — никаких employeeId-параметров.
 * Используется на `/work` для блока «Текущий крой».
 */
export function getCurrentWork(): Promise<CurrentWorkPassportDto[]> {
  return apiFetch<CurrentWorkPassportDto[]>('/shifts/current-work');
}

/**
 * Паспорта, возвращённые ОТК на переделку текущему сотруднику.
 * Используется на `/work` для секции «К переделке от ОТК». Backend
 * сам вырезает по сессии (ADR-0014).
 */
export function getMyRework(): Promise<ReworkPassportDto[]> {
  return apiFetch<ReworkPassportDto[]>('/shifts/my-rework');
}

export function startShift(body: StartShiftDto): Promise<ShiftSessionDto> {
  return apiFetch<ShiftSessionDto>('/shifts/start', {
    method: 'POST',
    body,
  });
}

export function stopShift(): Promise<ShiftSessionDto> {
  return apiFetch<ShiftSessionDto>('/shifts/stop', {
    method: 'POST',
    body: {},
  });
}

export function switchShiftOperation(
  body: SwitchShiftOperationDto,
): Promise<ShiftSessionDto> {
  return apiFetch<ShiftSessionDto>('/shifts/switch-operation', {
    method: 'POST',
    body,
  });
}

export function findPassportByCode(code: string): Promise<PassportDetailDto> {
  return apiFetch<PassportDetailDto>('/passports/by-code', {
    method: 'POST',
    body: { code },
  });
}

export function issuePassport(id: string): Promise<PassportDetailDto> {
  return apiFetch<PassportDetailDto>(
    `/passports/${encodeURIComponent(id)}/issue`,
    { method: 'POST', body: {} },
  );
}

export function scanPassport(id: string): Promise<PassportDetailDto> {
  return apiFetch<PassportDetailDto>(
    `/passports/${encodeURIComponent(id)}/scan`,
    { method: 'POST', body: {} },
  );
}

/**
 * Завершение операции швеёй (ТЗ §2, ADR-0014). На backend проверяется
 * `passport.currentEmployeeId = me AND status = IN_PROGRESS` — здесь
 * мы просто транслируем результат.
 */
export function completePassportOperation(id: string): Promise<PassportDetailDto> {
  return apiFetch<PassportDetailDto>(
    `/passports/${encodeURIComponent(id)}/complete-operation`,
    { method: 'POST', body: {} },
  );
}

/**
 * Пакетное завершение операций сразу по нескольким паспортам швеи
 * (см. `PassportsService.completeOperationsBatch`). Партиальный успех:
 * ответ `{ completed, failed }` — на backend каждый паспорт закрывается
 * в своей транзакции, упавший не блокирует остальные.
 */
export function completePassportOperationsBatch(
  passportIds: string[],
): Promise<BatchCompleteOperationsResultDto> {
  return apiFetch<BatchCompleteOperationsResultDto>(
    '/passports/batch/complete-operations',
    { method: 'POST', body: { passportIds } },
  );
}

/**
 * Подсказка для seamstress-баннера на /work — какой размер сейчас
 * разрешён к выдаче по очереди заказа и в каких ячейках лежат
 * паспорта этого размера. Backend сам решает применимость
 * (`OrderCutIssueRulesService.getActiveBannerForOperation`):
 * если operationId не CUTTING и не первый шаг ни одного маршрута
 * с активной очередью — вернёт `applicable = false`.
 */
export function getCutIssueBanner(
  operationId: string,
): Promise<OrderCutIssueRuleBannerDto> {
  return apiFetch<OrderCutIssueRuleBannerDto>('/cut-issue-banner', {
    searchParams: { operationId },
  });
}
