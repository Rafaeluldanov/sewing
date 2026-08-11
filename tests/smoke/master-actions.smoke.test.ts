/**
 * Smoke-тесты Stage 2 «Действия мастера над паспортами».
 *
 * Структурные инварианты, которые легко проверить без поднятия Nest /
 * Prisma — чтобы случайный рефакторинг не сломал
 *   1. факт существования модуля `master-actions` (controller + service);
 *   2. RBAC-обвязку (`@Roles`) и набор четырёх endpoints;
 *   3. UI-инварианты `/master`: блок «Действия с кроем», bottom-sheet
 *      `PassportActionsSheet`, обязательный select причины и крупная
 *      кнопка «Подтвердить»;
 *   4. отсутствие auto-fix (никакого «магического» закрытия
 *      `MasterCall` или вызова action'ов без подтверждения мастера).
 *
 * Покрытие соответствует ТЗ §8 «TESTS / Smoke».
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  MASTER_ACTION_REASONS,
  MASTER_ACTION_REASON_LABELS,
} from '../../packages/shared/src/master-actions';
import { parseAnyEmployeeQr } from '../../packages/shared/src/master-calls';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

describe('master-actions smoke — backend module', () => {
  test('module / controller / service существуют и подключены в AppModule', () => {
    const moduleSrc = readSrc(
      'apps/api/src/modules/master-actions/master-actions.module.ts',
    );
    expect(moduleSrc).toMatch(/MasterActionsController/);
    expect(moduleSrc).toMatch(/MasterActionsService/);

    const controllerSrc = readSrc(
      'apps/api/src/modules/master-actions/master-actions.controller.ts',
    );
    expect(controllerSrc).toMatch(/@Controller\(['"]master-actions['"]\)/);
    // Все четыре endpoints из ТЗ §3.
    expect(controllerSrc).toMatch(
      /@Post\(['"]passports\/:id\/unassign['"]\)/,
    );
    expect(controllerSrc).toMatch(
      /@Post\(['"]passports\/:id\/transfer-to-employee['"]\)/,
    );
    expect(controllerSrc).toMatch(
      /@Post\(['"]passports\/:id\/return-to-cell['"]\)/,
    );
    expect(controllerSrc).toMatch(
      /@Post\(['"]passports\/:id\/set-route-step['"]\)/,
    );

    const appModule = readSrc('apps/api/src/app.module.ts');
    expect(appModule).toMatch(/MasterActionsModule/);
  });

  test('endpoints защищены @Roles (SHOPFLOOR_MASTER + SHOP_MANAGER)', () => {
    const controllerSrc = readSrc(
      'apps/api/src/modules/master-actions/master-actions.controller.ts',
    );
    expect(controllerSrc).toMatch(/@Roles\(/);
    expect(controllerSrc).toMatch(/SHOPFLOOR_MASTER/);
    expect(controllerSrc).toMatch(/SHOP_MANAGER/);
    // Рабочих ролей в самом @Roles(...) быть не должно — это
    // «инструменты мастера», а не часть рабочего flow. Проверяем
    // конкретно содержимое декоратора, а не весь файл (комментарии
    // про forbidden-роли допустимы и желательны).
    const rolesDecoratorMatch = controllerSrc.match(
      /@Roles\(([\s\S]*?)\)\s*\nexport class MasterActionsController/,
    );
    expect(rolesDecoratorMatch, 'Class-level @Roles decorator not found').not.toBeNull();
    const rolesArgs = rolesDecoratorMatch![1]!;
    for (const forbidden of [
      'SEAMSTRESS',
      'CUTTER',
      'CUTTER_ASSISTANT',
      'IRONING',
      'PACKING',
      'QC',
      'DISPLAY',
    ]) {
      expect(rolesArgs).not.toMatch(new RegExp(`'${forbidden}'`));
    }
  });

  test('сервис идёт через prisma.$transaction и пишет MASTER_PASSPORT_* events', () => {
    const src = readSrc(
      'apps/api/src/modules/master-actions/master-actions.service.ts',
    );
    expect(src).toMatch(/prisma\.\$transaction/);
    expect(src).toMatch(/MASTER_PASSPORT_UNASSIGNED/);
    expect(src).toMatch(/MASTER_PASSPORT_TRANSFERRED/);
    expect(src).toMatch(/MASTER_PASSPORT_RETURNED_TO_CELL/);
    expect(src).toMatch(/MASTER_PASSPORT_ROUTE_STEP_SET/);
    // Безопасность: терминальные паспорта блокируются.
    expect(src).toMatch(/PassportTerminalForMasterException/);
    expect(src).toMatch(/PassportStatus\.PACKED/);
    expect(src).toMatch(/PassportStatus\.CANCELLED/);
  });

  test('shared-контракты содержат все 7 reasons и Zod-схемы', () => {
    expect(MASTER_ACTION_REASONS).toEqual([
      'WRONG_SCAN',
      'SHIFT_HANDOVER',
      'EMPLOYEE_MISTAKE',
      'ROUTE_CORRECTION',
      'CELL_CORRECTION',
      'MANAGER_DECISION',
      'OTHER',
    ]);
    for (const r of MASTER_ACTION_REASONS) {
      expect(MASTER_ACTION_REASON_LABELS[r]).toBeTruthy();
    }
    const sharedSrc = readSrc('packages/shared/src/master-actions.ts');
    expect(sharedSrc).toMatch(/UnassignPassportSchema/);
    expect(sharedSrc).toMatch(/TransferPassportSchema/);
    expect(sharedSrc).toMatch(/ReturnPassportToCellSchema/);
    expect(sharedSrc).toMatch(/SetRouteStepSchema/);
  });
});

describe('master-actions smoke — /master mobile UI', () => {
  test('master-page-client рендерит блок «Действия с кроем» и кнопку «Действия»', () => {
    const src = readSrc('apps/web/app/master/master-page-client.tsx');
    expect(src).toMatch(/Действия с кроем/);
    expect(src).toMatch(/PassportActionsSheet/);
    expect(src).toMatch(/master-call-card__passport-actions/);
    // qtyCut / статус / ячейка — обязательные поля на mobile-карточке
    // (см. ТЗ §1).
    expect(src).toMatch(/qtyCut/);
    expect(src).toMatch(/orderNumber/);
  });

  test('passport-actions-sheet содержит все 4 действия и обязательную причину', () => {
    const src = readSrc('apps/web/app/master/passport-actions-sheet.tsx');
    expect(src).toMatch(/Снять с сотрудника/);
    expect(src).toMatch(/Передать сотруднику/);
    expect(src).toMatch(/Вернуть в ячейку/);
    expect(src).toMatch(/Назначить операцию/);

    // Обязательный select причины + текстарея комментария.
    expect(src).toMatch(/MASTER_ACTION_REASONS/);
    expect(src).toMatch(/MASTER_ACTION_REASON_LABELS/);
    expect(src).toMatch(/Причина/);
    expect(src).toMatch(/Комментарий/);

    // Confirm-кнопка дисейблится без причины (canConfirm).
    expect(src).toMatch(/canConfirm/);
    expect(src).toMatch(/Подтвердить/);

    // Reuse общего сканера, никакого «своего» камера-стека.
    expect(src).toMatch(/QrScannerModal/);
  });

  test('CSS блока действий и bottom-sheet присутствует в globals.css', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.master-call-card__passports-block/);
    expect(css).toMatch(/\.master-call-card__passport-actions/);
    expect(css).toMatch(/\.master-actions-sheet\b/);
    expect(css).toMatch(/\.master-actions-sheet__confirm/);
  });

  test('server actions требуют reason на стороне UI (Zod-валидация)', () => {
    const src = readSrc('apps/web/app/master/master-actions-actions.ts');
    expect(src).toMatch(/UnassignPassportSchema/);
    expect(src).toMatch(/TransferPassportSchema/);
    expect(src).toMatch(/ReturnPassportToCellSchema/);
    expect(src).toMatch(/SetRouteStepSchema/);
    expect(src).toMatch(/safeParse/);
    expect(src).toMatch(/revalidatePath\(['"]\/master['"]\)/);
  });
});

describe('master-actions smoke — «выполнить операцию самой»', () => {
  test('endpoints объявлены и отданы в MasterActionsService', () => {
    const controllerSrc = readSrc(
      'apps/api/src/modules/master-actions/master-actions.controller.ts',
    );
    expect(controllerSrc).toMatch(
      /@Get\(['"]passports\/:id\/self-operation-steps['"]\)/,
    );
    expect(controllerSrc).toMatch(
      /@Post\(['"]passports\/:id\/self-operation['"]\)/,
    );
    expect(controllerSrc).toMatch(/MasterSelfOperationSchema/);
    expect(controllerSrc).toMatch(/listSelfOperationSteps/);
    expect(controllerSrc).toMatch(/performSelfOperation/);
  });

  test('движение паспорта идёт каналом швеи, а не своей копией правил', () => {
    const serviceSrc = readSrc(
      'apps/api/src/modules/master-actions/master-actions.service.ts',
    );
    // Только `PassportsService`: issue + complete. Никаких прямых
    // записей OPERATION_FINISHED мимо гейтов маршрута.
    expect(serviceSrc).toMatch(/this\.passports\.issueToEmployee\(/);
    expect(serviceSrc).toMatch(/this\.passports\.completeOperationByEmployee\(/);
    // Единственная запись событий паспорта в этом сервисе —
    // переоткрытие гейта на backward в `setRouteStep`. Прямой
    // `OPERATION_FINISHED` мимо `PassportsService` означал бы обход
    // гейтов маршрута и начислений.
    const writtenEventTypes = [
      ...serviceSrc.matchAll(
        /passportEvent\.create\(\{[\s\S]{0,200}?type: PassportEventType\.(\w+)/g,
      ),
    ].map((m) => m[1]);
    expect(writtenEventTypes).toEqual(['OPERATION_REWORK_OPENED']);
    // Доступность шагов считает тот же расчёт, что и «получить крой».
    expect(serviceSrc).toMatch(/previewOperationAvailability/);
  });

  test('техническая смена: создаётся напрямую и закрывается в finally', () => {
    const serviceSrc = readSrc(
      'apps/api/src/modules/master-actions/master-actions.service.ts',
    );
    expect(serviceSrc).toMatch(/shiftSession\.create/);
    expect(serviceSrc).toMatch(/finally\s*\{/);
    expect(serviceSrc).toMatch(/endedAt: new Date\(\)/);
    // Штатный старт смены НЕ используем: он синхронизирует оклад и
    // начислил бы мастеру повременные часы за минуту работы.
    expect(serviceSrc).not.toMatch(/shifts\.start\(/);
    expect(serviceSrc).not.toMatch(/syncDailySalary\(/);
  });

  test('UI: пункт в sheet, список шагов и предупреждение про оклад', () => {
    const src = readSrc('apps/web/app/master/passport-actions-sheet.tsx');
    expect(src).toMatch(/Выполнить операцию самой/);
    expect(src).toMatch(/selfOperation/);
    expect(src).toMatch(/fetchMasterSelfOperationStepsAction/);
    expect(src).toMatch(/masterSelfOperationAction/);
    // Недоступный шаг остаётся в списке с причиной отказа.
    expect(src).toMatch(/blockedReason/);
    expect(src).toMatch(/master-actions-sheet__step--blocked/);
    // Оклад: предупреждение показывается ДО нажатия.
    expect(src).toMatch(/pieceworkPaid/);
    expect(src).toMatch(/сдельного начисления/);

    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.master-actions-sheet__menu-item--work/);
    expect(css).toMatch(/\.master-actions-sheet__step--blocked/);
  });

  test('server action валидирует тело и ревалидирует /master', () => {
    const src = readSrc('apps/web/app/master/master-actions-actions.ts');
    expect(src).toMatch(/MasterSelfOperationSchema/);
    expect(src).toMatch(/masterSelfOperationAction/);
    expect(src).toMatch(/fetchMasterSelfOperationStepsAction/);
    expect(src).toMatch(/revalidatePath\(['"]\/master['"]\)/);
  });
});

/**
 * «Передать сотруднику»: получателя выбирают из списка, а не набирают
 * `EMPLOYEE:<cuid>` руками. 11.08.2026 свободное поле QR дало 17 подряд
 * 400 `INVALID_EMPLOYEE_QR` — вводить в него было физически нечего.
 */
