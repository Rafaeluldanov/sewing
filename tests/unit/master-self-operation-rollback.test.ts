/**
 * Unit-тесты компенсации неудавшегося «мастер выполняет операцию сама»
 * (`MasterActionsService.releaseAfterFailedSelfOperation`).
 *
 * Почему unit, а не integration: `performSelfOperation` зовёт
 * `issueToEmployee` + `completeOperationByEmployee`, и оба метода
 * проверяют ОДНИ И ТЕ ЖЕ гейты маршрута. Значит через HTTP нельзя
 * подобрать вход, на котором выдача пройдёт, а завершение упадёт —
 * такое даёт только гонка или сбой БД. Поэтому дефект (паспорт
 * остаётся «в работе у мастера», её кабинет такие паспорта не
 * показывает, повторная попытка упирается в `PASSPORT_ALREADY_ISSUED`)
 * закрепляем на самом компенсирующем helper-е.
 *
 * Инвариант: снимаем ТОЛЬКО владельца. `currentOperationId` /
 * `currentRouteStepIndex` / статус — движение по маршруту, которое
 * сделал `issueToEmployee`; откатывать его кусками нельзя (он менял и
 * `CellContent`, и события). Это та же семантика, что у мастерского
 * «Снять с сотрудника» (`unassign`).
 */
import { describe, expect, test, vi } from 'vitest';
import { MasterActionsService } from '@sewing/api/modules/master-actions/master-actions.service';

const MASTER_ID = 'emp-master';

function passportRow(currentEmployeeId: string | null) {
  return {
    id: 'p-1',
    number: 'P-20260814-0001',
    size: { code: 'M' },
    color: 'белый',
    qtyCut: 10,
    status: 'IN_PROGRESS',
    currentEmployeeId,
    currentEmployee: currentEmployeeId
      ? { id: currentEmployeeId, fullName: 'Демо Мастер' }
      : null,
    currentOperation: { id: 'op-1', name: 'ОВЕРЛОК' },
    currentCell: null,
    currentRouteStepIndex: 2,
  };
}

/**
 * Минимальный стенд: реальный сервис с заглушками зависимостей.
 * `$transaction` прогоняем колбэком — как настоящая Prisma-транзакция,
 * только без БД.
 */
function makeService(row: ReturnType<typeof passportRow>) {
  const update = vi.fn(async ({ data }: { data: { currentEmployeeId: null } }) =>
    passportRow(data.currentEmployeeId),
  );
  const auditLog = vi.fn(async () => undefined);
  const prisma = {
    passport: { findUnique: vi.fn(async () => row), update },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ passport: { update } }),
    ),
  };
  const service = new MasterActionsService(
    prisma as never,
    { log: auditLog } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, prisma, update, auditLog };
}

function rollback(
  service: MasterActionsService,
  cause: unknown = new Error('PASSPORT_COMPLETE_BACKWARD'),
) {
  // Приватный helper — зовём по имени: публичного API у компенсации нет
  // и быть не должно, её единственный вызов внутри `performSelfOperation`.
  return (
    service as unknown as {
      releaseAfterFailedSelfOperation: (
        passportId: string,
        actor: { employeeId: string },
        before: unknown,
        cause: unknown,
      ) => Promise<void>;
    }
  ).releaseAfterFailedSelfOperation(
    'p-1',
    { employeeId: MASTER_ID },
    { currentEmployeeId: MASTER_ID },
    cause,
  );
}

describe('self-operation rollback', () => {
  test('паспорт завис на мастере → владелец снят, аудит записан', async () => {
    const { service, update, auditLog } = makeService(passportRow(MASTER_ID));

    await rollback(service);

    expect(update).toHaveBeenCalledTimes(1);
    // Снимаем ТОЛЬКО владельца — ни операции, ни шага маршрута.
    expect(update.mock.calls[0]![0]).toEqual({
      where: { id: 'p-1' },
      data: { currentEmployeeId: null },
      include: expect.anything(),
    });
    expect(auditLog).toHaveBeenCalledTimes(1);
    const entry = auditLog.mock.calls[0]![0] as { event: string };
    expect(entry.event).toBe('MASTER_PASSPORT_SELF_OPERATION_ROLLED_BACK');
  });

  test('паспорт уже не за мастером → компенсация ничего не трогает', async () => {
    // Гонка: пока падало завершение, паспорт успели передать швее.
    const { service, update, auditLog } = makeService(passportRow('emp-other'));

    await rollback(service);

    expect(update).not.toHaveBeenCalled();
    expect(auditLog).not.toHaveBeenCalled();
  });

  test('сбой самой компенсации не всплывает наружу', async () => {
    // Иначе мастер увидела бы вторичную ошибку вместо причины отказа:
    // `performSelfOperation` пробрасывает исходную.
    const { service, prisma } = makeService(passportRow(MASTER_ID));
    prisma.$transaction.mockRejectedValueOnce(new Error('db is down'));

    await expect(rollback(service)).resolves.toBeUndefined();
  });
});
