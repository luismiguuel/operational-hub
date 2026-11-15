import { buildApp } from './app.js';
import { config } from './core/config.js';
import { db } from './core/db.js';
import { redis, queueConnection, aiQueue } from './core/redis.js';
const app = await buildApp();
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void (async () => {
      await app.close();
      await aiQueue.close();
      await queueConnection.quit();
      await redis.quit();
      await db.end();
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  });
await app.listen({ port: config.PORT, host: '0.0.0.0' });
