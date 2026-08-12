/**
 * Ведение отрезков смены (`ShiftSegment`) — источник «табеля дня» в
 * кабинете мастера (`/master`, вкладка «Сотрудники»).
 *
 * Сегмент = отрезок смены с НЕИЗМЕННОЙ парой «рабочее место + операция».
 * Нужен потому, что сама смена умеет менять операцию на лету
 * (`ShiftsService.switchOperation` перезаписывает `operationId`, не
 * закрывая смену), и от предыдущей операции не остаётся следа: смена на
 * 8 часов с тремя переключениями выглядит как 8 часов последней
 * операции.
 *
 * Функции, а не сервис: писать сегменты обязаны ЧЕТЫРЕ модуля (shifts,
 * me, master-actions и — через `ShiftsService.stop` — master-employee-stats),
 * и тащить ради двух запросов DI-зависимость в каждый дороже, чем
 * передать `prisma` аргументом. Тот же приём, что у `route-work-permits.ts`.
 *
 * ВАЖНО про fail-soft: обе функции съедают свои ошибки (логируя их).
 * Сегменты — отчётный контур; уронить из-за них старт смены, переход на
 * другой участок или закрытие смены нельзя — иначе сбой в табеле
 * останавливает цех. Дыра в табеле лечится сама на следующем
 * `start`/`stop`: открытый сегмент закрывается по `shiftSessionId`, а не
 * по «последнему открытому», поэтому рассинхрон не размазывается.
 */
import type { PrismaClient } from '@prisma/client';
import { Logger } from '@nestjs/common';

/** Минимальный клиент: подходит и `PrismaService`, и `tx`. */
type Db = Pick<PrismaClient, 'shiftSegment'>;

const logger = new Logger('ShiftSegments');

/**
 * Открывает сегмент смены. Зовётся при старте смены и при смене
 * операции внутри неё (после закрытия предыдущего сегмента).
 *
 * `at` — момент начала; по умолчанию `now()` на стороне БД. Явное
 * значение передаёт `start`, чтобы граница сегмента совпадала с
 * `ShiftSession.startedAt` до миллисекунды: иначе первый сегмент дня
 * начинался бы на несколько миллисекунд позже смены и «присутствие»
 * не сходилось бы с суммой сегментов.
 */
export async function openShiftSegment(
  db: Db,
  params: {
    shiftSessionId: string;
    employeeId: string;
    equipmentId: string;
    operationId: string;
    at?: Date;
  },
): Promise<void> {
  try {
    await db.shiftSegment.create({
      data: {
        shiftSessionId: params.shiftSessionId,
        employeeId: params.employeeId,
        equipmentId: params.equipmentId,
        operationId: params.operationId,
        ...(params.at ? { startedAt: params.at } : {}),
      },
    });
  } catch (err) {
    logger.warn(
      `openShiftSegment failed (shiftSessionId=${params.shiftSessionId}, operationId=${params.operationId}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Закрывает открытый сегмент смены. Зовётся отовсюду, где смена
 * заканчивается или меняет операцию.
 *
 * `updateMany` вместо `update`: сегмента может не быть вовсе (смена
 * заведена до появления таблицы и не попала в бэкфилл, или предыдущая
 * запись не удалась) — тогда это тихий no-op, а не `P2025`.
 */
export async function closeShiftSegments(
  db: Db,
  shiftSessionId: string,
  at: Date = new Date(),
): Promise<void> {
  try {
    await db.shiftSegment.updateMany({
      where: { shiftSessionId, endedAt: null },
      data: { endedAt: at },
    });
  } catch (err) {
    logger.warn(
      `closeShiftSegments failed (shiftSessionId=${shiftSessionId}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
