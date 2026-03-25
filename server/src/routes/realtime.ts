/** WebSocket route for real-time document sync (annotation updates and structure changes). */

import type { FastifyInstance } from 'fastify';
import { documentSyncHub } from '../realtime/hub.js';

export async function registerRealtimeRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/ws/documents/:documentId',
    { websocket: true },
    (socket, request) => {
      const { documentId } = request.params as { documentId: string };
      documentSyncHub.subscribe(documentId, socket);
    }
  );
}
