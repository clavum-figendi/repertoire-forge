import { Chess } from 'chess.js';

const CONTROLS = ['bullet', 'blitz', 'rapid', 'classical'];
const RECORD_LIMIT = 2 * 1024 * 1024;
const BATCH_BYTES = 256 * 1024;
const BATCH_GAMES = 25;

function optionsFor(options) {
  const { maxGames = 200, minMoves = 0, timeControls = CONTROLS, since, until } = options;
  if (maxGames !== Infinity && (!Number.isInteger(maxGames) || maxGames < 1)) throw new Error('maxGames must be a positive integer or Infinity');
  if (!Number.isInteger(minMoves) || minMoves < 0) throw new Error('minMoves must be a nonnegative integer');
  if (!Array.isArray(timeControls) || !timeControls.length || timeControls.some(v => !CONTROLS.includes(v))) throw new Error('Select bullet, blitz, rapid or classical time controls');
  const timestamp = value => {
    if (value === undefined) return undefined;
    const result = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(result)) throw new Error('Invalid archive date window');
    return result;
  };
  const start = timestamp(since), end = timestamp(until);
  if (start !== undefined && end !== undefined && start > end) throw new Error('since must not be after until');
  return { ...options, maxGames, minMoves, timeControls, since:start, until:end };
}

async function* chunks(url, signal, accept) {
  signal?.throwIfAborted();
  const response = await fetch(url, {signal, headers:{Accept:accept}});
  if (!response.ok) throw new Error(`Public API returned HTTP ${response.status}${response.status === 429 ? ' (rate limited; please retry later)' : ''}`);
  if (!response.body) throw new Error('Public API returned no response body');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, {once:true});
  try {
    while (true) {
      signal?.throwIfAborted();
      const {done, value} = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      yield decoder.decode(value, {stream:true});
    }
    const tail = decoder.decode(); if (tail) yield tail;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel(); reader.releaseLock();
  }
}

function parseRecord(text) {
  if (new TextEncoder().encode(text).length > RECORD_LIMIT) throw new Error('Archive game exceeds 2 MiB safety limit');
  return JSON.parse(text);
}

async function* ndjson(url, signal) {
  let pending = '';
  for await (const chunk of chunks(url, signal, 'application/x-ndjson')) {
    pending += chunk;
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).trim(); pending = pending.slice(end + 1);
      if (line.length > RECORD_LIMIT) throw new Error('Archive game exceeds 2 MiB safety limit');
      if (line) yield parseRecord(line);
    }
    if (pending.length > RECORD_LIMIT) throw new Error('Archive game exceeds 2 MiB safety limit');
  }
  if (pending.trim()) yield parseRecord(pending);
}

// Incremental parser for the public API's {"games":[{...}, ...]} envelope.
// Only one game object is retained; JSON strings may span arbitrary network chunks.
async function* monthlyGames(url, signal) {
  let prefix = '', record = '', tail = '', state = 'prefix', depth = 0, quoted = false, escaped = false, first = true;
  for await (const chunk of chunks(url, signal, 'application/json')) {
    for (const char of chunk) {
      if (state === 'prefix') {
        prefix += char;
        if (prefix.length > 1024) throw new Error('Invalid monthly archive envelope');
        if (char === '[') {
          if (!/^\s*\{\s*"games"\s*:\s*\[$/.test(prefix)) throw new Error('Invalid monthly archive envelope');
          state = 'between';
        }
      } else if (state === 'tail') {
        tail += char;
        if (tail.length > 1024) throw new Error('Invalid monthly archive ending');
      } else if (state === 'between' || state === 'comma') {
        if (/\s/.test(char)) continue;
        if (char === ']' && (state === 'comma' || first)) { state = 'tail'; continue; }
        if (state === 'comma' && char === ',') { state = 'between'; continue; }
        if (state !== 'between' || char !== '{') throw new Error('Invalid monthly archive game list');
        record = '{'; depth = 1; state = 'record'; first = false;
      } else {
        record += char;
        if (record.length > RECORD_LIMIT) throw new Error('Archive game exceeds 2 MiB safety limit');
        if (quoted) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') depth--;
        if (depth === 0) { const game = parseRecord(record); record = ''; state = 'comma'; yield game; }
      }
    }
  }
  if (state !== 'tail' || !/^\s*}\s*$/.test(tail)) throw new Error('Truncated or invalid monthly archive');
}

function chesscomPgn(game, options) {
  // Chess.com rapid is the provider's entire live rapid bucket (including long
  // games). Daily/correspondence is excluded; do not infer classical from clocks.
  if (game.rules !== 'chess' || !options.timeControls.includes(game.time_class) || !CONTROLS.includes(game.time_class)) return null;
  if (typeof game.pgn !== 'string' || !Number.isFinite(game.end_time) || !inWindow((game.start_time ?? game.end_time) * 1000, options)) return null;
  const result = /\[Result\s+"([^"]+)"\]/.exec(game.pgn)?.[1];
  if (!['1-0','0-1','1/2-1/2'].includes(result)) return null;
  const chess = new Chess();
  try { chess.loadPgn(game.pgn); } catch { throw new Error(`Invalid PGN in Chess.com archive${game.url ? ': ' + game.url : ''}`); }
  if (chess.header().Variant && chess.header().Variant.toLowerCase() !== 'standard') return null;
  if (chess.history().length <= 2 * options.minMoves) return null;
  // Chess.com Site is often just "Chess.com"; core dedup needs the unique URL.
  const link = game.url || chess.header().Link;
  if (typeof link !== 'string' || !/^https:\/\/(?:www\.)?chess\.com\/game\/(?:live|daily)\/\d+$/.test(link)) throw new Error('Chess.com game is missing a trustworthy game URL');
  const site = `[Site "${link}"]`;
  return /^\[Site\s+"[^"\r\n]*"\]/m.test(game.pgn) ? game.pgn.replace(/^\[Site\s+"[^"\r\n]*"\]/m, site) : site + '\n' + game.pgn;
}

