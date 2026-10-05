const app = document.querySelector('#app');
const toastEl = document.querySelector('#toast');
const audioProcessor = import('/audio-process.js');
const referenceAudio = import('/reference-sounds.js');
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const qs = new URLSearchParams(location.search);
let credentials = JSON.parse(sessionStorage.getItem('gb-session') || 'null');
let state = null, events = null, mode = 'home', busy = false, recording = false, referenceStop = null, audioContext = null, audioCache = new Map(), rawAudioCache = new Map(), playback = null, pattern = null, countdownTimer = null, toastTimer = null;
const phases = ['lobby', 'recording', 'composing', 'listening', 'voting', 'reveal'];
const phaseNames = ['01 / ROOM', '02 / RECORD', '03 / MAKE', '04 / LISTEN', '05 / VOTE', '06 / REVEAL'];

function toast(message) { toastEl.textContent = message; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('show'), 4200); }
async function request(url, data) {
  const res = await fetch(url, data ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) } : {});
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'Something went wrong.');
  return json;
}
function saveCredentials(result) {
  credentials = { code: result.code, token: result.token };
  sessionStorage.setItem('gb-session', JSON.stringify(credentials));
  history.replaceState({}, '', `/?room=${encodeURIComponent(result.code)}`);
  connect(); applyState(result.state);
}
function connect() {
  events?.close();
  if (!credentials) return;
  events = new EventSource(`/api/events?code=${encodeURIComponent(credentials.code)}&token=${encodeURIComponent(credentials.token)}`);
  events.addEventListener('state', e => { try { applyState(JSON.parse(e.data)); } catch (err) { console.error(err); } });
}
function applyState(next) {
  const previous = state;
  state = next;
  if (previous?.round !== next.round || previous?.kit.length !== next.kit.length) { pattern = null; audioCache.clear(); rawAudioCache.clear(); }
  if (playback && (previous?.phase !== next.phase || (next.phase === 'listening' && previous?.listeningIndex !== next.listeningIndex) || (next.phase === 'reveal' && (previous?.reveal?.index !== next.reveal?.index || previous?.reveal?.visible !== next.reveal?.visible)))) stopPlayback();
  render();
  if (next.kit.length) next.kit.forEach(prefetchSample);
  if (next.phase === 'reveal' && next.reveal?.visible && (!previous || previous.phase !== 'reveal' || previous.reveal?.index !== next.reveal.index || !previous.reveal?.visible)) {
    playTrack(next.tracks.find(t => t.id === next.reveal.trackId), 4, false).catch(() => {});
  }
}
async function action(type, extra = {}) {
  if (busy) return;
  busy = true;
  try { const next = await request('/api/action', { ...credentials, type, ...extra }); applyState(next); }
  catch (err) { toast(err.message); }
  finally { busy = false; }
}
function home() {
  app.innerHTML = `<section class="hero"><div class="hero-copy"><div class="eyebrow">A PARTY GAME FOR YOUR MOUTH</div><h1>MAKE<br><span class="outline">NOISE.</span><span class="tilt">MAKE</span><br>MUSIC.</h1><p>Record the weird sounds you're given. Build a beat from <strong>everyone's voices.</strong> Then listen, vote, and find out whose garbage is gold.</p><div class="entry-actions"><button class="button primary" data-nav="create">CREATE A ROOM <span>↗</span></button><button class="button ghost" data-nav="join">JOIN WITH CODE <span>→</span></button></div></div><div class="hero-art" aria-hidden="true"><div class="art-ring"></div><div class="art-star">✳</div><div class="record"></div><div class="art-sticker">100% HUMAN SOUNDS<br>0% TALENT REQUIRED</div><div class="art-sticker bottom">YOUR MIC IS THE BAND</div><div class="art-wire"></div></div></section>`;
}
function entry() {
  const join = mode === 'join';
  app.innerHTML = `<section class="form-panel"><div class="eyebrow">${join ? 'GET IN THE BAND' : 'START SOMETHING LOUD'}</div><h2>${join ? 'JOIN A ROOM.' : 'CREATE A ROOM.'}</h2><p>${join ? 'Ask your host for the six-character room code.' : 'Grab at least two friends. Everyone needs a microphone and their own browser.'}</p><form id="entry-form"><div class="field"><label for="name">YOUR STAGE NAME</label><input id="name" name="name" autocomplete="nickname" maxlength="24" placeholder="e.g. DJ Trash Panda" required autofocus></div>${join ? '<div class="field"><label for="code">ROOM CODE</label><input id="code" class="code" name="code" maxlength="6" autocapitalize="characters" autocomplete="off" placeholder="ABC123" required value="' + escapeHtml(qs.get('room') || '') + '"></div>' : ''}<button class="button primary wide" type="submit">${join ? 'JOIN THE BAND' : 'CREATE ROOM'} <span>↗</span></button></form><button class="backlink" data-nav="home">← BACK TO THE START</button></section>`;
}
function shell(title, subtitle) {
  const phase = phases.indexOf(state.phase);
  return `<div class="room"><div class="room-head"><div><div class="eyebrow">ROUND ${String(state.round || 1).padStart(2, '0')} / ${escapeHtml(state.genre?.name || 'GET READY')}</div><h1>${title}</h1>${subtitle ? `<p class="subtext">${subtitle}</p>` : ''}</div><button class="room-code" data-copy title="Copy invite link"><span><small>ROOM CODE</small>${escapeHtml(state.code)}</span><span>↗</span></button></div><div class="phase-steps">${phaseNames.map((s, i) => `<span class="${i === phase ? 'active' : ''}">${s}</span>`).join('')}</div>`;
}
function roster(detail) {
  return `<div class="roster">${state.players.map(p => `<div class="person"><span class="person-name">${escapeHtml(p.name)}${p.id === state.hostId ? '<i>HOST</i>' : ''}${p.id === state.me.id ? '<i>YOU</i>' : ''}</span><span class="status ${detail === 'recorded' ? p.recorded === p.assigned && p.assigned ? 'done' : '' : detail === 'submitted' ? p.submitted ? 'done' : '' : detail === 'voted' ? p.voted ? 'done' : '' : 'done'}">${detail === 'recorded' ? `${p.recorded}/${p.assigned} RECORDED` : detail === 'submitted' ? p.submitted ? 'TRACK READY' : 'MIXING' : detail === 'voted' ? p.voted ? 'VOTED' : 'LISTENING' : 'IN THE ROOM'}</span></div>`).join('')}</div>`;
}
function lobby() {
  app.innerHTML = shell('THE <span>GREEN ROOM.</span>', 'Get the band together. The chaos starts with three players.') + `<div class="two-col"><section class="card"><div class="label">YOUR BAND / ${state.players.length} OF 8</div>${roster()}<div class="room-action">${state.me.host ? `<button class="button primary" data-action="start" ${state.players.length < 3 ? 'disabled' : ''}>DRAW A GENRE →</button>` : '<div class="instruction">Waiting for the host to draw a genre. Invite more friends with the room code.</div>'}</div></section><aside class="card"><div class="label">HOW IT GOES</div><h2>SIX STEPS.<br>ONE HIT.</h2><p>Get a surprise genre and two sounds to make with your voice. Your recordings become a shared kit. Everyone creates a 16-step track, hears each mix anonymously, and votes.</p><div class="instruction"><b>HEADS UP:</b> Wear headphones for recording and playback. Your microphone works on localhost or a secure HTTPS site.</div><button class="button ghost room-action" data-copy>↗ COPY INVITE LINK</button></aside></div></div>`;
}
function recordingView() {
  const ready = state.players.every(p => p.recorded === p.assigned && p.assigned);
  app.innerHTML = shell('YOUR <span>ASSIGNMENT.</span>', 'Nobody knew their sounds until now. Make them with your own voice.') + `<div class="genre-banner"><div><span>THE GENRE IS</span><br><strong>${escapeHtml(state.genre.name)}</strong></div><span>${state.genre.bpm} BPM / ${state.me.assigned.length} SOUNDS EACH</span></div><div class="two-col"><section><div class="prompt-grid">${state.me.assigned.map((sound, i) => `<article class="prompt"><div class="number">SOUND 0${i + 1} / ${state.me.recorded.includes(sound) ? 'RECORDED ✓' : 'NEEDS YOUR VOICE'}</div><h3>${escapeHtml(sound)}</h3><p>${hint(sound)}</p><button class="button ${state.me.recorded.includes(sound) ? 'ghost' : 'orange'}" data-record="${escapeHtml(sound)}">${state.me.recorded.includes(sound) ? '↻ RE-RECORD' : '● RECORD 2.5 SEC'}</button></article>`).join('')}</div><p class="subtext">Tip: get close to your mic, make one clear hit or short sound, and leave a little silence at the end.</p></section><aside class="card"><div class="label">RECORDING PROGRESS</div>${roster('recorded')}<div class="progressline"><span style="width:${Math.round(state.players.reduce((n,p)=>n+p.recorded,0)/Math.max(1,state.players.length*2)*100)}%"></span></div>${state.me.host ? `<button class="button primary wide" data-action="compose" ${ready ? '' : 'disabled'}>OPEN THE STUDIO →</button>` : `<div class="instruction">${ready ? 'All recordings are in. Waiting for the host to open the studio.' : 'Record both sounds, then wait for the rest of the band.'}</div>`}</aside></div></div>`;
  app.querySelector('.prompt-grid + .subtext').textContent = 'Hear the synthesized example, then make one clear sound after the countdown. We keep one hit and remove the lead-in air.';
  state.me.assigned.forEach(sound => {
    const button = [...app.querySelectorAll('[data-record]')].find(el => el.dataset.record === sound);
    button?.insertAdjacentHTML('beforebegin', `<button class="button small ghost" data-reference="${escapeHtml(sound)}">♫ HEAR EXAMPLE</button>`);
  });
  state.me.recorded.forEach(sound => {
    const button = [...app.querySelectorAll('[data-record]')].find(el => el.dataset.record === sound);
    button?.insertAdjacentHTML('afterend', `<button class="button small ghost" data-preview-own="${escapeHtml(sound)}">▶ PREVIEW</button>`);
  });
}
function hint(sound) {
  if (/cowbell/i.test(sound)) return 'MOUTH CUE: one bright “ka-ding!” or metallic clink. Make it once.';
  if (/kick|808/i.test(sound)) return 'MOUTH CUE: one deep, punchy “boom!”';
  if (/bass|rumble/i.test(sound)) return 'MOUTH CUE: one low “bwum” or humming pulse.';
  if (/snare|breakbeat/i.test(sound)) return 'MOUTH CUE: one sharp “psh!” or “ka!”';
  if (/clap/i.test(sound)) return 'MOUTH CUE: one crisp “pa!”';
  if (/hat/i.test(sound)) return 'MOUTH CUE: one tiny “ts!” or “ch!”';
  if (/shaker|tambourine/i.test(sound)) return 'MOUTH CUE: one quick “shik!”';
  if (/vocal|hook|shout|voice/i.test(sound)) return 'MOUTH CUE: one short syllable like “hey!”';
  if (/scratch/i.test(sound)) return 'MOUTH CUE: one quick “wika!”';
  if (/riser|sweep/i.test(sound)) return 'MOUTH CUE: one rising “shoo!”';
  if (/guitar|string/i.test(sound)) return 'MOUTH CUE: one plucked “dwang!”';
  if (/impact/i.test(sound)) return 'MOUTH CUE: one dramatic “bwong!”';
  return 'MOUTH CUE: one short, pitched “bip!”';
}
function getPattern() {
  if (!pattern || pattern.length !== state.kit.length) {
    const saved = sessionStorage.getItem(`gb-pattern-${state.code}-${state.round}-${state.me.id}`);
    try { pattern = JSON.parse(saved); } catch { pattern = null; }
    if (!Array.isArray(pattern) || pattern.length !== state.kit.length) pattern = state.kit.map(() => Array(16).fill(0));
  }
  return pattern;
}
function sequencer() {
  const p = getPattern();
  return `<div class="sequencer-wrap"><div class="sequencer"><div class="seq-header"><span></span>${Array.from({length:16},(_,i)=>`<span class="${i%4===0?'bar':''}">${String(i+1).padStart(2,'0')}</span>`).join('')}</div>${state.kit.map((sample, row) => `<div class="seq-row"><div class="seq-label"><button data-sample="${row}" aria-label="Preview ${escapeHtml(sample.sound)}">▶</button><span class="sample-name" title="${escapeHtml(sample.sound)}">${escapeHtml(sample.sound)}</span></div>${p[row].map((on,col)=>`<button class="step ${on?'on':''}" data-step="${row}:${col}" aria-label="${escapeHtml(sample.sound)}, step ${col+1}" aria-pressed="${!!on}"></button>`).join('')}</div>`).join('')}</div></div>`;
}
function composing() {
  app.innerHTML = shell('THE <span>STUDIO.</span>', 'The whole band’s voices are your instrument. Make a 16-step loop.') + `<div class="studio-top"><div><div class="label">SHARED SAMPLE KIT / ${state.kit.length} SOUNDS</div><p>${state.genre.bpm} BPM · Click a square to add a sound. Every row is someone’s voice.</p></div><div class="studio-actions"><button class="button ghost" data-play-composition>▶ PLAY LOOP</button><button class="button ghost" data-clear>CLEAR</button><button class="button primary" data-submit ${state.me.submitted?'disabled':''}>${state.me.submitted?'TRACK SUBMITTED ✓':'SUBMIT TRACK →'}</button></div></div>${sequencer()}<div class="studio-foot"><span>01—04 / BEATS &nbsp;&nbsp; 05—08 / MORE BEATS &nbsp;&nbsp; 09—12 / KEEP GOING &nbsp;&nbsp; 13—16 / BRING IT HOME</span><span>${state.players.filter(p=>p.submitted).length}/${state.players.length} TRACKS SUBMITTED</span></div>${state.me.submitted ? `<div class="big-center"><div class="symbol">✳</div><h2>TRACK LOCKED IN.</h2><p>Waiting for the rest of the band to finish mixing.</p></div>` : ''}</div>`;
}
function listening() {
  const track = state.tracks[state.listeningIndex];
  const heard = state.me.heard.includes(state.listeningIndex);
  app.innerHTML = shell('BLIND <span>LISTENING.</span>', 'No names. Just tracks. Listen to each one before the vote.') + `<div class="listen-progress">${state.tracks.map((_,i)=>`<span class="${i<state.listeningIndex?'done':i===state.listeningIndex?'now':''}"></span>`).join('')}</div><div class="track-card"><div class="track-number">${String(track.number).padStart(2,'0')}</div><div><div class="label">NOW PLAYING / ${state.listeningIndex+1} OF ${state.tracks.length}</div><h2>UNKNOWN ARTIST</h2><p>${heard ? `You listened. Waiting for the band (${state.listeningHeard}/${state.players.length}).` : 'Press play to hear four loops. The next track starts when everyone finishes.'}</p></div><button class="button ${heard?'ghost':'primary'}" data-listen ${heard?'disabled':''}>${heard?'HEARD ✓':'▶ LISTEN NOW'}</button></div><div class="big-center"><div class="symbol">◉</div><p>Keep the artist a secret until the reveal. You’ll vote after every track has played.</p></div></div>`;
}
function voting() {
  app.innerHTML = shell('CAST YOUR <span>VOTE.</span>', 'Who made the best beat from the band’s questionable noises?') + `<div class="vote-grid">${state.tracks.map(t=>`<article class="vote-card ${t.own?'own':''}"><div class="label">ANONYMOUS MIX</div><div class="num">${String(t.number).padStart(2,'0')}</div><div class="controls"><button class="button small ghost" data-preview-track="${t.number-1}">▶ REPLAY</button><button class="button small primary" data-vote="${escapeHtml(t.id)}" ${t.own||state.me.voted?'disabled':''}>${t.own?'YOUR TRACK':state.me.voted?'VOTED ✓':'VOTE ↑'}</button></div></article>`).join('')}</div><div class="studio-foot"><span>YOU CAN’T VOTE FOR YOUR OWN TRACK.</span><span>${state.players.filter(p=>p.voted).length}/${state.players.length} VOTES IN</span></div></div>`;
}
function revealView() {
  const r = state.reveal;
  app.innerHTML = shell('THE <span>REVEAL.</span>', 'The votes are in. Time to meet the makers.') + `<div class="reveal"><div><div class="place">${r.finished ? 'THAT’S A WRAP' : `${r.rank || 3-r.index}${r.index===0?'RD':r.index===1?'ND':'ST'} PLACE / REVEAL ${r.index+1} OF ${r.total}`}</div>${r.visible ? `<h2>${escapeHtml(r.maker)}</h2><div class="vote-total">${r.votes} ${r.votes===1?'VOTE':'VOTES'} · TRACK ${String(state.tracks.find(t=>t.id===r.trackId)?.number||1).padStart(2,'0')}</div><div class="actions"><button class="button ghost" data-replay-reveal>▶ PLAY AGAIN</button></div>` : `<div class="count" id="countdown">${Math.max(1,Math.ceil((r.endsAt-Date.now())/1000))}</div><div class="vote-total">NEXT UP: ${r.index===0?'THIRD':r.index===1?'SECOND':'FIRST'} PLACE</div>`}${r.finished && state.me.host ? `<div class="actions"><button class="button primary" data-action="start">NEW ROUND ↗</button></div>` : ''}</div></div></div>`;
  clearInterval(countdownTimer);
  if (!r.visible && r.endsAt) countdownTimer = setInterval(() => { const el = document.querySelector('#countdown'); if (el) el.textContent = Math.max(1, Math.ceil((r.endsAt-Date.now())/1000)); }, 200);
}
function render() {
  if (!state) { mode === 'home' ? home() : entry(); return; }
  clearInterval(countdownTimer);
  ({ lobby, recording: recordingView, composing, listening, voting, reveal: revealView })[state.phase]();
}
function stopPlayback() {
  if (!playback) return;
  playback.cancelled = true;
  playback.sources.forEach(s => { try { s.stop(); } catch {} });
  clearTimeout(playback.timer);
  playback = null;
  document.querySelectorAll('.step.playhead').forEach(el => el.classList.remove('playhead'));
}
async function context() {
  audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state === 'suspended') await audioContext.resume();
  return audioContext;
}
function prefetchSample(sample) {
  if (!rawAudioCache.has(sample.id)) {
    const pending = fetch(sample.url).then(response => {
      if (!response.ok) throw new Error('Could not load a recording.');
      return response.arrayBuffer();
    });
    rawAudioCache.set(sample.id, pending);
    pending.catch(() => rawAudioCache.delete(sample.id));
  }
  return rawAudioCache.get(sample.id);
}
async function sampleBuffer(sample) {
  if (!audioCache.has(sample.id)) {
    const pending = (async () => {
      const ctx = await context();
      const data = await prefetchSample(sample);
      return ctx.decodeAudioData(data.slice(0));
    })();
    audioCache.set(sample.id, pending);
    pending.catch(() => audioCache.delete(sample.id));
  }
  return audioCache.get(sample.id);
}
async function playTrack(track, loops = 4, markHeard = false) {
  if (!track) return;
  stopPlayback();
  const ctx = await context();
  const buffers = await Promise.all(state.kit.map(sampleBuffer));
  const player = { cancelled: false, sources: [], timer: null };
  playback = player;
  const stepTime = 60 / state.genre.bpm / 4;
  const start = ctx.currentTime + .08;
  for (let bar = 0; bar < loops; bar++) for (let step = 0; step < 16; step++) {
    track.pattern.forEach((row, rowIndex) => {
      if (!row[step]) return;
      const source = ctx.createBufferSource(); source.buffer = buffers[rowIndex]; source.connect(ctx.destination); source.start(start + (bar*16+step)*stepTime); player.sources.push(source);
    });
  }
  const duration = loops*16*stepTime*1000 + 300;
  player.timer = setTimeout(() => {
    if (player.cancelled) return;
    playback = null;
    document.querySelectorAll('.step.playhead').forEach(el => el.classList.remove('playhead'));
    const playButton = document.querySelector('[data-play-composition]');
    if (playButton) playButton.textContent = '▶ PLAY LOOP';
    if (markHeard && state.phase === 'listening' && state.listeningIndex === track.number - 1) action('heard', { index: state.listeningIndex });
  }, duration);
  if (state.phase === 'composing') {
    for (let i=0;i<loops*16;i++) setTimeout(() => {
      if (player.cancelled) return;
      document.querySelectorAll('.step.playhead').forEach(el => el.classList.remove('playhead'));
      document.querySelectorAll(`.step[data-step$=":${i%16}"]`).forEach(el => el.classList.add('playhead'));
    }, i*stepTime*1000);
  }
}
async function recordSound(sound) {
  if (recording) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return toast('This browser cannot record audio. Try a current Chrome, Firefox, or Safari.');
  referenceStop?.(); referenceStop = null;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const mime = ['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg'].find(t => MediaRecorder.isTypeSupported(t));
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    const chunks = []; recording = true;
    const button = [...document.querySelectorAll('[data-record]')].find(b => b.dataset.record === sound);
    if (button) button.disabled = true;
    for (let count = 2; count > 0; count--) {
      if (button) button.textContent = `GET READY ${count}...`;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (state?.phase !== 'recording') throw new Error('Recording phase has ended.');
    if (button) button.innerHTML = '<span class="rec-indicator">RECORDING... </span>';
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onerror = () => toast('Recording failed. Try again.');
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      try {
        const blob = new Blob(chunks, { type: recorder.mimeType || mime || 'audio/webm' });
        const decoder = audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
        const decoded = await decoder.decodeAudioData(await blob.arrayBuffer());
        const { optimizePcm, encodeWav } = await audioProcessor;
        const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
        const optimized = optimizePcm(channels, decoded.sampleRate, { sound });
        const wav = new Blob([encodeWav(optimized.pcm, optimized.sampleRate)], { type: 'audio/wav' });
        const audio = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(wav); });
        const next = await request('/api/record', { ...credentials, sound, mime: 'audio/wav', audio });
        applyState(next); toast(`One ${sound} hit kept. Preview it or re-record.`);
      } catch (err) { toast(err.message); render(); }
      finally { recording = false; }
    };
    recorder.start(); setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 2500);
  } catch (err) { stream?.getTracks().forEach(t=>t.stop()); recording=false; toast(err.name === 'NotAllowedError' ? 'Allow microphone access to record your sounds.' : err.message); render(); }
}

