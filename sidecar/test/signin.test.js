// Station sign-ins: the encrypted store, the write-only API, and the real resolver signing in to a
// fake site whose live stream is only for signed-in visitors.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { LoginStore, parseKey, encrypt, decrypt } from '../src/logins.js';
import { Resolver } from '../src/resolver.js';
import { createApp } from '../src/app.js';
import { StationStore } from '../src/stations.js';

// Next to the app in the image, two levels up in the repository (as in scraper.test.js).
const here = path.dirname(fileURLToPath(import.meta.url));
const SCRAPER = [path.join(here, '..', 'media-scraper.js'), path.join(here, '..', '..', 'media-scraper.js')].find(p => existsSync(p));
let dir;
before(async () => { dir = await mkdtemp(path.join(tmpdir(), 'lb-signin-')); });
after(async () => { await rm(dir, { recursive: true, force: true }); });

test('logins: encrypted at rest, survive a restart, unreadable with another key', async () => {
  const key = randomBytes(32);
  const data = path.join(dir, 'store');
  const a = await new LoginStore({ dataDir: data, key }).load();
  await a.set('kpjr', { username: 'viewer@example.com', password: 'test-password' });
  await a.signedIn('kpjr', { cookies: [{ name: 'sid', value: 'abc' }], origins: [] });
  const raw = await readFile(path.join(data, 'logins.json'), 'utf8');
  assert.doesNotMatch(raw, /viewer@example\.com|test-password|abc/);
  assert.equal((await stat(path.join(data, 'logins.json'))).mode & 0o077, 0);

  const b = await new LoginStore({ dataDir: data, key }).load();
  assert.equal(b.get('kpjr').password, 'test-password');
  assert.equal(b.get('kpjr').session.cookies[0].value, 'abc');
  assert.deepEqual(Object.keys(b.status('kpjr')).sort(), ['configured', 'error', 'signedInAt', 'username']);

  const warnings = [];
  const c = await new LoginStore({ dataDir: data, key: randomBytes(32), log: { warn: m => warnings.push(m) } }).load();
  assert.equal(c.get('kpjr'), null);
  assert.match(warnings[0], /enter it again/);
});

test('logins: without LOGIN_KEY a private key file is generated once', async () => {
  const data = path.join(dir, 'genkey');
  const a = await new LoginStore({ dataDir: data }).load();
  await a.set('x', { username: 'u@example.com', password: 'p' });
  assert.equal((await stat(path.join(data, 'login.key'))).mode & 0o077, 0);
  const b = await new LoginStore({ dataDir: data }).load();
  assert.equal(b.get('x').username, 'u@example.com');
});

test('logins: key formats and validation', () => {
  const k = randomBytes(32);
  assert.deepEqual(parseKey(k.toString('hex')), k);
  assert.deepEqual(parseKey(k.toString('base64')), k);
  assert.equal(parseKey(''), null);
  assert.throws(() => parseKey('short'), /32 bytes/);
  assert.deepEqual(decrypt(k, encrypt(k, { a: 1 })), { a: 1 });
});

// A site with a two-field sign-in form behind a "Log in" button, and a live page that loads its
// HLS stream only for a signed-in session.
let site, siteUrl, signIns = 0, offAir = false;
const SEGMENT = Buffer.alloc(188 * 10, 0x47);
before(async () => {
  site = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const signedIn = /(?:^|; )sid=good/.test(req.headers.cookie || '');
    const html = body => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<!doctype html><html><body>${body}</body></html>`); };
    if (u.pathname === '/live') {
      if (!signedIn) return html('<h1>Live</h1><button id="showLogin">Log in</button><div id="f" hidden><form method="post" action="/session"><input type="email" name="email"><input type="password" name="password"><button>Go</button></form></div><script>showLogin.onclick=()=>f.hidden=false</script>');
      if (offAir) return html('<h1>Live</h1><p>Our next newscast starts at 5 PM.</p><a href="/account">My account</a>');
      return html('<h1>Live</h1><video id="v"></video><script>fetch("/live/stream.m3u8")</script>');
    }
    if (u.pathname === '/session' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const f = new URLSearchParams(body);
        if (f.get('email') === 'viewer@example.com' && f.get('password') === 'test-password') {
          signIns++;
          res.writeHead(303, { location: '/live', 'set-cookie': 'sid=good; Path=/; HttpOnly' });
          return res.end();
        }
        html('<p>Wrong password</p><form method="post" action="/session"><input type="email" name="email"><input type="password" name="password"></form>');
      });
      return;
    }
    if (u.pathname === '/live/stream.m3u8') {
      if (!signedIn) { res.writeHead(403); return res.end(); }
      const seq = Math.floor(Date.now() / 4000);
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-MEDIA-SEQUENCE:${seq}\n#EXTINF:4,\nseg${seq}.ts\n#EXTINF:4,\nseg${seq + 1}.ts\n`);
    }
    if (/^\/live\/seg\d+\.ts$/.test(u.pathname)) { res.writeHead(signedIn ? 200 : 403, { 'content-type': 'video/mp2t' }); return res.end(signedIn ? SEGMENT : ''); }
    res.writeHead(404); res.end();
  });
  await new Promise(r => site.listen(0, '127.0.0.1', r));
  siteUrl = `http://127.0.0.1:${site.address().port}`;
});
after(() => site.close());

