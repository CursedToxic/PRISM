#!/usr/bin/env node
'use strict';
/* ==================================================================
   PRISM :: leaderboard server

   Serves the app out of this folder and persists the operator ladder
   to leaderboard.json. No dependencies.

     node server.js                  -> http://127.0.0.1:7070
     node server.js --port 8080
     node server.js --host 0.0.0.0   -> share one board on the LAN

   API
     GET    /api/leaderboard              the whole board
     POST   /api/leaderboard              upsert one operator, returns the board
     DELETE /api/leaderboard?handle=NAME  drop one operator

   There is no authentication: anything that can reach the port can post
   any handle. Keep it on 127.0.0.1 unless you trust the network.
   ================================================================== */

const http = require('http');
const fs   = require('fs');
const fsp  = fs.promises;
const path = require('path');

const ROOT = __dirname;
const FILE = path.join(ROOT, 'leaderboard.json');
const TMP  = FILE + '.tmp';

const MAX_OPERATORS = 500;
const MAX_BODY      = 8 * 1024;
const HANDLE        = /^[A-Za-z0-9_-]{3,16}$/;

const argv = process.argv.slice(2);
function flag(name, fallback) {
  const i = argv.indexOf('--' + name);
  const v = i >= 0 ? argv[i + 1] : null;
  return (v && v[0] !== '-') ? v : fallback;
}
const PORT = Number(process.env.PORT || flag('port', 7070));
const HOST = process.env.HOST || flag('host', '127.0.0.1');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.woff2': 'font/woff2'
};

/* The board starts with the three simulated study-group operators so a solo
   run still has rivals. Delete them from leaderboard.json for a real class. */
const SEED = {
  version: 1,
  updated: null,
  operators: [
    { handle: '0xCAFE',       xp: 6940, mastery: 83, quests: 4, year: 12, sim: true },
    { handle: 'nullptr_nina', xp: 4180, mastery: 71, quests: 3, year: 12, sim: true },
    { handle: 'voidling',     xp: 1620, mastery: 48, quests: 1, year: 12, sim: true }
  ]
};

/* ---------------- board file ---------------- */
function clamp(v, lo, hi) {
  v = Math.round(Number(v));
  if (!isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}
function cleanEntry(e) {
  if (!e || !HANDLE.test(String(e.handle || ''))) return null;
  return {
    handle:  String(e.handle),
    xp:      clamp(e.xp, 0, 10000000),
    mastery: clamp(e.mastery, 0, 100),
    quests:  clamp(e.quests, 0, 99),
    year:    Number(e.year) === 11 ? 11 : 12,
    sim:     !!e.sim,
    updated: typeof e.updated === 'string' ? e.updated : new Date().toISOString()
  };
}
function normalise(board) {
  const list = (board && Array.isArray(board.operators)) ? board.operators : [];
  const seen = Object.create(null);
  const operators = [];
  for (const raw of list) {
    const e = cleanEntry(raw);
    if (!e) continue;
    const key = e.handle.toLowerCase();
    if (seen[key]) continue;
    seen[key] = true;
    operators.push(e);
  }
  operators.sort((a, b) => b.xp - a.xp || a.handle.localeCompare(b.handle));
  return {
    version: 1,
    updated: (board && typeof board.updated === 'string') ? board.updated : null,
    operators: operators.slice(0, MAX_OPERATORS)
  };
}

/* Every read-modify-write runs through one chain, so two operators publishing
   at the same moment cannot interleave and lose an update. */
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn);
  queue = run.then(() => {}, () => {});
  return run;
}

