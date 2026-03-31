/**
 * debug.js — Client-side debug logger and panel controller.
 *
 * Usage:
 *   import { dbg } from './debug.js';
 *   dbg.info('world loaded', { turn: 5 });
 *   dbg.error('fetch failed', err);
 *   dbg.api('GET', url, 200, 142);
 *
 * Toggle panel: Ctrl+Shift+D  or  click the DBG button in the header.
 */

const MAX_ENTRIES = 300;

class DebugLogger {
  constructor() {
    this._entries  = [];
    this._world    = null;   // last loaded world snapshot
    this._rateLimit = null;  // { remaining, limit, reset }
    this._listeners = [];

    // Capture unhandled JS errors
    window.addEventListener('error', e => {
      this.error(`Uncaught: ${e.message}`, { file: e.filename, line: e.lineno, col: e.colno });
    });
    window.addEventListener('unhandledrejection', e => {
      this.error(`Unhandled promise rejection: ${e.reason?.message ?? e.reason}`);
    });

    // Intercept console.error / console.warn so they show in the panel too
    const orig_error = console.error.bind(console);
    const orig_warn  = console.warn.bind(console);
    console.error = (...args) => { this.error('[console] ' + args.join(' ')); orig_error(...args); };
    console.warn  = (...args) => { this.warn('[console] '  + args.join(' ')); orig_warn(...args); };
  }

  // ── Public logging API ──────────────────────────────────────────────

  info(msg, data)  { this._push('info',  msg, data); }
  warn(msg, data)  { this._push('warn',  msg, data); }
  error(msg, data) { this._push('error', msg, data); }

  /** Log a GitHub API call. Call after the response arrives. */
  api(method, url, status, ms, rateRemaining) {
    const level = status >= 400 ? 'error' : 'api';
    this._push(level, `${method} ${status} (${ms}ms)`, { url });
    if (rateRemaining != null) {
      this._rateLimit = { ...this._rateLimit, remaining: rateRemaining };
    }
  }

  /** Store rate-limit headers parsed from a GitHub API response. */
  setRateLimit({ remaining, limit, reset }) {
    this._rateLimit = { remaining, limit, reset };
    this._notify();
  }

  /** Store the last loaded world state for inspection. */
  setWorld(world) {
    this._world = world;
    this._notify();
  }

  clear() {
    this._entries = [];
    this._notify();
  }

  getEntries() { return [...this._entries]; }
  getWorld()   { return this._world; }
  getRateLimit() { return this._rateLimit; }

  /** Subscribe to updates (panel re-render). */
  onChange(fn) { this._listeners.push(fn); }

  /** Build a plain-text report suitable for pasting into a bug report. */
  report(cfg) {
    const lines = [
      '=== Conspiracy Client Debug Report ===',
      `Time:    ${new Date().toISOString()}`,
      `User:    ${cfg?.userid ?? '(none)'}`,
      `Repo:    ${cfg?.github_repo ?? '(none)'}`,
      `Token:   ${cfg?.github_token ? cfg.github_token.slice(0, 8) + '…' : '(none)'}`,
      `Turn:    ${this._world?.turn ?? '?'}`,
      `Regions: ${this._world?.regions?.length ?? 0}`,
      `Heroes:  ${this._world?.heroes?.length ?? 0}`,
      `Rate:    ${this._rateLimit ? `${this._rateLimit.remaining}/${this._rateLimit.limit}` : 'unknown'}`,
      '',
      '--- Log ---',
      ...this._entries.map(e => `[${e.time}] ${e.level.toUpperCase().padEnd(5)} ${e.msg}${e.data ? ' ' + JSON.stringify(e.data) : ''}`),
    ];
    return lines.join('\n');
  }

  // ── Internal ────────────────────────────────────────────────────────

  _push(level, msg, data) {
    const entry = {
      level,
      msg,
      data:  data !== undefined ? data : null,
      time:  new Date().toTimeString().slice(0, 8),
      ts:    Date.now(),
    };
    this._entries.unshift(entry);          // newest first
    if (this._entries.length > MAX_ENTRIES) this._entries.pop();
    this._notify();
  }

  _notify() {
    this._listeners.forEach(fn => fn());
  }
}

export const dbg = new DebugLogger();

// ── Panel UI ────────────────────────────────────────────────────────────────

export function initDebugPanel(getCfg) {
  // Inject panel HTML
  const panel = document.createElement('div');
  panel.id = 'debug-panel';
  panel.innerHTML = `
    <div id="debug-header">
      <span id="debug-title">Debug</span>
      <span id="debug-rate"></span>
      <button id="debug-copy">Copy report</button>
      <button id="debug-clear">Clear</button>
      <button id="debug-close">✕</button>
    </div>
    <div id="debug-meta"></div>
    <div id="debug-log"></div>
  `;
  document.body.appendChild(panel);

  // Keyboard shortcut: Ctrl+Shift+D
  document.addEventListener('keydown', e => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') toggle();
  });

  document.getElementById('debug-close').addEventListener('click', () => hide());
  document.getElementById('debug-clear').addEventListener('click', () => { dbg.clear(); render(); });
  document.getElementById('debug-copy').addEventListener('click', () => {
    navigator.clipboard.writeText(dbg.report(getCfg()))
      .then(() => flash('debug-copy', 'Copied!'))
      .catch(() => flash('debug-copy', 'Failed'));
  });

  dbg.onChange(render);

  function render() {
    if (!panel.classList.contains('open')) return;

    // Meta row
    const cfg = getCfg();
    const rl  = dbg.getRateLimit();
    const w   = dbg.getWorld();
    document.getElementById('debug-rate').textContent =
      rl ? `Rate: ${rl.remaining}/${rl.limit}` : '';
    document.getElementById('debug-meta').innerHTML = [
      `<span class="dm-label">User</span><span>${cfg?.userid ?? '—'}</span>`,
      `<span class="dm-label">Repo</span><span>${cfg?.github_repo ?? '—'}</span>`,
      `<span class="dm-label">Token</span><span>${cfg?.github_token ? cfg.github_token.slice(0,8)+'…' : 'none'}</span>`,
      `<span class="dm-label">Turn</span><span>${w?.turn ?? '—'}</span>`,
      `<span class="dm-label">Regions</span><span>${w?.regions?.length ?? 0}</span>`,
      `<span class="dm-label">Heroes</span><span>${w?.heroes?.length ?? 0}</span>`,
      `<span class="dm-label">Factions</span><span>${w?.factions?.length ?? 0}</span>`,
    ].join('');

    // Log
    const entries = dbg.getEntries();
    document.getElementById('debug-log').innerHTML = entries.length === 0
      ? '<div class="dl-empty">No log entries.</div>'
      : entries.map(e => {
          const dataStr = e.data ? `<div class="dl-data">${escHtml(JSON.stringify(e.data, null, 2))}</div>` : '';
          return `<div class="dl-entry dl-${e.level}"><span class="dl-time">${e.time}</span><span class="dl-level">${e.level}</span><span class="dl-msg">${escHtml(e.msg)}</span>${dataStr}</div>`;
        }).join('');
  }

  function toggle() {
    panel.classList.toggle('open');
    if (panel.classList.contains('open')) render();
  }

  function hide() { panel.classList.remove('open'); }

  function flash(id, text) {
    const el = document.getElementById(id);
    const orig = el.textContent;
    el.textContent = text;
    setTimeout(() => { el.textContent = orig; }, 1500);
  }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // Expose toggle so the header button can call it
  return { toggle };
}