test('resolver: signs in through the site\'s form, then reuses the session', { timeout: 180_000 }, async () => {
  const logins = await new LoginStore({ dataDir: path.join(dir, 'resolver'), key: randomBytes(32) }).load();
  await logins.set('member', { username: 'viewer@example.com', password: 'test-password' });
  const marketsDir = path.join(dir, 'markets');
  await mkdir(marketsDir, { recursive: true });
  await writeFile(path.join(marketsDir, 't.json'), JSON.stringify({ name: 'T', stations: [{ id: 'member', name: 'Member TV', url: `${siteUrl}/live` }] }));
  const store = await new StationStore({ dataDir: path.join(dir, 'resolver-data'), marketsDir, market: 't' }).load();
  const resolver = new Resolver({ scraperPath: SCRAPER, ytDlp: '', waitMs: 8000, log: {} });
  let t = Date.now();
  const app = createApp({ store, resolver, logins, config: { apiKey: 'secret' }, log: {}, now: () => t });
  try {
    const first = await app.cache.get(store.get('member'), { force: true });
    assert.equal(first.type, 'hls');
    assert.match(first.url, /\/live\/stream\.m3u8$/);
    assert.equal(signIns, 1);
    assert.ok(logins.get('member').session.cookies.some(c => c.name === 'sid'));
    assert.ok(logins.status('member').signedInAt);

    await app.cache.get(store.get('member'), { force: true });
    assert.equal(signIns, 1); // the saved session was enough

    // A session the site no longer accepts: no stream with it, so the resolver signs in again,
    // but not within 10 minutes of the last sign-in.
    // A recent session the site no longer accepts: the page asks to sign in, so it signs in again,
    // though not within 10 minutes of the last sign-in (meanwhile it keeps the session).
    logins.get('member').session.cookies.find(c => c.name === 'sid').value = 'expired';
    await assert.rejects(app.cache.get(store.get('member'), { force: true }), /No live stream found/);
    assert.equal(logins.get('member').session.cookies.find(c => c.name === 'sid').value, 'expired');
    t += 11 * 60_000;
    await app.cache.get(store.get('member'), { force: true });
    assert.equal(signIns, 2);
    // Off the air while signed in (no stream, no sign-in prompt): no new sign-in, the slate plays.
    offAir = true;
    t += 11 * 60_000;
    await assert.rejects(app.cache.get(store.get('member'), { force: true }), /No live stream found/);
    assert.equal(signIns, 2);
    offAir = false;

    // A wrong password is reported as a sign-in failure, not "nothing streaming".
    await logins.set('member', { username: 'viewer@example.com', password: 'wrong' });
    app.cache.invalidate();
    t += 11 * 60_000;
    await assert.rejects(app.cache.get(store.get('member'), { force: true }), /Sign-in: the site didn't accept/);
    assert.match(logins.status('member').error, /didn't accept/);
    // A failed sign-in isn't tried again on its own, however long it has been...
    t += 60 * 60_000;
    await assert.rejects(app.cache.get(store.get('member'), { force: true }), /last sign-in failed/);
    // ...only when tested (or saved again), and only for a few minutes after.
    logins.allowRetry('member', t - 1);
    await assert.rejects(app.cache.get(store.get('member'), { force: true }), /last sign-in failed/);
    logins.allowRetry('member', t + 60_000);
    await assert.rejects(app.cache.get(store.get('member'), { force: true }), /Sign-in: the site didn't accept/);
  } finally {
    await resolver.close();
  }
});

test('API: sign-ins are write-only and need the API key', async () => {
  const logins = await new LoginStore({ dataDir: path.join(dir, 'api'), key: randomBytes(32) }).load();
  const marketsDir = path.join(dir, 'markets');
  const store = await new StationStore({ dataDir: path.join(dir, 'api-data'), marketsDir, market: 't' }).load();
  const app = createApp({ store, resolver: { resolve: async () => { throw new Error('unused'); } }, logins, config: { apiKey: 'secret' }, log: {} });
  const server = http.createServer(app.handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  const put = (key, body) => fetch(`${url}/api/stations/member/login`, { method: 'PUT', headers: key ? { 'x-api-key': key } : {}, body: JSON.stringify(body) });
  try {
    assert.equal((await put(null, { username: 'a@example.com', password: 'p' })).status, 401);
    assert.equal((await put('secret', { username: 'a@example.com' })).status, 400);
    const saved = await (await put('secret', { username: 'a@example.com', password: 'test-password' })).json();
    assert.deepEqual(saved, { id: 'member', configured: true, username: 'a@example.com', signedInAt: null, error: null });
    const list = await (await fetch(`${url}/api/logins`, { headers: { 'x-api-key': 'secret' } })).text();
    assert.doesNotMatch(list, /test-password/);
    assert.equal((await fetch(`${url}/api/logins`)).status, 401);
    const status = await (await fetch(`${url}/api/status`)).text();
    assert.doesNotMatch(status, /a@example\.com|signIn/);
    // Only for a station that exists.
    assert.equal((await fetch(`${url}/api/stations/nope/login`, { method: 'PUT', headers: { 'x-api-key': 'secret' }, body: JSON.stringify({ username: 'a@example.com', password: 'p' }) })).status, 404);
    assert.equal((await fetch(`${url}/api/stations/%E0%A4%A/login`, { method: 'PUT', headers: { 'x-api-key': 'secret' }, body: '{}' })).status, 400);
    const removed = await (await fetch(`${url}/api/stations/member/login`, { method: 'DELETE', headers: { 'x-api-key': 'secret' } })).json();
    assert.equal(removed.configured, false);
  } finally {
    server.close();
  }
});

// A site whose sign-up form takes an email, a password twice and its terms box, then asks the
// new member to confirm their email; and variants with a CAPTCHA or an extra required field.
test('resolver: creates an account through a plain sign-up form, and stops where a person is needed', { timeout: 180_000 }, async () => {
  const users = new Map();
  const page = body => `<!doctype html><html><body>${body}</body></html>`;
  const form = extra => `<form method="post" action="/account"><input type="email" name="email" required>
    <input type="password" name="password" required><input type="password" name="confirm" required>${extra}
    <label><input type="checkbox" name="terms" required> I agree to the Terms of Service</label>
    <label><input type="checkbox" name="news"> Send me the newsletter</label><button>Create account</button></form>`;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const html = body => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(body)); };
    if (u.pathname === '/join') return html(`<h1>Join</h1>${form('')}`);
    if (u.pathname === '/join-captcha') return html(`${form('')}<iframe src="/hcaptcha.com/checkbox" width="300" height="80"></iframe>`);
    if (u.pathname === '/join-name') return html(form('<input type="text" name="name" placeholder="Full name" required>'));
    if (u.pathname === '/account' && req.method === 'POST') {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const f = new URLSearchParams(body);
        if (!f.get('terms') || f.get('password') !== f.get('confirm') || f.get('news')) return html(`<p role="alert">Please accept the terms</p>${form('')}`);
        users.set(f.get('email'), f.get('password'));
        res.writeHead(303, { location: '/welcome', 'set-cookie': 'sid=new; Path=/' });
        res.end();
      });
      return;
    }
    if (u.pathname === '/welcome') return html('<h1>Almost there</h1><p>Check your email to confirm your account.</p>');
    res.writeHead(404); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const resolver = new Resolver({ scraperPath: SCRAPER, ytDlp: '', log: {} });
  const account = { username: 'viewer@example.com', password: 'test-password' };
  try {
    await assert.rejects(resolver.signUp({ id: 's', signUpUrl: `${base}/join` }, account), /accept the site's terms/);
    assert.equal(users.size, 0);
    const made = await resolver.signUp({ id: 's', signUpUrl: `${base}/join` }, { ...account, acceptTerms: true });
    assert.equal(users.get('viewer@example.com'), 'test-password');
    assert.equal(made.confirmEmail, true);
    assert.ok(made.session.cookies.some(c => c.name === 'sid'));

    await assert.rejects(resolver.signUp({ id: 's', signUpUrl: `${base}/join-captcha` }, { ...account, acceptTerms: true }), /CAPTCHA/);
    await assert.rejects(resolver.signUp({ id: 's', signUpUrl: `${base}/join-name` }, { ...account, acceptTerms: true }), /more than an email and password \(Full name\)/);
    await assert.rejects(resolver.signUp({ id: 's' }, account), /no sign-up page URL/);
    assert.equal(users.size, 1);
  } finally {
    await resolver.close();
    server.close();
  }
});

test('API: sign-up needs the API key, saves the account, and reports a failure without saving', async () => {
  const logins = await new LoginStore({ dataDir: path.join(dir, 'signup-api'), key: randomBytes(32) }).load();
  const store = await new StationStore({ dataDir: path.join(dir, 'signup-api-data'), marketsDir: path.join(dir, 'markets'), market: 't' }).load();
  let fail = false;
  const seen = [];
  const resolver = {
    resolve: async () => { throw new Error('unused'); },
    signUp: async (station, account) => {
      seen.push(account);
      if (fail) throw new Error('Sign-up: the sign-up form has a CAPTCHA');
      return { confirmEmail: true, session: { cookies: [], origins: [] } };
    },
  };
  const app = createApp({ store, resolver, logins, config: { apiKey: 'secret' }, log: {} });
  const server = http.createServer(app.handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const post = (key, body) => fetch(`http://127.0.0.1:${server.address().port}/api/stations/member/signup`, { method: 'POST', headers: key ? { 'x-api-key': key } : {}, body: JSON.stringify(body) });
  try {
    assert.equal((await post(null, { username: 'a@example.com', password: 'p' })).status, 401);
    const ok = await (await post('secret', { username: 'a@example.com', password: 'test-password', acceptTerms: true })).json();
    assert.deepEqual([ok.ok, ok.confirmEmail, ok.username, ok.signedInAt], [true, true, 'a@example.com', null]);
    assert.equal(seen[0].acceptTerms, true);
    assert.equal(logins.get('member').password, 'test-password');
    await logins.remove('member');
    fail = true;
    const bad = await (await post('secret', { username: 'a@example.com', password: 'test-password', acceptTerms: 'yes' })).json();
    assert.equal(bad.ok, false);
    assert.match(bad.error, /CAPTCHA/);
    assert.equal(seen[1].acceptTerms, false); // only a literal true accepts the terms
    assert.equal(logins.get('member'), null);
  } finally {
    server.close();
  }
});

test('logins: overlapping saves all land, and a replaced account ignores the old one\'s outcome', async () => {
  const logins = await new LoginStore({ dataDir: path.join(dir, 'race'), key: randomBytes(32) }).load();
  await logins.set('a', { username: 'a@example.com', password: 'p' });
  await logins.set('b', { username: 'b@example.com', password: 'p' });
  const old = logins.get('a');
  await Promise.all([
    logins.saveSession('a', { cookies: [], origins: [] }),
    logins.forgetSession('a'),
    logins.signedIn('b', { cookies: [], origins: [] }),
    logins.set('c', { username: 'c@example.com', password: 'p' }),
  ]);
  await logins.set('a', { username: 'new@example.com', password: 'q' });
  await logins.signedIn('a', { cookies: [{ name: 'old' }], origins: [] }, old);
  await logins.failed('a', 'old account failed', old);
  const again = await new LoginStore({ dataDir: path.join(dir, 'race'), key: logins.key }).load();
  assert.deepEqual([...again.entries.keys()].sort(), ['a', 'b', 'c']);
  assert.equal(again.get('a').username, 'new@example.com');
  assert.equal(again.get('a').session, null);
  assert.equal(again.get('a').error, null);
  assert.ok(again.get('b').signedInAt);
});

test('logins: a damaged file is set aside instead of stopping the sidecar', async () => {
  const data = path.join(dir, 'damaged');
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, 'logins.json'), '{"version":1,"stations":{"a":');
  const warnings = [];
  const store = await new LoginStore({ dataDir: data, key: randomBytes(32), log: { warn: m => warnings.push(m) } }).load();
  assert.equal(store.get('a'), null);
  assert.match(warnings[0], /damaged/);
});