async function* chesscomGames(username, options, progress) {
  await progress('archives');
  const root = 'https://api.chess.com/pub/player/' + encodeURIComponent(username.toLowerCase()) + '/games/';
  let text = '';
  for await (const chunk of chunks(root + 'archives', options.signal, 'application/json')) {
    text += chunk;
    if (text.length > RECORD_LIMIT) throw new Error('Archive index exceeds 2 MiB safety limit');
  }
  const index = JSON.parse(text);
  if (!Array.isArray(index.archives)) throw new Error('No public game archives for this username');
  const months = [...new Set(index.archives)].sort().reverse();
  for (const url of months) {
    if (typeof url !== 'string' || !url.startsWith(root) || !/^\d{4}\/(0[1-9]|1[0-2])$/.test(url.slice(root.length))) throw new Error('Invalid archive URL');
    const month = url.slice(-7), start = Date.parse(month.replace('/', '-') + '-01T00:00:00Z');
    const date = new Date(start), end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    if (options.since !== undefined && end <= options.since || options.until !== undefined && start > options.until) continue;
    await progress('month', {month});
    for await (const game of monthlyGames(url, options.signal)) yield chesscomPgn(game, options);
  }
}

function inWindow(time, options) {
  if (options.since === undefined && options.until === undefined) return true;
  return Number.isFinite(time) && (options.since === undefined || time >= options.since) && (options.until === undefined || time <= options.until);
}

function lichessPgn(game) {
  if (!/^[A-Za-z0-9]{8}$/.test(game.id || '')) throw new Error('Lichess game is missing a trustworthy 8-character game ID');
  if (typeof game.pgn === 'string' && game.pgn.trim()) {
    const site = `[Site "https://lichess.org/${game.id}"]`;
    return /^\[Site\s+"[^"\r\n]*"\]/m.test(game.pgn) ? game.pgn.replace(/^\[Site\s+"[^"\r\n]*"\]/m, site) : site + '\n' + game.pgn;
  }
  if (typeof game.moves !== 'string') throw new Error('Lichess game is missing PGN or moves');
  const result = game.winner === 'white' ? '1-0' : game.winner === 'black' ? '0-1' : '1/2-1/2';
  const safe = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, ' ');
  const headers = {Event:'Lichess public game', Site:`https://lichess.org/${game.id}`, White:game.players?.white?.user?.name || 'Anonymous', Black:game.players?.black?.user?.name || 'Anonymous', Result:result};
  if (Number.isFinite(game.createdAt)) headers.Date = new Date(game.createdAt).toISOString().slice(0,10).replaceAll('-', '.');
  return Object.entries(headers).map(([key,value]) => `[${key} "${safe(value)}"]`).join('\n') + '\n\n' + game.moves.split(/\s+/).map((move,i) => i % 2 === 0 ? `${i / 2 + 1}. ${move}` : move).join(' ') + ' ' + result;
}

