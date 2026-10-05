import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const rooms = new Map();
const genres = [
  { name: 'HIP-HOP', bpm: 92, color: '#d7ff45', sounds: ['808 kick', 'snare crack', 'closed hi-hat', 'open hi-hat', 'sub bass', 'vinyl scratch', 'hand clap', 'vocal chop'] },
  { name: 'HOUSE', bpm: 122, color: '#ff8c6a', sounds: ['four-on-floor kick', 'clap', 'shaker', 'open hat', 'bass pulse', 'synth stab', 'riser', 'vocal hook'] },
  { name: 'DRUM & BASS', bpm: 172, color: '#9a90ff', sounds: ['punchy kick', 'snare', 'rolling hi-hat', 'reese bass', 'breakbeat chop', 'synth blip', 'impact', 'vocal shout'] },
  { name: 'DISCO', bpm: 116, color: '#ffcd55', sounds: ['dance kick', 'hand clap', 'tambourine', 'funk bass', 'guitar chop', 'string stab', 'cowbell', 'vocal sparkle'] },
  { name: 'TECHNO', bpm: 130, color: '#63d9d0', sounds: ['hard kick', 'metallic hat', 'clap', 'rumble bass', 'acid squelch', 'synth pulse', 'noise sweep', 'robot voice'] }
];
const id = (n = 18) => randomBytes(n).toString('base64url');
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const error = (res, status, message) => send(res, status, { error: message });
const shuffle = arr => arr.map(value => ({ value, sort: Math.random() })).sort((a, b) => a.sort - b.sort).map(x => x.value);
const player = (room, token) => room.players.find(p => p.token === token);
const safeName = name => String(name || '').trim().replace(/\s+/g, ' ').slice(0, 24);

function newRoom(name) {
  let code;
  do { code = randomBytes(3).toString('hex').toUpperCase(); } while (rooms.has(code));
  const host = { id: id(8), token: id(), name, assigned: [], sampleIds: {}, recordings: {}, track: null, vote: null, heard: [] };
  const room = { code, players: [host], hostId: host.id, phase: 'lobby', round: 0, genre: null, order: [], listeningIndex: 0, reveal: null, revealTimer: null, clients: new Set(), updated: Date.now() };
  rooms.set(code, room);
  return { room, host };
}

