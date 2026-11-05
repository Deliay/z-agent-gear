import Redis from 'ioredis';

const url = process.env.REDIS_URL;
const redis = new Redis(url, { enableOfflineQueue: false, retryStrategy: () => null });
redis.on('error', (err) => console.log('event error:', err.message));
redis.on('close', () => console.log('event close'));
redis.on('ready', () => console.log('event ready'));

const probe = async (label) => {
  try {
    await redis.set(`zag:probe:${label}`, '1', 'EX', 30);
    console.log(label, 'set OK');
  } catch (err) {
    console.log(label, 'set FAIL:', err.message, '| status =', redis.status);
  }
};

await probe('immediate');
await new Promise((r) => setTimeout(r, 3000));
console.log('status after 3s =', redis.status);
await probe('after-3s');
await new Promise((r) => setTimeout(r, 10000));
console.log('status after 13s =', redis.status);
await probe('after-13s');
redis.disconnect();
process.exit(0);
