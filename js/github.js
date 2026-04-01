/**
 * github.js — GitHub REST API client.
 * Fetches world state JSON from the repo and submits orders as a PR.
 */
import { dbg } from './debug.js';

/** Thrown when the GitHub API responds with 401. Caller should re-auth. */
export class AuthError extends Error {
  constructor() { super('GitHub token expired or revoked'); this.status = 401; }
}

export class GitHubClient {
  constructor({ token, repo }) {
    this.token = token;
    this.repo  = repo;   // "owner/repo" — authenticated user owns this repo
    this.base  = 'https://api.github.com';
  }

  // ── Raw file fetch ──────────────────────────────────────────────────

  /**
   * Fetch a file via the GitHub Contents API (authenticated, avoids raw rate limits).
   * Returns decoded text content, or null for 404.
   */
  async _fetchContents(repo, path) {
    const res = await fetch(`${this.base}/repos/${repo}/contents/${path}`, {
      headers: this._headers(),
    });
    if (res.status === 404) return null;
    if (res.status === 401) throw new AuthError();
    if (!res.ok) throw new Error(`fetchContents ${path}: ${res.status}`);
    const data = await res.json();
    // Contents API returns base64-encoded content
    return atob(data.content.replace(/\n/g, ''));
  }

  /** Fetch a JSON file from the repo's default branch (authenticated). */
  async fetchJSON(path) {
    const text = await this._fetchContents(this.repo, path);
    if (text === null) throw new Error(`fetchJSON ${path}: 404`);
    return JSON.parse(text);
  }

  /** Fetch a text file (e.g. events.log). Returns string or null. */
  async fetchText(path) {
    return this._fetchContents(this.repo, path);
  }

  // ── World state loading ─────────────────────────────────────────────

  /** Fetch static region topology from cnspr/engine/world/map.json. */
  async loadMap() {
    const res = await fetch('https://raw.githubusercontent.com/cnspr/engine/main/world/map_cube.json');
    if (!res.ok) return [];
    return res.json();
  }

  async loadWorld(userid) {
    const load = async (path, fallback) => {
      try {
        const text = await this._fetchContents(this.repo, path);
        if (text !== null) return JSON.parse(text);
      } catch {}
      return fallback;
    };

    const [heroes, factions, regionsDynamic, armies, economy, belief, turnObj, mapStatic] =
      await Promise.all([
        load(`${userid}/heroes.json`,   []),
        load(`${userid}/factions.json`, []),
        load(`shared/regions.json`,     []),
        load(`${userid}/armies.json`,   []),
        load(`${userid}/economy.json`,  {}),
        load(`${userid}/belief.json`,   {}),
        load(`${userid}/turn.json`,     { turn: 0 }),
        this.loadMap(),
      ]);

    // Merge static topology (map.json) with dynamic state (shared/regions.json)
    const dynamicById = Object.fromEntries(regionsDynamic.map(r => [r.id, r]));
    const regions = mapStatic.map(s => ({ ...s, ...dynamicById[s.id] }));

    return { heroes, factions, regions, armies, economy, belief, turn: turnObj.turn ?? 0 };
  }

  async loadEventLog(userid) {
    const text = await this._fetchContents(this.repo, `${userid}/history/events.log`);
    if (!text) return [];
    return text.split('\n').map(l => l.trim()).filter(Boolean).reverse();
  }

  /** Load per-turn stats snapshots for the Statistics panel. */
  async loadStats(userid) {
    const res    = await this._get(`/repos/${this.repo}/git/trees/main?recursive=1`);
    const prefix = `${userid}/history/stats_`;
    const files  = (res.tree ?? [])
      .filter(f => f.path.startsWith(prefix) && f.path.endsWith('.json'))
      .map(f => f.path)
      .sort();

    const snapshots = await Promise.all(
      files.map(f =>
        this._fetchContents(this.repo, f)
          .then(t => t ? JSON.parse(t) : null)
          .catch(() => null)
      )
    );
    return snapshots.filter(Boolean);
  }

  // ── Onboarding helpers ─────────────────────────────────────────────

  /**
   * Fork the canonical world repo into the authenticated user's account.
   * Returns the fork object. GitHub creates forks asynchronously — callers
   * should poll isForkReady() after this returns.
   */
  async forkCanonical() {
    return this._post(`/repos/${this.repo}/forks`, {});
  }

