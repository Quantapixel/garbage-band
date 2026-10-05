import { randomBytes } from 'node:crypto';

const ROOM_TTL_SECONDS = 60 * 60 * 24;
const PREFIX = 'garbage-band/';

export class MemoryRoomStore {
  constructor() { this.rooms = new Map(); }
  async create(code, room) {
    if (this.rooms.has(code)) return false;
    this.rooms.set(code, structuredClone(room));
    return true;
  }
  async get(code) { const room = this.rooms.get(code); return room ? structuredClone(room) : null; }
  async update(code, mutate) {
    const previous = this.rooms.get(code);
    if (!previous) return null;
    const next = structuredClone(previous);
    mutate(next);
    next.version = (next.version || 0) + 1;
    next.updatedAt = Date.now();
    this.rooms.set(code, next);
    return structuredClone(next);
  }
}

// Compare-and-swap keeps simultaneous votes and submissions from overwriting
// each other when Vercel routes requests to different function instances.
const CAS_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;

export class RedisRoomStore {
  constructor(redis) { this.redis = redis; }
  key(code) { return `${PREFIX}room:${code}`; }
  async create(code, room) {
    const result = await this.redis.set(this.key(code), JSON.stringify(room), { nx: true, ex: ROOM_TTL_SECONDS });
    return result === 'OK';
  }
  async get(code) {
    const raw = await this.redis.get(this.key(code));
    return raw ? JSON.parse(raw) : null;
  }
  async update(code, mutate) {
    const key = this.key(code);
    for (let attempt = 0; attempt < 16; attempt++) {
      const raw = await this.redis.get(key);
      if (!raw) return null;
      const next = JSON.parse(raw);
      mutate(next);
      next.version = (next.version || 0) + 1;
      next.updatedAt = Date.now();
      const swapped = await this.redis.eval(CAS_SCRIPT, [key], [raw, JSON.stringify(next), String(ROOM_TTL_SECONDS)]);
      if (Number(swapped) === 1) return next;
    }
    throw new Error('Room is busy. Try again.');
  }
}

export class MemoryAudioStore {
  constructor() { this.audio = new Map(); }
  async put(code, sampleId, bytes, mime) {
    const pathname = `memory:${code}:${sampleId}:${randomBytes(6).toString('hex')}`;
    this.audio.set(pathname, { bytes: Buffer.from(bytes), mime });
    return pathname;
  }
  async get(pathname) { return this.audio.get(pathname) || null; }
  async delete(pathname) { this.audio.delete(pathname); }
}

export class BlobAudioStore {
  constructor(blob) { this.blob = blob; }
  async put(code, sampleId, bytes, mime) {
    const result = await this.blob.put(`${PREFIX}${code}/${sampleId}.wav`, new Blob([bytes], { type: mime }), { access: 'private', addRandomSuffix: true, contentType: mime });
    return result.pathname;
  }
  async get(pathname) {
    const result = await this.blob.get(pathname, { access: 'private' });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return { bytes: Buffer.from(await new Response(result.stream).arrayBuffer()), mime: result.blob.contentType || 'audio/wav' };
  }
  async delete(pathname) { await this.blob.del(pathname); }
}

let servicesPromise;
export async function getServices() {
  servicesPromise ||= (async () => {
    const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
    const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
    const blobReady = !!(process.env.BLOB_READ_WRITE_TOKEN || (process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN));
    if (redisUrl && redisToken && blobReady) {
      const [{ Redis }, blob] = await Promise.all([import('@upstash/redis'), import('@vercel/blob')]);
      const redis = new Redis({ url: redisUrl, token: redisToken, automaticDeserialization: false });
      return { rooms: new RedisRoomStore(redis), audio: new BlobAudioStore(blob), durable: true };
    }
    if (process.env.VERCEL || redisUrl || redisToken || blobReady) throw new Error('Configure Upstash Redis and Vercel Blob before serving the game.');
    return { rooms: new MemoryRoomStore(), audio: new MemoryAudioStore(), durable: false };
  })();
  return servicesPromise;
}

export async function cleanupExpiredBlobs(now = Date.now()) {
  const { rooms, audio, durable } = await getServices();
  if (!durable) return 0;
  let cursor, removed = 0;
  do {
    const page = await audio.blob.list({ prefix: PREFIX, cursor, limit: 1000 });
    const old = page.blobs.filter(item => now - new Date(item.uploadedAt).getTime() > ROOM_TTL_SECONDS * 1000);
    const codes = [...new Set(old.map(item => item.pathname.slice(PREFIX.length).split('/')[0]))];
    const active = new Map(await Promise.all(codes.map(async code => [code, await rooms.get(code)])));
    const expired = old.filter(item => {
      const room = active.get(item.pathname.slice(PREFIX.length).split('/')[0]);
      return !room || !room.players.some(player => Object.values(player.recordings).some(recording => recording.pathname === item.pathname));
    });
    if (expired.length) {
      await audio.blob.del(expired.map(item => item.url));
      removed += expired.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return removed;
}
