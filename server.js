import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { handleGame } from './lib/game.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const staticFiles = new Set(['index.html', 'app.js', 'audio-process.js', 'reference-sounds.js', 'style.css']);
const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8' };

export const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/api/game') return handleGame(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(404); res.end(); return; }
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!staticFiles.has(file)) { res.writeHead(404); res.end(); return; }
  try {
    const filePath = path.join(root, file);
    const [data, info] = await Promise.all([readFile(filePath), stat(filePath)]);
    res.writeHead(200, { 'content-type': mime[file.split('.').pop()], 'content-length': info.size });
    res.end(req.method === 'HEAD' ? undefined : data);
  } catch { res.writeHead(404); res.end(); }
});

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, '0.0.0.0', () => console.log(`Garbage Band listening on http://localhost:${port}`));
}
