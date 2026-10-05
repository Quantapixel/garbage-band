import { randomBytes, randomInt } from 'node:crypto';
import { getServices } from './storage.js';

const genres = [
  { name: 'HIP-HOP', bpm: 92, color: '#d7ff45', sounds: ['808 kick', 'snare crack', 'closed hi-hat', 'open hi-hat', 'sub bass', 'vinyl scratch', 'hand clap', 'vocal chop'] },
  { name: 'HOUSE', bpm: 122, color: '#ff8c6a', sounds: ['four-on-floor kick', 'clap', 'shaker', 'open hat', 'bass pulse', 'synth stab', 'riser', 'vocal hook'] },
  { name: 'DRUM & BASS', bpm: 172, color: '#9a90ff', sounds: ['punchy kick', 'snare', 'rolling hi-hat', 'reese bass', 'breakbeat chop', 'synth blip', 'impact', 'vocal shout'] },
  { name: 'DISCO', bpm: 116, color: '#ffcd55', sounds: ['dance kick', 'hand clap', 'tambourine', 'funk bass', 'guitar chop', 'string stab', 'cowbell', 'vocal sparkle'] },
  { name: 'TECHNO', bpm: 130, color: '#63d9d0', sounds: ['hard kick', 'metallic hat', 'clap', 'rumble bass', 'acid squelch', 'synth pulse', 'noise sweep', 'robot voice'] }
];
const PHASE_DURATION_MS = { recording: 30 * 1000, composing: 2 * 60 * 1000 };
const id = (size = 18) => randomBytes(size).toString('base64url');
const shuffle = values => values.map(value => ({ value, sort: Math.random() })).sort((a, b) => a.sort - b.sort).map(item => item.value);
const safeName = value => String(value || '').trim().replace(/\s+/g, ' ').slice(0, 24);
const meFor = (room, token) => room?.players.find(player => player.token === token);
const audioUrl = (room, sampleId, token) => `/api/game?op=audio&code=${encodeURIComponent(room.code)}&sampleId=${encodeURIComponent(sampleId)}&token=${encodeURIComponent(token)}`;

class GameError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const requireRoom = room => { if (!room) throw new GameError(404, 'Room not found. Check the code.'); return room; };
const requirePlayer = (room, token) => { const player = meFor(room, token); if (!player) throw new GameError(403, 'Join a room first.'); return player; };

function finishComposing(room) {
  const submitted = room.players.filter(player => player.track);
  const makers = submitted.length ? submitted : room.players;
  if (!submitted.length) for (const player of makers) if (!player.track) player.track = { pattern: [] };
  room.order = shuffle(makers.map(player => ({ id: id(8), makerId: player.id })));
  room.phase = 'listening';
  room.listeningIndex = 0;
  room.phaseEndsAt = null;
}

export function advanceTimers(room, now = Date.now()) {
  if (!room.phaseEndsAt || now < room.phaseEndsAt) return false;
  if (room.phase === 'recording') {
    room.phase = 'composing';
    room.phaseEndsAt = now + PHASE_DURATION_MS.composing;
  } else if (room.phase === 'composing') {
    finishComposing(room);
  } else {
    room.phaseEndsAt = null;
  }
  return true;
}

export function revealState(room, now = Date.now()) {
  if (!room.reveal) return null;
  const countdownMs = 4000, playMs = 12000, slotMs = countdownMs + playMs;
  const elapsed = Math.max(0, now - room.reveal.startedAt);
  const total = room.reveal.ranked.length;
  const finished = elapsed >= total * slotMs;
  const index = finished ? total - 1 : Math.floor(elapsed / slotMs);
  const visible = finished || elapsed % slotMs >= countdownMs;
  const ranked = visible ? room.reveal.ranked[index] : null;
  return {
    index, total, visible, finished,
    endsAt: finished ? null : room.reveal.startedAt + index * slotMs + (visible ? slotMs : countdownMs),
    rank: ranked?.rank ?? null, maker: ranked?.name ?? null, trackId: ranked?.id ?? null, votes: ranked?.votes ?? null
  };
}

