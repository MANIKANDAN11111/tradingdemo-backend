import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const PGBIN = process.env.PGBIN || '/usr/lib/postgresql/14/bin';
const PGDATA = path.join(ROOT, 'server', 'pgdata');
const PGSOCK = path.join(ROOT, 'server', 'pgsock');
const PGLOG = path.join(ROOT, 'server', 'pg.log');
const PGPORT = process.env.PGPORT || '5433';

const bin = (name) => path.join(PGBIN, name);

/**
 * Bring the private, user-owned PostgreSQL cluster up if it is not already
 * running. Safe to call on every boot: a missing cluster is simply skipped
 * (the app then talks to whatever DATABASE_URL points at).
 */
export function ensureLocalPostgres() {
  if (!fs.existsSync(path.join(PGDATA, 'PG_VERSION'))) {
    return { started: false, reason: 'no private cluster at server/pgdata' };
  }

  if (isReady()) {
    return { started: false, reason: 'already running' };
  }

  try {
    fs.mkdirSync(PGSOCK, { recursive: true });
    execFileSync(
      bin('pg_ctl'),
      [
        '-D', PGDATA,
        '-l', PGLOG,
        '-o', `-p ${PGPORT} -k ${PGSOCK} -c listen_addresses=127.0.0.1`,
        'start',
      ],
      { stdio: 'ignore' },
    );
  } catch (err) {
    return { started: false, reason: `pg_ctl start failed: ${err.message}` };
  }

  // give it a moment to accept connections
  for (let i = 0; i < 40; i += 1) {
    if (isReady()) return { started: true, reason: `started on 127.0.0.1:${PGPORT}` };
    sleep(250);
  }
  return { started: false, reason: 'started but not accepting connections' };
}

function isReady() {
  try {
    execFileSync(bin('pg_isready'), ['-h', '127.0.0.1', '-p', PGPORT], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Blocking sleep — only used during startup, before the server accepts traffic. */
function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy-wait is fine here: bounded, once per boot, before listen()
  }
}