  /** Returns true once the player's fork exists and is accessible. */
  async isForkReady(userid) {
    try {
      await this._get(`/repos/${userid}/world`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a branch on the player's fork, add world/{userid}/turn.json,
   * and return the branch name. This is the "sample modification" step.
   */
  async initWorldBranch(userid) {
    const branch = `join/${userid}`;
    const path   = `${userid}/turn.json`;

    // Get HEAD of main on the fork
    const ref = await this._get(`/repos/${userid}/world/git/ref/heads/main`);
    const sha  = ref.object.sha;

    // Create the join branch
    await this._post(`/repos/${userid}/world/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha,
    });

    // Commit the initial world file
    await this._put(`/repos/${userid}/world/contents/${path}`, {
      message: `Initialize world for ${userid}`,
      content: btoa(JSON.stringify({ turn: 0 }, null, 2)),
      branch,
    });

    return branch;
  }

  /**
   * Open a PR from the player's fork branch to the canonical repo's main.
   * Returns the PR object (includes html_url).
   */
  async submitJoinPR(userid, branch) {
    return this._post(`/repos/${this.repo}/pulls`, {
      title: `Join: ${userid}`,
      head:  `${userid}:${branch}`,
      base:  'main',
      body:  `World initialization for player **${userid}**.`,
    });
  }

  // ── Order submission ────────────────────────────────────────────────

  /**
   * Commit orders to a branch on the player's fork, then open a PR
   * from that branch to the canonical repo's main.
   * Returns the PR HTML URL.
   */
  async submitOrders(userid, turn, ordersObj) {
    const branch  = `orders/turn-${String(turn).padStart(4, '0')}`;
    const path    = `${userid}/orders/turn.json`;
    const content = JSON.stringify(ordersObj, null, 2);

    // 1. Get HEAD of main on the player's fork
    const ref = await this._get(`/repos/${this.repo}/git/ref/heads/main`);
    const sha = ref.object.sha;

    // 2. Create orders branch on the fork (ignore 422 if it already exists)
    try {
      await this._post(`/repos/${this.repo}/git/refs`, {
        ref: `refs/heads/${branch}`, sha,
      });
    } catch (err) {
      if (!err.message.includes('422')) throw err;
    }

    // 3. Commit orders file to the branch (fetch existing SHA if present)
    let existingSha;
    try {
      const existing = await this._get(`/repos/${this.repo}/contents/${path}?ref=${branch}`);
      existingSha = existing.sha;
    } catch {}

    await this._put(`/repos/${this.repo}/contents/${path}`, {
      message: `Turn ${turn} orders`,
      content: btoa(unescape(encodeURIComponent(content))),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
    });

    // 4. Open PR from fork branch to canonical repo main
    const pr = await this._post(`/repos/${this.repo}/pulls`, {
      title: `Turn ${turn} orders — ${userid}`,
      head:  `${userid}:${branch}`,
      base:  'main',
      body:  `Turn ${turn} order submission by ${userid}.`,
    });

    return pr.html_url;
  }

  // ── Music library ───────────────────────────────────────────────────

  /** Load shared/music.json from the repo. Returns {} on missing. */
  async loadMusicLibrary(userid) {
    try {
      const text = await this._fetchContents(this.repo, `shared/music.json`);
      return text ? JSON.parse(text) : {};
    } catch { return {}; }
  }

  /** Commit shared/music.json to the repo (creates or updates). */
  async saveMusicLibrary(userid, data) {
    const path    = `shared/music.json`;
    const content = JSON.stringify(data, null, 2);

    // Fetch existing SHA (needed for update)
    let existingSha;
    try {
      const existing = await this._get(`/repos/${this.repo}/contents/${path}`);
      existingSha = existing.sha;
    } catch {}

    await this._put(`/repos/${this.repo}/contents/${path}`, {
      message: 'Update music library',
      content: btoa(unescape(encodeURIComponent(content))),
      ...(existingSha ? { sha: existingSha } : {}),
    });
  }

  // ── Turn management ────────────────────────────────────────────────

  /**
   * Advance shared/world.json to the next turn and optionally set a deadline.
   * This writes directly to the canonical repo's main branch (game-master only).
   */
  async advanceTurn(userid, deadlineUtc = null) {
    const path = 'shared/world.json';
    // Read current world.json
    const fileRes  = await this._get(`/repos/${this.repo}/contents/${path}`);
    const current  = JSON.parse(atob(fileRes.content.replace(/\n/g, '')));
    const nextTurn = (current.current_turn ?? 1) + 1;
    const updated  = { ...current, current_turn: nextTurn, turn_deadline_utc: deadlineUtc ?? null };
    await this._put(`/repos/${this.repo}/contents/${path}`, {
      message: `Advance to turn ${nextTurn}`,
      content: btoa(JSON.stringify(updated, null, 2)),
      sha:     fileRes.sha,
    });
    return nextTurn;
  }

  // ── HTTP helpers ────────────────────────────────────────────────────

  _headers() {
    return {
      'Authorization':        `Bearer ${this.token}`,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  async _request(method, path, body) {
    const url = `${this.base}${path}`;
    const t0  = Date.now();
    const res = await fetch(url, {
      method,
      headers: { ...this._headers(), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const ms = Date.now() - t0;

    const remaining = res.headers.get('X-RateLimit-Remaining');
    const limit     = res.headers.get('X-RateLimit-Limit');
    const reset     = res.headers.get('X-RateLimit-Reset');
    if (remaining != null) dbg.setRateLimit({ remaining: +remaining, limit: +limit, reset: +reset });

    dbg.api(method, url, res.status, ms, remaining != null ? +remaining : undefined);

    if (res.status === 401) throw new AuthError();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  _get(path)        { return this._request('GET',  path); }
  _post(path, body) { return this._request('POST', path, body); }
  _put(path, body)  { return this._request('PUT',  path, body); }
}