async function* lichessGames(username, options) {
  const url = new URL('https://lichess.org/api/games/user/' + encodeURIComponent(username));
  // Never set max here: the provider limit would run before our length filter.
  const params = {pgnInJson:true, moves:true, clocks:false, evals:false, opening:false, sort:'dateDesc', ongoing:false, finished:true, perfType:options.timeControls.join(',')};
  for (const key of ['since', 'until']) if (options[key] !== undefined) params[key] = options[key];
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key, String(value));
  for await (const game of ndjson(url, options.signal)) {
    if (game.error) throw new Error(`Lichess export: ${game.error}`);
    const finished = ['mate','resign','stalemate','timeout','draw','outoftime','cheat','variantEnd'].includes(game.status);
    const eligible = game.variant === 'standard' && finished && options.timeControls.includes(game.speed) && inWindow(game.createdAt, options);
    if (!eligible) { yield null; continue; }
    let plies;
    if (typeof game.moves === 'string') plies = game.moves.trim() ? game.moves.trim().split(/\s+/).length : 0;
    else {
      if (typeof game.pgn !== 'string') throw new Error('Lichess game is missing moves and PGN');
      const chess = new Chess(); chess.loadPgn(game.pgn); plies = chess.history().length;
    }
    yield plies > 2 * options.minMoves ? lichessPgn(game) : null;
  }
}

/**
 * onBatch receives one concatenated PGN string, awaited for backpressure (<=25 games,
 * normally <=256 KiB; a single game may be up to 2 MiB). Returns {matched,scanned}.
 * scanned counts provider records inspected, including excluded games; not total
 * history size. Without onBatch, returns the legacy concatenated PGN string.
 * minMoves is strict: > 2*N plies; an unfinished final move counts as half a move.
 * Dates are inclusive epoch milliseconds or parseable ISO dates: Lichess start
 * time; Chess.com start_time when provided, otherwise the API's end_time.
 * Chess.com visits months newest-first, but games within a month stay in provider
 * order to avoid buffering the month. Daily is excluded; long rapid remains rapid,
 * not classical, unless the provider explicitly supplies time_class=classical.
 * Progress is {stage,platform,matched,scanned,...}; totals are never estimated.
 * matched counts selected games (not deduplicated DB additions). Empty selection
 * returns zero counts (or an empty legacy string); callback/network errors reject.
 * Legacy string mode alone has a 30 MiB memory guard; onBatch has no history cap.
 */
export async function fetchArchive(platform, username, rawOptions = {}) {
  if (!['lichess','chesscom'].includes(platform)) throw new Error('Unknown game platform');
  if (typeof username !== 'string' || !/^[A-Za-z0-9_-]{2,30}$/.test(username)) throw new Error('Enter a valid username (letters, numbers, underscore, dash).');
  const options = optionsFor(rawOptions), {signal} = options;
  let matched = 0, scanned = 0, batch = [], bytes = 0, legacyBytes = 0;
  const legacy = [];
  const progress = (stage, extra = {}) => options.onProgress?.({stage,platform,matched,scanned,...extra});
  const flush = async () => {
    if (!batch.length) return;
    signal?.throwIfAborted();
    await options.onBatch(batch.join('\n\n'));
    signal?.throwIfAborted(); batch = []; bytes = 0;
  };
  try {
    signal?.throwIfAborted();
    await progress('fetching');
    const source = platform === 'lichess' ? lichessGames(username, options) : chesscomGames(username, options, progress);
    for await (const pgn of source) {
      signal?.throwIfAborted(); scanned++;
      if (pgn) {
        const size = new TextEncoder().encode(pgn).length;
        if (options.onBatch) {
          if (batch.length && bytes + size > BATCH_BYTES) await flush();
          batch.push(pgn); bytes += size;
        } else {
          legacyBytes += size;
          if (legacyBytes > 30 * 1024 * 1024) throw new Error('Import exceeds 30 MiB. Use onBatch for full history streaming.');
          legacy.push(pgn);
        }
        matched++;
        if (options.onBatch && (batch.length >= BATCH_GAMES || bytes >= BATCH_BYTES)) await flush();
      }
      if (scanned % 25 === 0) await progress('scanning');
      if (matched >= options.maxGames) break;
    }
    if (options.onBatch) await flush();
    await progress('complete');
    return options.onBatch ? {matched,scanned} : legacy.join('\n\n');
  } catch (error) {
    await progress(signal?.aborted ? 'cancelled' : 'error', {message:error.message});
    throw error;
  }
}
