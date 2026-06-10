import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodIssue, ZodSchema } from 'zod';

/**
 * Валидация body/query по Zod-схеме из `@sewing/shared`.
 *
 * При ошибке отдаётся 400 с полями:
 *   { statusCode, message, code: 'VALIDATION_ERROR', issues: [...] }
 *
 * Формат совпадает с §12/§13 docs/api.md.
 *
 * Понятность сообщений (10.06.2026):
 *   Авторские сообщения в схемах написаны по-русски — их отдаём как есть.
 *   Но если у поля нет своего message, Zod подставляет английский дефолт
 *   («Required», «Expected number, received nan», «String must contain…»),
 *   и пользователь видел бы непонятную строку. Поэтому такие дефолты
 *   переводим в русский текст с указанием КОНКРЕТНОГО поля: что именно
 *   заполнить / какой формат ожидается.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: humanizeIssue(i),
      }));
      throw new BadRequestException({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: issues[0]?.message ?? 'Проверьте правильность заполнения полей.',
        issues,
      });
    }
    return parsed.data;
  }
}

const CYRILLIC = /[а-яё]/i;

/**
 * Человекочитаемые подписи для часто встречающихся полей. Для полей не из
 * словаря (в основном внутренние идентификаторы, которые шлёт само
 * приложение) показываем исходное имя — пользователь всё равно поймёт, где
 * именно проблема, а не увидит обезличенное «Невалидные данные».
 */
const FIELD_LABELS: Record<string, string> = {
  comment: 'Комментарий',
  reason: 'Причина',
  description: 'Описание',
  unit: 'Единица измерения',
  qty: 'Количество',
  quantity: 'Количество',
  issuedQty: 'Количество к выдаче',
  returnQty: 'Количество к возврату',
  receivedQty: 'Принятое количество',
  unitCost: 'Цена за единицу',
  price: 'Цена',
  code: 'Код',
  name: 'Название',
  login: 'Логин',
  password: 'Пароль',
  color: 'Цвет',
  sizeCode: 'Размер',
  date: 'Дата',
  shippedAt: 'Дата отгрузки',
  materialRole: 'Роль материала',
  sourceType: 'Тип источника',
};

function fieldLabel(path: (string | number)[]): string {
  const named = [...path].reverse().find((p) => typeof p === 'string') as
    | string
    | undefined;
  if (!named) return 'поле';
  return FIELD_LABELS[named] ?? named;
}

/** Подсказка с номером строки для массивов (`lines.2.qty` → « (строка 3)»). */
function rowHint(path: (string | number)[]): string {
  const idx = path.find((p) => typeof p === 'number');
  return typeof idx === 'number' ? ` (строка ${idx + 1})` : '';
}

function humanizeIssue(issue: ZodIssue): string {
  // Авторское русское сообщение в схеме — оставляем как есть.
  if (CYRILLIC.test(issue.message)) return issue.message;

  const label = fieldLabel(issue.path);
  const row = rowHint(issue.path);

  switch (issue.code) {
    case 'invalid_type':
      if (issue.received === 'undefined' || issue.received === 'null') {
        return `Заполните обязательное поле «${label}»${row}.`;
      }
      if (issue.expected === 'number') {
        return `Поле «${label}»${row}: введите число.`;
      }
      if (issue.expected === 'string') {
        return `Поле «${label}»${row}: введите текст.`;
      }
      return `Поле «${label}»${row}: неверный тип значения.`;
    case 'too_small': {
      if (issue.type === 'string') {
        return issue.minimum === 1 || issue.minimum === 0
          ? `Заполните поле «${label}»${row}.`
          : `Поле «${label}»${row}: минимум ${issue.minimum} символов.`;
      }
      if (issue.type === 'array') {
        return `Добавьте хотя бы ${issue.minimum} строку${row}.`;
      }
      return `Поле «${label}»${row}: значение не меньше ${issue.minimum}.`;
    }
    case 'too_big': {
      if (issue.type === 'string') {
        return `Поле «${label}»${row}: не больше ${issue.maximum} символов.`;
      }
      if (issue.type === 'array') {
        return `Слишком много строк — не больше ${issue.maximum}${row}.`;
      }
      return `Поле «${label}»${row}: значение не больше ${issue.maximum}.`;
    }
    case 'invalid_enum_value':
      return `Поле «${label}»${row}: выберите одно из допустимых значений.`;
    case 'invalid_string':
      return `Поле «${label}»${row}: неверный формат.`;
    case 'unrecognized_keys':
      return `Переданы неизвестные поля: ${issue.keys.join(', ')}.`;
    case 'invalid_date':
      return `Поле «${label}»${row}: укажите корректную дату.`;
    default:
      return `Поле «${label}»${row}: неверное значение.`;
  }
}
