# Garbage Band

A browser party game for 3–8 players. The host creates a room, guests join with a six-character code, and each round moves through recording, beat making, anonymous listening, voting, and a countdown reveal.

## Run it

Requires Node.js 20 or newer. There are no external server dependencies.

```bash
npm start
```

Open `http://localhost:3000` on the host computer. For other devices, run the server behind an HTTPS reverse proxy and share its URL. Browsers require HTTPS or localhost for microphone access. Set `PORT` to change the listening port.

```bash
npm test
```

## How a round works

1. The host creates a room and shares its code or invite link. At least three players must join.
2. A random genre assigns two surprise sounds to each player. Each prompt has a synthesized example and a mouth cue. After a short countdown, each player records a 2.5-second vocal take and can preview or replace it. The browser isolates the strongest single sound, cuts breath before it and a second attempt after it, removes low microphone rumble, balances volume, and adds short edge fades before uploading the sample.
3. Once every sample is in, the host opens the shared kit. Each player makes one 16-step pattern and submits it.
4. Tracks play in a random anonymous order. Each player listens to four loops of each track; the room advances after everyone has listened.
5. Everyone votes once for another player's track. The server rejects self-votes.
6. The top three appear in order: third, second, first. Each reveal shows the maker and plays their track. The host can start another round.

Rooms and recordings are held in server memory, so restarting the server clears them. A browser tab restores its room session after a reload in the same tab.

Sequencer playback uses Web Audio scheduling, so each sample starts on its assigned step. Samples are prefetched when the shared kit opens to reduce the wait before first playback.
