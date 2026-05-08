/**
 * Серверные обёртки над Nest API модуля «Действия мастера» (Stage 2
 * «Мастер цеха»).
 *
 * Контракт — `apps/api/src/modules/master-actions/master-actions.controller.ts`,
 * `@sewing/shared` (`master-actions.ts`). Используются из server actions
 * (`apps/web/app/master/master-actions-actions.ts`).
 */

import type {
  FindMasterPassportByCodeResultDto,
  MasterActionResultDto,
  ReturnPassportToCellDto,
  SetRouteStepDto,
  TransferPassportDto,
  UnassignPassportDto,
} from '@sewing/shared';
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
