import test from 'node:test';
import assert from 'node:assert/strict';
import { optimizePcm, encodeWav } from '../public/audio-process.js';

test('recordings start on the audible hit and have a consistent, unclipped level', () => {
  const sampleRate = 48000;
  const source = new Float32Array(sampleRate);
  for (let i = 0; i < source.length; i++) {
    const time = i / sampleRate;
    source[i] = time >= .4 && time < .62 ? .08 * Math.sin(2 * Math.PI * 220 * time) : 0;
  }
  const result = optimizePcm([source], sampleRate);
  assert.ok(result.trimmedMs >= 380 && result.trimmedMs <= 400);
  assert.ok(result.pcm.length < sampleRate * .3);
  const firstAudible = result.pcm.findIndex(value => Math.abs(value) > .08);
  assert.ok(firstAudible >= 0 && firstAudible < sampleRate * .02);
  const peak = Math.max(...result.pcm.map(Math.abs));
  assert.ok(peak > .25 && peak <= .91);
  assert.ok(Math.abs(result.pcm[0]) < .001);
  assert.ok(Math.abs(result.pcm.at(-1)) < .001);
  const wav = new DataView(encodeWav(result.pcm, sampleRate));
  assert.equal(wav.getUint32(24, true), sampleRate);
  assert.equal(wav.getUint32(40, true), result.pcm.length * 2);
});

test('a silent recording asks for another take', () => {
  assert.throws(() => optimizePcm([new Float32Array(48000)], 48000), /No clear sound/);
});

test('a cowbell take keeps one hit and drops breath and a second attempt', () => {
  const sampleRate = 48000;
  const source = new Float32Array(Math.round(sampleRate * 2));
  for (let i = 0; i < source.length; i++) {
    const time = i / sampleRate;
    if (time >= .1 && time < .43) source[i] += .025 * Math.sin(2 * Math.PI * 3100 * time);
    for (const [at, loudness] of [[.55, .22], [.72, .19]]) {
      const elapsed = time - at;
      if (elapsed >= 0 && elapsed < .24) source[i] += loudness * Math.exp(-elapsed * 11) * Math.sin(2 * Math.PI * 720 * elapsed);
    }
  }
  const result = optimizePcm([source], sampleRate, { sound: 'cowbell' });
  assert.ok(result.trimmedMs >= 535 && result.trimmedMs <= 560, `trimmed at ${result.trimmedMs}ms`);
  assert.ok(result.pcm.length / sampleRate < .2, `sample lasts ${result.pcm.length / sampleRate}s`);
  assert.equal(result.removedRepeat, true);
  const first40ms = result.pcm.slice(0, Math.round(sampleRate * .04));
  const peak = Math.max(...first40ms.map(Math.abs));
  assert.ok(peak > .2, `first 40ms peak is ${peak}`);
});