async function writeBoard(board) {
  board.updated = new Date().toISOString();
  await fsp.writeFile(TMP, JSON.stringify(board, null, 2) + '\n');
  await fsp.rename(TMP, FILE);           /* atomic: readers never see a half file */
  return board;
}
async function readBoard() {
  let raw;
  try {
    raw = await fsp.readFile(FILE, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    console.log('· no leaderboard.json yet — seeding one');
    return writeBoard(normalise(SEED));
  }
  try {
    return normalise(JSON.parse(raw));
  } catch (e) {
    const bak = path.join(ROOT, 'leaderboard.corrupt-' + Date.now() + '.json');
    await fsp.rename(FILE, bak);
    console.error('! leaderboard.json was not valid JSON — kept it as ' +
                  path.basename(bak) + ' and started a fresh board');
    return writeBoard(normalise(SEED));
  }
}

/* ---------------- http plumbing ---------------- */
function sendJSON(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('body was not valid JSON')); }
    });
    req.on('error', reject);
  });
}

async function handleAPI(req, res, query) {
  if (req.method === 'GET') {
    return sendJSON(res, 200, await serial(readBoard));
  }

  if (req.method === 'POST') {
    let body;
    try { body = await readBody(req); }
    catch (e) { return sendJSON(res, 400, { error: e.message }); }

    const entry = cleanEntry(body);
    if (!entry) return sendJSON(res, 400, { error: 'handle must be 3–16 of A-Z a-z 0-9 _ -' });
    entry.sim = false;                   /* only the seed may claim to be simulated */

    const board = await serial(async () => {
      const b = await readBoard();
      const key = entry.handle.toLowerCase();
      const at = b.operators.findIndex(o => o.handle.toLowerCase() === key);
      if (at >= 0) entry.handle = b.operators[at].handle;   /* keep original casing */
      if (at >= 0) b.operators[at] = entry; else b.operators.push(entry);
      return writeBoard(normalise(b));
    });
    console.log('· ' + entry.handle + ' → ' + entry.xp.toLocaleString() + ' XP');
    return sendJSON(res, 200, board);
  }

  if (req.method === 'DELETE') {
    const handle = String(query.get('handle') || '');
    if (!HANDLE.test(handle)) return sendJSON(res, 400, { error: 'handle required' });
    const board = await serial(async () => {
      const b = await readBoard();
      const key = handle.toLowerCase();
      b.operators = b.operators.filter(o => o.handle.toLowerCase() !== key);
      return writeBoard(b);
    });
    console.log('· removed ' + handle);
    return sendJSON(res, 200, board);
  }

  res.writeHead(405, { 'Allow': 'GET, POST, DELETE' });
  res.end();
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Allow': 'GET, HEAD' });
    return res.end();
  }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch (e) { rel = pathname; }
  if (rel === '/' || rel === '') rel = '/index.html';

  const file = path.join(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {   /* no climbing out */
    res.writeHead(403); return res.end('forbidden');
  }
  if (path.basename(file).charAt(0) === '.') {                /* no dotfiles */
    res.writeHead(404); return res.end('not found');
  }

  let data, stat;
  try {
    stat = await fsp.stat(file);
    if (stat.isDirectory()) { res.writeHead(404); return res.end('not found'); }
    data = await fsp.readFile(file);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('not found: ' + rel);
  }

  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-store'
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

const server = http.createServer((req, res) => {
  const parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const done = parsed.pathname === '/api/leaderboard'
    ? handleAPI(req, res, parsed.searchParams)
    : serveStatic(req, res, parsed.pathname);

  Promise.resolve(done).catch(err => {
    console.error('! ' + req.method + ' ' + parsed.pathname + ' — ' + err.message);
    if (!res.headersSent) sendJSON(res, 500, { error: 'server error' });
    else res.end();
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error('! port ' + PORT + ' is already in use — try: node server.js --port ' + (PORT + 1));
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
  console.log('');
  console.log('  PRISM  ->  http://' + shown + ':' + PORT);
  console.log('  board  ->  ' + FILE);
  if (HOST === '0.0.0.0') console.log('  open to the network — anyone who can reach this port can post any handle');
  console.log('');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { console.log('\nstopped'); server.close(() => process.exit(0)); });
}
