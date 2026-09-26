export interface ReturnEvidenceView {
  id: string;
  originalFilename: string;
  mimeType: 'image/webp';
  sizeBytes: number;
  width: number;
  height: number;
  contentUrl: string;
  createdAt: Date;
}

export interface ReturnEvidenceDelivery {
  stream: Readable;
  sizeBytes: number;
  mimeType: 'image/webp';
}
import type { Readable } from 'node:stream';