function view(room, me) {
  const kit = room.players.flatMap(player => player.assigned.filter(sound => player.recordings[sound]).map(sound => ({
    id: player.sampleIds[sound], sound, url: audioUrl(room, player.sampleIds[sound], me.token)
  })));
  const tracks = room.order.map((entry, index) => ({
    number: index + 1, id: entry.id,
    pattern: room.players.find(player => player.id === entry.makerId)?.track?.pattern || [],
    own: entry.makerId === me.id
  }));
  return {
    code: room.code, phase: room.phase, round: room.round, version: room.version,
    endsAt: room.phaseEndsAt || null,
    genre: room.genre && { name: room.genre.name, bpm: room.genre.bpm, color: room.genre.color },
    hostId: room.hostId,
    me: {
      id: me.id, name: me.name, host: me.id === room.hostId, assigned: me.assigned,
      recorded: me.assigned.filter(sound => me.recordings[sound]),
      ownClips: Object.fromEntries(me.assigned.filter(sound => me.recordings[sound]).map(sound => [sound, audioUrl(room, me.sampleIds[sound], me.token)])),
      submitted: !!me.track, voted: me.vote !== null, heard: me.heard
    },
    players: room.players.map(player => ({ id: player.id, name: player.name, recorded: player.assigned.filter(sound => player.recordings[sound]).length, assigned: player.assigned.length, submitted: !!player.track, voted: player.vote !== null })),
    kit: ['composing', 'listening', 'voting', 'reveal'].includes(room.phase) ? kit : [],
    tracks: ['listening', 'voting', 'reveal'].includes(room.phase) ? tracks : [],
    listeningIndex: room.listeningIndex,
    listeningHeard: room.phase === 'listening' ? room.players.filter(player => player.heard.includes(room.listeningIndex)).length : 0,
    reveal: room.phase === 'reveal' ? revealState(room) : null
  };
}

function beginRound(room) {
  room.round++;
  room.genre = genres[randomInt(genres.length)];
  room.phase = 'recording'; room.order = []; room.listeningIndex = 0; room.reveal = null;
  room.phaseEndsAt = Date.now() + PHASE_DURATION_MS.recording;
  for (const player of room.players) {
    player.assigned = shuffle(room.genre.sounds).slice(0, 2);
    player.sampleIds = Object.fromEntries(player.assigned.map(sound => [sound, id(8)]));
    player.recordings = {}; player.track = null; player.vote = null; player.heard = [];
  }
}

function validPattern(pattern, kitSize) {
  return Array.isArray(pattern) && pattern.length === kitSize && pattern.every(row => Array.isArray(row) && row.length === 16 && row.every(value => value === 0 || value === 1));
}