test('resolver: the email never goes into a search box, and only terms boxes are ticked', { timeout: 120_000 }, async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/home') return res.end('<!doctype html><form action="/search"><input type="text" name="q" placeholder="Search"></form>');
    res.end(`<!doctype html><form method="post" action="/x"><input type="email" name="email"><input type="password" name="pw">
      <label><input type="checkbox" name="terms"> I accept the Terms of Use</label>
      <label><input type="checkbox" name="offers" required> I agree to receive offers from partners</label></form>`);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const resolver = new Resolver({ scraperPath: SCRAPER, ytDlp: '', log: {} });
  const failures = [];
  const login = { username: 'viewer@example.com', password: 'test-password', mayAttempt: () => null, failed: async m => { failures.push(m); } };
  try {
    const browser = await resolver.browser();
    const context = await browser.newContext();
    await assert.rejects(resolver.signIn(context, { id: 's', url: `${base}/home` }, login), /no sign-in form found/);
    await context.close();
    await assert.rejects(resolver.signUp({ id: 's', signUpUrl: `${base}/join` }, { ...login, acceptTerms: true }), /asks you to tick "I agree to receive offers from partners"/);
  } finally {
    await resolver.close();
    server.close();
  }
});

test('resolver: a field it can\'t type into fails without the typed value; ZIP fields aren\'t sign-in codes', { timeout: 120_000 }, async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/locked') return res.end('<!doctype html><form><input type="email" name="email"><input type="password" name="pw" readonly></form>');
    if (req.url === '/zip') return res.end('<!doctype html><form method="get" action="/home"><input type="email" name="email"><input type="password" name="pw"><button>Log in</button></form>');
    res.end('<!doctype html><h1>Home</h1><label>Weather <input name="zipcode" placeholder="ZIP code"></label>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const resolver = new Resolver({ scraperPath: SCRAPER, ytDlp: '', log: {} });
  const failures = [];
  let signedIn = 0;
  const login = { username: 'viewer@example.com', password: 'secret-value-123', mayAttempt: () => null, failed: async m => { failures.push(m); }, signedIn: async () => { signedIn++; } };
  try {
    const browser = await resolver.browser();
    let context = await browser.newContext();
    const err = await resolver.signIn(context, { id: 's', url: `${base}/locked` }, login).catch(e => e);
    await context.close();
    assert.match(err.message, /couldn't type into the site's password field/);
    assert.doesNotMatch(err.message + failures.join(' '), /secret-value-123/);
    context = await browser.newContext();
    await resolver.signIn(context, { id: 's', url: `${base}/zip` }, login);
    await context.close();
    assert.equal(signedIn, 1);
  } finally {
    await resolver.close();
    server.close();
  }
});

