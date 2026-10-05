// Prepare a voice recording for use as a beat sample. The first audible hit
// starts near the beginning of the exported file, so sequencer steps stay tight.
export function optimizePcm(channels, sampleRate, { sound = '' } = {}) {
  if (!Array.isArray(channels) || !channels.length || !Number.isFinite(sampleRate) || sampleRate < 8000) throw new Error('Could not read this recording. Try again.');
  const length = Math.min(...channels.map(channel => channel.length));
  if (!length) throw new Error('Recording was empty. Try again.');
  const mono = new Float32Array(length);
  const count = channels.length;
  for (let i = 0; i < length; i++) {
    for (const channel of channels) mono[i] += channel[i] / count;
  }

  // Remove DC and very low microphone rumble without thinning bass notes.
  const rc = 1 / (2 * Math.PI * 28);
  const alpha = rc / (rc + 1 / sampleRate);
  let previousInput = 0, previousOutput = 0;
  for (let i = 0; i < length; i++) {
    const input = mono[i];
    const output = alpha * (previousOutput + input - previousInput);
    mono[i] = output;
    previousInput = input;
    previousOutput = output;
  }

  const frameSize = Math.max(32, Math.round(sampleRate * .005));
  const levels = [];
  for (let start = 0; start < length; start += frameSize) {
    let energy = 0;
    const end = Math.min(length, start + frameSize);
    for (let i = start; i < end; i++) energy += mono[i] * mono[i];
    levels.push(Math.sqrt(energy / (end - start)));
  }
  const maxLevel = Math.max(...levels);
  if (maxLevel < .003) throw new Error('No clear sound detected. Record a little louder and try again.');
  const quietLevels = [...levels].sort((a, b) => a - b);
  const noiseFloor = quietLevels[Math.floor(quietLevels.length * .2)] || 0;
  const frameSeconds = frameSize / sampleRate;
  const peakFrame = levels.indexOf(maxLevel);

  // Work backwards from the strongest sound. A quiet breath or an earlier
  // false start should not become the sample's attack.
  const lookback = Math.ceil(.22 / frameSeconds);
  const lower = Math.max(0, peakFrame - lookback);
  let attackFrame = lower, strongestRise = -Infinity;
  for (let i = lower; i <= peakFrame; i++) {
    const from = Math.max(lower, i - 8);
    let baseline = 0;
    for (let j = from; j < i; j++) baseline += levels[j];
    baseline /= Math.max(1, i - from);
    const rise = levels[i] - baseline;
    if (levels[i] >= maxLevel * .22 && rise > strongestRise) {
      strongestRise = rise;
      attackFrame = i;
    }
  }
  const start = Math.max(0, attackFrame * frameSize - Math.round(sampleRate * .006));

  // A sequencer step should trigger one event. End on the natural tail, at the
  // next obvious attack, or at a sound-specific length cap, whichever is first.
  const shortHit = /hat|shaker|tambourine|clap|snare|kick|808|cowbell|impact|blip/i.test(sound);
  const longPhrase = /vocal|hook|voice|shout|riser|sweep/i.test(sound);
  const maxSeconds = shortHit ? .55 : longPhrase ? 1.15 : .8;
  const hardEnd = Math.min(levels.length, Math.ceil((start + sampleRate * maxSeconds) / frameSize));
  const tailThreshold = Math.max(.004, noiseFloor * 2.5, maxLevel * .1);
  let endFrame = hardEnd, quietRun = 0, removedRepeat = false;
  for (let i = peakFrame + Math.ceil(.055 / frameSeconds); i < hardEnd; i++) {
    const from = Math.max(peakFrame, i - 8);
    let prior = 0;
    for (let j = from; j < i; j++) prior += levels[j];
    prior /= Math.max(1, i - from);
    if (i - attackFrame > Math.ceil(.09 / frameSeconds) && levels[i] > maxLevel * .3 && levels[i] > prior * 1.7 && levels[i] - prior > maxLevel * .16) {
      endFrame = i;
      removedRepeat = true;
      break;
    }
    quietRun = levels[i] < tailThreshold ? quietRun + 1 : 0;
    if (quietRun >= 5) {
      endFrame = Math.min(hardEnd, i + Math.ceil(.025 / frameSeconds));
      break;
    }
  }
  const end = Math.min(length, Math.max(start + Math.round(sampleRate * .04), endFrame * frameSize));
  const pcm = mono.slice(start, end);

  let peak = 0, energy = 0;
  for (const sample of pcm) { peak = Math.max(peak, Math.abs(sample)); energy += sample * sample; }
  const rms = Math.sqrt(energy / pcm.length);
  const gain = Math.min(.9 / peak, .18 / rms, 12);
  const fadeIn = Math.min(Math.round(sampleRate * .003), Math.floor(pcm.length / 2));
  const fadeOut = Math.min(Math.round(sampleRate * .018), Math.floor(pcm.length / 2));
  for (let i = 0; i < pcm.length; i++) {
    const envelope = Math.min(1, fadeIn ? i / fadeIn : 1, fadeOut ? (pcm.length - 1 - i) / fadeOut : 1);
    pcm[i] = Math.max(-1, Math.min(1, pcm[i] * gain * envelope));
  }
  return { pcm, sampleRate, trimmedMs: Math.round(start / sampleRate * 1000), gain, removedRepeat };
}

export function encodeWav(pcm, sampleRate) {
  const output = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(output);
  const label = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  label(0, 'RIFF'); view.setUint32(4, output.byteLength - 8, true);
  label(8, 'WAVE'); label(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  label(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const value = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(44 + i * 2, value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), true);
  }
  return output;
}
