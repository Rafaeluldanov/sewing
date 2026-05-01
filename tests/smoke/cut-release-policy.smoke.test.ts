/**
 * Smoke-тесты Stage 3 «Мастер цеха» — политика выдачи кроя
 * (`CutReleasePolicy`).
 *
 * Структурные инварианты, которые легко проверить без поднятия Nest /
 * Prisma. Покрытие соответствует ТЗ §10 «TESTS / Smoke»:
 *
 *   1. модуль существует (controller / service / module) и подключён в
 *      AppModule + PassportsModule;
 *   2. RBAC — endpoints защищены `@Roles('SHOPFLOOR_MASTER',
 *      'SHOP_MANAGER')` (ADMIN bypass-ит RolesGuard глобально);
 *   3. error-message формируется shared-хелпером и совпадает с ТЗ:
 *      «Сейчас разрешена выдача только: Чёрный XS, лимит 100 шт.»;
 *   4. scan / complete-operation НЕ зовут проверку политики — только
 *      `issueToEmployee` (граница ТЗ §11 «НЕ ДЕЛАТЬ»);
 *   5. UI: на `/master` рендерится блок «Ограничения выдачи кроя» с
 *      двумя крупными кнопками и bottom-sheet формой;
 *   6. UI на `/work` показывает inline-message ровно как есть, без
 *      префикса `[CUT_RELEASE_POLICY_VIOLATION] `.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { formatCutReleasePolicyMessage } from '../../packages/shared/src/cut-release-policy';

const repoRoot = path.resolve(__dirname, '..', '..');

function readSrc(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), 'utf8');
}

describe('cut-release-policy smoke — backend module', () => {
  test('module / controller / service существуют и подключены в AppModule + PassportsModule', () => {
    const moduleSrc = readSrc(
      'apps/api/src/modules/cut-release-policy/cut-release-policy.module.ts',
    );
    expect(moduleSrc).toMatch(/CutReleasePolicyController/);
    expect(moduleSrc).toMatch(/CutReleasePolicyService/);
    // Сервис экспортируется наружу — `PassportsService` его инжектит.
    expect(moduleSrc).toMatch(/exports:\s*\[\s*CutReleasePolicyService\s*\]/);

    const controllerSrc = readSrc(
      'apps/api/src/modules/cut-release-policy/cut-release-policy.controller.ts',
    );
    expect(controllerSrc).toMatch(/@Controller\(['"]cut-release-policy['"]\)/);
    // Все четыре endpoints из ТЗ §3.
    expect(controllerSrc).toMatch(/@Get\(\)/);
    expect(controllerSrc).toMatch(/@Post\(\)/);
    expect(controllerSrc).toMatch(/@Patch\(['"]:id['"]\)/);
    expect(controllerSrc).toMatch(/@Post\(['"]:id\/disable['"]\)/);

    const appModule = readSrc('apps/api/src/app.module.ts');
    expect(appModule).toMatch(/CutReleasePolicyModule/);

    // PassportsModule импортирует cut-release-policy, чтобы PassportsService
    // мог вытащить активную политику в issueToEmployee.
    const passportsModule = readSrc(
      'apps/api/src/modules/passports/passports.module.ts',
    );
    expect(passportsModule).toMatch(/CutReleasePolicyModule/);
  });

  test('endpoints защищены @Roles (SHOPFLOOR_MASTER + SHOP_MANAGER, ADMIN — bypass)', () => {
    const controllerSrc = readSrc(
      'apps/api/src/modules/cut-release-policy/cut-release-policy.controller.ts',
    );
    expect(controllerSrc).toMatch(/@Roles\(/);
    expect(controllerSrc).toMatch(/SHOPFLOOR_MASTER/);
    expect(controllerSrc).toMatch(/SHOP_MANAGER/);
    // Ловушка: «рабочих» ролей в самом @Roles(...) быть не должно —
    // это управленческий endpoint. Проверяем содержимое декоратора, а
    // не весь файл (комментарии про forbidden-роли допустимы).
    const rolesDecoratorMatch = controllerSrc.match(
      /@Roles\(([\s\S]*?)\)\s*\nexport class CutReleasePolicyController/,
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

  test('CutReleasePolicy Prisma-модель существует и имеет ожидаемые поля', () => {
    const schema = readSrc('prisma/schema.prisma');
    expect(schema).toMatch(/model\s+CutReleasePolicy\s+\{/);
    // Только поля, важные для контракта Stage 3 (без жёсткой проверки
    // комментариев — их можно править без риска для логики).
    expect(schema).toMatch(/isActive\s+Boolean/);
    expect(schema).toMatch(/color\s+String\?/);
    expect(schema).toMatch(/sizeId\s+String\?/);
    expect(schema).toMatch(/limitQty\s+Int/);
    expect(schema).toMatch(/consumedQty\s+Int\s+@default\(0\)/);
    expect(schema).toMatch(/createdById\s+String/);
    expect(schema).toMatch(/@@index\(\[isActive\]\)/);
  });

  test('AuditEntityType расширен CUT_RELEASE_POLICY', () => {
    const auditSrc = readSrc('apps/api/src/modules/audit/audit.service.ts');
    expect(auditSrc).toMatch(/['"]CUT_RELEASE_POLICY['"]/);
  });

  test('CutReleasePolicyViolationException имеет HTTP 409 и code CUT_RELEASE_POLICY_VIOLATION', () => {
    const errorsSrc = readSrc('apps/api/src/common/errors.ts');
    expect(errorsSrc).toMatch(/class\s+CutReleasePolicyViolationException/);
    // HTTP 409 (HttpStatus.CONFLICT) + ровно тот code, который ловит
    // `apps/web/app/work/actions.ts::explainApiError`.
    expect(errorsSrc).toMatch(
      /CUT_RELEASE_POLICY_VIOLATION[\s\S]*HttpStatus\.CONFLICT/,
    );
  });

  test('issueToEmployee зовёт evaluateCutReleasePolicyForIssue + consumeCutReleasePolicyInTx', () => {
    const src = readSrc(
      'apps/api/src/modules/passports/passports.service.ts',
    );
    expect(src).toMatch(/evaluateCutReleasePolicyForIssue/);
    expect(src).toMatch(/consumeCutReleasePolicyInTx/);
    // Atomic increment: conditional updateMany по `isActive` и
    // `consumedQty`, чтобы выдержать гонку между pre-check и tx.
    expect(src).toMatch(/cutReleasePolicy\.updateMany/);
    // Pre-check учитывает «первая операция маршрута ИЛИ категория
    // CUTTING». Это сознательная граница политики (см. ТЗ §4).
    expect(src).toMatch(/currentRouteStepIndex\s*===\s*0/);
    expect(src).toMatch(/OperationCategory\.CUTTING/);
    // Audit-событие consumption пишется в той же транзакции.
    expect(src).toMatch(/CUT_RELEASE_POLICY_CONSUMED/);
  });

  test('scan и complete-operation НЕ зовут проверку политики (граница ТЗ §11)', () => {
    const src = readSrc(
      'apps/api/src/modules/passports/passports.service.ts',
    );
    // Находим тела scanOnOperation и completeOperationByEmployee и
    // убеждаемся, что ни одно из них не зовёт policy-helpers / не
    // упоминает CUT_RELEASE_POLICY_*.
    for (const methodName of ['scanOnOperation', 'completeOperationByEmployee']) {
      const re = new RegExp(
        `async\\s+${methodName}\\s*\\([\\s\\S]*?\\n  \\}`,
        'm',
      );
      const match = src.match(re);
      expect(match, `method ${methodName} not matched`).not.toBeNull();
      const body = match![0]!;
      expect(body).not.toMatch(/evaluateCutReleasePolicyForIssue/);
      expect(body).not.toMatch(/consumeCutReleasePolicyInTx/);
      expect(body).not.toMatch(/CUT_RELEASE_POLICY/);
    }
  });
});

describe('cut-release-policy smoke — shared / message contract', () => {
  test('shared экспортирует Zod-схемы и DTO', () => {
    const sharedSrc = readSrc('packages/shared/src/cut-release-policy.ts');
    expect(sharedSrc).toMatch(/CreateCutReleasePolicySchema/);
    expect(sharedSrc).toMatch(/UpdateCutReleasePolicySchema/);
    expect(sharedSrc).toMatch(/CutReleasePolicyDto/);
    expect(sharedSrc).toMatch(/formatCutReleasePolicyMessage/);

    const indexSrc = readSrc('packages/shared/src/index.ts');
    expect(indexSrc).toMatch(/cut-release-policy/);
  });

  test('exact message: «Сейчас разрешена выдача только: Чёрный XS, лимит 100 шт.»', () => {
    // Точная строка из ТЗ Stage 3 §4. Если кто-то сломает формат,
    // тест упадёт — это и есть смысл «exact string»-проверки.
    expect(
      formatCutReleasePolicyMessage({
        color: 'Чёрный',
        sizeLabel: 'XS',
        limitQty: 100,
      }),
    ).toBe('Сейчас разрешена выдача только: Чёрный XS, лимит 100 шт.');
  });

  test('message без фильтров корректно деградирует до «весь крой»', () => {
    // Edge-case: мастер задал только лимит без color/size.
    expect(
      formatCutReleasePolicyMessage({
        color: null,
        sizeLabel: null,
        limitQty: 50,
      }),
    ).toBe('Сейчас разрешена выдача только: весь крой, лимит 50 шт.');
  });

  test('message с одним фильтром (только цвет / только размер)', () => {
    expect(
      formatCutReleasePolicyMessage({
        color: 'Чёрный',
        sizeLabel: null,
        limitQty: 30,
      }),
    ).toBe('Сейчас разрешена выдача только: Чёрный, лимит 30 шт.');
    expect(
      formatCutReleasePolicyMessage({
        color: null,
        sizeLabel: 'M',
        limitQty: 20,
      }),
    ).toBe('Сейчас разрешена выдача только: M, лимит 20 шт.');
  });
});

describe('cut-release-policy smoke — /master mobile UI', () => {
  test('master-page-client рендерит CutReleasePolicyCard и polling-ит политику', () => {
    const src = readSrc('apps/web/app/master/master-page-client.tsx');
    expect(src).toMatch(/CutReleasePolicyCard/);
    // Polling использует тот же тикер, что и master-calls — отдельного
    // setInterval быть не должно (mobile UI экономит wakelock).
    expect(src).toMatch(/refreshCutReleasePolicyAction/);
  });

  test('cut-release-policy-card содержит карточку, форму и обе кнопки', () => {
    const src = readSrc('apps/web/app/master/cut-release-policy-card.tsx');
    expect(src).toMatch(/Ограничения выдачи кроя/);
    expect(src).toMatch(/Установить ограничение/);
    expect(src).toMatch(/Снять ограничение/);
    // Форма: select размер (через `<select>`), input цвет (через
    // datalist) и numeric input лимит — всё в одном bottom-sheet.
    expect(src).toMatch(/master-actions-sheet/);
    expect(src).toMatch(/datalist/);
    expect(src).toMatch(/type="number"/);
    // Bottom-sheet шарит CSS со Stage 2 PassportActionsSheet — это
    // фиксирует визуальную консистентность.
    expect(src).toMatch(/master-actions-sheet__confirm/);
  });

  test('CSS блока политики присутствует в globals.css', () => {
    const css = readSrc('apps/web/app/globals.css');
    expect(css).toMatch(/\.master-cut-release-card\b/);
    expect(css).toMatch(/\.master-cut-release-card__primary\b/);
    expect(css).toMatch(/\.master-cut-release-card__secondary\b/);
  });

  test('server actions не префиксят сообщение [CODE] для VIOLATION', () => {
    // Серверные actions /master сами не префиксят (они работают с
    // form-validation). Ключевая защита для рабочего — в /work/actions.ts.
    const masterActionsSrc = readSrc(
      'apps/web/app/master/cut-release-policy-actions.ts',
    );
    expect(masterActionsSrc).toMatch(/CreateCutReleasePolicySchema/);
    expect(masterActionsSrc).toMatch(/safeParse/);
    expect(masterActionsSrc).toMatch(/revalidatePath\(['"]\/master['"]\)/);
    // Никакого `[${e.code}]` в master-actions — иначе UI на master
    // показывал бы код перед текстом, что не нужно.
    expect(masterActionsSrc).not.toMatch(/\[\$\{e\.code\}\]/);
  });
});

describe('cut-release-policy smoke — /work raw inline-message', () => {
  test('explainApiError на /work НЕ префиксит CUT_RELEASE_POLICY_VIOLATION', () => {
    const src = readSrc('apps/web/app/work/actions.ts');
    // RAW_API_ERROR_CODES должен явно содержать наш код.
    expect(src).toMatch(/CUT_RELEASE_POLICY_VIOLATION/);
    expect(src).toMatch(/RAW_API_ERROR_CODES/);
    // Логика: если e.code в RAW_API_ERROR_CODES — возвращаем e.message
    // без префикса. Эту ветку фиксируем грубым match'ем, чтобы случайный
    // рефактор не вернул `[CODE] ` обратно.
    expect(src).toMatch(/RAW_API_ERROR_CODES\.has\(e\.code\)[\s\S]{0,80}return\s+e\.message/);
  });
});

describe('cut-release-policy smoke — что сознательно не делаем', () => {
  test('нет alert/звуков/модалок на VIOLATION (inline-message only)', () => {
    // Для рабочего полная грамотность UI лежит в seamstress-active-panel
    // (или work/state machine). Здесь проверяем общий контракт actions:
    // никаких alert(), confirm(), playSound() — только error string.
    const actionsSrc = readSrc('apps/web/app/work/actions.ts');
    expect(actionsSrc).not.toMatch(/window\.alert/);
    expect(actionsSrc).not.toMatch(/playSound/);
  });

  test('сервис cut-release-policy не плодит multi-policy', () => {
    const src = readSrc(
      'apps/api/src/modules/cut-release-policy/cut-release-policy.service.ts',
    );
    // create() сначала гасит все isActive=true в той же транзакции —
    // single-active инвариант MVP. Не используем уникальный индекс,
    // но enforce-им на сервисе.
    expect(src).toMatch(/updateMany\([\s\S]*?isActive:\s*true[\s\S]*?isActive:\s*false/);
  });
});
