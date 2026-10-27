// Finds a station's live stream: opens its page in headless Chromium with media-scraper.js
// loaded before the page's own scripts, records every manifest the page requests (with the
// headers it sent), presses play if nothing loads, then probes the candidates from Node and
// keeps the best live one. Pages that only embed YouTube/Twitch/etc. fall back to yt-dlp.
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { probeManifest } from './probe.js';
import { DAI_BLOCKED_HOST_RE, isAd, manifestTypeOf, mergeCandidates, pickBest, pickHeaders, unblockedStreamUrl } from './pick.js';
import { expiryFromUrl } from './hls.js';

const run = promisify(execFile);

const PLAY_SELECTORS = [
  '.vjs-big-play-button',
  '.jw-display-icon-display',
  '.jw-icon-playback',
  'button[aria-label*="play" i]',
  '[role="button"][aria-label*="play" i]',
  '[class*="play-button" i]',
  '[class*="PlayButton"]',
  '[data-testid*="play" i]',
];

const EMBED_PROVIDERS = /youtube|twitch|kick|vimeo|dailymotion|facebook|rumble/i;

const BOT_CHECK_TEXT = /press (?:&|and) hold|verify (?:that )?you are (?:a )?human|are you a robot|confirm you are a human|access to this page has been denied|checking your browser|captcha/i;

export function isBotCheck(status, text) {
  return BOT_CHECK_TEXT.test(text || '') && (status === 403 || status === 429 || status === 503 || text.length < 1500);
}

const USER_FIELDS = [
  'input[type="email"]',
  'input[autocomplete~="username"]',
  'input[autocomplete~="email"]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[name*="user" i]',
  'input[name*="login" i]',
  'input[type="text"]',
];

async function visible(frame, selector) {
  const loc = frame.locator(selector).filter({ visible: true }).first();
  return (await loc.count().catch(() => 0)) ? loc : null;
}

// The visible email/username and password fields: from the frame with a password field, else
// (the email step of a two-step form) from one with a field that is clearly an email or username,
// so a site's search box never gets the email.
export async function signInForm(page) {
  for (const frame of page.frames()) {
    const password = await visible(frame, 'input[type="password"]');
    if (!password) continue;
    let user = null;
    for (const sel of USER_FIELDS) if ((user = await visible(frame, sel))) break;
    return { frame, user, password };
  }
  for (const frame of page.frames()) {
    for (const sel of USER_FIELDS.filter(f => f !== 'input[type="text"]')) {
      const user = await visible(frame, sel);
      if (user) return { frame, user, password: null };
    }
  }
  return { user: null, password: null };
}

// After the password: a field for a code the site sent (emailed code, text message, authenticator),
// or a row of one-character boxes for one. ZIP, promo and similar "code" fields don't count.
async function asksForCode(page) {
  for (const frame of page.frames()) {
    const found = await frame.evaluate(() => {
      const inputs = [...document.querySelectorAll('input')].filter(el => el.offsetParent && !['hidden', 'checkbox', 'radio', 'submit', 'button'].includes(el.type));
      const named = el => `${el.name} ${el.id} ${el.autocomplete} ${el.placeholder} ${el.getAttribute('aria-label') || ''}`;
      const code = inputs.some(el => el.autocomplete === 'one-time-code'
        || (/code|otp|mfa|2fa|two.?factor|verif|passcode/i.test(named(el)) && !/zip|post|promo|coupon|discount|gift|qr|bar|country|area|referr/i.test(named(el))));
      return code || inputs.filter(el => el.maxLength === 1).length >= 4;
    }).catch(() => false);
    if (found) return true;
  }
  return false;
}

