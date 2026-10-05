import test from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../server.js';
import { revealState } from '../lib/game.js';

function wav() {
  const rate = 16000, samples = 3200;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / rate) * 7000), 44 + i * 2);
  return bytes.toString('base64');
}

test('three players complete a round, including anonymous listening and ranked votes', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, data, status = 200) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal(response.status, status);
    return response.json();
  };
  try {
    const host = await post('/api/game?op=create', { name: 'Ada' }, 201);
    const act = (p, type, extra = {}, status = 200) => post('/api/game?op=action', { code: host.code, token: p.token, type, ...extra }, status);
    assert.match((await act(host, 'start', {}, 409)).error, /3 players/);
    const ben = await post('/api/game?op=join', { code: host.code, name: 'Ben' }, 201);
    const cy = await post('/api/game?op=join', { code: host.code, name: 'Cy' }, 201);
    const players = [host, ben, cy];
    assert.equal((await act(host, 'start')).phase, 'recording');
    for (const p of players) {
      const state = await (await fetch(`${base}/api/game?op=state&code=${host.code}&token=${p.token}`)).json();
      assert.equal(state.me.assigned.length, 2);
      for (const sound of state.me.assigned) await post('/api/game?op=record', { code: host.code, token: p.token, sound, mime: 'audio/wav', audio: wav() });
    }
    const hostRecordingState = await (await fetch(`${base}/api/game?op=state&code=${host.code}&token=${host.token}`)).json();
    const ownClip = Object.values(hostRecordingState.me.ownClips)[0];
    assert.equal((await fetch(base + ownClip)).status, 200);
    assert.equal((await fetch(base + ownClip.replace(host.token, ben.token))).status, 403);
    let state = await act(host, 'compose');
    assert.equal(state.kit.length, 6);
    assert.equal(state.kit.every(sample => !state.players.some(p => sample.id.includes(p.id))), true);
    const pattern = state.kit.map((_, i) => Array.from({ length: 16 }, (_, j) => i === 0 && j === 0 ? 1 : 0));
    for (const p of players) state = await act(p, 'submit', { pattern });
    assert.equal(state.phase, 'listening');
    assert.equal(state.tracks.length, 3);
    assert.equal(state.tracks.every(t => !('maker' in t) && !state.players.some(p => p.id === t.id)), true);
    for (let index = 0; index < 3; index++) for (const p of players) state = await act(p, 'heard', { index });
    assert.equal(state.phase, 'voting');
    const ownTrack = async p => (await (await fetch(`${base}/api/game?op=state&code=${host.code}&token=${p.token}`)).json()).tracks.find(t => t.own).id;
    const adaTrack = await ownTrack(host), benTrack = await ownTrack(ben);
    assert.match((await act(host, 'vote', { trackId: adaTrack }, 409)).error, /another player/);
    await act(host, 'vote', { trackId: benTrack });
    await act(ben, 'vote', { trackId: adaTrack });
    state = await act(cy, 'vote', { trackId: adaTrack });
    assert.equal(state.phase, 'reveal');
    assert.equal(state.reveal.total, 3);
    assert.equal(state.reveal.visible, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('reveal stages derive from a stored timestamp', () => {
  const startedAt = 1_000_000;
  const room = { reveal: { startedAt, ranked: [{ id: 'c', name: 'Cy', votes: 0, rank: 3 }, { id: 'b', name: 'Ben', votes: 1, rank: 2 }, { id: 'a', name: 'Ada', votes: 2, rank: 1 }] } };
  assert.equal(revealState(room, startedAt + 1000).visible, false);
  assert.deepEqual([revealState(room, startedAt + 4000).rank, revealState(room, startedAt + 20_000).rank, revealState(room, startedAt + 36_000).rank], [3, 2, 1]);
  assert.equal(revealState(room, startedAt + 48_000).finished, true);
});
