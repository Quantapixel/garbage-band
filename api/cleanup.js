import { cleanupExpiredBlobs } from '../lib/storage.js';

export default async function cleanup(req, res) {
  if (req.method !== 'GET' || !process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    res.writeHead(401); res.end('Unauthorized'); return;
  }
  try {
    const removed = await cleanupExpiredBlobs();
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ removed });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Cleanup failed.' });
  }
}
