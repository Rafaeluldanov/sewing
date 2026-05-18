import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';
import { CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES } from '@sewing/shared/constructor-tasks';

import { ConstructorTaskFileInvalidException } from '../../common/errors.js';
import type { UploadedFileLike } from '../patterns/patterns-storage.service.js';

/**
 * Локальный файловый storage для модуля «Заявка конструктору» — файлы,
 * прикреплённые к `ConstructorTask`.
 *
 * Дизайн зеркалирует `TechCardsStorageService` / `PatternsStorageService`:
 *   - локальный файловый storage без S3/CDN; раздача — через
 *     `useStaticAssets('/uploads', uploadsRoot)` в `main.ts`;
 *   - файлы лежат в `<uploadsRoot>/constructor-tasks/<taskId>/<safeName>`;
 *   - `safeName` = `${timestamp}-${randomHex}.${ext}` — не зависит от
 *     пользовательского `originalname`, защита от path-traversal;
 *   - расширение НЕ ограничено (PDF / JPG / PNG / DWG / ZIP / ...);
 *     валидация — только по размеру файла;
 *   - upload НЕ перезаписывает существующие файлы: каждая загрузка —
 *     новое имя, БД хранит публичный URL.
 *
 * Корень storage — `PATTERNS_UPLOADS_DIR` (тот же `apps/api/uploads`,
 * что у других модулей), раздаётся единым префиксом `/uploads`.
 */
@Injectable()
export class ConstructorTasksStorageService {
  private readonly logger = new Logger(ConstructorTasksStorageService.name);

  readonly uploadsRoot: string = resolve(
    process.env.PATTERNS_UPLOADS_DIR ?? join(process.cwd(), 'apps/api/uploads'),
  );

  readonly publicPrefix = '/uploads';

  /**
   * Сохранить один файл задачи. Возвращает данные, которые надо
   * записать в `ConstructorTaskFile`.
   */
  async saveTaskFile(
    taskId: string,
    file: UploadedFileLike,
  ): Promise<{
    publicUrl: string;
    storedFileName: string;
    originalFileName: string;
    contentType: string;
    sizeBytes: number;
  }> {
    const safeOriginal = this.normalizeOriginalName(file.originalname);
    this.assertSize(file);
    const ext = this.extractExtension(safeOriginal);
    const storedFileName = this.makeStoredFileName(ext);
    const relativePath = posix.join(
      'constructor-tasks',
      taskId,
      storedFileName,
    );
    await this.writeFileSafe(relativePath, file.buffer);
    return {
      publicUrl: `${this.publicPrefix}/${relativePath}`,
      storedFileName,
      originalFileName: safeOriginal,
      contentType: file.mimetype || 'application/octet-stream',
      sizeBytes: file.size,
    };
  }

  /**
   * Удалить физический файл по относительному пути (без префикса
   * `/uploads/`). Используется при удалении `ConstructorTaskFile`
   * в админке. Молча игнорирует ENOENT — если файл уже удалён,
   * это OK.
   */
  async deleteByPublicUrl(publicUrl: string): Promise<void> {
    if (!publicUrl.startsWith(`${this.publicPrefix}/`)) return;
    const relative = publicUrl.slice(this.publicPrefix.length + 1);
    const absolute = resolve(this.uploadsRoot, relative);
    if (!absolute.startsWith(this.uploadsRoot + '/')) {
      this.logger.error(
        `Path traversal attempt suppressed on delete: ${absolute}`,
      );
      return;
    }
    try {
      await unlink(absolute);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        this.logger.warn(
          `Failed to delete file ${absolute}: ${(err as Error).message}`,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // INTERNAL helpers (parallel to TechCardsStorageService).
  // -------------------------------------------------------------------------

  private makeStoredFileName(ext: string): string {
    const timestamp = Date.now();
    const random = randomBytes(8).toString('hex');
    return ext ? `${timestamp}-${random}.${ext}` : `${timestamp}-${random}`;
  }

  private normalizeOriginalName(raw: string | undefined): string {
    if (!raw) {
      throw new ConstructorTaskFileInvalidException(
        'У файла нет имени — выберите его заново и повторите попытку.',
      );
    }
    const basename = raw.split(/[/\\]/).pop() ?? raw;
    const trimmed = basename.trim();
    if (trimmed.length === 0) {
      throw new ConstructorTaskFileInvalidException(
        'Имя файла пустое — переименуйте файл и повторите попытку.',
      );
    }
    if (trimmed.length > 255) {
      throw new ConstructorTaskFileInvalidException(
        'Имя файла слишком длинное (более 255 символов).',
      );
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(trimmed)) {
      throw new ConstructorTaskFileInvalidException(
        'В имени файла недопустимые символы (control characters).',
      );
    }
    return trimmed;
  }

  private extractExtension(safeOriginal: string): string {
    const lastDot = safeOriginal.lastIndexOf('.');
    if (lastDot <= 0 || lastDot === safeOriginal.length - 1) {
      return '';
    }
    return safeOriginal.slice(lastDot + 1).toLowerCase();
  }

  private assertSize(file: UploadedFileLike): void {
    if (file.size > CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES) {
      const mb = Math.round(CONSTRUCTOR_TASK_FILE_MAX_SIZE_BYTES / 1024 / 1024);
      throw new ConstructorTaskFileInvalidException(
        `Файл слишком большой: лимит ${mb} МБ.`,
      );
    }
    if (file.size <= 0) {
      throw new ConstructorTaskFileInvalidException(
        'Файл пустой — выберите корректный файл.',
      );
    }
  }

  private async writeFileSafe(
    relativePath: string,
    buffer: Buffer,
  ): Promise<void> {
    const absolute = resolve(this.uploadsRoot, relativePath);
    if (
      !absolute.startsWith(this.uploadsRoot + '/') &&
      absolute !== this.uploadsRoot
    ) {
      this.logger.error(
        `Path traversal attempt suppressed: ${absolute} outside ${this.uploadsRoot}`,
      );
      throw new ConstructorTaskFileInvalidException('Недопустимый путь файла.');
    }
    await mkdir(absolute.slice(0, absolute.lastIndexOf('/')), {
      recursive: true,
    });
    await writeFile(absolute, buffer);
  }
}