function view(room, me) {
  const kit = room.players.flatMap(p => p.assigned.filter(sound => p.recordings[sound]).map(sound => ({ id: p.sampleIds[sound], sound, url: `/api/audio/${room.code}/${p.sampleIds[sound]}?token=${encodeURIComponent(me.token)}` })));
  const tracks = room.order.map((entry, i) => ({ number: i + 1, id: entry.id, pattern: room.players.find(p => p.id === entry.makerId)?.track?.pattern || [], own: entry.makerId === me.id }));
  const ranked = room.phase === 'reveal' && room.reveal?.visible ? room.reveal.ranked[room.reveal.index] : null;
  return {
    code: room.code, phase: room.phase, round: room.round, genre: room.genre && { name: room.genre.name, bpm: room.genre.bpm, color: room.genre.color },
    hostId: room.hostId, me: { id: me.id, name: me.name, host: me.id === room.hostId, assigned: me.assigned, recorded: me.assigned.filter(s => me.recordings[s]), ownClips: Object.fromEntries(me.assigned.filter(s => me.recordings[s]).map(s => [s, `/api/audio/${room.code}/${me.sampleIds[s]}?token=${encodeURIComponent(me.token)}`])), submitted: !!me.track, voted: me.vote !== null, heard: me.heard },
    players: room.players.map(p => ({ id: p.id, name: p.name, recorded: p.assigned.filter(s => p.recordings[s]).length, assigned: p.assigned.length, submitted: !!p.track, voted: p.vote !== null })),
    kit: ['composing', 'listening', 'voting', 'reveal'].includes(room.phase) ? kit : [],
    tracks: ['listening', 'voting', 'reveal'].includes(room.phase) ? tracks : [],
    listeningIndex: room.listeningIndex,
    listeningHeard: room.phase === 'listening' ? room.players.filter(p => p.heard.includes(room.listeningIndex)).length : 0,
    reveal: room.phase === 'reveal' ? { index: room.reveal.index, total: room.reveal.ranked.length, visible: room.reveal.visible, endsAt: room.reveal.endsAt, finished: room.reveal.finished, rank: ranked ? ranked.rank : null, maker: ranked ? ranked.name : null, trackId: ranked ? ranked.id : null, votes: ranked ? ranked.votes : null } : null
  };
}
function broadcast(room) {
  room.updated = Date.now();
  for (const client of room.clients) {
    try { client.res.write(`event: state\ndata: ${JSON.stringify(view(room, client.player))}\n\n`); } catch { room.clients.delete(client); }
  }
}
function beginRound(room) {
  if (room.revealTimer) clearTimeout(room.revealTimer);
  room.round++;
  room.genre = genres[randomInt(genres.length)];
  room.phase = 'recording'; room.order = []; room.listeningIndex = 0; room.reveal = null;
  for (const p of room.players) {
    p.assigned = shuffle(room.genre.sounds).slice(0, 2);
    p.sampleIds = Object.fromEntries(p.assigned.map(sound => [sound, id(8)]));
    p.recordings = {}; p.track = null; p.vote = null; p.heard = [];
  }
  broadcast(room);
}
function beginReveal(room) {
  const sorted = room.players.map(p => ({ id: room.order.find(entry => entry.makerId === p.id).id, name: p.name, votes: room.players.filter(v => v.vote === p.id).length, tie: Math.random() }))
    .sort((a, b) => b.votes - a.votes || a.tie - b.tie).slice(0, 3).reverse();
  const ranked = sorted.map((entry, i) => ({ ...entry, rank: sorted.length - i }));
  room.phase = 'reveal';
  room.reveal = { ranked, index: 0, visible: false, endsAt: Date.now() + 4000, finished: false };
  broadcast(room);
  const tick = () => {
    if (room.phase !== 'reveal') return;
    if (!room.reveal.visible) {
      room.reveal.visible = true;
      room.reveal.endsAt = Date.now() + 12000;
      broadcast(room);
      room.revealTimer = setTimeout(tick, 12000);
      room.revealTimer.unref();
    } else if (room.reveal.index < room.reveal.ranked.length - 1) {
      room.reveal.index++;
      room.reveal.visible = false;
      room.reveal.endsAt = Date.now() + 4000;
      broadcast(room);
      room.revealTimer = setTimeout(tick, 4000);
      room.revealTimer.unref();
    } else {
      room.reveal.finished = true;
      room.reveal.endsAt = null;
      broadcast(room);
    }
  };
  room.revealTimer = setTimeout(tick, 4000);
  room.revealTimer.unref();
}
async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 6_000_000) throw new Error('Recording is too large (6 MB max).'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new Error('Invalid request.'); }
}
function validPattern(pattern, kit) {
  if (!Array.isArray(pattern) || pattern.length !== kit.length) return false;
  return pattern.every(row => Array.isArray(row) && row.length === 16 && row.every(v => v === 0 || v === 1));
}
function act(room, me, data) {
  switch (data.type) {
    case 'start':
      if (me.id !== room.hostId || !['lobby', 'reveal'].includes(room.phase) || (room.phase === 'reveal' && !room.reveal.finished)) throw new Error('Only the host can start a round.');
      if (room.players.length < 3) throw new Error('At least 3 players are needed.');
      beginRound(room); break;
    case 'compose':
      if (me.id !== room.hostId || room.phase !== 'recording') throw new Error('Only the host can move to the studio.');
      if (room.players.some(p => p.assigned.some(s => !p.recordings[s]))) throw new Error('Wait for every recording.');
      room.phase = 'composing'; broadcast(room); break;
    case 'submit': {
      if (room.phase !== 'composing') throw new Error('The studio is closed.');
      const kit = room.players.flatMap(p => p.assigned.filter(s => p.recordings[s]));
      if (!validPattern(data.pattern, kit)) throw new Error('Invalid 16-step track.');
      if (!data.pattern.some(row => row.some(Boolean))) throw new Error('Add at least one beat to your track.');
      me.track = { pattern: data.pattern };
      if (room.players.every(p => p.track)) { room.order = shuffle(room.players.map(p => ({ id: id(8), makerId: p.id }))); room.phase = 'listening'; room.listeningIndex = 0; }
      broadcast(room); break;
    }
    case 'heard':
      if (room.phase !== 'listening' || data.index !== room.listeningIndex) throw new Error('This listening slot has ended.');
      if (!me.heard.includes(data.index)) me.heard.push(data.index);
      if (room.players.every(p => p.heard.includes(room.listeningIndex))) {
        if (room.listeningIndex < room.order.length - 1) room.listeningIndex++;
        else room.phase = 'voting';
      }
      broadcast(room); break;
    case 'vote':
      if (room.phase !== 'voting') throw new Error('Voting is closed.');
      if (me.vote !== null) throw new Error('You already voted.');
      const chosen = room.order.find(entry => entry.id === data.trackId);
      if (!chosen || chosen.makerId === me.id) throw new Error('Choose another player’s track.');
      me.vote = chosen.makerId;
      if (room.players.every(p => p.vote !== null)) beginReveal(room); else broadcast(room);
      break;
    default: throw new Error('Unknown action.');
  }
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const data = await body(req); const name = safeName(data.name);
      if (!name) return error(res, 400, 'Enter your name.');
      const { room, host } = newRoom(name);
      return send(res, 201, { code: room.code, token: host.token, state: view(room, host) });
    }
    if (req.method === 'POST' && url.pathname === '/api/join') {
      const data = await body(req); const code = String(data.code || '').toUpperCase().trim(); const room = rooms.get(code); const name = safeName(data.name);
      if (!room) return error(res, 404, 'Room not found. Check the code.');
      if (room.phase !== 'lobby') return error(res, 409, 'This round has already started.');
      if (!name) return error(res, 400, 'Enter your name.');
      if (room.players.length >= 8) return error(res, 409, 'This room is full.');
      if (room.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return error(res, 409, 'That name is already taken.');
      const p = { id: id(8), token: id(), name, assigned: [], sampleIds: {}, recordings: {}, track: null, vote: null, heard: [] };
      room.players.push(p); broadcast(room);
      return send(res, 201, { code, token: p.token, state: view(room, p) });
    }
    if (parts[0] === 'api' && parts[1] === 'rooms' && parts.length === 3 && req.method === 'GET') {
      const room = rooms.get(parts[2]); const me = room && player(room, url.searchParams.get('token'));
      return me ? send(res, 200, view(room, me)) : error(res, 404, 'Room not found.');
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      const room = rooms.get(url.searchParams.get('code')); const me = room && player(room, url.searchParams.get('token'));
      if (!me) return error(res, 404, 'Room not found.');
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
      const client = { res, player: me }; room.clients.add(client);
      res.write(`event: state\ndata: ${JSON.stringify(view(room, me))}\n\n`);
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { clearInterval(heartbeat); room.clients.delete(client); });
      return;
    }
    if (url.pathname === '/api/action' && req.method === 'POST') {
      const data = await body(req); const room = rooms.get(data.code); const me = room && player(room, data.token);
      if (!me) return error(res, 403, 'Join a room first.');
      try { act(room, me, data); } catch (e) { return error(res, 409, e.message); }
      return send(res, 200, view(room, me));
    }
    if (url.pathname === '/api/record' && req.method === 'POST') {
      const data = await body(req); const room = rooms.get(data.code); const me = room && player(room, data.token);
      if (!me) return error(res, 403, 'Join a room first.');
      if (room.phase !== 'recording' || !me.assigned.includes(data.sound)) return error(res, 409, 'That sound is not assigned to you.');
      if (!/^audio\/(webm|ogg|mp4|wav)(;codecs=[\w,.-]+)?$/.test(data.mime || '')) return error(res, 400, 'Unsupported audio format.');
      if (typeof data.audio !== 'string' || data.audio.length > 5_500_000) return error(res, 400, 'Recording is too large.');
      const bytes = Buffer.from(data.audio, 'base64');
      if (!bytes.length || bytes.length > 4_000_000) return error(res, 400, 'Recording is invalid or too large.');
      me.recordings[data.sound] = { bytes, mime: data.mime };
      broadcast(room);
      return send(res, 200, view(room, me));
    }
    if (parts[0] === 'api' && parts[1] === 'audio' && parts.length === 4 && req.method === 'GET') {
      const room = rooms.get(parts[2]); const me = room && player(room, url.searchParams.get('token'));
      if (!me) return error(res, 403, 'Audio unavailable.');
      const sampleId = parts[3];
      const owner = room.players.find(p => Object.values(p.sampleIds).includes(sampleId));
      const sound = owner && Object.keys(owner.sampleIds).find(key => owner.sampleIds[key] === sampleId);
      const audio = sound && owner.recordings[sound];
      if (room.phase === 'recording' && owner?.id !== me.id) return error(res, 403, 'Audio unavailable.');
      if (!['recording', 'composing', 'listening', 'voting', 'reveal'].includes(room.phase)) return error(res, 403, 'Audio unavailable.');
      if (!audio) return error(res, 404, 'Recording not found.');
      res.writeHead(200, { 'content-type': audio.mime, 'content-length': audio.bytes.length, 'cache-control': 'private, max-age=300' }); res.end(audio.bytes); return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return error(res, 404, 'Not found.');
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'app.js', 'audio-process.js', 'style.css'].includes(file)) return error(res, 404, 'Not found.');
    const filePath = path.join(root, file); const info = await stat(filePath); const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': { 'html': 'text/html; charset=utf-8', 'js': 'text/javascript; charset=utf-8', 'css': 'text/css; charset=utf-8' }[file.split('.').pop()], 'content-length': info.size }); res.end(req.method === 'HEAD' ? undefined : data);
  } catch (e) { error(res, e.message?.includes('large') ? 413 : 400, e.message || 'Request failed.'); }
}

export const server = http.createServer(handler);
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => console.log(`Garbage Band listening on http://localhost:${port}`));
}
