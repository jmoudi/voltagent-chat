// ==UserScript==
// @name         PixAI Performance Guard
// @namespace    pixai-perf-guard
// @version      2.0.0
// @description  Keeps pixai.art from eating CPU and memory: lazy background tabs, frozen hidden tabs, optional unloading, tracker/ad blocking, frame-rate cap, lite visuals, and a collapsible control panel with live diagnostics.
// @match        https://pixai.art/*
// @match        https://www.pixai.art/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @sandbox      raw
// @noframes
// ==/UserScript==

/*
 * Control panel: the small ⚡ button in the bottom-left corner, or Alt+Shift+P.
 * Settings are saved per browser and sync live across open pixai tabs.
 *
 * Background tabs
 *   Lazy-load: a tab opened in the background (middle-click, Ctrl+click) is
 *     stopped before any page script runs and loads when you switch to it.
 *   Freeze: a tab you switched away from has its setTimeout / setInterval
 *     callbacks held (polling, ad refresh, tickers) and media paused. On return
 *     held timeouts run once and each interval ticks once.
 *   Unload (off by default): after N minutes hidden the tab drops to a
 *     placeholder, freeing its memory; it reloads and restores scroll on return.
 * Blocking
 *   Analytics, tag managers, ads, session replay and fingerprinting scripts
 *   never execute; the service worker is refused; custom patterns can be added.
 * Visible tab
 *   Lite visuals (near-instant animations, no backdrop blur), an animation
 *   frame cap, and a minimum setInterval period.
 * Diagnostics
 *   Attributes timer, animation-frame and long-frame time to the scripts that
 *   spent it. "Copy report" puts the findings on the clipboard.
 *
 * Console: pixaiPerf.open(), pixaiPerf.report(), pixaiPerf.set(key, value).
 *
 * Needs Tampermonkey or Violentmonkey (must run in the page at document-start).
 */

