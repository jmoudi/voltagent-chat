// ==UserScript==
// @name         PixAI Performance Guard
// @namespace    pixai-perf-guard
// @version      1.0.0
// @description  Keeps pixai.art from eating CPU: background tabs stay unloaded until opened, hidden tabs get their timers and media frozen, trackers/ads/session-replay and the service worker are blocked.
// @match        https://pixai.art/*
// @match        https://www.pixai.art/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @sandbox      raw
// @noframes
// ==/UserScript==

/*
 * What it does (each part can be switched off in CONFIG):
 *
 *  1. Lazy background tabs: a pixai tab opened in the background (middle-click,
 *     Ctrl+click) is stopped before any page script runs and shows a small
 *     placeholder. It loads the moment you switch to it.
 *  2. Freeze hidden tabs: a tab you switched away from gets its setTimeout /
 *     setInterval callbacks held (polling, ad refresh, tickers) and its media
 *     paused. On return, held timeouts run once and each interval ticks once.
 *  3. Third-party blocking: analytics, tag managers, ads, session replay and
 *     fingerprinting scripts never execute.
 *  4. Service worker: registration is refused and an existing one removed.
 *
 * Diagnostics: run `pixaiPerf.debug()` in the devtools console on a pixai tab,
 * reload, use the site for a minute, then run `pixaiPerf.report()`. It lists the
 * heaviest timer callbacks and long-frame scripts by source, workers created,
 * WebSocket traffic, and what was blocked.
 *
 * Needs Tampermonkey or Violentmonkey (the script must run in the page context
 * at document-start; Greasemonkey 4 can't do that).
 */