// Types a value into a field. Playwright's errors repeat the typed text, so a failure is only
// reported as false, never with its message.
async function typeInto(field, value) {
  try {
    await field.fill(value, { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

// An unexpected error from signing in or up, as a ResolveError whose message can't contain the
// email or password (Playwright repeats what it was asked to type).
function scrubbed(e, what, details, { username, password }) {
  if (e instanceof ResolveError) return e;
  let message = String(e?.message || e).split('\n')[0];
  for (const secret of [password, username, JSON.stringify(password ?? '').slice(1, -1), encodeURIComponent(password ?? '')]) {
    if (secret) message = message.split(secret).join('***');
  }
  return new ResolveError(`${what}: ${message}`, details);
}

// The page offers to sign in: a visible password field, or a "Log in" / "Sign in" control.
// The page itself, not its embedded widgets (a comments box has its own "Log in" button).
async function asksToSignIn(page) {
  const frame = page.mainFrame();
  if (await visible(frame, 'input[type="password"]')) return true;
  for (const role of ['button', 'link']) {
    if (await frame.getByRole(role, { name: SIGN_IN_NAMES }).filter({ visible: true }).count().catch(() => 0)) return true;
  }
  return false;
}

// A page whose form submits with "Log in" / "Sign in": a sign-in form, not a sign-up one.
async function looksLikeSignIn(frame) {
  const names = await frame.locator('button[type="submit"], input[type="submit"], form button').filter({ visible: true })
    .evaluateAll(els => els.map(el => (el.innerText || el.value || '').trim())).catch(() => []);
  return names.length > 0 && names.every(n => /^(log ?in|sign ?in|continue|next|send login code)$/i.test(n)) && names.some(n => /log ?in|sign ?in|login code/i.test(n));
}

const SIGN_IN_NAMES = /^\s*(log ?in|sign ?in)\s*$/i;
const SIGN_UP_NAMES = /^\s*(sign ?up|register|join( now| free| for free)?|create (an |your |a free )?account|get started)\s*$/i;
// A box accepting the site's terms (or privacy policy), which the person accepted in the settings;
// boxes agreeing to anything else (offers, partners, an age) are left to the person.
const TERMS_LABEL = /\bterms\b|conditions|privacy policy|terms of (use|service)/i;
const NOT_TERMS_LABEL = /offer|partner|marketing|newsletter|promot|updates|news\b|\b1[38]\b|years? old|\bage\b/i;
const CONFIRM_EMAIL = /(verify|confirm|activate)\b[^.]{0,60}\b(e-?mail|account|address)|check your (e-?mail|inbox)/i;

async function clickSignInLink(page) {
  return clickControl(page, SIGN_IN_NAMES);
}

// The text a person reads for a field: its <label>, aria-label, placeholder or name.
async function fieldLabel(field) {
  return field.evaluate(el => {
    const byFor = el.id && el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    return (byFor?.innerText || el.closest('label')?.innerText || el.getAttribute('aria-label') || el.placeholder || el.name || '').replace(/\s+/g, ' ').trim();
  }).catch(() => '');
}

// Visible fields the form requires beyond the email and password: names, birthdays, phone
// numbers, choices. Those are the person's to fill in on the site.
async function otherRequiredFields(frame) {
  return frame.evaluate(() => [...document.querySelectorAll('input, select, textarea')]
    .filter(el => el.offsetParent && (el.required || el.getAttribute('aria-required') === 'true'))
    .filter(el => !['email', 'password', 'checkbox', 'hidden', 'submit', 'button'].includes(el.type))
    .filter(el => !/e-?mail|user/i.test(`${el.name} ${el.id} ${el.autocomplete}`))
    .filter(el => !el.value)
    .map(el => (el.labels?.[0]?.innerText || el.getAttribute('aria-label') || el.placeholder || el.name || el.type).replace(/\s+/g, ' ').trim()))
    .catch(() => []);
}

async function clickControl(page, names) {
  for (const frame of page.frames()) {
    for (const role of ['button', 'link']) {
      const loc = frame.getByRole(role, { name: names }).filter({ visible: true }).first();
      if (await loc.count().catch(() => 0)) {
        await loc.click({ timeout: 3000 }).catch(() => {});
        return true;
      }
    }
  }
  return false;
}

// A CAPTCHA the person would have to solve: a visible reCAPTCHA checkbox or challenge, hCaptcha
// or Cloudflare Turnstile. Invisible reCAPTCHA that never challenges is fine.
async function showsCaptcha(page) {
  const sel = 'iframe[src*="recaptcha"][src*="bframe"], iframe[src*="recaptcha"][src*="anchor"]:not([src*="size=invisible"]), iframe[src*="hcaptcha.com"], iframe[src*="challenges.cloudflare.com"], iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], iframe[title*="captcha" i]';
  for (const frame of page.frames()) {
    if ((await frame.locator(sel).filter({ visible: true }).count().catch(() => 0)) > 0) return true;
  }
  return false;
}

export class ResolveError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.details = details;
  }
}

function cookieHeader(cookies, url) {
  let host;
  try { host = new URL(url).hostname; } catch { return null; }
  const matching = cookies.filter(c => {
    const d = c.domain.replace(/^\./, '');
    return host === d || host.endsWith('.' + d);
  });
  return matching.length ? matching.map(c => `${c.name}=${c.value}`).join('; ') : null;
}

export class Resolver {
  // timezoneId: the station's time zone for the browser (players check it against the market);
  // unset uses the host's.
  constructor({ scraperPath, ytDlp = 'yt-dlp', maxHeight = 1080, pageTimeoutMs = 45_000, waitMs = 20_000, channel = 'chrome', timezoneId, log = console } = {}) {
    this.scraperPath = scraperPath;
    this.timezoneId = timezoneId;
    this.channel = channel;
    this.ytDlp = ytDlp;
    this.maxHeight = maxHeight;
    this.pageTimeoutMs = pageTimeoutMs;
    this.waitMs = waitMs;
    this.log = log;
    this.browserPromise = null;
    this.scraperSource = null;
  }

  async browser() {
    if (!this.browserPromise) {
      const options = { args: ['--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled', '--mute-audio'] };
      // Prefer Google Chrome; fall back to the bundled Chromium where it's missing (ARM). Both play
      // H.264/AAC, which station players check for before they request a stream.
      const launch = this.channel
        ? chromium.launch({ ...options, channel: this.channel }).catch(e => {
          this.log.warn?.(`browser channel "${this.channel}" unavailable (${e.message.split('\n')[0]}); using bundled Chromium`);
          return chromium.launch(options);
        })
        : chromium.launch(options);
      this.browserPromise = launch.then(b => {
        b.on('disconnected', () => { this.browserPromise = null; });
        return b;
      }, err => { this.browserPromise = null; throw err; });
    }
    return this.browserPromise;
  }

  async userAgent(browser) {
    // A regular desktop Chrome UA: some players refuse "HeadlessChrome".
    const major = (browser.version().match(/^(\d+)/) || [])[1] || '140';
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }

  async close() {
    if (this.browserPromise) {
      const b = await this.browserPromise.catch(() => null);
      this.browserPromise = null;
      await b?.close().catch(() => {});
    }
  }

  // login: the station's saved sign-in, for a station that streams only to signed-in accounts
  // ({ username, password, session } plus callbacks that store the outcome; see app.js). A saved
  // session is tried first; when the page then has no stream, the session may have expired, so
  // the resolver signs in again once.
  async resolve(station, login = null) {
    if (station.streamUrl) return this.resolveManual(station);
    try {
      return await this.resolvePage(station, login);
    } catch (e) {
      // Only a page with no stream at all suggests the session expired; a bot check, DRM or a
      // failed sign-in wouldn't get better by signing in again.
      if (!login?.session || !(e instanceof ResolveError) || e.details?.reason !== 'no-stream') throw e;
      // Too soon to sign in again (or a failed sign-in waiting): keep the session, and report the
      // page as it was, so a station that is just off the air still plays its slate.
      // A session signed in recently is probably fine and the station just off the air.
      // Sign in again when the page asks for it, when the session is old, or when Test now asks;
      // otherwise the station is probably just off the air. Never sooner than mayAttempt allows.
      if ((!e.details.signedOut && login.sessionFresh?.() && !login.retrying?.()) || login.mayAttempt?.()) throw e;
      this.log.info?.(`[${station.id}] no stream with the saved session; signing in again`);
      await login.forgetSession();
      return this.resolvePage(station, { ...login, session: null, mayAttempt: () => null });
    }
  }

  async resolvePage(station, login) {
    if (!this.scraperSource) this.scraperSource = await readFile(this.scraperPath, 'utf8');
    const started = Date.now();
    const browser = await this.browser();
    const ua = await this.userAgent(browser);
    const context = await browser.newContext({
      userAgent: ua,
      locale: 'en-US',
      ...(this.timezoneId ? { timezoneId: this.timezoneId } : {}),
      viewport: { width: 1280, height: 720 },
      ...(login?.session ? { storageState: login.session } : {}),
    });
    const found = [];
    const embeds = [];
    // Keeps the session's renewed cookies once a stream was found with it.
    const finish = async result => {
      if (login) await context.storageState().then(state => login.saveSession(state)).catch(() => {});
      return result;
    };
    try {
      if (login && !login.session) await this.signIn(context, station, login);
      await context.addInitScript({ content: 'Object.defineProperty(navigator, "webdriver", { get: () => undefined });' });
      // Runs in every frame, cross-origin player iframes included, before the page's scripts.
      await context.addInitScript({ content: this.scraperSource });

      // The player's ad-insertion stream request goes to the DAI host that DNS ad blockers leave alone.
      await context.route(DAI_BLOCKED_HOST_RE, route => route.continue({ url: unblockedStreamUrl(route.request().url()) }));

      context.on('response', async res => {
        try {
          const url = unblockedStreamUrl(res.url());
          const type = manifestTypeOf(url, res.headers()['content-type'] || '');
          if (!type || isAd(url)) return;
          found.push({ url, type, sources: ['network'], headers: pickHeaders(await res.request().allHeaders()) });
        } catch { /* page closed */ }
      });

      const page = await context.newPage();
      const response = await page.goto(station.url, { waitUntil: 'domcontentloaded', timeout: this.pageTimeoutMs });

      // Wait for the player to request a manifest; nudge it with a play click if it doesn't.
      const deadline = Date.now() + this.waitMs;
      let clickedAt = 0;
      let firstSeen = 0;
      while (Date.now() < deadline) {
        await page.waitForTimeout(1000);
        if (found.length && !firstSeen) firstSeen = Date.now();
        if (firstSeen && Date.now() - firstSeen > 3000) break; // give master/variant requests a moment
        if (!found.length && !clickedAt && Date.now() - started > 7000) {
          clickedAt = Date.now();
          await this.pressPlay(page);
        }
      }

      for (const frame of page.frames()) {
        let items = [];
        try {
          items = await frame.evaluate(() => (window.MediaScraper
            ? window.MediaScraper.scan({ quiet: true, probe: false }).then(window.MediaScraper.toJSON)
            : []));
        } catch { continue; }
        for (const i of items) {
          // A guessed pairing (the page's only manifest) gets no pairing bonus: it could be an ad.
          if (i.manifest) found.push({ url: i.manifest, type: manifestTypeOf(i.manifest), sources: ['scan'], paired: !i.manifestGuessed });
          if ((i.type === 'hls' || i.type === 'dash') && i.url && /^https?:/.test(i.url)) {
            found.push({ url: i.url, type: i.type, sources: [i.foundBy?.includes('network') ? 'network' : 'scan'] });
          }
          if (i.kind === 'embed' && i.url) embeds.push({ provider: i.provider, url: i.url, id: i.id });
        }
      }

      const cookies = await context.cookies();
      const candidates = mergeCandidates(found.map(c => ({ ...c, url: unblockedStreamUrl(c.url) })).filter(c => !isAd(c.url))).slice(0, 30);
      // A few at a time: one by one, unreachable candidates (10 s timeout each) add up to minutes.
      let next = 0;
      const probeNext = async () => {
        while (next < candidates.length) {
          const c = candidates[next++];
          const headers = { 'user-agent': ua, referer: station.url, ...(c.headers || {}) };
          const cookie = cookieHeader(cookies, c.url);
          if (cookie && !headers.cookie) headers.cookie = cookie;
          c.headers = headers;
          c.probe = await probeManifest(c.url, headers, { maxHeight: this.maxHeight });
        }
      };
      await Promise.all(Array.from({ length: 4 }, probeNext));

      const best = pickBest(candidates);
      if (best) {
        const url = best.probe.finalUrl || best.url;
        return finish({
          url,
          type: best.type || (best.probe.dash ? 'dash' : 'hls'),
          headers: best.headers,
          via: 'page',
          expiresAt: expiryFromUrl(url, Date.now()),
          resolvedAt: Date.now(),
          tookMs: Date.now() - started,
        });
      }

      for (const e of embeds) {
        if (!this.ytDlp || !EMBED_PROVIDERS.test(e.provider || '')) continue;
        const viaYtDlp = await this.fromYtDlp(e.url).catch(() => null);
        if (viaYtDlp) return finish({ ...viaYtDlp, via: `yt-dlp (${e.provider})`, resolvedAt: Date.now(), tookMs: Date.now() - started });
      }

      const drmOnly = candidates.length > 0 && candidates.some(c => c.probe?.drm) && !candidates.some(c => c.probe?.ok);
      const botCheck = !candidates.length && await this.showsBotCheck(page, response);
      // With a saved session: is the page asking to sign in (signed out), or just not streaming?
      const signedOut = !!login?.session && !drmOnly && !botCheck && await asksToSignIn(page);
      const message = drmOnly ? 'The station\'s stream is DRM-protected; Jellyfin can\'t play it'
        : botCheck ? 'The station\'s site shows a bot check instead of the page; the sidecar doesn\'t get around bot checks'
          : 'No live stream found on the page';
      throw new ResolveError(message, {
        reason: drmOnly ? 'drm' : botCheck ? 'bot-check' : 'no-stream',
        signedOut,
        candidates: candidates.map(c => ({ url: c.url, sources: c.sources, paired: !!c.paired, probe: c.probe })),
        embeds,
        tookMs: Date.now() - started,
      });
    } finally {
      await context.close().catch(() => {});
    }
  }

  // A station with a manual stream URL: use it directly when it's a live manifest, otherwise let
  // yt-dlp resolve it (a page it has an extractor for). No browser involved.
  async resolveManual(station) {
    const started = Date.now();
    const headers = {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
      referer: station.url,
    };
    const probe = await probeManifest(station.streamUrl, headers, { maxHeight: this.maxHeight });
    if (probe.ok && probe.live) {
      const url = probe.finalUrl || station.streamUrl;
      return { url, type: probe.dash ? 'dash' : 'hls', headers, via: 'manual URL', expiresAt: expiryFromUrl(url, Date.now()), resolvedAt: Date.now(), tookMs: Date.now() - started };
    }
    if (this.ytDlp) {
      const viaYtDlp = await this.fromYtDlp(station.streamUrl).catch(() => null);
      if (viaYtDlp) return { ...viaYtDlp, via: 'manual URL (yt-dlp)', resolvedAt: Date.now(), tookMs: Date.now() - started };
    }
    throw new ResolveError(`Manual stream URL is not a live stream: ${probe.ok ? 'not live' : probe.error}`, { probe, tookMs: Date.now() - started });
  }

  // Signs in with the station's saved email and password through the site's own sign-in form,
  // the way a person would: the form on signInUrl (else the station page), opened with its "Log
  // in" / "Sign in" link when it isn't showing, email (then "next" on two-step forms), password,
  // Enter. A CAPTCHA ends it: the sidecar doesn't solve them.
  async signIn(context, station, login) {
    try {
      return await this.signInSteps(context, station, login);
    } catch (e) {
      throw scrubbed(e, 'Sign-in', { signIn: true }, login);
    }
  }

  async signInSteps(context, station, login) {
    const url = station.signInUrl || station.url;
    const waiting = login.mayAttempt?.();
    if (waiting) throw new ResolveError(`Sign-in: ${waiting}`, { signIn: true, url });
    const fail = async message => {
      await login.failed(message).catch(() => {});
      throw new ResolveError(`Sign-in: ${message}`, { signIn: true, url });
    };
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.pageTimeoutMs });
      await page.waitForTimeout(2500);
      let form = await signInForm(page);
      if (!form.user && !form.password && await clickSignInLink(page)) {
        await page.waitForTimeout(3000);
        form = await signInForm(page);
      }
      if (await showsCaptcha(page)) return await fail('the site asks for a CAPTCHA, which the sidecar doesn\'t solve');
      if (!form.user && !form.password) return await fail(`no sign-in form found at ${url}`);
      if (form.user && !(await typeInto(form.user, login.username))) return await fail('couldn\'t type into the site\'s email field');
      if (!form.password) {
        await form.user.press('Enter', { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(3000);
        form = await signInForm(page);
        if (!form.password) return await fail(await showsCaptcha(page) ? 'the site asks for a CAPTCHA, which the sidecar doesn\'t solve' : 'the sign-in form has no password field after the email');
      }
      if (!(await typeInto(form.password, login.password))) return await fail('couldn\'t type into the site\'s password field');
      await form.password.press('Enter', { timeout: 5000 }).catch(() => {});
      for (let waited = 0; waited < 20_000; waited += 1000) {
        await page.waitForTimeout(1000);
        if (await showsCaptcha(page)) return await fail('the site asks for a CAPTCHA, which the sidecar doesn\'t solve');
        if (!(await signInForm(page)).password) {
          await page.waitForTimeout(1500); // let the site store its session, or show its next step
          if (await asksForCode(page)) return await fail('the site asks for a code it sent you (an emailed code or two-step sign-in), which the sidecar can\'t enter');
          await login.signedIn(await context.storageState());
          this.log.info?.(`[${station.id}] signed in`);
          return;
        }
      }
      return await fail('the site didn\'t accept the email and password (the sign-in form is still showing)');
    } finally {
      await page.close().catch(() => {});
    }
  }

  // Creates an account on the station's site with the email and password the person chose, through
  // the site's own sign-up form, when it asks for nothing else: email, password (and a repeat of
  // it) and, if acceptTerms, its terms box. It stops at a CAPTCHA or any other required field; an
  // email to confirm is left to the person. Returns { confirmEmail, session }.
  async signUp(station, account) {
    try {
      return await this.signUpSteps(station, account);
    } catch (e) {
      throw scrubbed(e, 'Sign-up', { signUp: true }, account);
    }
  }

  async signUpSteps(station, { username, password, acceptTerms = false }) {
    const url = station.signUpUrl;
    const fail = message => { throw new ResolveError(`Sign-up: ${message}`, { signUp: true, url }); };
    if (!url) fail('the station has no sign-up page URL');
    const browser = await this.browser();
    const context = await browser.newContext({ userAgent: await this.userAgent(browser), locale: 'en-US', viewport: { width: 1280, height: 720 } });
    try {
      const page = await context.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.pageTimeoutMs });
      await page.waitForTimeout(2500);
      if (!(await signInForm(page)).password && await clickControl(page, SIGN_UP_NAMES)) await page.waitForTimeout(3000);
      if (await showsCaptcha(page)) fail('the sign-up form has a CAPTCHA, which the sidecar doesn\'t solve; create the account on the site yourself');
      const form = await signInForm(page);
      if (!form.password || !form.user) fail(`no sign-up form with an email and password at ${url}`);
      const frame = form.frame;
      if (await looksLikeSignIn(frame)) fail(`${url} shows a sign-in form, not a sign-up form`);

      const extra = await otherRequiredFields(frame);
      if (extra.length) fail(`the form asks for more than an email and password (${extra.join(', ')}); create the account on the site yourself`);
      const boxes = await frame.locator('input[type="checkbox"]').filter({ visible: true }).all();
      for (const box of boxes) {
        if (await box.isChecked()) continue;
        const label = await fieldLabel(box);
        const required = await box.evaluate(el => el.required || el.getAttribute('aria-required') === 'true');
        if (TERMS_LABEL.test(label) && !NOT_TERMS_LABEL.test(label)) {
          if (!acceptTerms) fail('the site asks you to accept its terms; tick "I accept the site\'s terms" first');
          await box.check({ force: true });
        } else if (required) {
          fail(`the form asks you to tick "${label.slice(0, 80)}"; create the account on the site yourself`);
        } // optional boxes (newsletters) stay unticked
      }

      if (!(await typeInto(form.user, username))) fail('couldn\'t type into the site\'s email field');
      const passwords = await frame.locator('input[type="password"]').filter({ visible: true }).all();
      for (const p of passwords) if (!(await typeInto(p, password))) fail('couldn\'t type into the site\'s password field');
      await passwords[passwords.length - 1].press('Enter', { timeout: 5000 }).catch(() => {});

      for (let waited = 0; waited < 20_000; waited += 1000) {
        await page.waitForTimeout(1000);
        if (await showsCaptcha(page)) fail('the site asked for a CAPTCHA after the form was sent; create the account on the site yourself');
        if (!(await signInForm(page)).password) {
          await page.waitForTimeout(1500);
          const text = await page.evaluate(() => document.body?.innerText.slice(0, 3000) ?? '').catch(() => '');
          this.log.info?.(`[${station.id}] account created`);
          return { confirmEmail: CONFIRM_EMAIL.test(text), session: await context.storageState() };
        }
      }
      const problem = await page.locator('[role="alert"], [class*="error" i]').filter({ visible: true }).first().innerText({ timeout: 1000 }).catch(() => '');
      return fail(problem ? `the site said: ${problem.replace(/\s+/g, ' ').trim().slice(0, 160)}` : 'the site didn\'t accept the sign-up (the form is still showing)');
    } finally {
      await context.close().catch(() => {});
    }
  }

  // Only names the failure: a page answered with a challenge ("press and hold", a CAPTCHA) rather
  // than its content.
  async showsBotCheck(page, response) {
    let text = '';
    try { text = await page.evaluate(() => `${document.title} ${document.body?.innerText.slice(0, 2000) ?? ''}`); } catch { /* closed */ }
    return isBotCheck(response?.status(), text);
  }

  async pressPlay(page) {
    for (const frame of page.frames()) {
      for (const sel of PLAY_SELECTORS) {
        try {
          const el = await frame.$(sel);
          if (el && await el.isVisible()) { await el.click({ timeout: 2000 }); return true; }
        } catch { /* detached, covered, cross-origin */ }
      }
      try {
        await frame.evaluate(() => {
          for (const v of document.querySelectorAll('video')) { v.muted = true; v.play().catch(() => {}); }
        });
      } catch { /* ignore */ }
    }
    return false;
  }

  // yt-dlp prints the media URL; for YouTube live that's a muxed HLS playlist. Embed URLs come
  // from the scanned page, which can replace window.MediaScraper and return anything: only an
  // http(s) URL is accepted, and `--` ends option parsing so it can't be read as an option.
  async fromYtDlp(url) {
    if (!/^https?:\/\//i.test(String(url))) return null;
    const { stdout } = await run(this.ytDlp, [
      '-g', '--no-playlist', '--no-warnings',
      '-f', `b[protocol^=m3u8][height<=${this.maxHeight}]/b[protocol^=m3u8]/b`,
      '--', url,
    ], { timeout: 60_000 });
    const manifest = stdout.split(/\r?\n/).find(l => /^https?:/.test(l));
    if (!manifest) return null;
    const headers = {};
    const probe = await probeManifest(manifest, headers, { maxHeight: this.maxHeight });
    if (!probe.ok || probe.live !== true) return null;
    return { url: probe.finalUrl || manifest, type: 'hls', headers, expiresAt: expiryFromUrl(manifest, Date.now()) };
  }
}