(() => {
  'use strict';

  const VERSION = '2.0.0';
  const W = window;
  const TAG = '[pixai-guard]';

  // Untouched timer functions. Everything this script schedules goes through
  // these, so it keeps working while the page's own timers are frozen.
  const N = {
    setTimeout: W.setTimeout,
    clearTimeout: W.clearTimeout,
    setInterval: W.setInterval,
    clearInterval: W.clearInterval,
    raf: W.requestAnimationFrame,
    caf: W.cancelAnimationFrame,
  };
  const later = (fn, ms) => N.setTimeout.call(W, fn, ms);
  const every = (fn, ms) => N.setInterval.call(W, fn, ms);
  const stopTimer = id => N.clearTimeout.call(W, id); // ids are shared, clears either kind

  // ------------------------------------------------------------------ storage

  const NS = 'pixaiPerf.';

  function read(key, session) {
    try {
      return (session ? sessionStorage : localStorage).getItem(NS + key);
    } catch {
      return null;
    }
  }

  function write(key, value, session) {
    try {
      const area = session ? sessionStorage : localStorage;
      if (value == null) area.removeItem(NS + key);
      else area.setItem(NS + key, value);
    } catch {}
  }

  // ----------------------------------------------------------------- settings

  const DEFAULTS = {
    deferBackgroundTabs: true,
    freezeHiddenTabs: true,
    freezeDelaySec: 2,
    pauseMedia: true,
    markFrozenTitle: true,
    freezeWebSockets: false,
    exemptGenerator: true,
    unloadAfterMin: 0,
    blockThirdParty: true,
    blockServiceWorker: true,
    customBlock: '',
    liteVisuals: false,
    fpsCap: 0,
    minIntervalMs: 0,
    diagnostics: false,
    corner: 'bl',
    showLauncher: true,
  };

  const S = {};
  let customPatterns = [];

  function loadSettings() {
    let saved = {};
    try {
      saved = JSON.parse(read('settings')) || {};
    } catch {}
    for (const [k, def] of Object.entries(DEFAULTS)) {
      S[k] = typeof saved[k] === typeof def ? saved[k] : def;
    }
    customPatterns = S.customBlock.split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#'))
      .map(l => {
        try {
          return new RegExp(l, 'i');
        } catch {
          const s = l.toLowerCase();
          return { test: url => url.toLowerCase().includes(s) };
        }
      });
  }

  // Only differences from the defaults are stored, so new defaults reach old installs
  function saveSettings() {
    const diff = {};
    for (const [k, def] of Object.entries(DEFAULTS)) if (S[k] !== def) diff[k] = S[k];
    write('settings', Object.keys(diff).length ? JSON.stringify(diff) : null);
    loadSettings();
  }

  loadSettings();
  if (read('debug') === '1') { // v1 flag
    write('debug', null);
    S.diagnostics = true;
    saveSettings();
  }
  const loadedWith = { ...S };

  // -------------------------------------------------- lazy and unloaded tabs

  const WOKE = 'wokeAt';
  const SLEPT = 'slept';
  const MARK = '💤 ';

  function describePage() {
    const u = new URL(location.href);
    const q = u.searchParams.get('q');
    const art = u.pathname.match(/\/artwork\/(\d+)/);
    if (q && q.trim()) return `${q.trim()} – PixAI search`;
    if (art) return `Artwork ${art[1]} – PixAI`;
    return 'PixAI' + (u.pathname.replace(/^\/[a-z]{2}(?=\/|$)/, '') || '/');
  }

  function paintPlaceholder(slept) {
    const html = document.documentElement || document.appendChild(document.createElement('html'));
    const head = document.createElement('head');
    const icon = document.createElement('link');
    icon.rel = 'icon';
    icon.href = '/favicon.ico';
    head.append(document.createElement('title'), icon);
    const body = document.createElement('body');
    body.style.cssText = 'margin:0;height:100vh;display:grid;place-items:center;' +
      'background:#16161d;color:#9a9aae;font:14px system-ui,sans-serif';
    body.textContent = slept
      ? '💤 Unloaded to save memory. Reloads when you open this tab.'
      : '⏸ Paused in background. Loads when you open this tab.';
    html.replaceChildren(head, body);
    document.title = slept && slept.title ? MARK + slept.title : '⏸ ' + describePage();
  }

  function deferIfHidden() {
    if (document.visibilityState !== 'hidden' || document.prerendering) return false;
    let slept = null;
    try {
      slept = JSON.parse(read(SLEPT, true));
    } catch {}
    if (slept && slept.url !== location.href) slept = null;
    if (!slept) {
      if (!S.deferBackgroundTabs) return false;
      // Just woken by us: never stop the same tab twice in a row
      if (Date.now() - Number(read(WOKE, true)) < 10000) return false;
    }

    W.stop();
    paintPlaceholder(slept);
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', wake);
      write(WOKE, String(Date.now()), true);
      location.reload();
    };
    document.addEventListener('visibilitychange', wake);
    later(wake, 0);
    return true;
  }

  if (deferIfHidden()) return;

  // ------------------------------------------------------------------- stats

  const stats = {
    blocked: [], // { url, host, kind }
    workers: [], // { type, url }
    sockets: new Map(), // url -> { open, messages, bytes }
    sources: new Map(), // "kind: caller" -> { calls, total, max }
    frames: new Map(), // long-animation-frame script attribution
    recentFrames: [], // [startTime, duration], last 60 s
    loafSupported: false,
    freezes: 0,
    lastHeld: 0,
  };
  const pendingTimeouts = new Set();
  const liveIntervals = new Set();
  let ui = null; // control panel, created at DOMContentLoaded

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

  // Two nearest stack frames outside this script
  function __pp_callerKey() {
    const frames = (new Error().stack || '').split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('Error') && !l.includes('__pp_'));
    return frames.slice(0, 2).map(l => l.replace(/^at /, '')).join(' ← ') || '?';
  }

  const stripQuery = url => String(url).split(/[?#]/)[0];

  try {
    // Chrome 123+: frames over 50 ms, with the scripts that ran in them
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        stats.recentFrames.push([e.startTime, e.duration]);
        if (!S.diagnostics) continue;
        for (const s of e.scripts || []) {
          const fn = s.sourceFunctionName ? ` ${s.sourceFunctionName}` : '';
          record(stats.frames, `long frame: ${s.invoker || s.invokerType} | ${s.sourceURL || '?'}${fn}`, s.duration);
        }
      }
      const cutoff = performance.now() - 60000;
      while (stats.recentFrames.length && stats.recentFrames[0][0] < cutoff) stats.recentFrames.shift();
    }).observe({ type: 'long-animation-frame', buffered: true });
    stats.loafSupported = true;
  } catch {}

  // ------------------------------------------------------- third-party block

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
    try {
      u = new URL(String(raw), location.href);
    } catch {
      return false;
    }
    if (customPatterns.some(p => p.test(u.href))) return true;
    return S.blockThirdParty && u.hostname !== location.hostname &&
      THIRD_PARTY.test(u.hostname + u.pathname);
  }

  {
    const defused = new WeakSet();
    const nSetAttribute = Element.prototype.setAttribute;

    // A script with an unknown type is neither fetched nor run. `error` fires
    // like it would under an ad blocker, so loaders waiting on it don't hang.
    const defuse = (script, url) => {
      if (defused.has(script)) return;
      defused.add(script);
      nSetAttribute.call(script, 'type', 'javascript/blocked');
      let host = '?';
      try { host = new URL(String(url), location.href).hostname; } catch {}
      stats.blocked.push({ url: String(url), host, kind: 'script' });
      console.debug(TAG, 'blocked script', String(url));
      ui && ui.refresh();
      later(() => script.dispatchEvent(new Event('error')), 0);
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

  // ------------------------------------------------------------ service worker

  if ('ServiceWorkerContainer' in W) {
    const register = ServiceWorkerContainer.prototype.register;
    ServiceWorkerContainer.prototype.register = function __pp_register(url, options) {
      if (!S.blockServiceWorker) return register.call(this, url, options);
      console.debug(TAG, 'refused service worker', String(url));
      return Promise.reject(new DOMException('Service worker blocked by userscript', 'SecurityError'));
    };
    W.addEventListener('load', () => {
      if (!S.blockServiceWorker) return;
      navigator.serviceWorker.getRegistrations().then(regs => {
        for (const r of regs) r.unregister().then(ok => ok && console.debug(TAG, 'removed service worker', r.scope));
      }).catch(() => {});
    }, { once: true });
  }

  // ---------------------------------------------------------------- workers

  for (const name of ['Worker', 'SharedWorker']) {
    const Native = W[name];
    if (!Native) continue;
    W[name] = {
      [name]: class extends Native {
        constructor(url, options) {
          const s = String(url);
          if (customPatterns.some(p => p.test(s))) {
            let host = s;
            try { host = new URL(s, location.href).hostname || s; } catch {}
            stats.blocked.push({ url: s, host, kind: 'worker' });
            throw new DOMException(`${name} blocked by userscript`, 'SecurityError');
          }
          super(url, options);
          stats.workers.push({ type: name, url: stripQuery(s), atS: Math.round(performance.now() / 1000) });
        }
      },
    }[name];
  }

  // ------------------------------------------------------------- timers & rAF

  let frozen = false;
  const held = new Map(); // timer id -> run(); an interval holds at most one tick

  // With diagnostics on, times each call and books it to the scheduling caller
  function __pp_wrap(kind, handler) {
    if (!S.diagnostics) return handler;
    const key = `${kind}: ${__pp_callerKey()}`;
    return function (...a) {
      const t0 = performance.now();
      try {
        return handler.apply(this, a);
      } finally {
        record(stats.sources, key, performance.now() - t0);
      }
    };
  }

  W.setTimeout = function __pp_setTimeout(handler, delay, ...args) {
    if (typeof handler !== 'function') return N.setTimeout.call(W, handler, delay, ...args);
    const fn = __pp_wrap('timeout', handler);
    const run = () => fn.apply(W, args);
    const id = N.setTimeout.call(W, () => {
      if (frozen) return void held.set(id, run);
      pendingTimeouts.delete(id);
      run();
    }, delay);
    pendingTimeouts.add(id);
    return id;
  };

  W.setInterval = function __pp_setInterval(handler, delay, ...args) {
    if (typeof handler !== 'function') return N.setInterval.call(W, handler, delay, ...args);
    const fn = __pp_wrap('interval', handler);
    const run = () => fn.apply(W, args);
    if (S.minIntervalMs > 0) delay = Math.max(Number(delay) || 0, S.minIntervalMs);
    const id = N.setInterval.call(W, () => (frozen ? held.set(id, run) : run()), delay);
    liveIntervals.add(id);
    return id;
  };

  // Browsers share one id pool, so each clear function must handle both kinds
  W.clearTimeout = function __pp_clearTimeout(id) {
    held.delete(id);
    pendingTimeouts.delete(id);
    liveIntervals.delete(id);
    return N.clearTimeout.call(W, id);
  };
  W.clearInterval = function __pp_clearInterval(id) {
    held.delete(id);
    pendingTimeouts.delete(id);
    liveIntervals.delete(id);
    return N.clearInterval.call(W, id);
  };

  // Frame cap: a frame is either granted (every callback in it runs) or skipped
  // (its callbacks move to the next frame).
  let rafSeq = 0;
  let grantedTs = -1;
  let lastGrant = -Infinity;
  const rafNative = new Map(); // our id -> current native id

  function frameGranted(ts) {
    if (!S.fpsCap || ts === grantedTs) return true;
    if (ts - lastGrant < 1000 / S.fpsCap - 3) return false;
    lastGrant = grantedTs = ts;
    return true;
  }

  W.requestAnimationFrame = function __pp_requestAnimationFrame(callback) {
    if (typeof callback !== 'function') return N.raf.call(W, callback);
    const id = ++rafSeq;
    const fn = __pp_wrap('animation frame', callback);
    const tick = ts => {
      if (!frameGranted(ts)) return void rafNative.set(id, N.raf.call(W, tick));
      rafNative.delete(id);
      fn.call(W, ts);
    };
    rafNative.set(id, N.raf.call(W, tick));
    return id;
  };
  W.cancelAnimationFrame = function __pp_cancelAnimationFrame(id) {
    const n = rafNative.get(id);
    if (n === undefined) return;
    rafNative.delete(id);
    N.caf.call(W, n);
  };

  // ------------------------------------------------------------- WebSockets

  const heldEvents = []; // [socket, event] in arrival order
  const replayed = new WeakSet();

  if (W.WebSocket) {
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
        const url = stripQuery(a[0]);
        const s = stats.sockets.get(url) || { open: 0, messages: 0, bytes: 0 };
        stats.sockets.set(url, s);
        s.open++;
        // Registered first, so it runs before the page's own listeners
        const gate = e => {
          if (replayed.has(e)) return;
          if (e.type === 'close') s.open--;
          if (e.type === 'message') {
            s.messages++;
            s.bytes += typeof e.data === 'string' ? e.data.length : (e.data.byteLength || e.data.size || 0);
          }
          if (frozen && S.freezeWebSockets) {
            e.stopImmediatePropagation();
            heldEvents.push([this, clone(e)]);
          }
        };
        for (const t of ['open', 'message', 'error', 'close']) this.addEventListener(t, gate);
      }
    };
  }

  // ----------------------------------------------------------- freeze & unload

  const pausedMedia = new Set();
  const keepTabRunning = () => read('keepRunning', true) === '1';
  const isExempt = () => keepTabRunning() || (S.exemptGenerator && /\/generator\b/.test(location.pathname));

  function markTitle(on) {
    const t = document.title;
    if (on && !t.startsWith(MARK)) document.title = MARK + t;
    if (!on && t.startsWith(MARK)) document.title = t.slice(MARK.length);
  }

  function freeze() {
    if (frozen || !document.hidden || !S.freezeHiddenTabs || isExempt()) return;
    frozen = true;
    stats.freezes++;
    if (S.pauseMedia) {
      for (const m of document.querySelectorAll('video, audio')) {
        if (!m.paused) {
          m.pause();
          pausedMedia.add(m);
        }
      }
    }
    if (S.markFrozenTitle) markTitle(true);
  }

  function thaw() {
    if (!frozen) return;
    frozen = false;
    markTitle(false);
    for (const m of pausedMedia) m.play().catch(() => {});
    pausedMedia.clear();
    stats.lastHeld = held.size + heldEvents.length;
    for (const [socket, event] of heldEvents.splice(0)) socket.dispatchEvent(event);
    // Live iteration so a callback clearing a later held timer still cancels it
    for (const [id, run] of held) {
      held.delete(id);
      pendingTimeouts.delete(id);
      try {
        run();
      } catch (e) {
        if (W.reportError) W.reportError(e);
        else console.error(e);
      }
    }
  }

  function hasUnsavedText() {
    for (const t of document.querySelectorAll('textarea')) if (t.value.trim()) return true;
    for (const c of document.querySelectorAll('[contenteditable]:not([contenteditable="false"])')) {
      if (c.textContent.trim()) return true;
    }
    return false;
  }

  let unloading = false;
  function unload() {
    if (!document.hidden || !S.unloadAfterMin || isExempt() || hasUnsavedText()) return;
    write(SLEPT, JSON.stringify({
      url: location.href,
      y: Math.round(W.scrollY),
      title: document.title.replace(MARK, ''),
    }), true);
    unloading = true;
    location.reload();
  }
  // Ours is the first listener on window: keep "leave site?" prompts out of it
  W.addEventListener('beforeunload', e => {
    if (unloading) e.stopImmediatePropagation();
  });

  let freezeTimer = 0;
  let unloadTimer = 0;
  function scheduleHiddenWork() {
    stopTimer(freezeTimer);
    stopTimer(unloadTimer);
    if (!document.hidden) return thaw();
    if (S.freezeHiddenTabs) freezeTimer = later(freeze, S.freezeDelaySec * 1000);
    else thaw();
    if (S.unloadAfterMin > 0) unloadTimer = later(unload, S.unloadAfterMin * 60000);
  }
  document.addEventListener('visibilitychange', scheduleHiddenWork, true);
  if (document.hidden) scheduleHiddenWork();

  // Back from an unload: put the scroll position back once the content is there
  (() => {
    let slept = null;
    try {
      slept = JSON.parse(read(SLEPT, true));
    } catch {}
    write(SLEPT, null, true);
    if (!slept || slept.url !== location.href || !slept.y) return;
    let stop = false;
    const giveUp = () => { stop = true; };
    for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown']) {
      W.addEventListener(t, giveUp, { once: true, passive: true, capture: true });
    }
    const until = Date.now() + 10000;
    const step = () => {
      if (stop || Math.abs(W.scrollY - slept.y) < 5 || Date.now() > until) return;
      W.scrollTo(0, slept.y);
      later(step, 300);
    };
    W.addEventListener('load', () => later(step, 300), { once: true });
  })();

  // ------------------------------------------------------------ lite visuals

  const LITE_CSS = `*, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    transition-delay: 0s !important;
    scroll-behavior: auto !important;
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }`;
  let liteSheet = null;
  let liteStyle = null;

  function applyLite() {
    if ('adoptedStyleSheets' in Document.prototype) {
      if (!liteSheet) {
        liteSheet = new CSSStyleSheet();
        liteSheet.replaceSync(LITE_CSS);
      }
      const others = document.adoptedStyleSheets.filter(s => s !== liteSheet);
      document.adoptedStyleSheets = S.liteVisuals ? [...others, liteSheet] : others;
    } else if (S.liteVisuals && !liteStyle) {
      liteStyle = document.createElement('style');
      liteStyle.textContent = LITE_CSS;
      (document.head || document.documentElement).append(liteStyle);
    } else if (!S.liteVisuals && liteStyle) {
      liteStyle.remove();
      liteStyle = null;
    }
  }
  applyLite();

  // ------------------------------------------------------------ live settings

  function settingsChanged() {
    applyLite();
    scheduleHiddenWork();
    if (ui) ui.sync();
  }

  function setSetting(key, value) {
    if (!(key in DEFAULTS) || typeof value !== typeof DEFAULTS[key]) return false;
    S[key] = value;
    saveSettings();
    settingsChanged();
    return true;
  }

  W.addEventListener('storage', e => {
    if (e.key !== NS + 'settings') return;
    loadSettings();
    settingsChanged();
  });

  // ------------------------------------------------------------------ report

  const heapMB = () => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);

  function longFramesLastMinute() {
    const cutoff = performance.now() - 60000;
    const recent = stats.recentFrames.filter(f => f[0] >= cutoff);
    return { count: recent.length, ms: Math.round(recent.reduce((a, f) => a + f[1], 0)) };
  }

  function topSources(n) {
    return [...stats.sources, ...stats.frames]
      .map(([source, s]) => ({ source, calls: s.calls, totalMs: Math.round(s.total), maxMs: Math.round(s.max) }))
      .sort((a, b) => b.totalMs - a.totalMs)
      .slice(0, n);
  }

  function report() {
    return {
      version: VERSION,
      page: location.pathname + location.search,
      userAgent: navigator.userAgent,
      uptimeS: Math.round(performance.now() / 1000),
      settings: { ...S },
      diagnosticsOn: S.diagnostics,
      intervalsLive: liveIntervals.size,
      timeoutsPending: pendingTimeouts.size,
      freezes: stats.freezes,
      heldOnLastReturn: stats.lastHeld,
      heapMB: heapMB(),
      longFramesLastMinute: stats.loafSupported ? longFramesLastMinute() : 'not supported',
      blocked: stats.blocked.map(b => b.url),
      workers: stats.workers,
      sockets: [...stats.sockets].map(([url, s]) => ({ url, ...s })),
      timeBySource: topSources(30),
    };
  }

  // ------------------------------------------------------------------- panel

  const PANEL_CSS = `
:host {
  all: initial; position: fixed; z-index: 2147483647; display: flex; gap: 8px;
  font: 12px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #e7e7f0; color-scheme: dark;
  --bg: #17171f; --bg2: #22222d; --line: rgba(255,255,255,.09); --muted: #8e8ea4;
  --accent: #8b7bff; --ok: #3ecf8e; --warn: #f5a524; --cold: #6cb6ff;
}
:host([data-corner^="b"]) { bottom: 12px; flex-direction: column; }
:host([data-corner^="t"]) { top: 12px; flex-direction: column-reverse; }
:host([data-corner$="l"]) { left: 12px; align-items: flex-start; }
:host([data-corner$="r"]) { right: 12px; align-items: flex-end; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
button, input, select, textarea { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.launcher {
  position: relative; width: 30px; height: 30px; padding: 0; border-radius: 50%;
  border: 1px solid rgba(255,255,255,.14); background: rgba(23,23,31,.85);
  display: grid; place-items: center; cursor: pointer; opacity: .45; transition: opacity .15s;
}
.launcher:hover, .launcher:focus-visible, :host([data-open]) .launcher { opacity: 1; }
.launcher svg { width: 15px; height: 15px; fill: #b9b0ff; }
.dot {
  position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border-radius: 50%;
  background: var(--ok); border: 2px solid var(--bg);
}
.dot.keep { background: var(--warn); }

.panel {
  width: 336px; max-height: min(620px, calc(100vh - 64px)); overflow: auto; overscroll-behavior: contain;
  background: var(--bg); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0,0,0,.5);
}
header {
  position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 8px;
  padding: 10px 10px 10px 12px; background: var(--bg); border-bottom: 1px solid var(--line);
}
header strong { font-size: 13px; }
.ver { color: var(--muted); font-size: 11px; }
.spacer { flex: 1; }
.pill { font-size: 10px; font-weight: 600; padding: 1px 8px; border-radius: 99px; background: rgba(62,207,142,.14); color: var(--ok); }
.pill.keep { background: rgba(245,165,36,.14); color: var(--warn); }
.icon-btn {
  width: 24px; height: 24px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 6px;
  background: transparent; color: var(--muted); cursor: pointer; font-size: 14px;
}
.icon-btn:hover { background: var(--bg2); color: inherit; }

.tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; padding: 10px 12px 0; }
.tile { background: var(--bg2); border-radius: 8px; padding: 6px 8px; min-width: 0; }
.tile .v { font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tile .l { font-size: 10px; color: var(--muted); white-space: nowrap; }
.spark { display: block; width: calc(100% - 24px); height: 28px; margin: 8px 12px 0; }
.spark polyline { fill: none; stroke: var(--accent); stroke-width: 1.5; vector-effect: non-scaling-stroke; }
.spark line { stroke: var(--line); }
.meta { padding: 4px 12px 10px; color: var(--muted); font-size: 11px; }

details { border-top: 1px solid var(--line); }
summary {
  list-style: none; cursor: pointer; padding: 9px 12px; display: flex; justify-content: space-between;
  font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--muted);
}
summary::-webkit-details-marker { display: none; }
summary::after { content: '›'; font-size: 14px; line-height: 1; transition: transform .15s; }
details[open] > summary::after { transform: rotate(90deg); }
summary:hover { color: inherit; }
.group { padding-bottom: 6px; }

.row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 5px 12px; }
.row.block { flex-direction: column; align-items: stretch; gap: 4px; }
label.row { cursor: pointer; }
.text { flex: 1; min-width: 0; }
.hint { display: block; color: var(--muted); font-size: 11px; }
.needs-reload { color: var(--warn); font-size: 11px; margin-left: 3px; }
.this-tab { border-top: 1px solid var(--line); padding: 6px 0; }

.switch { position: relative; width: 30px; height: 17px; flex: none; }
.switch input {
  appearance: none; -webkit-appearance: none; margin: 0; width: 100%; height: 100%; display: block;
  border-radius: 99px; background: #3a3a4a; cursor: pointer; transition: background .15s;
}
.switch input:checked { background: var(--accent); }
.knob {
  position: absolute; top: 2px; left: 2px; width: 13px; height: 13px; border-radius: 50%;
  background: #fff; pointer-events: none; transition: transform .15s;
}
.switch input:checked + .knob { transform: translateX(13px); }

.field { display: flex; align-items: center; gap: 4px; flex: none; color: var(--muted); }
input[type=number], select, textarea {
  background: var(--bg2); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px;
}
input[type=number] { width: 58px; text-align: right; }
select { padding-right: 4px; cursor: pointer; }
textarea { width: 100%; min-height: 64px; resize: vertical; font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace; }

.list { margin: 2px 12px 6px; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.item { display: grid; grid-template-columns: auto 1fr auto auto; gap: 8px; align-items: center; padding: 4px 8px; font-size: 11px; }
.item + .item { border-top: 1px solid var(--line); }
.kind { font-size: 10px; padding: 0 5px; border-radius: 4px; background: var(--bg2); color: var(--muted); white-space: nowrap; }
.src { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, Menlo, Consolas, monospace; }
.n { font-variant-numeric: tabular-nums; color: var(--muted); white-space: nowrap; }
.empty { padding: 6px 8px; color: var(--muted); font-size: 11px; }

.btns { display: flex; gap: 6px; padding: 4px 12px 6px; flex-wrap: wrap; }
.btn {
  padding: 4px 10px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg2);
  cursor: pointer;
}
.btn:hover { border-color: rgba(255,255,255,.25); }
.btn.primary { background: var(--accent); border-color: transparent; color: #fff; }

.reloadbar {
  position: sticky; bottom: 0; z-index: 2; display: flex; align-items: center; gap: 8px;
  padding: 8px 12px; background: #2b2438; border-top: 1px solid var(--line);
}
.foot { display: flex; align-items: center; gap: 6px; padding: 8px 12px 10px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
kbd { font: 10px ui-monospace, Menlo, Consolas, monospace; padding: 1px 4px; border: 1px solid var(--line); border-radius: 4px; }
`;

  const FIELDS = [
    { group: 'Background tabs', open: true },
    { key: 'deferBackgroundTabs', label: 'Lazy-load tabs opened in background', hint: 'Middle-click and Ctrl+click tabs load when you open them.' },
    { key: 'freezeHiddenTabs', label: 'Freeze tabs you switch away from', hint: 'Holds timers (polling, ad refresh, tickers) until you return.' },
    { key: 'freezeDelaySec', label: 'Freeze after', unit: 's', min: 0, max: 600 },
    { key: 'pauseMedia', label: 'Pause video and audio while frozen' },
    { key: 'markFrozenTitle', label: 'Mark frozen tabs with 💤' },
    { key: 'freezeWebSockets', label: 'Hold live-update messages too', hint: 'WebSocket events replay in order on return.' },
    { key: 'exemptGenerator', label: 'Never freeze generator pages', hint: 'Generation progress keeps updating in the background.' },
    { key: 'unloadAfterMin', label: 'Unload after hidden for', unit: 'min', min: 0, max: 1440, hint: 'Frees the tab’s memory, reloads and restores scroll on return. 0 = never. Skipped while a text box has text.' },
    { group: 'Blocking', open: false, extra: 'blocked' },
    { key: 'blockThirdParty', label: 'Block trackers, ads, session replay', reload: true },
    { key: 'blockServiceWorker', label: 'Block service worker', reload: true, hint: 'Also turns off pixai push notifications.' },
    { key: 'customBlock', label: 'Also block scripts and workers matching', type: 'text', reload: true, hint: 'One per line: regex or plain text, tested against the full URL.' },
    { group: 'Visible tab', open: false },
    { key: 'liteVisuals', label: 'Lite visuals', hint: 'Near-instant animations and transitions, no backdrop blur.' },
    { key: 'fpsCap', label: 'Animation frame cap', options: [[0, 'Off'], [30, '30 fps'], [20, '20 fps'], [10, '10 fps']] },
    { key: 'minIntervalMs', label: 'Minimum timer interval', options: [[0, 'Off'], [100, '100 ms'], [250, '250 ms'], [1000, '1 s']], hint: 'Applies to timers the page starts after the change.' },
    { group: 'Diagnostics', open: false, extra: 'diagnostics' },
    { key: 'diagnostics', label: 'Record what runs', hint: 'Attributes time to scripts. Small overhead while on.' },
    { group: 'Panel', open: false },
    { key: 'corner', label: 'Position', options: [['bl', 'Bottom left'], ['br', 'Bottom right'], ['tl', 'Top left'], ['tr', 'Top right']] },
    { key: 'showLauncher', label: 'Show launcher button', hint: 'Alt+Shift+P opens the panel either way.' },
  ];

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k in el && !k.includes('-')) el[k] = v;
      else el.setAttribute(k, v);
    }
    el.append(...kids.flat().filter(k => k != null && k !== false));
    return el;
  }

  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...kids);
    return el;
  }

  const shortSource = s => s.replace(/(?:https?|chrome-extension|moz-extension):\/\/[^\s)]*?\/([^/\s)?#]+)(?:[?#][^\s):]*)?(?=[:\s)]|$)/g, '$1');

  function createPanel() {
    const host = document.createElement('pixai-perf-guard');
    const root = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(PANEL_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      root.append(h('style', { textContent: PANEL_CSS }));
    }

    const controls = new Map(); // key -> input element
    let isOpen = false;
    let refreshTimer = 0;
    let lagTimer = 0;
    const lag = [];

    // Header & status
    const pill = h('span', { class: 'pill' }, 'Active');
    const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close panel', title: 'Close (Esc)', onclick: () => close() }, '✕');
    const header = h('header', null, h('strong', null, 'PixAI Guard'), h('span', { class: 'ver' }, 'v' + VERSION), pill, h('span', { class: 'spacer' }), closeBtn);

    const tile = label => {
      const v = h('div', { class: 'v' }, '–');
      return [h('div', { class: 'tile' }, v, h('div', { class: 'l' }, label)), v];
    };
    const [tBlocked, vBlocked] = tile('blocked');
    const [tTimers, vTimers] = tile('timers');
    const [tLag, vLag] = tile('lag avg/max');
    tLag.title = 'Main-thread lag in ms over the last 12 s: how late a 200 ms tick fires';
    const [tHeap, vHeap] = tile('JS heap');
    tTimers.title = 'Intervals running · timeouts pending';
    const tiles = h('div', { class: 'tiles' }, tBlocked, tTimers, tLag, tHeap);

    const line = svg('polyline', { points: '' });
    const spark = svg('svg', { class: 'spark', viewBox: '0 0 100 28', preserveAspectRatio: 'none', 'aria-hidden': 'true' },
      svg('title', {}, 'Main-thread lag, last 12 s'), svg('line', { x1: 0, y1: 27.5, x2: 100, y2: 27.5 }), line);
    const meta = h('div', { class: 'meta' });

    // This tab
    const keepInput = h('input', {
      type: 'checkbox',
      onchange: e => {
        write('keepRunning', e.target.checked ? '1' : null, true);
        refresh();
      },
    });
    const thisTab = h('div', { class: 'this-tab' }, h('label', { class: 'row' },
      h('span', { class: 'text' }, 'Keep this tab running',
        h('span', { class: 'hint' }, 'No freezing or unloading for this tab until it closes.')),
      h('span', { class: 'switch' }, keepInput, h('span', { class: 'knob' }))));

    // Settings groups
    const extras = {};
    const groups = [];
    let current = null;
    for (const f of FIELDS) {
      if (f.group) {
        current = h('div', { class: 'group' });
        const d = h('details', { open: f.open }, h('summary', null, f.group), current);
        groups.push(d);
        if (f.extra) {
          extras[f.extra] = h('div');
          d.append(extras[f.extra]);
        }
        continue;
      }
      current.append(fieldRow(f));
    }

    function fieldRow(f) {
      const def = DEFAULTS[f.key];
      const label = h('span', { class: 'text' }, f.label,
        f.reload && h('span', { class: 'needs-reload', title: 'Turning this off takes effect after a reload' }, '↻'),
        f.hint && h('span', { class: 'hint' }, f.hint));
      let input;
      if (typeof def === 'boolean') {
        input = h('input', { type: 'checkbox', onchange: () => update(f.key, input.checked) });
        controls.set(f.key, input);
        return h('label', { class: 'row' }, label, h('span', { class: 'switch' }, input, h('span', { class: 'knob' })));
      }
      if (f.options) {
        input = h('select', { onchange: () => update(f.key, typeof def === 'number' ? Number(input.value) : input.value) },
          f.options.map(([v, text]) => h('option', { value: String(v) }, text)));
      } else if (f.type === 'text') {
        input = h('textarea', { spellcheck: false, placeholder: 'e.g. some-widget\\.js', onchange: () => update(f.key, input.value) });
        controls.set(f.key, input);
        return h('label', { class: 'row block' }, label, input);
      } else {
        input = h('input', {
          type: 'number', min: f.min, max: f.max, step: 1,
          onchange: () => {
            const n = Math.min(f.max, Math.max(f.min, Number(input.value) || 0));
            input.value = n;
            update(f.key, n);
          },
        });
      }
      controls.set(f.key, input);
      return h('label', { class: 'row' }, label, h('span', { class: 'field' }, input, f.unit));
    }

    function update(key, value) {
      setSetting(key, value);
      refresh();
    }

    // Diagnostics extras
    const diagList = h('div', { class: 'list' });
    const copyBtn = h('button', {
      class: 'btn primary',
      onclick: async () => {
        const text = JSON.stringify(report(), null, 1);
        try {
          await navigator.clipboard.writeText(text);
          copyBtn.textContent = 'Copied ✓';
        } catch {
          console.info(TAG, text);
          copyBtn.textContent = 'Printed to console';
        }
        later(() => { copyBtn.textContent = 'Copy report'; }, 1600);
      },
    }, 'Copy report');
    const clearBtn = h('button', {
      class: 'btn',
      onclick: () => {
        stats.sources.clear();
        stats.frames.clear();
        refresh();
      },
    }, 'Clear');
    extras.diagnostics.append(diagList, h('div', { class: 'btns' }, copyBtn, clearBtn));

    const blockedList = h('div', { class: 'list' });
    extras.blocked.append(blockedList);

    const reloadBar = h('div', { class: 'reloadbar', hidden: true },
      h('span', { class: 'spacer' }, 'Some changes apply after a reload.'),
      h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Reload'));

    const foot = h('div', { class: 'foot' },
      h('span', null, h('kbd', null, 'Alt'), '+', h('kbd', null, 'Shift'), '+', h('kbd', null, 'P')),
      h('span', { class: 'spacer' }),
      h('button', {
        class: 'btn',
        onclick: () => {
          Object.assign(S, DEFAULTS);
          saveSettings();
          settingsChanged();
          refresh();
        },
      }, 'Reset to defaults'));

    const panel = h('section', { class: 'panel', hidden: true, role: 'dialog', 'aria-label': 'PixAI Performance Guard' },
      header, tiles, spark, meta, thisTab, groups, reloadBar, foot);

    const dot = h('span', { class: 'dot' });
    const launcher = h('button', {
      class: 'launcher', 'aria-label': 'PixAI Performance Guard', 'aria-expanded': 'false',
      title: 'PixAI Performance Guard (Alt+Shift+P)', onclick: () => toggle(),
    }, svg('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' }, svg('path', { d: 'M13 2 4.5 13.5H11L10 22l8.5-11.5H12z' })), dot);

    root.append(panel, launcher);

    function sync() {
      host.dataset.corner = S.corner;
      launcher.hidden = !S.showLauncher;
      for (const [key, input] of controls) {
        if (input.type === 'checkbox') input.checked = S[key];
        else if (root.activeElement !== input) input.value = String(S[key]);
      }
      reloadBar.hidden = !FIELDS.some(f => f.reload && S[f.key] !== loadedWith[f.key]);
    }

    function renderRows(list, rows, empty) {
      list.replaceChildren(...(rows.length ? rows : [h('div', { class: 'empty' }, empty)]));
    }

    let blockedShown = -1;
    function refresh() {
      const keep = keepTabRunning();
      keepInput.checked = keep;
      dot.className = 'dot' + (keep ? ' keep' : '');
      launcher.title = `PixAI Performance Guard: ${stats.blocked.length} blocked (Alt+Shift+P)`;
      if (!isOpen) return;

      pill.textContent = keep ? 'Kept running' : 'Active';
      pill.className = 'pill' + (keep ? ' keep' : '');
      vBlocked.textContent = stats.blocked.length;
      vTimers.textContent = `${liveIntervals.size} · ${pendingTimeouts.size}`;
      if (lag.length) {
        const avg = lag.reduce((a, b) => a + b, 0) / lag.length;
        vLag.textContent = `${Math.round(avg)}/${Math.round(Math.max(...lag))}`;
        const peak = Math.max(50, ...lag);
        const x0 = 60 - lag.length; // newest sample at the right edge
        line.setAttribute('points', lag.map((v, i) => `${((x0 + i) / 59) * 100},${27 - (v / peak) * 25}`).join(' '));
      }
      const heap = heapMB();
      vHeap.textContent = heap == null ? 'n/a' : `${heap} MB`;

      const bits = [];
      if (stats.loafSupported) {
        const lf = longFramesLastMinute();
        bits.push(`Long frames last min: ${lf.count} (${lf.ms} ms)`);
      }
      let open = 0;
      let msgs = 0;
      for (const s of stats.sockets.values()) {
        open += Math.max(0, s.open);
        msgs += s.messages;
      }
      if (stats.sockets.size) bits.push(`WebSockets: ${open} open, ${msgs} msgs`);
      if (stats.workers.length) bits.push(`Workers: ${stats.workers.length}`);
      if (stats.freezes) bits.push(`Frozen ${stats.freezes}× (last return ran ${stats.lastHeld} held)`);
      meta.textContent = bits.join(' · ') || 'Lag is sampled while this panel is open.';

      if (blockedShown !== stats.blocked.length) {
        blockedShown = stats.blocked.length;
        const byHost = new Map(); // "kind host" -> count
        for (const b of stats.blocked) byHost.set(`${b.kind} ${b.host}`, (byHost.get(`${b.kind} ${b.host}`) || 0) + 1);
        renderRows(blockedList, [...byHost].map(([key, n]) => {
          const [kind, hostName] = key.split(' ');
          return h('div', { class: 'item' },
            h('span', { class: 'kind' }, kind), h('span', { class: 'src', title: hostName }, hostName),
            h('span', { class: 'n' }, n > 1 ? `×${n}` : ''), h('span'));
        }), 'Nothing blocked on this page yet.');
      }

      if (!S.diagnostics) {
        renderRows(diagList, [], 'Turn on “Record what runs”, use the page for a minute, then check back.');
      } else {
        renderRows(diagList, topSources(8).map(r => {
          const [kind, ...rest] = r.source.split(': ');
          const src = shortSource(rest.join(': '));
          return h('div', { class: 'item' },
            h('span', { class: 'kind' }, kind),
            h('span', { class: 'src', title: r.source }, src),
            h('span', { class: 'n' }, `${r.totalMs} ms`),
            h('span', { class: 'n' }, `${r.calls}×`));
        }), 'Nothing recorded yet.');
      }
    }

    function open() {
      if (isOpen) return;
      isOpen = true;
      panel.hidden = false;
      host.dataset.open = '';
      launcher.setAttribute('aria-expanded', 'true');
      sync();
      let last = performance.now();
      lag.length = 0;
      lagTimer = every(() => {
        const now = performance.now();
        lag.push(Math.max(0, now - last - 200));
        if (lag.length > 60) lag.shift();
        last = now;
      }, 200);
      refresh();
      refreshTimer = every(refresh, 1000);
      closeBtn.focus({ preventScroll: true });
    }

    function close() {
      if (!isOpen) return;
      if (root.activeElement && S.showLauncher) launcher.focus({ preventScroll: true });
      isOpen = false;
      panel.hidden = true;
      delete host.dataset.open;
      launcher.setAttribute('aria-expanded', 'false');
      stopTimer(lagTimer);
      stopTimer(refreshTimer);
    }

    const toggle = () => (isOpen ? close() : open());

    document.addEventListener('pointerdown', e => {
      if (isOpen && !e.composedPath().includes(host)) close();
    }, true);

    sync();
    refresh();
    return { host, open, close, toggle, sync, refresh, get isOpen() { return isOpen; } };
  }

  function mountPanel() {
    if (!ui) ui = createPanel();
    if (!ui.host.isConnected) document.documentElement.append(ui.host);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountPanel, { once: true });
  } else {
    mountPanel();
  }
  // Put it back if the site rebuilds the document element's children
  new MutationObserver(() => ui && !ui.host.isConnected && mountPanel())
    .observe(document.documentElement || document, { childList: true });

  // Registered before any page script, so keystrokes typed into the panel can be
  // kept from the site's own keyboard shortcuts
  for (const type of ['keydown', 'keyup', 'keypress']) {
    W.addEventListener(type, e => {
      if (type === 'keydown' && e.altKey && e.shiftKey && e.code === 'KeyP') {
        e.preventDefault();
        e.stopImmediatePropagation();
        mountPanel();
        ui.toggle();
        return;
      }
      if (!ui) return;
      const inPanel = e.composedPath().includes(ui.host);
      if (type === 'keydown' && e.key === 'Escape' && ui.isOpen) ui.close();
      if (inPanel) e.stopImmediatePropagation();
    }, true);
  }

  // ------------------------------------------------------------- console API

  W.pixaiPerf = {
    version: VERSION,
    settings: S,
    get frozen() { return frozen; },
    set: setSetting,
    open: () => { mountPanel(); ui.open(); },
    close: () => ui && ui.close(),
    debug(on = true) { setSetting('diagnostics', !!on); },
    report() {
      const data = report();
      console.info(TAG, data);
      console.table(data.timeBySource);
      return data;
    },
  };
})();
