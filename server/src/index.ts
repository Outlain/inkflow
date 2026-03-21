import path from 'node:path';
import Fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { config, isProduction } from './config.js';
import { getDb } from './db/database.js';
import { registerLibraryRoutes } from './routes/library.js';
import { registerRealtimeRoutes } from './routes/realtime.js';

async function createServer() {
  getDb();

  const app = Fastify({
    logger: true,
    bodyLimit: config.maxUploadBytes
  });

  await app.register(fastifyMultipart, {
    limits: {
      files: 1,
      fileSize: config.maxUploadBytes
    }
  });

  await app.register(fastifyWebsocket);
  await app.register(registerLibraryRoutes, { prefix: '/api' });
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
    app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: 'Not found.' }));
  }

  return app;
}

const app = await createServer();

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