function act(room, token, data) {
  const player = requirePlayer(room, token);
  switch (data.type) {
    case 'start':
      if (player.id !== room.hostId || !['lobby', 'reveal'].includes(room.phase) || (room.phase === 'reveal' && !revealState(room).finished)) throw new GameError(409, 'Only the host can start a round.');
      if (room.players.length < 3) throw new GameError(409, 'At least 3 players are needed.');
      beginRound(room); break;
    case 'compose':
      if (player.id !== room.hostId || room.phase !== 'recording') throw new GameError(409, 'Only the host can move to the studio.');
      if (room.players.some(member => member.assigned.some(sound => !member.recordings[sound]))) throw new GameError(409, 'Wait for every recording.');
      room.phase = 'composing';
      room.phaseEndsAt = Date.now() + PHASE_DURATION_MS.composing;
      break;
    case 'submit': {
      if (room.phase !== 'composing') throw new GameError(409, 'The studio is closed.');
      const kitSize = room.players.reduce((total, member) => total + member.assigned.filter(sound => member.recordings[sound]).length, 0);
      if (!validPattern(data.pattern, kitSize)) throw new GameError(409, 'Invalid 16-step track.');
      if (!data.pattern.some(row => row.some(Boolean))) throw new GameError(409, 'Add at least one beat to your track.');
      player.track = { pattern: data.pattern };
      if (room.players.every(member => member.track)) { room.order = shuffle(room.players.map(member => ({ id: id(8), makerId: member.id }))); room.phase = 'listening'; room.listeningIndex = 0; room.phaseEndsAt = null; }
      break;
    }
    case 'heard':
      if (room.phase !== 'listening' || data.index !== room.listeningIndex) throw new GameError(409, 'This listening slot has ended.');
      if (!player.heard.includes(data.index)) player.heard.push(data.index);
      if (room.players.every(member => member.heard.includes(room.listeningIndex))) {
        if (room.listeningIndex < room.order.length - 1) room.listeningIndex++;
        else { room.phase = 'voting'; room.phaseEndsAt = null; }
      }
      break;
    case 'vote': {
      if (room.phase !== 'voting') throw new GameError(409, 'Voting is closed.');
      if (player.vote !== null) throw new GameError(409, 'You already voted.');
      const chosen = room.order.find(entry => entry.id === data.trackId);
      if (!chosen || chosen.makerId === player.id) throw new GameError(409, 'Choose another player’s track.');
      player.vote = chosen.makerId;
      if (room.players.every(member => member.vote !== null)) {
        const sorted = room.players
          .filter(member => room.order.some(entry => entry.makerId === member.id))
          .map(member => ({ id: room.order.find(entry => entry.makerId === member.id).id, name: member.name, votes: room.players.filter(voter => voter.vote === member.id).length, tie: Math.random() }))
          .sort((a, b) => b.votes - a.votes || a.tie - b.tie).slice(0, 3).reverse();
        room.phase = 'reveal';
        room.reveal = { ranked: sorted.map((entry, index) => ({ ...entry, rank: sorted.length - index })), startedAt: Date.now() };
        room.phaseEndsAt = null;
      }
      break;
    }
    default: throw new GameError(400, 'Unknown action.');
  }
}

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readBody(req) {
  if (req.body !== undefined) {
    const raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString() : JSON.stringify(req.body);
    if (Buffer.byteLength(raw) > 4_000_000) throw new GameError(413, 'Request is too large.');
    try { return JSON.parse(raw); }
    catch { throw new GameError(400, 'Invalid request.'); }
  }
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 4_000_000) throw new GameError(413, 'Request is too large.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw new GameError(400, 'Invalid request.'); }
}

function validateWav(bytes) {
  return bytes.length >= 44 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE' && bytes.readUInt16LE(22) === 1 && bytes.readUInt16LE(34) === 16;
}