test('API: a station sync drops sign-ins of stations no longer sent, but an empty list keeps them', async () => {
  const logins = await new LoginStore({ dataDir: path.join(dir, 'orphans'), key: randomBytes(32) }).load();
  const store = await new StationStore({ dataDir: path.join(dir, 'orphans-data'), marketsDir: path.join(dir, 'markets'), market: 't' }).load();
  const app = createApp({ store, resolver: { resolve: async () => { throw new Error('unused'); } }, logins, config: { apiKey: 'secret' }, log: {} });
  const server = http.createServer(app.handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const put = list => fetch(`http://127.0.0.1:${server.address().port}/api/stations`, { method: 'PUT', headers: { 'x-api-key': 'secret' }, body: JSON.stringify(list) });
  try {
    await put([{ id: 'member', url: 'https://example.com/a' }, { id: 'other', url: 'https://example.com/b' }]);
    await logins.set('member', { username: 'a@example.com', password: 'p' });
    await logins.set('other', { username: 'b@example.com', password: 'p' });
    assert.equal((await put([])).status, 200);
    assert.ok(logins.get('member') && logins.get('other'));
    await put([{ id: 'member', url: 'https://example.com/a' }]);
    assert.ok(logins.get('member'));
    assert.equal(logins.get('other'), null);
  } finally {
    server.close();
  }
});
