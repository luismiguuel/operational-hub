import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { config } from './config.js';
export const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1 });
export const queueConnection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
export const aiQueue = new Queue<{ projectId: string; actorId: string }>('project-summary', {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600, count: 200 },
    removeOnFail: { age: 86400, count: 200 },
  },
});

export const knowledgeQueue = new Queue<{ documentId: string }>('knowledge-index', {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});
