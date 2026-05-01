# Workshop needs source recon (после внедрения категорий, погонных метров, фурнитуры)

> Технический отчёт по источникам строк `WorkshopNeed` после этапа
> «Исправить формирование Потребности цеха». Изменения в Prisma НЕ
> вносились (см. ТЗ §«Не менять Prisma»). В отчёте перечислены все
> sourceType, какие данные они теперь забирают, и как ведёт себя
> расчёт для category-driven заказа vs legacy-заказа.
>
> Связанный код:
> - `apps/api/src/modules/workshop-needs/workshop-needs.service.ts`
> - `packages/shared/src/workshop-needs.ts`
> - `apps/web/app/admin/workshop-needs/page.tsx`
> - `apps/web/app/admin/workshop-needs/inline-edit-row.tsx`
> - `tests/smoke/workshop-needs-category-driven.smoke.test.ts`
> - `tests/integration/workshop-needs-category-driven.test.ts`

## 1. sourceType-ы строк потребности

| sourceType                    | sourceId               | materialRole       | sourceName       | description                                                             | unit                          | calculationMethod                                | Когда генерится                                                     |
| ----------------------------- | ---------------------- | ------------------ | ---------------- | ----------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| `TECH_CARD_MATERIAL_LINE`     | `techCardLine.id`      | `line.materialRole` | `line.name`     | live-техкарта: «<fabric> <density> г/м², <color>, ширина <w> см»        | `line.unit`                  | `AREA_DENSITY` если есть лекало+area+density, иначе `QTY_PER_UNIT` | **Только для legacy-заказа** (без category или без параметров) |
| `ORDER_MATERIAL_REQUIREMENT`  | `requirement.id`       | `r.materialRole`   | `r.name`         | snapshot заказа после `OrdersService.start()`                          | `r.unit`                     | как у TECH_CARD_MATERIAL_LINE                                       | **Только для legacy-заказа** (когда snapshot уже есть)             |
| `PATTERN_MATERIAL_AREA`       | `materialRole`         | `materialRole`     | `matchedLine.name ?? role` | «<fabric> <density> г/м², <color>, ширина <w> см» (из техкарты) | `кг` или `м²` (если плотности нет) | `AREA_DENSITY` (или `QTY_PER_UNIT` для м²)                          | **Только для category-driven заказа** — по одной строке на роль с заполненными `PatternMaterialArea` |
| `PATTERN_SIZE_PARAMETER_VALUE`| `categoryParameterId` | `value.roleKey`   | `value.labelSnapshot` | «<fabric> <density> г/м², <color>, ширина <w> см» (из техкарты) | `parameter.unit` (м пог. / м² / кг) | `LINEAR_M_BY_SIZE`                                  | Всегда — если в карточке номенклатуры заполнены значения по размерам |
| `PATTERN_PARAMETER_NORM`      | `norm.id`              | `norm.roleKey`     | `norm.labelSnapshot` | «<label>, <hardwareSize>, <hardwareMaterial>, цвет <color>»     | `norm.unit` (шт / м / …)     | `QTY_PER_UNIT`                                      | Всегда — для каждой нормы фурнитуры с `qtyPerItem > 0`               |
| `ORDER_APPLICATION`           | `application.id`       | `APPLICATION`      | `typeLabel`       | «<Тип>, <stage>, <место>, <WxH мм>, <цвет/описание>»                    | `application.unit ?? шт`     | `QTY_PER_UNIT`                                      | Всегда — для каждого активного `OrderApplication`                    |

Слово «Упаковка» нигде в UI не появляется (см. `getTechCardMaterialRoleLabel`,
`PATTERN_CATEGORY_PARAMETER_GROUPS`). Отдельной material-роли `HARDWARE`
нет — фурнитура остаётся под roleKey `PACKAGING`, а UI показывает её
как «Фурнитура».

## 2. Где и как создаются строки