document.addEventListener('click', async e => {
  const target = e.target.closest('button'); if (!target) return;
  if (target.dataset.nav) { mode = target.dataset.nav; render(); return; }
  if (target.hasAttribute('data-copy')) { try { await navigator.clipboard.writeText(`${location.origin}/?room=${state.code}`); toast('Invite link copied.'); } catch { toast(`Room code: ${state.code}`); } return; }
  if (target.dataset.action) return action(target.dataset.action);
  if (target.dataset.record) return recordSound(target.dataset.record);
  if (target.dataset.reference) { try { referenceStop?.(); const ctx = await context(); const { playReference } = await referenceAudio; referenceStop = playReference(ctx, target.dataset.reference); } catch(err) { toast(err.message); } return; }
  if (target.dataset.previewOwn) { try { const ctx = await context(); const response = await fetch(state.me.ownClips[target.dataset.previewOwn]); if (!response.ok) throw new Error('Preview unavailable.'); const buffer = await ctx.decodeAudioData(await response.arrayBuffer()); const source = ctx.createBufferSource(); source.buffer=buffer; source.connect(ctx.destination); source.start(); } catch(err) {toast(err.message);} return; }
  if (target.dataset.step) {
    if (state.me.submitted) return;
    const [row,col] = target.dataset.step.split(':').map(Number); const p = getPattern(); p[row][col] = p[row][col] ? 0 : 1;
    target.classList.toggle('on', !!p[row][col]); target.setAttribute('aria-pressed', !!p[row][col]);
    sessionStorage.setItem(`gb-pattern-${state.code}-${state.round}-${state.me.id}`, JSON.stringify(p)); return;
  }
  if (target.dataset.sample !== undefined) { try { const ctx = await context(); const buffer = await sampleBuffer(state.kit[Number(target.dataset.sample)]); const source = ctx.createBufferSource(); source.buffer=buffer; source.connect(ctx.destination); source.start(); } catch(err) {toast(err.message);} return; }
  if (target.hasAttribute('data-clear')) { pattern = state.kit.map(()=>Array(16).fill(0)); sessionStorage.setItem(`gb-pattern-${state.code}-${state.round}-${state.me.id}`,JSON.stringify(pattern)); render(); return; }
  if (target.hasAttribute('data-play-composition')) { try { if (playback) {stopPlayback(); target.textContent='▶ PLAY LOOP';} else {await playTrack({pattern:getPattern()},4); target.textContent='■ STOP';} } catch(err) {toast(err.message);} return; }
  if (target.hasAttribute('data-submit')) return action('submit', {pattern:getPattern()});
  if (target.hasAttribute('data-listen')) { try { await playTrack(state.tracks[state.listeningIndex],4,true); target.disabled=true; target.textContent='♫ PLAYING...'; } catch(err) {toast(err.message);} return; }
  if (target.dataset.previewTrack !== undefined) { try { await playTrack(state.tracks[Number(target.dataset.previewTrack)],4); toast('Playing track.'); } catch(err) {toast(err.message);} return; }
  if (target.dataset.vote) return action('vote',{trackId:target.dataset.vote});
  if (target.hasAttribute('data-replay-reveal')) { try { await playTrack(state.tracks.find(t=>t.id===state.reveal.trackId),4); } catch(err) {toast(err.message);} }
});
document.addEventListener('submit', async e => {
  if (e.target.id !== 'entry-form') return;
  e.preventDefault(); const form = new FormData(e.target); const button = e.target.querySelector('button[type=submit]'); button.disabled = true;
  try { saveCredentials(await request(mode === 'join' ? '/api/join' : '/api/rooms', { name: form.get('name'), ...(mode === 'join' ? { code: form.get('code') } : {}) })); }
  catch (err) { toast(err.message); button.disabled = false; }
});
window.addEventListener('beforeunload', () => { events?.close(); stopPlayback(); });
(async () => {
  if (credentials) {
    try { const next = await request(`/api/rooms/${encodeURIComponent(credentials.code)}?token=${encodeURIComponent(credentials.token)}`); connect(); applyState(next); return; }
    catch { sessionStorage.removeItem('gb-session'); credentials = null; }
  }
  if (qs.get('room')) mode = 'join';
  render();
})();
