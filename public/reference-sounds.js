// Short synthesized guides. They show the shape and pitch of a sound; players
// still make the actual sample with their own voice.
export function referenceKind(sound) {
  const name = sound.toLowerCase();
  if (/cowbell/.test(name)) return 'cowbell';
  if (/kick|808/.test(name)) return 'kick';
  if (/snare|breakbeat/.test(name)) return 'snare';
  if (/clap/.test(name)) return 'clap';
  if (/hat|shaker|tambourine/.test(name)) return 'hat';
  if (/bass|rumble/.test(name)) return 'bass';
  if (/scratch/.test(name)) return 'scratch';
  if (/riser|sweep/.test(name)) return 'riser';
  if (/guitar|string/.test(name)) return 'pluck';
  if (/impact/.test(name)) return 'impact';
  if (/robot/.test(name)) return 'robot';
  if (/vocal|hook|shout|voice/.test(name)) return 'vocal';
  return 'synth';
}

export function createReferencePcm(sound, sampleRate = 44100) {
  const kind = referenceKind(sound);
  const duration = { hat: .25, clap: .3, snare: .38, kick: .48, cowbell: .48, bass: .65, riser: .7, vocal: .62, robot: .58 }[kind] || .5;
  const pcm = new Float32Array(Math.round(sampleRate * duration));
  let seed = 987654321, previousNoise = 0, phase = 0;
  for (let i = 0; i < pcm.length; i++) {
    const t = i / sampleRate;
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = (seed / 2147483648 - 1);
    const brightNoise = noise - previousNoise * .7;
    previousNoise = noise;
    const attack = Math.min(1, t / .004);
    let value = 0;
    switch (kind) {
      case 'kick': {
        const frequency = 45 + 120 * Math.exp(-t * 17);
        phase += 2 * Math.PI * frequency / sampleRate;
        value = Math.sin(phase) * Math.exp(-t * 9);
        break;
      }
      case 'cowbell': value = (Math.sin(2 * Math.PI * 540 * t) + .68 * Math.sin(2 * Math.PI * 810 * t)) * Math.exp(-t * 8); break;
      case 'snare': value = (brightNoise * .8 + Math.sin(2 * Math.PI * 180 * t) * .3) * Math.exp(-t * 16); break;
      case 'clap': value = brightNoise * (1 + .7 * Math.sin(2 * Math.PI * 42 * t)) * Math.exp(-t * 20); break;
      case 'hat': value = brightNoise * Math.exp(-t * (/open/.test(sound) ? 11 : 28)); break;
      case 'bass': value = (Math.sin(2 * Math.PI * 82 * t) + .35 * Math.sin(2 * Math.PI * 164 * t)) * Math.exp(-t * 3); break;
      case 'scratch': value = brightNoise * Math.sin(2 * Math.PI * (70 * t + 140 * t * t)) * Math.exp(-t * 7); break;
      case 'riser': value = brightNoise * Math.min(1, t * 2.2) + .25 * Math.sin(2 * Math.PI * (180 * t + 420 * t * t)); break;
      case 'pluck': value = (Math.sin(2 * Math.PI * 220 * t) + .4 * Math.sin(2 * Math.PI * 440 * t)) * Math.exp(-t * 9); break;
      case 'impact': value = (Math.sin(2 * Math.PI * (110 * t - 40 * t * t)) + brightNoise * .4) * Math.exp(-t * 8); break;
      case 'robot': value = (Math.sin(2 * Math.PI * (150 * t + 60 * t * t)) + .4 * Math.sin(2 * Math.PI * 600 * t)) * Math.exp(-t * 3); break;
      case 'vocal': value = (Math.sin(2 * Math.PI * 180 * t) + .4 * Math.sin(2 * Math.PI * 540 * t) + .2 * Math.sin(2 * Math.PI * 900 * t)) * Math.exp(-t * 4); break;
      default: value = (Math.sin(2 * Math.PI * 440 * t) + .3 * Math.sin(2 * Math.PI * 880 * t)) * Math.exp(-t * 7);
    }
    const release = Math.min(1, (duration - t) / .015);
    pcm[i] = value * attack * Math.max(0, release);
  }
  let peak = 0;
  for (const sample of pcm) peak = Math.max(peak, Math.abs(sample));
  const gain = peak ? .55 / peak : 0;
  for (let i = 0; i < pcm.length; i++) pcm[i] *= gain;
  return pcm;
}

export function playReference(context, sound) {
  const pcm = createReferencePcm(sound, context.sampleRate);
  const buffer = context.createBuffer(1, pcm.length, context.sampleRate);
  buffer.copyToChannel(pcm, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  return () => { try { source.stop(); } catch {} };
}