export async function handleGame(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const op = url.searchParams.get('op');
  try {
    const { rooms, audio } = await getServices();
    if (req.method === 'POST' && op === 'create') {
      const data = await readBody(req), name = safeName(data.name);
      if (!name) throw new GameError(400, 'Enter your name.');
      for (let attempt = 0; attempt < 12; attempt++) {
        const code = randomBytes(3).toString('hex').toUpperCase();
        const host = { id: id(8), token: id(), name, assigned: [], sampleIds: {}, recordings: {}, track: null, vote: null, heard: [] };
        const room = { code, players: [host], hostId: host.id, phase: 'lobby', round: 0, genre: null, order: [], listeningIndex: 0, reveal: null, phaseEndsAt: null, version: 0, updatedAt: Date.now() };
        if (await rooms.create(code, room)) return send(res, 201, { code, token: host.token, state: view(room, host) });
      }
      throw new GameError(503, 'Could not create a room. Try again.');
    }
    if (req.method === 'POST' && op === 'join') {
      const data = await readBody(req), code = String(data.code || '').toUpperCase().trim(), name = safeName(data.name);
      if (!name) throw new GameError(400, 'Enter your name.');
      let joined;
      const room = await rooms.update(code, draft => {
        if (draft.phase !== 'lobby') throw new GameError(409, 'This round has already started.');
        if (draft.players.length >= 8) throw new GameError(409, 'This room is full.');
        if (draft.players.some(member => member.name.toLowerCase() === name.toLowerCase())) throw new GameError(409, 'That name is already taken.');
        joined = { id: id(8), token: id(), name, assigned: [], sampleIds: {}, recordings: {}, track: null, vote: null, heard: [] };
        draft.players.push(joined);
      });
      requireRoom(room);
      return send(res, 201, { code, token: joined.token, state: view(room, joined) });
    }
    if (req.method === 'GET' && op === 'state') {
      let room = requireRoom(await rooms.get(url.searchParams.get('code')));
      if (room.phaseEndsAt && Date.now() >= room.phaseEndsAt) {
        room = requireRoom(await rooms.update(url.searchParams.get('code'), draft => { advanceTimers(draft); })) || room;
      }
      const player = requirePlayer(room, url.searchParams.get('token'));
      return send(res, 200, view(room, player));
    }
    if (req.method === 'POST' && op === 'action') {
      const data = await readBody(req);
      const room = await rooms.update(data.code, draft => { advanceTimers(draft); act(draft, data.token, data); });
      requireRoom(room);
      return send(res, 200, view(room, requirePlayer(room, data.token)));
    }
    if (req.method === 'POST' && op === 'record') {
      const data = await readBody(req);
      let before = requireRoom(await rooms.get(data.code));
      if (before.phaseEndsAt && Date.now() >= before.phaseEndsAt) {
        before = requireRoom(await rooms.update(data.code, draft => { advanceTimers(draft); })) || before;
      }
      const player = requirePlayer(before, data.token);
      if (before.phase !== 'recording' || !player.assigned.includes(data.sound)) throw new GameError(409, 'That sound is not assigned to you.');
      if (data.mime !== 'audio/wav' || typeof data.audio !== 'string' || data.audio.length > 3_500_000) throw new GameError(400, 'Invalid recording.');
      const bytes = Buffer.from(data.audio, 'base64');
      if (!validateWav(bytes) || bytes.length > 2_600_000) throw new GameError(400, 'Invalid WAV recording.');
      const sampleId = player.sampleIds[data.sound];
      const pathname = await audio.put(before.code, sampleId, bytes, 'audio/wav');
      let replaced;
      const room = await rooms.update(before.code, draft => {
        advanceTimers(draft);
        const current = requirePlayer(draft, data.token);
        if (draft.phase !== 'recording' || current.sampleIds[data.sound] !== sampleId) throw new GameError(409, 'Recording phase has ended.');
        replaced = current.recordings[data.sound]?.pathname;
        current.recordings[data.sound] = { pathname, mime: 'audio/wav' };
      });
      if (!room) throw new GameError(404, 'Room not found.');
      if (replaced) audio.delete(replaced).catch(() => {});
      return send(res, 200, view(room, requirePlayer(room, data.token)));
    }
    if (req.method === 'GET' && op === 'audio') {
      const room = requireRoom(await rooms.get(url.searchParams.get('code')));
      const player = requirePlayer(room, url.searchParams.get('token'));
      const sampleId = url.searchParams.get('sampleId');
      const owner = room.players.find(member => Object.values(member.sampleIds).includes(sampleId));
      const sound = owner && Object.keys(owner.sampleIds).find(key => owner.sampleIds[key] === sampleId);
      if (!owner || !sound) throw new GameError(404, 'Recording not found.');
      if (room.phase === 'recording' && owner.id !== player.id) throw new GameError(403, 'Audio unavailable.');
      if (!['recording', 'composing', 'listening', 'voting', 'reveal'].includes(room.phase)) throw new GameError(403, 'Audio unavailable.');
      const recording = owner.recordings[sound];
      if (!recording) throw new GameError(404, 'Recording not found.');
      const clip = await audio.get(recording.pathname);
      if (!clip) throw new GameError(404, 'Recording not found.');
      res.writeHead(200, { 'content-type': clip.mime, 'content-length': clip.bytes.length, 'cache-control': 'private, max-age=300' });
      return res.end(clip.bytes);
    }
    throw new GameError(404, 'Not found.');
  } catch (error) {
    if (!(error instanceof GameError)) console.error(error);
    send(res, error.status || 500, { error: error.status ? error.message : 'Server error. Try again.' });
  }
}
