# Garbage Band

A browser party game for 3–8 players. The host creates a room, guests join with a six-character code, and each round moves through recording, beat making, anonymous listening, voting, and a countdown reveal.

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

Open `http://localhost:3000`. Set `PORT` to change the port. With no cloud credentials, the local server keeps rooms and recordings in memory, so a restart clears them. Run `npm test` for the automated checks. Other devices need an HTTPS URL for microphone access; `localhost` works on the same device.

## Deploy to Vercel

The Vercel version uses Upstash Redis for room state and private Vercel Blob storage for recordings. Functions poll room state every two seconds. Reveal stages use a stored start time, so they continue across function restarts. Both storage integrations must be connected before a deployed room can be created.

1. Import this Git repository into a new Vercel project. Use the **Other** framework preset, leave the root directory at the repository root, and use the default install command. `vercel.json` serves `public/` and deploys `api/` as functions.
2. In the Vercel project, open **Storage → Create Database → Upstash Redis**. Connect the database to the project for **Production** and **Preview**. It must provide `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.
3. Create a **Vercel Blob** store and connect it to the same project for **Production** and **Preview**. It must provide `BLOB_READ_WRITE_TOKEN` (or the Blob OIDC variables).
4. Add a long random `CRON_SECRET` environment variable for Production. Vercel sends it to the daily `/api/cleanup` cron endpoint, which removes recordings from expired rooms. Redeploy after changing integrations or environment variables.
5. Deploy the main branch. Share the production HTTPS URL with your friends. Test one room with three separate browser sessions: each records two sounds, submits a track, listens, votes, and sees third, second, then first place.

The site returns a server error for room creation if either storage integration is missing; check the function logs and environment variables. If you run the app locally with cloud variables, it uses the cloud stores. Do not commit secrets to Git.

Vercel Functions limit request bodies to 4.5 MB. The browser optimizes each recording and sends a short WAV; the API rejects recordings over 2.6 MB. Rooms expire 24 hours after their last update. A room tab can restore its session after a reload in the same tab.

## How a round works

1. The host creates a room and shares its code or invite link. At least three players must join.
2. A random genre assigns two surprise sounds to each player. Each prompt has a synthesized example and a mouth cue. After a short countdown, each player records a 2.5-second vocal take and can preview or replace it. The browser isolates the strongest single sound, cuts breath before it and a second attempt after it, removes low microphone rumble, balances volume, and adds short edge fades before uploading the sample.
3. Once every sample is in, the host opens the shared kit. Each player makes one 16-step pattern and submits it.
4. Tracks play in a random anonymous order. Each player listens to four loops of each track; the room advances after everyone has listened.
5. Everyone votes once for another player's track. The server rejects self-votes.
6. The top three appear in order: third, second, first. Each reveal shows the maker and plays their track. The host can start another round.

Sequencer playback uses Web Audio scheduling, so each sample starts on its assigned step. Samples are prefetched when the shared kit opens to reduce the wait before first playback.
