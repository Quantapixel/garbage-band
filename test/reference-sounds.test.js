import test from 'node:test';
import assert from 'node:assert/strict';
import { createReferencePcm, referenceKind } from '../public/reference-sounds.js';

test('assigned sounds have short, playable example audio', () => {
  for (const [sound, expected] of [['cowbell', 'cowbell'], ['808 kick', 'kick'], ['closed hi-hat', 'hat'], ['sub bass', 'bass'], ['vocal hook', 'vocal'], ['synth stab', 'synth']]) {
    assert.equal(referenceKind(sound), expected);
    const pcm = createReferencePcm(sound, 22050);
    assert.ok(pcm.length > 2000 && pcm.length < 22050, sound);
    const peak = Math.max(...pcm.map(Math.abs));
    assert.ok(peak > .1 && peak <= .56, sound);
  }
});
