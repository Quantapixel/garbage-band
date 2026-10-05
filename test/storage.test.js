import test from 'node:test';
import assert from 'node:assert/strict';
import { RedisRoomStore } from '../lib/storage.js';

test('simultaneous Redis updates preserve both room changes', async () => {
  const values = new Map();
  const redis = {
    async set(key, value, options) {
      if (options.nx && values.has(key)) return null;
      values.set(key, value);
      return 'OK';
    },
    async get(key) { return values.get(key) ?? null; },
    async eval(_script, [key], [before, after]) {
      if (values.get(key) !== before) return 0;
      values.set(key, after);
      return 1;
    }
  };
  const rooms = new RedisRoomStore(redis);
  assert.equal(await rooms.create('ABC123', { players: [], version: 0 }), true);
  assert.equal(await rooms.create('ABC123', { players: [], version: 0 }), false);
  await Promise.all([
    rooms.update('ABC123', room => room.players.push('Ada')),
    rooms.update('ABC123', room => room.players.push('Ben'))
  ]);
  const room = await rooms.get('ABC123');
  assert.deepEqual(room.players, ['Ada', 'Ben']);
  assert.equal(room.version, 2);
});
