import test from 'node:test';
import assert from 'node:assert/strict';
import { server } from '../server.js';

test('three players complete a round, including anonymous listening and ranked votes', async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, data, status = 200) => {
    const response = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) });
    assert.equal(response.status, status);
    return response.json();
  };
  try {
    const host = await post('/api/rooms', { name: 'Ada' }, 201);
    const act = (p, type, extra = {}, status = 200) => post('/api/action', { code: host.code, token: p.token, type, ...extra }, status);
    assert.match((await act(host, 'start', {}, 409)).error, /3 players/);
    const ben = await post('/api/join', { code: host.code, name: 'Ben' }, 201);
    const cy = await post('/api/join', { code: host.code, name: 'Cy' }, 201);
    const players = [host, ben, cy];
    assert.equal((await act(host, 'start')).phase, 'recording');
    for (const p of players) {
      const state = await (await fetch(`${base}/api/rooms/${host.code}?token=${p.token}`)).json();
      assert.equal(state.me.assigned.length, 2);
      for (const sound of state.me.assigned) await post('/api/record', { code: host.code, token: p.token, sound, mime: 'audio/webm', audio: Buffer.from('fake audio').toString('base64') });
    }
    const hostRecordingState = await (await fetch(`${base}/api/rooms/${host.code}?token=${host.token}`)).json();
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
    const ownTrack = async p => (await (await fetch(`${base}/api/rooms/${host.code}?token=${p.token}`)).json()).tracks.find(t => t.own).id;
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
