import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * Валидация body/query по Zod-схеме из `@sewing/shared`.
 *
 * При ошибке отдаётся 400 с полями:
 *   { statusCode, message, code: 'VALIDATION_ERROR', issues: [...] }
 *
 * Формат совпадает с §12/§13 docs/api.md.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      }));
      throw new BadRequestException({
        statusCode: 400,
        code: 'VALIDATION_ERROR',
        message: issues[0]?.message ?? 'Невалидные данные',
        issues,
      });
    }
    return parsed.data;
  }
}