(() => {
  'use strict';

  const CONFIG = {
    deferBackgroundTabs: true,

    freezeHiddenTabs: true,
    freezeDelayMs: 2000, // grace period after switching away before freezing
    // Pages where background work is wanted (generation progress etc.)
    freezeExcludePaths: [/\/generator\b/],
    // Also hold WebSocket events while frozen (replayed in order on return)
    freezeWebSockets: false,

    // Lower bound for setInterval periods in visible tabs; 0 leaves them alone
    minIntervalMs: 0,

    blockThirdParty: true,
    // Extra RegExps tested against full script URLs, first-party included
    extraBlock: [],

    blockServiceWorker: true,

    // RegExps tested against Worker / SharedWorker script URLs
    blockWorkers: [],
  };

  const W = window;
  const TAG = '[pixai-perf]';
  const nSetTimeout = W.setTimeout;
  const nClearTimeout = W.clearTimeout;
  const nSetInterval = W.setInterval;
  const nClearInterval = W.clearInterval;

  let DEBUG = false;
  try { DEBUG = localStorage.getItem('pixaiPerf.debug') === '1'; } catch {}
  const log = (...a) => (DEBUG ? console.info : console.debug)(TAG, ...a);

  // ---------------------------------------------------------------- 1. lazy tabs

  const RELOAD_KEY = 'pixaiPerf.wokeAt';

  function describePage() {
    const u = new URL(location.href);
    const q = u.searchParams.get('q');
    const art = u.pathname.match(/\/artwork\/(\d+)/);
    if (q && q.trim()) return `${q.trim()} – PixAI search`;
    if (art) return `Artwork ${art[1]} – PixAI`;
    return 'PixAI' + (u.pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '') || '/');
  }

  function paintPlaceholder() {
    const html = document.documentElement || document.appendChild(document.createElement('html'));
    const head = document.createElement('head');
    const icon = document.createElement('link');
    icon.rel = 'icon';
    icon.href = '/favicon.ico';
    head.append(document.createElement('title'), icon);
    const body = document.createElement('body');
    body.style.cssText = 'margin:0;height:100vh;display:grid;place-items:center;' +
      'background:#16161d;color:#9a9aae;font:14px system-ui,sans-serif';
    body.textContent = '⏸ Paused in background. Loads when you open this tab.';
    html.replaceChildren(head, body);
    document.title = '⏸ ' + describePage();
  }

  function deferIfBackground() {
    if (!CONFIG.deferBackgroundTabs || document.visibilityState !== 'hidden' || document.prerendering) {
      return false;
    }
    try {
      // We just woke this tab with a reload; never stop it twice in a row.
      if (Date.now() - Number(sessionStorage.getItem(RELOAD_KEY)) < 10000) return false;
    } catch {}

    W.stop();
    paintPlaceholder();
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', wake);
      try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch {}
      location.reload();
    };
    document.addEventListener('visibilitychange', wake);
    nSetTimeout.call(W, wake, 0);
    return true;
  }

  if (deferIfBackground()) return;

  // ------------------------------------------------------------- diagnostics

  const timerStats = new Map(); // source -> { calls, total, max }
  const frameStats = new Map();
  const socketStats = new Map(); // url -> { messages, bytes }
  const workers = [];
  const blocked = [];

  function record(map, key, ms) {
    const s = map.get(key);
    if (s) {
      s.calls++;
      s.total += ms;
      if (ms > s.max) s.max = ms;
    } else {
      map.set(key, { calls: 1, total: ms, max: ms });
    }
  }

  // Two nearest frames outside this script, e.g. "fn (https://…/chunk.js:1:2345)"
  function __pp_callerKey() {
    const frames = (new Error().stack || '').split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('Error') && !l.includes('__pp_'));
    return frames.slice(0, 2).map(l => l.replace(/^at /, '')).join(' ← ') || '?';
  }

  if (DEBUG) {
    try {
      // Chrome 123+: attributes long frames (>50 ms) to the script and entry point
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          for (const s of entry.scripts || []) {
            const fn = s.sourceFunctionName ? ` ${s.sourceFunctionName}` : '';
            record(frameStats, `${s.invoker || s.invokerType} | ${s.sourceURL || '?'}${fn}`, s.duration);
          }
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
    } catch {}
  }

  // ------------------------------------------------------- 3. third-party block

  const THIRD_PARTY = new RegExp([
    // analytics & tag managers
    'googletagmanager\\.com', 'google-analytics\\.com', 'analytics\\.google\\.com',
    'analytics\\.ahrefs\\.com', 'static\\.cloudflareinsights\\.com', 'cdn\\.segment\\.(com|io)',
    'mxpnl\\.com', 'mixpanel\\.com', 'amplitude\\.com', 'mc\\.yandex\\.', 'hm\\.baidu\\.com',
    // session replay & heatmaps
    'clarity\\.ms', 'hotjar\\.(com|io)', 'fullstory\\.com', 'logrocket\\.(com|io)',
    'mouseflow\\.com', 'smartlook\\.', 'posthog\\.com', 'sentry-cdn\\.com',
    'datadoghq-browser-agent\\.com', 'newrelic\\.com', 'nr-data\\.net',
    // ad tech & marketing pixels
    'doubleclick\\.net', 'googlesyndication\\.com', 'googleadservices\\.com', 'adservice\\.google\\.',
    'fundingchoicesmessages\\.google\\.com', 'connect\\.facebook\\.net', 'analytics\\.tiktok\\.com',
    'ads-twitter\\.com', 'redditstatic\\.com/ads', 'bat\\.bing\\.com', 'snap\\.licdn\\.com',
    'sc-static\\.net', 'amazon-adsystem\\.com', 'adnxs\\.com', 'criteo\\.(com|net)',
    'pubmatic\\.com', 'rubiconproject\\.com', 'openx\\.net', 'casalemedia\\.com', 'taboola\\.com',
    'outbrain\\.com', 'adsafeprotected\\.com', 'moatads\\.com', 'doubleverify\\.com',
    'nitropay\\.com', 'ezoic\\.(com|net)', 'mediavine\\.com', 'adthrive\\.com', 'venatus',
    'playwire\\.com', 'fuseplatform\\.net', 'pubfig', 'a-mo\\.net', 'adsrvr\\.org',
    // fingerprinting
    'fpjs\\.io', 'fpnpmcdn\\.net', 'openfpcdn\\.io',
  ].join('|'), 'i');

  function isBlockedUrl(raw) {
    let u;
    try { u = new URL(String(raw), location.href); } catch { return false; }
    if (CONFIG.extraBlock.some(re => re.test(u.href))) return true;
    return CONFIG.blockThirdParty && u.hostname !== location.hostname &&
      THIRD_PARTY.test(u.hostname + u.pathname);
  }

  if (CONFIG.blockThirdParty || CONFIG.extraBlock.length) {
    const defused = new WeakSet();
    const nSetAttribute = Element.prototype.setAttribute;

    // A script with an unknown type is neither fetched nor run. Fire `error`
    // like an ad blocker would, so loaders waiting on it don't hang.
    const defuse = (script, url) => {
      if (defused.has(script)) return;
      defused.add(script);
      nSetAttribute.call(script, 'type', 'javascript/blocked');
      blocked.push(String(url));
      log('blocked script', String(url));
      nSetTimeout.call(W, () => script.dispatchEvent(new Event('error')), 0);
    };

    const proto = HTMLScriptElement.prototype;
    const src = Object.getOwnPropertyDescriptor(proto, 'src');
    const type = Object.getOwnPropertyDescriptor(proto, 'type');
    Object.defineProperty(proto, 'src', {
      ...src,
      set(v) {
        if (isBlockedUrl(v)) defuse(this, v);
        src.set.call(this, v);
      },
    });
    Object.defineProperty(proto, 'type', {
      ...type,
      set(v) {
        if (!defused.has(this)) type.set.call(this, v);
      },
    });
    Element.prototype.setAttribute = function __pp_setAttribute(name, value) {
      if (this instanceof HTMLScriptElement) {
        const n = String(name).toLowerCase();
        if (n === 'type' && defused.has(this)) return;
        if (n === 'src' && isBlockedUrl(value)) defuse(this, value);
      }
      return nSetAttribute.call(this, name, value);
    };

    // Scripts in the HTML itself: the parser runs a microtask checkpoint before
    // executing each one, so this observer gets to them first.
    const parserWatch = new MutationObserver(records => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n instanceof HTMLScriptElement && n.src && isBlockedUrl(n.src)) defuse(n, n.src);
        }
      }
    });
    parserWatch.observe(document, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => parserWatch.disconnect(), { once: true });

    // Firefox-only hook, harmless elsewhere
    document.addEventListener('beforescriptexecute', e => {
      if (defused.has(e.target)) e.preventDefault();
    }, true);
  }

  // ----------------------------------------------------------- 4. service worker

  if (CONFIG.blockServiceWorker && 'ServiceWorkerContainer' in W) {
    ServiceWorkerContainer.prototype.register = function __pp_register(url) {
      log('refused service worker', String(url));
      return Promise.reject(new DOMException('Service worker blocked by userscript', 'SecurityError'));
    };
    W.addEventListener('load', () => {
      navigator.serviceWorker.getRegistrations().then(regs => {
        for (const r of regs) r.unregister().then(ok => ok && log('removed service worker', r.scope));
      }).catch(() => {});
    }, { once: true });
  }

  // ------------------------------------------------------------------ workers

  if (DEBUG || CONFIG.blockWorkers.length) {
    for (const name of ['Worker', 'SharedWorker']) {
      const Native = W[name];
      if (!Native) continue;
      W[name] = {
        [name]: class extends Native {
          constructor(url, options) {
            const s = String(url);
            if (CONFIG.blockWorkers.some(re => re.test(s))) {
              log(`blocked ${name}`, s);
              throw new DOMException(`${name} blocked by userscript`, 'SecurityError');
            }
            super(url, options);
            workers.push({ type: name, url: s, atMs: Math.round(performance.now()) });
            log(`${name} started`, s);
          }
        },
      }[name];
    }
  }

  // ------------------------------------------------------------ 2. freeze

  let frozen = false;
  const held = new Map(); // timer id -> run(); intervals coalesce to one entry
  const heldEvents = []; // [socket, event] in arrival order
  const replayed = new WeakSet();
  const pausedMedia = new Set();

  const isExcluded = () => CONFIG.freezeExcludePaths.some(re => re.test(location.pathname));

  function freeze() {
    if (frozen || !document.hidden || isExcluded()) return;
    frozen = true;
    for (const m of document.querySelectorAll('video, audio')) {
      if (!m.paused) {
        m.pause();
        pausedMedia.add(m);
      }
    }
    log('frozen');
  }

  function thaw() {
    if (!frozen) return;
    frozen = false;
    log(`thawed, running ${held.size} held timers, ${heldEvents.length} socket events`);
    for (const m of pausedMedia) m.play().catch(() => {});
    pausedMedia.clear();
    for (const [socket, event] of heldEvents.splice(0)) socket.dispatchEvent(event);
    // Live iteration so a callback clearing a later held timer still cancels it
    for (const [id, run] of held) {
      held.delete(id);
      try {
        run();
      } catch (e) {
        if (W.reportError) W.reportError(e);
        else console.error(e);
      }
    }
  }

  const patchTimers = CONFIG.freezeHiddenTabs || CONFIG.minIntervalMs > 0 || DEBUG;

  function __pp_wrap(kind, handler, args) {
    if (!DEBUG) return () => handler.apply(W, args);
    const key = `${kind}: ${__pp_callerKey()}`;
    return () => {
      const t0 = performance.now();
      try {
        handler.apply(W, args);
      } finally {
        record(timerStats, key, performance.now() - t0);
      }
    };
  }

  if (patchTimers) {
    W.setTimeout = function __pp_setTimeout(handler, delay, ...args) {
      if (typeof handler !== 'function') return nSetTimeout.call(W, handler, delay, ...args);
      const run = __pp_wrap('setTimeout', handler, args);
      const id = nSetTimeout.call(W, () => (frozen ? held.set(id, run) : run()), delay);
      return id;
    };
    W.setInterval = function __pp_setInterval(handler, delay, ...args) {
      if (typeof handler !== 'function') return nSetInterval.call(W, handler, delay, ...args);
      const run = __pp_wrap('setInterval', handler, args);
      if (CONFIG.minIntervalMs > 0) delay = Math.max(Number(delay) || 0, CONFIG.minIntervalMs);
      const id = nSetInterval.call(W, () => (frozen ? held.set(id, run) : run()), delay);
      return id;
    };
    // Browsers share one id pool between the two, so each must clear both kinds
    W.clearTimeout = function __pp_clearTimeout(id) {
      held.delete(id);
      return nClearTimeout.call(W, id);
    };
    W.clearInterval = function __pp_clearInterval(id) {
      held.delete(id);
      return nClearInterval.call(W, id);
    };
  }

  if ((CONFIG.freezeHiddenTabs && CONFIG.freezeWebSockets) || DEBUG) {
    const NativeWS = W.WebSocket;
    const clone = e => {
      const c = e.type === 'message'
        ? new MessageEvent('message', { data: e.data, origin: e.origin, lastEventId: e.lastEventId })
        : e.type === 'close'
          ? new CloseEvent('close', { code: e.code, reason: e.reason, wasClean: e.wasClean })
          : new Event(e.type);
      replayed.add(c);
      return c;
    };
    W.WebSocket = class WebSocket extends NativeWS {
      constructor(...a) {
        super(...a);
        const url = String(a[0]);
        // Registered first, so it runs before the page's own listeners
        const gate = e => {
          if (replayed.has(e)) return;
          if (DEBUG && e.type === 'message') {
            const s = socketStats.get(url) || { messages: 0, bytes: 0 };
            s.messages++;
            s.bytes += typeof e.data === 'string' ? e.data.length : (e.data.byteLength || e.data.size || 0);
            socketStats.set(url, s);
          }
          if (frozen && CONFIG.freezeWebSockets) {
            e.stopImmediatePropagation();
            heldEvents.push([this, clone(e)]);
          }
        };
        for (const t of ['open', 'message', 'error', 'close']) this.addEventListener(t, gate);
      }
    };
  }

  if (CONFIG.freezeHiddenTabs) {
    let pending = 0;
    const onVisibility = () => {
      nClearTimeout.call(W, pending);
      if (document.hidden) pending = nSetTimeout.call(W, freeze, CONFIG.freezeDelayMs);
      else thaw();
    };
    document.addEventListener('visibilitychange', onVisibility, true);
    if (document.hidden) onVisibility();
  }

  // ------------------------------------------------------------- console API

  const table = (map, n = 20) => [...map]
    .map(([source, s]) => ({ source, calls: s.calls, totalMs: Math.round(s.total), maxMs: Math.round(s.max) }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, n);

  W.pixaiPerf = {
    config: CONFIG,
    get frozen() { return frozen; },
    blocked,
    workers,
    debug(on = true) {
      try {
        if (on) localStorage.setItem('pixaiPerf.debug', '1');
        else localStorage.removeItem('pixaiPerf.debug');
      } catch {}
      console.info(TAG, `debug ${on ? 'on' : 'off'}; reload the tab to apply`);
    },
    // Prints the tables and returns the same data, so
    // `copy(JSON.stringify(pixaiPerf.report(), null, 1))` puts it on the clipboard.
    report() {
      if (!DEBUG) {
        console.info(TAG, 'debug is off: run pixaiPerf.debug(), reload, use the page, then report again');
      }
      const data = {
        page: location.pathname + location.search,
        uptimeS: Math.round(performance.now() / 1000),
        frozen,
        blocked,
        workers,
        timers: table(timerStats),
        longFrames: table(frameStats),
        sockets: [...socketStats].map(([url, s]) => ({ url, ...s })),
      };
      console.info(TAG, `uptime ${data.uptimeS} s, frozen: ${frozen}`);
      console.info(TAG, 'blocked scripts', blocked);
      console.info(TAG, 'workers started', workers);
      console.info(TAG, 'timer callbacks by source (heaviest first)');
      console.table(data.timers);
      console.info(TAG, 'scripts inside long frames >50 ms (Chrome only)');
      console.table(data.longFrames);
      console.info(TAG, 'WebSocket traffic');
      console.table(data.sockets);
      return data;
    },
  };

  log('active', DEBUG ? CONFIG : '');
})();
