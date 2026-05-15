import { z } from 'zod';

import { StartOrderSampleSchema } from '@sewing/shared/order-samples';

/**
 * Тело `POST /api/orders/:orderId/samples/start`.
 *
 * Источник истины валидации — Zod-схема в
 * `packages/shared/src/order-samples.ts`. Здесь только реэкспорт
 * `type`-алиаса для backend-кода и `Schema`-инстанса для пайпа.
 */
export { StartOrderSampleSchema };
export type StartOrderSampleDto = z.infer<typeof StartOrderSampleSchema>;
