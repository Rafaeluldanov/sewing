import { z } from 'zod';

import {
  ApproveOrderSampleSchema,
  RejectOrderSampleSchema,
  CancelOrderSampleSchema,
} from '@sewing/shared/order-samples';

export { ApproveOrderSampleSchema, RejectOrderSampleSchema, CancelOrderSampleSchema };
export type ApproveOrderSampleDto = z.infer<typeof ApproveOrderSampleSchema>;
export type RejectOrderSampleDto = z.infer<typeof RejectOrderSampleSchema>;
export type CancelOrderSampleDto = z.infer<typeof CancelOrderSampleSchema>;
