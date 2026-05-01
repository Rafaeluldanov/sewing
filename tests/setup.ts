import 'reflect-metadata';

/**
 * Global test setup для MVP 1.1.
 *
 * `reflect-metadata` обязателен для NestJS DI: декораторы записывают
 * туда типы конструкторов, без этого `@Injectable()` не может собрать
 * зависимости. В рабочем API подключается через `import 'reflect-metadata'`
 * в `main.ts`; здесь мы запускаем тесты без `main.ts`, поэтому нужен
 * глобальный setup.
 */