```
WorkshopNeedsService.calculateForOrder
├── (1) load Order + items + materialRequirements + techCard.materialLines
│      + patternItem.{materialAreas, parameterNorms, sizeParameterValues, categoryId}
│      + applications
├── (2) build SourceLine[]: snapshot, или если snapshot пуст — live техкарта
├── (3) detect isCategoryDriven = patternItem.categoryId
│       AND (parameterNorms.length || sizeParameterValues.length || materialAreas.length)
├── (4) if !isCategoryDriven:
│        for each SourceLine → computeLine() → TECH_CARD_MATERIAL_LINE / ORDER_MATERIAL_REQUIREMENT
├── (5) for each active OrderApplication → computeApplication() → ORDER_APPLICATION
├── (6) if isCategoryDriven:
│        group materialAreas by role → computeMaterialAreaByRole() → PATTERN_MATERIAL_AREA
│        (techcard line по той же роли — только enrichment: density / width / color / fabricType)
├── (7) for each PatternItemParameterNorm with QTY_PER_ITEM:
│        find techcard line via findEnrichmentLine() → computeParameterNorm() → PATTERN_PARAMETER_NORM
│        (description обогащается hardwareSizeText / hardwareMaterialText / цвет)
├── (8) group PatternItemSizeParameterValue by categoryParameterId:
│        find techcard line via findEnrichmentLine() → computeLinearBySizeParameter() → PATTERN_SIZE_PARAMETER_VALUE
│        (description обогащается из техкарты, цвет резолвится через colorRule)
└── (9) transaction: delete CALCULATED-rows (or all if force) → insert computed[]
       audit log: { isCategoryDriven, methods: { AREA_DENSITY, QTY_PER_UNIT, LINEAR_M_BY_SIZE, PATTERN_MATERIAL_AREA }, warningsCount }
```

## 3. Что было лишним и почему

До этапа техкарта была универсальным источником количества: каждая
строка `TechCardMaterialLine` или `OrderMaterialRequirement` создавала
свою `WorkshopNeed`, даже если в карточке номенклатуры под эту роль
не было ни одного заполненного параметра. На примере (см. ТЗ
§«Сценарий A»):

| TechCard | Заполнено в номенклатуре | До исправления → WorkshopNeed | После исправления → WorkshopNeed |
| --- | --- | --- | --- |
| Дюспа (MAIN_FABRIC, 90 г/м², 140 см) | размерные значения LINEAR_M_BY_SIZE | две строки: TECH_CARD + LINEAR | одна строка: PATTERN_SIZE_PARAMETER_VALUE с описанием «Дюспа 90 г/м², бордо, ширина 140 см» |
| Тафта (LINING, 90 г/м², 150 см) | LINING-параметр пуст | одна строка: TECH_CARD | **нет строки** (Тафта не попадает) |
| Синтепон (FILLER) | FILLER-параметр пуст | одна строка: TECH_CARD | **нет строки** (Синтепон не попадает) |
| Молния (PACKAGING, 60 см, пластик) | норма PACKAGING / Молния = 1 шт | две строки: TECH_CARD + PARAMETER_NORM | одна строка: PATTERN_PARAMETER_NORM с описанием «Молния, 60 см, пластик, цвет бордо» |

Это и есть «убрать лишние строки, которые создаются только из техкарты
без заполненного параметра в номенклатуре» из ТЗ §3.

## 4. Enrichment (как техкарта обогащает потребность)

`findEnrichmentLine({ roleKey, labelSnapshot, sourceLines })` — общий
helper, который на стороне расчёта ищет строку техкарты для параметра
номенклатуры. Алгоритм:

1. **exact match**: `materialRole === roleKey` И normalized(name|fabricType)
   == normalized(labelSnapshot);
2. **single-role fallback**: ровно одна строка с `materialRole === roleKey`;
3. иначе — `null`, description = `labelSnapshot`.

Нормализация: `trim → lower → collapse-spaces → ё→е`.

В итоговой строке потребности из найденной techcard-строки берутся:

- `fabricType`, `densityGsm`, `plannedWidthCm` — для description тканей;
- `hardwareSizeText`, `hardwareMaterialText`, `materialImageUrl` — для description фурнитуры (PACKAGING) и preview UI;
- `colorRule`, `fixedColorText`, `selectedColorText` (snapshot only) — для резолвинга цвета:
  - `ORDER_COLOR` → `Order.color`;
  - `FIXED_COLOR` → `fixedColorText`;
  - `ORDER_SELECTED_COLOR` → `selectedColorText` (snapshot) или `null` (live);
  - `NO_COLOR` → `null`.

