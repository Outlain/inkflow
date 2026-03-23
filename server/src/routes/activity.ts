import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createChapter,
  deleteChapter,
  endSession,
  ensureDefaultUserFromEnv,
  exportActivity,
  fireWebhook,
  getActivityConfig,
  getActivitySummary,
  getDefaultUser,
  getDocumentActivitySummary,
  getDocumentChapters,
  heartbeat,
  logActivityEvents,
  setupUser,
  startSession,
  updateActivityConfig,
  updateChapter
} from '../services/activityService.js';

const setupSchema = z.object({
  displayName: z.string().trim().min(1).max(80)
});

const startSessionSchema = z.object({
  sessionType: z.enum(['app', 'study']),
  documentId: z.string().optional(),
  deviceId: z.string().min(1),
  deviceLabel: z.string().optional(),
  pageIndex: z.number().int().min(0).optional()
});

const heartbeatSchema = z.object({
  sessionId: z.string().min(1),
  pageIndex: z.number().int().min(0).optional()
});

const endSessionSchema = z.object({
  sessionId: z.string().min(1),
  pageIndex: z.number().int().min(0).optional()
});

const eventTypeEnum = z.enum([
  'session.start', 'session.end', 'page.edited', 'document.created',
  'document.imported', 'document.exported', 'page.created', 'page.deleted',
  'folder.created'
]);

const logEventsSchema = z.object({
  events: z.array(z.object({
    sessionId: z.string().optional(),
    documentId: z.string().optional(),
    pageId: z.string().optional(),
    eventType: eventTypeEnum,
    metadata: z.record(z.unknown()).optional()
  })).min(1).max(100)
});

const configSchema = z.object({
  idleTimeoutSecs: z.number().int().min(60).max(3600).optional(),
  dailyGoalMins: z.number().int().min(0).max(1440).optional(),
  webhookUrl: z.string().url().nullable().optional(),
  webhookEnabled: z.boolean().optional()
});

const createChapterSchema = z.object({
  title: z.string().trim().min(1).max(200),
  startPageIndex: z.number().int().min(0),
  endPageIndex: z.number().int().min(0),
  color: z.string().optional()
});

const updateChapterSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  startPageIndex: z.number().int().min(0).optional(),
  endPageIndex: z.number().int().min(0).optional(),
  color: z.string().nullable().optional()
});

const exportQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
});

function requireUser() {
  const user = getDefaultUser();
  if (!user) {
    throw { statusCode: 403, message: 'No user configured. Complete setup first.' };
  }
  return user;
}

export async function registerActivityRoutes(app: FastifyInstance): Promise<void> {
  // Auto-create user from env var on startup
  ensureDefaultUserFromEnv();

  // ── User setup ──

  app.get('/users/me', async (_request, reply) => {
    const user = getDefaultUser();
    if (!user) {
      return reply.status(404).send({ error: 'No user configured', setupRequired: true });
    }
    return reply.send(user);
  });

  app.post('/users/setup', async (request, reply) => {
    const body = setupSchema.parse(request.body);
    const user = setupUser(body.displayName);
    return reply.status(201).send(user);
  });

  // ── Sessions ──

  app.post('/activity/sessions/start', async (request, reply) => {
    const user = requireUser();
    const body = startSessionSchema.parse(request.body);
    const session = startSession({
      userId: user.id,
      sessionType: body.sessionType,
      documentId: body.documentId,
      deviceId: body.deviceId,
      deviceLabel: body.deviceLabel,
      pageIndex: body.pageIndex
    });
    return reply.status(201).send(session);
  });

  app.post('/activity/heartbeat', async (request, reply) => {
    requireUser();
    const body = heartbeatSchema.parse(request.body);
    const session = heartbeat(body.sessionId, body.pageIndex);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found or already ended' });
    }
    return reply.send(session);
  });

  app.post('/activity/sessions/end', async (request, reply) => {
    requireUser();
    const body = endSessionSchema.parse(request.body);
    const session = endSession(body.sessionId, body.pageIndex);
    if (!session) {
      return reply.status(404).send({ error: 'Session not found' });
    }
    // Fire webhook in background
    if (session.endedAt) {
      fireWebhook(session).catch(() => {});
    }
    return reply.send(session);
  });

  // ── Events ──

  app.post('/activity/events', async (request, reply) => {
    const user = requireUser();
    const body = logEventsSchema.parse(request.body);
    const events = logActivityEvents(user.id, body.events);
    return reply.status(201).send({ events });
  });

  // ── Summary / Stats ──

  app.get('/activity/summary', async (_request, reply) => {
    const user = requireUser();
    const summary = getActivitySummary(user.id);
    return reply.send(summary);
  });

  app.get('/activity/documents/:documentId', async (request, reply) => {
    const user = requireUser();
    const { documentId } = request.params as { documentId: string };
    const summary = getDocumentActivitySummary(user.id, documentId);
    return reply.send(summary);
  });

  // ── Config ──

  app.get('/activity/config', async (_request, reply) => {
    const cfg = getActivityConfig();
    return reply.send(cfg);
  });

  app.put('/activity/config', async (request, reply) => {
    requireUser();
    const body = configSchema.parse(request.body);
    const cfg = updateActivityConfig(body);
    return reply.send(cfg);
  });

  // ── Export ──

  app.get('/activity/export', async (request, reply) => {
    const user = requireUser();
    const query = exportQuerySchema.parse(request.query);
    const data = exportActivity(user.id, query.from, query.to);
    return reply.send(data);
  });

  // ── Chapters ──

  app.get('/documents/:documentId/chapters', async (request, reply) => {
    const { documentId } = request.params as { documentId: string };
    const chapters = getDocumentChapters(documentId);
    return reply.send({ chapters });
  });

  app.post('/documents/:documentId/chapters', async (request, reply) => {
    requireUser();
    const { documentId } = request.params as { documentId: string };
    const body = createChapterSchema.parse(request.body);
    const chapter = createChapter(documentId, body);
    return reply.status(201).send(chapter);
  });

  app.put('/chapters/:chapterId', async (request, reply) => {
    requireUser();
    const { chapterId } = request.params as { chapterId: string };
    const body = updateChapterSchema.parse(request.body);
    const chapter = updateChapter(chapterId, body);
    if (!chapter) {
      return reply.status(404).send({ error: 'Chapter not found' });
    }
    return reply.send(chapter);
  });

  app.delete('/chapters/:chapterId', async (request, reply) => {
    requireUser();
    const { chapterId } = request.params as { chapterId: string };
    const deleted = deleteChapter(chapterId);
    if (!deleted) {
      return reply.status(404).send({ error: 'Chapter not found' });
    }
    return reply.send({ ok: true });
  });
}
