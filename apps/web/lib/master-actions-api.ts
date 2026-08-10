/**
 * Серверные обёртки над Nest API модуля «Действия мастера» (Stage 2
 * «Мастер цеха»).
 *
 * Контракт — `apps/api/src/modules/master-actions/master-actions.controller.ts`,
 * `@sewing/shared` (`master-actions.ts`). Используются из server actions
 * (`apps/web/app/master/master-actions-actions.ts`).
 */

import type {
  CreateRouteWorkPermitDto,
  RevokeRouteWorkPermitDto,
  RouteWorkPermitDto,
  FindMasterPassportByCodeResultDto,
  MasterActionResultDto,
  MasterSelfOperationDto,
  MasterSelfOperationStepsDto,
  ReturnPassportToCellDto,
  SetRouteStepDto,
  TransferPassportDto,
  UnassignPassportDto,
} from '@sewing/shared';
import type {
  CreatePassportDefectDto,
  DefectTypeDto,
  QcPassportDetailDto,
} from '@sewing/shared/qc';
import type {
  ApprovePassportQtyCorrectionResultDto,
  CreatePassportQtyCorrectionDto,
} from '@sewing/shared/passport-qty-corrections';
import { apiFetch } from './api';

export function unassignMasterPassport(
  passportId: string,
  body: UnassignPassportDto,
): Promise<MasterActionResultDto> {
  return apiFetch<MasterActionResultDto>(
    `/master-actions/passports/${encodeURIComponent(passportId)}/unassign`,
    { method: 'POST', body },
  );
}

export function transferMasterPassport(
  passportId: string,
  body: TransferPassportDto,
): Promise<MasterActionResultDto> {
  return apiFetch<MasterActionResultDto>(
    `/master-actions/passports/${encodeURIComponent(passportId)}/transfer-to-employee`,
    { method: 'POST', body },
  );
}

export function returnMasterPassportToCell(
  passportId: string,
  body: ReturnPassportToCellDto,
): Promise<MasterActionResultDto> {
  return apiFetch<MasterActionResultDto>(
    `/master-actions/passports/${encodeURIComponent(passportId)}/return-to-cell`,
    { method: 'POST', body },
  );
}

export function setMasterPassportRouteStep(
  passportId: string,
  body: SetRouteStepDto,
): Promise<MasterActionResultDto> {
  return apiFetch<MasterActionResultDto>(
    `/master-actions/passports/${encodeURIComponent(passportId)}/set-route-step`,
    { method: 'POST', body },
  );
}

export function findMasterPassportByCode(
  code: string,
): Promise<FindMasterPassportByCodeResultDto> {
  return apiFetch<FindMasterPassportByCodeResultDto>(
    `/master-actions/find-passport-by-code`,
    { method: 'POST', body: { code } },
  );
}

// ---------------------------------------------------------------------------
// «Выполнить операцию самой»
// ---------------------------------------------------------------------------

/**
 * Шаги маршрута заказа с доступностью для взятия на себя, станками и
 * флагом `pieceworkPaid` (см. `MasterActionsService.
 * listSelfOperationSteps`). Read-only — кэш не нужен, состояние
 * паспорта меняется каждым сканом в цехе.
 */
export function getMasterSelfOperationSteps(
  passportId: string,
): Promise<MasterSelfOperationStepsDto> {
  return apiFetch<MasterSelfOperationStepsDto>(
    `/master-actions/passports/${encodeURIComponent(passportId)}/self-operation-steps`,
    { cache: 'no-store' },
  );
}

/** Мастер выполнила операцию маршрута сама (одно действие вместо смены и двух сканов). */
export function performMasterSelfOperation(
  passportId: string,
  body: MasterSelfOperationDto,
): Promise<MasterActionResultDto> {
  return apiFetch<MasterActionResultDto>(
    `/master-actions/passports/${encodeURIComponent(passportId)}/self-operation`,
    { method: 'POST', body },
  );
}

// ---------------------------------------------------------------------------
// ОТК-действия мастера (делегируют в QcService на бэке)
// ---------------------------------------------------------------------------

/** Справочник видов брака для формы «зафиксировать брак» в кабинете мастера. */
export function listMasterDefectTypes(): Promise<DefectTypeDto[]> {
  return apiFetch<DefectTypeDto[]>(`/master-actions/defect-types`);
}

/** ОТК-карточка паспорта (виды-независимый detail) для режимов брак/возврат. */
export function getMasterPassportQcDetail(
  passportId: string,
): Promise<QcPassportDetailDto> {
  return apiFetch<QcPassportDetailDto>(
    `/master-actions/passports/${encodeURIComponent(passportId)}/qc-detail`,
  );
}

/** Зафиксировать брак по паспорту (см. `QcService.recordDefect`). */
export function recordMasterPassportDefect(
  passportId: string,
  body: CreatePassportDefectDto,
): Promise<QcPassportDetailDto> {
  return apiFetch<QcPassportDetailDto>(
    `/master-actions/passports/${encodeURIComponent(passportId)}/defect`,
    { method: 'POST', body },
  );
}

/**
 * Корректировка количества по паспорту одним шагом: мастер сам аппрувер,
 * заявка создаётся сразу `APPROVED` и применяется в той же транзакции
 * (см. `PassportQtyCorrectionsService.applyByMaster`).
 */
export function applyMasterQtyCorrection(
  passportId: string,
  body: CreatePassportQtyCorrectionDto,
): Promise<ApprovePassportQtyCorrectionResultDto> {
  return apiFetch<ApprovePassportQtyCorrectionResultDto>(
    `/master-actions/passports/${encodeURIComponent(passportId)}/qty-correction`,
    { method: 'POST', body },
  );
}

/** Вернуть паспорт на выбранную SEW-операцию (см. `QcService.returnToRework`). */
export function returnMasterPassportToRework(
  passportId: string,
  targetOperationId: string,
): Promise<QcPassportDetailDto> {
  return apiFetch<QcPassportDetailDto>(
    `/master-actions/passports/${encodeURIComponent(passportId)}/return-to-rework`,
    { method: 'POST', body: { targetOperationId } },
  );
}

// ---------------------------------------------------------------------------
// Наряд-допуск (RouteWorkPermit)
// ---------------------------------------------------------------------------

export function createRouteWorkPermit(
  body: CreateRouteWorkPermitDto,
): Promise<RouteWorkPermitDto> {
  return apiFetch<RouteWorkPermitDto>('/master-actions/route-work-permits', {
    method: 'POST',
    body,
  });
}

export function listRouteWorkPermits(
  orderId?: string,
): Promise<RouteWorkPermitDto[]> {
  return apiFetch<RouteWorkPermitDto[]>('/master-actions/route-work-permits', {
    cache: 'no-store',
    ...(orderId ? { searchParams: { orderId } } : {}),
  });
}

export function revokeRouteWorkPermit(
  id: string,
  body: RevokeRouteWorkPermitDto,
): Promise<RouteWorkPermitDto> {
  return apiFetch<RouteWorkPermitDto>(
    `/master-actions/route-work-permits/${encodeURIComponent(id)}/revoke`,
    { method: 'POST', body },
  );
}
