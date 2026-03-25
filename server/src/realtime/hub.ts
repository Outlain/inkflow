/**
 * WebSocket pub/sub hub for real-time document sync. Clients subscribe by
 * document ID and receive broadcast SyncEvents (page updates, structure changes).
 * Automatically cleans up on socket close/error.
 */

import type { WebSocket } from '@fastify/websocket';
import type { SyncEvent } from '../../../shared/src/contracts.js';

class DocumentSyncHub {
  private readonly socketsByDocument = new Map<string, Set<WebSocket>>();

  subscribe(documentId: string, socket: WebSocket): void {
    const bucket = this.socketsByDocument.get(documentId) ?? new Set<WebSocket>();
    bucket.add(socket);
    this.socketsByDocument.set(documentId, bucket);

    const cleanup = () => {
      const nextBucket = this.socketsByDocument.get(documentId);
      nextBucket?.delete(socket);
      if (nextBucket && nextBucket.size === 0) {
        this.socketsByDocument.delete(documentId);
      }
    };

    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  broadcast(documentId: string, event: SyncEvent): void {
    const bucket = this.socketsByDocument.get(documentId);
    if (!bucket || bucket.size === 0) {
      return;
    }

    const payload = JSON.stringify(event);
    for (const socket of bucket) {
      if (socket.readyState === socket.OPEN) {
        socket.send(payload);
      }
    }
  }
}

export const documentSyncHub = new DocumentSyncHub();
