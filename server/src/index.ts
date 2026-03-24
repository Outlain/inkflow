import path from 'node:path';
import Fastify from 'fastify';
import fastifyCompress from '@fastify/compress';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { config, isProduction } from './config.js';
import { getDb } from './db/database.js';
import { registerActivityRoutes } from './routes/activity.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerRealtimeRoutes } from './routes/realtime.js';
import { startReaper } from './services/activityService.js';

const devClientOrigin = 'http://127.0.0.1:5173';

async function createServer() {
  getDb();

  const app = Fastify({
    logger: true,
    bodyLimit: config.maxUploadBytes
  });

  await app.register(fastifyCompress, {
    threshold: 1024 // compress responses > 1KB
  });

  await app.register(fastifyMultipart, {
    limits: {
      files: 1,
      fileSize: config.maxUploadBytes
    }
  });

  await app.register(fastifyWebsocket);
  await app.register(registerLibraryRoutes, { prefix: '/api' });
  await app.register(registerActivityRoutes, { prefix: '/api' });
  await app.register(registerRealtimeRoutes);


  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString()
  }));

  if (isProduction) {
    const clientDist = path.resolve(process.cwd(), 'dist/client');
    await app.register(fastifyStatic, {
      root: path.join(clientDist, 'assets'),
      prefix: '/assets/',
      wildcard: false
    });

    app.get('/', (_request, reply) =>
      reply.type('text/html').sendFile('index.html', clientDist, {
        immutable: false,
        maxAge: 0
      })
    );

    app.setNotFoundHandler((request, reply) => {
      if (request.raw.method === 'GET' && !request.url.startsWith('/api') && !request.url.startsWith('/assets/')) {
        return reply.type('text/html').sendFile('index.html', clientDist, {
          immutable: false,
          maxAge: 0
        });
      }
      return reply.status(404).send({ error: 'Not found.' });
    });
  } else {
    app.setNotFoundHandler(async (request, reply) => {
      const isPageRequest = request.raw.method === 'GET' || request.raw.method === 'HEAD';
      const isBackendRoute = request.url.startsWith('/api') || request.url.startsWith('/health') || request.url.startsWith('/ws/');

      if (!isPageRequest || isBackendRoute) {
        return reply.status(404).send({ error: 'Not found.' });
      }

      const upstreamUrl = new URL(request.raw.url || '/', devClientOrigin);
      const upstreamResponse = await fetch(upstreamUrl, {
        method: request.raw.method,
        headers: {
          accept: request.headers.accept ?? '*/*'
        }
      });

      reply.code(upstreamResponse.status);

      const contentType = upstreamResponse.headers.get('content-type');
      if (contentType) {
        reply.header('content-type', contentType);
      }

      const cacheControl = upstreamResponse.headers.get('cache-control');
      if (cacheControl) {
        reply.header('cache-control', cacheControl);
      }

      if (request.raw.method === 'HEAD') {
        return reply.send();
      }

      const body = await upstreamResponse.arrayBuffer();
      return reply.send(Buffer.from(body));
    });
  }

  startReaper();

  return app;
}

const app = await createServer();

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
