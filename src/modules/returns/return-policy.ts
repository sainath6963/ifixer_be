import type { OrderDocument } from '../../database/schemas/order.schema';
import type { ReturnRequestDocument } from '../../database/schemas/return-request.schema';
import { ReturnRequestStatus } from '../../domain/enums';

export const ALLOCATED_RETURN_STATUSES = [
  ReturnRequestStatus.Requested,
  ReturnRequestStatus.Approved,
  ReturnRequestStatus.Received,
  ReturnRequestStatus.Completed,
];

export function returnDeadline(deliveredAt: Date, windowDays: number): Date {
  return new Date(deliveredAt.getTime() + windowDays * 24 * 60 * 60 * 1000);
}

export function allocatedReturnQuantities(
  requests: Pick<ReturnRequestDocument, 'status' | 'items'>[],
): Map<string, number> {
  const allocated = new Map<string, number>();
  for (const request of requests) {
    if (!ALLOCATED_RETURN_STATUSES.includes(request.status)) continue;
    for (const item of request.items) {
      const variantId = item.variantId.toHexString();
      allocated.set(variantId, (allocated.get(variantId) ?? 0) + item.quantity);
    }
  }
  return allocated;
}

export function estimatedItemValue(
  item: OrderDocument['items'][number],
  requestedQuantity: number,
): number {
  if (requestedQuantity === item.quantity) return item.lineTotalInPaise;
  return Math.floor((item.lineTotalInPaise * requestedQuantity) / item.quantity);
}
