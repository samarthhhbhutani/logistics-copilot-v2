import type { Rfq } from '@lc/core';
import type { RfqResponse } from '@lc/contract';

export function toRfqResponse(rfq: Rfq): RfqResponse {
  return {
    id: rfq.id,
    sourceEmailId: rfq.sourceEmailId,
    originPort: rfq.originPort,
    destinationPort: rfq.destinationPort,
    incoterm: rfq.incoterm,
    status: rfq.status,
    createdAt: rfq.createdAt.toISOString(),
    updatedAt: rfq.updatedAt.toISOString(),
  };
}