describe('master-actions smoke — выбор получателя из списка', () => {
  test('backend: ручка transfer-candidates существует и read-only', () => {
    const controllerSrc = readSrc(
      'apps/api/src/modules/master-actions/master-actions.controller.ts',
    );
    expect(controllerSrc).toMatch(/@Get\(['"]transfer-candidates['"]\)/);
    expect(controllerSrc).toMatch(/MasterTransferCandidatesQuerySchema/);

    const serviceSrc = readSrc(
      'apps/api/src/modules/master-actions/master-actions.service.ts',
    );
    expect(serviceSrc).toMatch(/listTransferCandidates/);
    // Сортировка «кому по руке»: смена на текущем шаге паспорта — сверху.
    expect(serviceSrc).toMatch(/operationIsCurrentStep/);
    expect(serviceSrc).toMatch(/operationInRoute/);
    // Неактивных не отдаём.
    expect(serviceSrc).toMatch(/where: \{ active: true \}/);
  });

  test('UI: список сотрудников вместо свободного ввода EMPLOYEE:<id>', () => {
    const src = readSrc('apps/web/app/master/passport-actions-sheet.tsx');
    expect(src).toMatch(/EmployeePicker/);
    expect(src).toMatch(/fetchMasterTransferCandidatesAction/);
    // Отправляем employeeId — сырой QR-строки в теле больше нет.
    expect(src).toMatch(/employeeId/);
    expect(src).not.toMatch(/placeholder="EMPLOYEE:/);
    // Скан бейджа остаётся: формат проверяем на клиенте, а карточку
    // человека резолвит backend (подписанный «Мой QR-код»).
    expect(src).toMatch(/parseAnyEmployeeQr/);
    expect(src).toMatch(/resolveMasterEmployeeQrAction/);

    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.master-actions-sheet__people/);
    expect(css).toMatch(/\.master-actions-sheet__person\b/);
  });

  test('оба формата бейджа: parseAnyEmployeeQr в shared', () => {
    expect(parseAnyEmployeeQr('EMPLOYEE:emp-1')).toEqual({
      kind: 'badge',
      employeeId: 'emp-1',
    });
    expect(parseAnyEmployeeQr('SEWING_EMPLOYEE:body.sig')).toEqual({
      kind: 'signed',
      token: 'body.sig',
    });
    // Чужие QR цеха не должны выглядеть как сотрудник.
    expect(parseAnyEmployeeQr('passport:abc')).toBeNull();
    expect(parseAnyEmployeeQr('cell:abc')).toBeNull();
    expect(parseAnyEmployeeQr('')).toBeNull();
  });

  test('backend резолвит подписанный токен через MeService', () => {
    const serviceSrc = readSrc(
      'apps/api/src/modules/master-actions/master-actions.service.ts',
    );
    expect(serviceSrc).toMatch(/parseAnyEmployeeQr/);
    expect(serviceSrc).toMatch(/me\.verifyEmployeeQrToken/);
    expect(serviceSrc).toMatch(/EmployeeQrTokenInvalidException/);
    expect(serviceSrc).toMatch(/resolveEmployeeQr/);

    // Закрытие вызова сканом — тот же контур, чтобы «Мой QR-код»
    // работал на обоих экранах мастера.
    const callsSrc = readSrc(
      'apps/api/src/modules/master-calls/master-calls.service.ts',
    );
    expect(callsSrc).toMatch(/parseAnyEmployeeQr/);
    expect(callsSrc).toMatch(/me\.verifyEmployeeQrToken/);

    // Лимит длины поднят: подписанный токен длиннее прежних 200.
    const sharedSrc = readSrc('packages/shared/src/master-actions.ts');
    expect(sharedSrc).toMatch(/employeeQr: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(1024\)/);
  });
});

describe('master-actions smoke — что сознательно не делаем', () => {
  test('actions сервер-сайд не закрывает MasterCall автоматически', () => {
    const actionsSrc = readSrc(
      'apps/web/app/master/master-actions-actions.ts',
    );
    // Никаких «авторазрешений» вызова мастера после действий.
    expect(actionsSrc).not.toMatch(/resolveMasterCallByEmployeeQr/);
    // И в сервисе тоже — Stage 2 правит только Passport / CellContent /
    // AuditLog.
    const serviceSrc = readSrc(
      'apps/api/src/modules/master-actions/master-actions.service.ts',
    );
    expect(serviceSrc).not.toMatch(/masterCall\.update/);
    expect(serviceSrc).not.toMatch(/MasterCallStatus\.RESOLVED/);
  });

  test('passport-actions-sheet требует подтверждения (нет auto-fix)', () => {
    const src = readSrc('apps/web/app/master/passport-actions-sheet.tsx');
    // submit() вызывается ТОЛЬКО внутри onClick «Подтвердить».
    expect(src).toMatch(/onClick=\{submit\}/);
    // Никаких useEffect-таймеров, которые сами что-то отправляют —
    // mobile UI не должен «сам по себе» фиксировать действие.
    expect(src).not.toMatch(/setInterval/);
    expect(src).not.toMatch(/setTimeout\(.*submit/);
  });
});
