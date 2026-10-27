// Sign-ins for stations that stream only to signed-in (free) accounts. Each station's email and
// password, and the browser session after signing in (its cookies are as good as the password),
// are encrypted with AES-256-GCM in DATA_DIR/logins.json. Nothing here is ever sent back out:
// the API reports only whether a station has a sign-in, its email and how the last one went.
//
// The key is LOGIN_KEY (32 bytes, base64 or hex) when set, so logins.json alone (a backup of the
// data volume, say) reveals nothing. Without it, a key is generated once into DATA_DIR/login.key.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';

const text = v => (v === undefined || v === null ? '' : String(v).trim());

export function parseKey(value) {
  const v = text(value);
  if (!v) return null;
  const key = /^[0-9a-f]{64}$/i.test(v) ? Buffer.from(v, 'hex') : Buffer.from(v, 'base64');
  if (key.length !== 32) throw new Error('LOGIN_KEY must be 32 bytes, as 64 hex digits or base64 (openssl rand -base64 32)');
  return key;
}

export function encrypt(key, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

export function decrypt(key, box) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8'));
}

export function normalizeLogin(raw) {
  const username = text(raw?.username);
  const password = raw?.password === undefined || raw?.password === null ? '' : String(raw.password);
  if (!username) throw new Error('an email or username is required');
  if (!password) throw new Error('a password is required');
  if (username.length > 320 || password.length > 1024) throw new Error('email or password too long');
  return { username, password };
}

export class LoginStore {
  constructor({ dataDir, key = null, log = {} }) {
    this.file = path.join(dataDir, 'logins.json');
    this.keyFile = path.join(dataDir, 'login.key');
    this.dataDir = dataDir;
    this.key = key;
    this.log = log;
    this.entries = new Map(); // id -> { username, password, session, signedInAt, error }
    this.writing = Promise.resolve();
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    if (!this.key) {
      try {
        this.key = parseKey(await readFile(this.keyFile, 'utf8'));
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        this.key = randomBytes(32);
        await writeFile(this.keyFile, this.key.toString('base64') + '\n', { mode: 0o600 });
        this.log.info?.('sign-ins: generated a key in login.key (set LOGIN_KEY to keep it out of the data volume)');
      }
    }
    let saved = {};
    try {
      saved = JSON.parse(await readFile(this.file, 'utf8')).stations || {};
    } catch (e) {
      if (e.code === 'ENOENT') { /* no sign-ins yet */ } else if (e instanceof SyntaxError) {
        // Never keep the sidecar from starting: set the damaged file aside; sign-ins are entered again.
        const aside = `${this.file}.damaged-${Date.now()}`;
        await rename(this.file, aside).catch(() => {});
        this.log.warn?.(`sign-ins: ${this.file} was damaged; moved it to ${aside}`);
      } else throw e;
    }
    for (const [id, box] of Object.entries(saved)) {
      try {
        this.entries.set(id, decrypt(this.key, box));
      } catch {
        // Another key (LOGIN_KEY changed): the sign-in has to be entered again.
        this.log.warn?.(`sign-ins: can't decrypt the sign-in for ${id} with this key; enter it again`);
      }
    }
    return this;
  }

  // One write at a time, each of the entries as they are when it starts, so overlapping saves
  // (a sign-in finishing while the settings page saves an account) can't trip over each other.
  persist() {
    const write = async () => {
      const stations = {};
      for (const [id, { retry, ...entry }] of this.entries) stations[id] = encrypt(this.key, entry);
      const tmp = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, stations }, null, 2) + '\n', { mode: 0o600 });
      await rename(tmp, this.file);
      await chmod(this.file, 0o600).catch(() => {});
    };
    const done = this.writing.then(write, write);
    this.writing = done.catch(() => {});
    return done;
  }

  get(id) {
    return this.entries.get(id) || null;
  }

  // A new email or password: the old session belonged to the old account.
  async set(id, raw) {
    const { username, password } = normalizeLogin(raw);
    this.entries.set(id, { username, password, session: null, signedInAt: null, error: null });
    await this.persist();
    return this.status(id);
  }

  async remove(id) {
    const had = this.entries.delete(id);
    if (had) await this.persist();
    return had;
  }

  // The outcome of a resolve goes to the account it started with (`entry`, from get()): if the
  // sign-in was replaced or removed meanwhile, the old account's cookies and errors are dropped.
  current(id, entry) {
    return !!entry && this.entries.get(id) === entry;
  }

  // The session's cookies after a stream was found with it (sites renew them as they're used).
  async saveSession(id, session, entry = this.entries.get(id)) {
    if (!this.current(id, entry)) return;
    entry.session = session;
    await this.persist();
  }

  async signedIn(id, session, entry = this.entries.get(id)) {
    if (!this.current(id, entry)) return;
    Object.assign(entry, { session, signedInAt: new Date().toISOString(), error: null });
    await this.persist();
  }

  // A failed sign-in isn't tried again on its own (that could lock the account, or email a code
  // each time): only after the sign-in is saved again or the station is tested.
  async failed(id, message, entry = this.entries.get(id)) {
    if (!this.current(id, entry)) return;
    Object.assign(entry, { session: null, error: message });
    await this.persist();
  }

  async forgetSession(id, entry = this.entries.get(id)) {
    if (!this.current(id, entry) || !entry.session) return;
    entry.session = null;
    await this.persist();
  }

  // Test now: let a failed sign-in be tried again, once.
  allowRetry(id) {
    const entry = this.entries.get(id);
    if (entry) entry.retry = true;
  }

  // What the API may show: never the password or the session.
  status(id) {
    const e = this.entries.get(id);
    return e
      ? { configured: true, username: e.username, signedInAt: e.signedInAt, error: e.error }
      : { configured: false };
  }
}