Если `colorRule = ORDER_SELECTED_COLOR` и цвет не резолвится — в
`calculationNote` пишется warning «Цвет нужно указать в заказе»,
который UI показывает плашкой.

## 5. Классификация секций (UI)

`getWorkshopNeedKind({ sourceType, calculationMethod, materialRole })` теперь
смотрит сперва на `materialRole`:

| materialRole          | Секция UI                  |
| --------------------- | -------------------------- |
| `PACKAGING`           | **Фурнитура** (HARDWARE)   |
| `APPLICATION`         | **Нанесение** (APPLICATION)|
| `MAIN_FABRIC`, `RIB`, `LINING`, `THREAD`, `FILLER`, `INTERLINING`, `ADDITIONAL_FABRIC`, `MARKING` | **Материалы** (MATERIAL) |
| (без роли)            | fallback по `sourceType` / `calculationMethod` |

Это закрывает требование ТЗ §7: «Спанбонд / Синтепон / Нитки не должны
попадать в секцию Фурнитура только потому, что источник
`PATTERN_PARAMETER_NORM` или `calculationMethod = QTY_PER_UNIT`».

## 6. Legacy-обратная совместимость

Legacy-заказ — это любой заказ, у которого:
- НЕТ `PatternItem.categoryId`, или
- категория есть, но `parameterNorms / sizeParameterValues / materialAreas` пусты.

Для таких заказов `isCategoryDriven = false`, и:

- Каждая строка техкарты / snapshot заказа становится `WorkshopNeed`
  (как раньше).
- Если у строки есть `materialRole + densityGsm` и совпадающая
  `PatternMaterialArea` — расчёт `AREA_DENSITY` (formula = totalArea ×
  density / 1000).
- Иначе — `QTY_PER_UNIT` (formula = qtyPerUnit × Σ qtyPlan).
- Никаких `PATTERN_MATERIAL_AREA` строк не создаётся.
- `PATTERN_PARAMETER_NORM` / `PATTERN_SIZE_PARAMETER_VALUE` не появляются
  (нечего обрабатывать).

Тесты:
- `integration/workshop-needs.test.ts` — старые сценарии AREA_DENSITY /
  QTY_PER_UNIT / fallback.
- `integration/workshop-needs-category-driven.test.ts` — Scenario E /
  Scenario E2 — legacy mode и pattern с категорией без параметров.

## 7. Acceptance summary

| ТЗ | Статус |
| --- | --- |
| 1. Не создаются лишние строки из техкарты для category-driven номенклатуры | ✅ — `if (!isCategoryDriven)` гейт |
| 2. Потребность создаётся только по заполненным параметрам номенклатуры | ✅ — PARAMETER_NORM / SIZE_PARAMETER_VALUE / MATERIAL_AREA |
| 3. Техкарта = enrichment, а не quantity source для category-driven | ✅ — `findEnrichmentLine` |
| 4. Фурнитура: размер / материал / цвет видны | ✅ — `hardwareSizeText`, `hardwareMaterialText`, `selectedColorText` в DTO + UI secondary-блок |
| 5. Warning «Цвет нужно указать в заказе» | ✅ — `requiresColorSelection && !selectedColorText` → calculationNote + UI плашка |
| 6. Нитки / Синтепон / Наполнитель не попадают в «Фурнитуру» | ✅ — `getWorkshopNeedKind` по materialRole |
| 7. PACKAGING остаётся «Фурнитура» | ✅ — `PATTERN_CATEGORY_PARAMETER_GROUPS::PACKAGING.label = 'Фурнитура'` |
| 8. Legacy-техкарты без категории продолжают работать | ✅ — Scenario E + старый тест-комплект `integration/workshop-needs.test.ts` |
| 9. Формулы не сломаны | ✅ — все 91 тест integration по workshop-needs / patterns / production-cost / order-cost зелёные |
| 10. Typecheck / build / smoke / integration проходят | ✅ — full suite зелёная |
