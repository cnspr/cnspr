/**
 * app.js — Root controller.
 * Wires together config, GitHub client, and all UI panels.
 */

debugger;
import { Config }       from './config.js';
import { GitHubClient, AuthError } from './github.js';
import { MusicPlayer, MOODS }  from './musicplayer.js';
import { YTMusicPlayer, MusicLibrary, YouTubePlayer, YouTubeSearchService, MOOD_QUERIES } from './youtubemusic.js';
import { dbg, initDebugPanel } from './debug.js';
import { MapView }      from './mapview.js';
import { EventViewer }  from './eventviewer.js';
import { StatsPanel }   from './statspanel.js';
import { OrdersPanel }  from './orderspanel.js';
import { SetupPanel }   from './setuppanel.js';
import { RegionInfoPanel }   from './regionpanel.js';
import { RegionOrdersPanel } from './regionorders.js';

// ── Turn → date ────────────────────────────────────────────────────────────
const GAME_START_YEAR = new Date().getFullYear();
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function turnToDate(turn) {
  const d = new Date(GAME_START_YEAR, 0, 1 + (turn - 1) * 7);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

// ── State ──────────────────────────────────────────────────────────────────
let gh      = null;
let world   = null;
let cfg     = null;
let music   = null;
let library = null;   // MusicLibrary (always created; used by YTMusicPlayer)
let ytPlayer = null;  // shared YouTubePlayer instance

// ── Boot ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  dbg.info('DOMContentLoaded');

  cfg = Config.load();
  dbg.info('Config loaded', {
    userid:   cfg?.userid ?? null,
    repo:     cfg?.github_repo ?? null,
    hasToken: !!cfg?.github_token,
  });

  if (!cfg?.github_token) {
    dbg.info('No token — showing login screen');
    showLogin();
    return;
  }

  initApp();
});

// ── Login screen ─────────────────────────────────────────────────────────────
function showLogin(errorMsg) {
  document.getElementById('login-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');

  if (errorMsg) {
    const errEl = document.getElementById('login-error');
    errEl.textContent = errorMsg;
    errEl.classList.remove('hidden');
  }

  document.getElementById('btn-pat').addEventListener('click', async () => {
    const token      = document.getElementById('pat-input').value.trim();
    const mubertKey  = document.getElementById('mubert-key-input').value.trim();
    const errEl      = document.getElementById('login-error');

    if (!token) {
      errEl.textContent = 'Enter a Personal Access Token.';
      errEl.classList.remove('hidden');
      return;
    }

    errEl.classList.add('hidden');
    try {
      const me = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      }).then(r => r.ok ? r.json() : Promise.reject(new Error('Invalid token')));

      cfg = { userid: me.login, github_token: token, github_repo: `${me.login}/world`, ...(mubertKey ? { mubert_api_key: mubertKey } : {}) };
      Config.save(cfg);
      dbg.info('PAT login successful', { userid: cfg.userid });
      initApp();
    } catch (err) {
      dbg.error('PAT login failed', { message: err.message });
      errEl.textContent = `Token error: ${err.message}`;
      errEl.classList.remove('hidden');
    }
  }, { once: true });
}

// ── Re-auth helper ────────────────────────────────────────────────────────────
function handleAuthError() {
  Config.clear();
  cfg = null;
  dbg.warn('Token invalid — returning to login');
  showLogin('Your token has expired or been revoked. Please enter a new one.');
}

// ── Main app ────────────────────────────────────────────────────────────────
function initApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');

  const debugPanel = initDebugPanel(() => cfg);
  const btnDebug = document.getElementById('btn-debug');
  if (cfg.debug) btnDebug.classList.remove('hidden');
  btnDebug.addEventListener('click', () => debugPanel.toggle());
  dbg.info('App initialised', { userid: cfg.userid, repo: cfg.github_repo });

  gh = new GitHubClient({ token: cfg.github_token, repo: cfg.github_repo });

  // ── Music library (always created; populated after world load) ──────
  library  = new MusicLibrary();
  ytPlayer = new YouTubePlayer(document.getElementById('yt-player-container'));

  music = _createMusicPlayer();

  function _createMusicPlayer() {
    const mode = cfg.music_mode ?? 'procedural';
    if (mode === 'youtube' || mode === 'mp3') {
      return new YTMusicPlayer({
        playBtn:       document.getElementById('btn-music-play'),
        skipBtn:       document.getElementById('btn-music-skip'),
        titleEl:       document.getElementById('music-title'),
        library,
        ytPlayer,
        mode,
        mp3ServiceUrl: cfg.mp3_service_url ?? '',
        autosave:      cfg.music_autosave ?? true,
        autosavePct:   cfg.music_autosave_pct ?? 80,
        onAutoSave:    async (moodKey, track) => {
          const added = library.addTrack(moodKey, track);
          if (added) {
            dbg.info('Auto-saved track', { moodKey, title: track.title });
            gh?.saveMusicLibrary(cfg.userid, library.toJSON()).catch(() => {});
          }
        },
      });
    }
    // Default: procedural / Mubert
    return new MusicPlayer({
      playBtn:      document.getElementById('btn-music-play'),
      skipBtn:      document.getElementById('btn-music-skip'),
      titleEl:      document.getElementById('music-title'),
      mubertApiKey: cfg.mubert_api_key ?? null,
    });
  }

  // Tab switching
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
  });

  // Config dropdown menu
  const cfgWrap  = document.getElementById('config-menu-wrap');
  const cfgMenu  = document.getElementById('config-menu');
  document.getElementById('btn-config').addEventListener('click', e => {
    e.stopPropagation();
    cfgMenu.classList.toggle('hidden');
  });
  document.addEventListener('click', () => cfgMenu.classList.add('hidden'));

  document.getElementById('cfg-reload').addEventListener('click', () => {
    cfgMenu.classList.add('hidden');
    loadWorld();
  });
  document.getElementById('cfg-logout').addEventListener('click', () => {
    cfgMenu.classList.add('hidden');
    if (confirm('Log out and reset configuration?')) { Config.clear(); location.reload(); }
  });
  document.getElementById('cfg-new-turn').addEventListener('click', () => {
    cfgMenu.classList.add('hidden');
    openCreateTurnModal();
  });
  document.getElementById('cfg-setup').addEventListener('click', () => {
    cfgMenu.classList.add('hidden');
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.getElementById('tab-setup').classList.add('active');
  });

  document.getElementById('cfg-music').addEventListener('click', () => {
    cfgMenu.classList.add('hidden');
    openMusicSettingsModal();
  });

  // ── Map selection overlay ─────────────────────────────────────────────
  const mapSelectionEl  = document.getElementById('map-selection');
  const regionInfoEl    = document.getElementById('region-info');
  const regionOrdersEl  = document.getElementById('wo-content');

  let mapView;

  function dismissMapSelection() {
    mapSelectionEl.classList.remove('open');
    mapView?.deselect();
  }

  const regionInfoPanel = new RegionInfoPanel(regionInfoEl, { onDismiss: dismissMapSelection });

  const ordersPanel = new OrdersPanel({
    typeEl:    document.getElementById('order-type'),
    paramsEl:  document.getElementById('order-params'),
    listEl:    document.getElementById('orders-list'),
    countEl:   document.getElementById('order-count'),
    statusEl:  document.getElementById('orders-status'),
    addBtn:    document.getElementById('btn-add-order'),
    clearBtn:  document.getElementById('btn-clear-orders'),
    submitBtn: document.getElementById('btn-submit-orders'),
  });

  const regionOrdersPanel = new RegionOrdersPanel(
    regionOrdersEl,
    (type, params) => ordersPanel.addOrder(type, params),
  );

  // Map view toolbar
  document.querySelectorAll('.map-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.map-view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      mapView?.setView(btn.dataset.view);
    });
  });

  // Init panels
  mapView = new MapView(
    document.getElementById('map-canvas'),
    (region) => {
      if (region && world) {
        regionInfoPanel.show(region, world, mapView.getAdjacentIds(region.id));
        regionOrdersPanel.show(region, world);
        mapSelectionEl.classList.add('open');
      } else {
        regionOrdersPanel.hide();
        mapSelectionEl.classList.remove('open');
      }
    },
  );

  const eventViewer = new EventViewer(
    document.getElementById('events-list'),
    document.getElementById('events-filter'),
    (regionId) => {
      // Navigate to map tab and select region
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelector('.tab-btn[data-tab="map"]').classList.add('active');
      document.getElementById('tab-map').classList.add('active');
      mapView?.selectById(regionId);
    },
  );

  const statsPanel = new StatsPanel();

  new SetupPanel(
    {
      forkBtn:    document.getElementById('btn-fork'),
      forkStatus: document.getElementById('fork-status'),
      initBtn:    document.getElementById('btn-init-world'),
      initStatus: document.getElementById('init-status'),
      prBtn:      document.getElementById('btn-join-pr'),
      prStatus:   document.getElementById('pr-status'),
    },
    gh,
    cfg.userid,
  );

  // Load world and wire everything up
  async function loadWorld() {
    document.getElementById('header-turn').textContent  = 'Loading…';
    document.getElementById('header-trust').textContent = '';
    try {
      dbg.info('Loading world…', { userid: cfg.userid });
      world = await gh.loadWorld(cfg.userid);
      dbg.info('World loaded', {
        turn:     world.turn,
        regions:  world.regions?.length ?? 0,
        heroes:   world.heroes?.length  ?? 0,
        factions: world.factions?.length ?? 0,
      });
      dbg.setWorld(world);
      music.update(world);

      // Sync music library from GitHub (non-blocking; localStorage already loaded)
      gh.loadMusicLibrary(cfg.userid).then(data => {
        if (data && Object.keys(data).length) library.loadData(data);
      }).catch(() => {});

      document.getElementById('header-turn').textContent  = turnToDate(world.turn);
      document.getElementById('header-trust').textContent = `Trust: ${world.economy.trust ?? 0}`;

      mapView.render(world);
      ordersPanel.setContext(gh, cfg.userid, world.turn, { onSubmit: () => music.triggerResolution() });

      const events = await gh.loadEventLog(cfg.userid);
      dbg.info('Event log loaded', { entries: events.length });
      eventViewer.load(events);

      const snapshots = await gh.loadStats(cfg.userid);
      dbg.info('Stats snapshots loaded', { count: snapshots.length });
      statsPanel.render(snapshots);

    } catch (err) {
      if (err instanceof AuthError) {
        dbg.error('Auth error during world load');
        handleAuthError();
        return;
      }
      dbg.error('World load failed', { message: err.message, stack: err.stack });
      document.getElementById('header-turn').textContent = 'Error loading world';
      console.error(err);
    }
  }

  // ── Music library search button ───────────────────────────────────────────
  document.getElementById('btn-music-search').addEventListener('click', () => openMusicModal());

  // ── Music library modal ───────────────────────────────────────────────────

  const musicModal = document.getElementById('music-modal');

  function openMusicModal() {
    musicModal.classList.remove('hidden');
    _populateMoodSelects();
    _renderSavedPane();
    _updateMoodBadge();
  }

  function _closeMusicModal() { musicModal.classList.add('hidden'); }

  document.getElementById('mm-close-btn').addEventListener('click', _closeMusicModal);
  musicModal.addEventListener('click', e => { if (e.target === musicModal) _closeMusicModal(); });

  // Tab switching
  musicModal.querySelectorAll('.mm-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      musicModal.querySelectorAll('.mm-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('mm-pane-saved').classList.toggle('hidden', tab.dataset.mmTab !== 'saved');
      document.getElementById('mm-pane-search').classList.toggle('hidden', tab.dataset.mmTab !== 'search');
      if (tab.dataset.mmTab === 'search') _preFillSearch();
    });
  });

  function _updateMoodBadge() {
    document.getElementById('mm-mood-badge').textContent = music?.mood?.name ?? '';
  }

  function _populateMoodSelects() {
    const opts = Object.values(MOODS).map(m =>
      `<option value="${m.key}">${m.name}</option>`
    ).join('');
    document.getElementById('mm-mood-select').innerHTML = opts;
    document.getElementById('mm-search-mood-select').innerHTML = opts;
    // Default to current mood
    const cur = music?.mood?.key ?? 'BUREAU_NORMAL';
    document.getElementById('mm-mood-select').value = cur;
    document.getElementById('mm-search-mood-select').value = cur;
  }

  function _renderSavedPane() {
    const mood   = document.getElementById('mm-mood-select').value;
    const tracks = library.tracksForMood(mood);
    const el     = document.getElementById('mm-saved-list');

    if (!tracks.length) {
      el.innerHTML = `<div class="mm-empty">No tracks saved for this mood.<br>Use the Search tab to find and add some.</div>`;
      return;
    }

    el.innerHTML = tracks.map((t, i) => `
      <div class="mm-track-row">
        <button class="mm-play-btn" data-idx="${i}" data-mood="${mood}" title="Play now">▶</button>
        <span class="mm-track-title" title="${t.title}">${t.title}</span>
        <span class="mm-track-ch" title="${t.channel ?? ''}">${t.channel ?? ''}</span>
        <a class="mm-open-link" href="https://www.youtube.com/watch?v=${t.videoId}" target="_blank" rel="noopener" title="Open on YouTube">↗</a>
        <button class="mm-remove-btn" data-idx="${i}" data-mood="${mood}" title="Remove">✕</button>
      </div>
    `).join('');

    el.querySelectorAll('.mm-play-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const track = library.tracksForMood(btn.dataset.mood)[+btn.dataset.idx];
        if (track && music?.playTrack) music.playTrack(btn.dataset.mood, track);
      });
    });

    el.querySelectorAll('.mm-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const track = library.tracksForMood(btn.dataset.mood)[+btn.dataset.idx];
        if (!track) return;
        library.removeTrack(btn.dataset.mood, track.videoId);
        _renderSavedPane();
        _setMmStatus(`Removed "${track.title}"`);
        gh?.saveMusicLibrary(cfg.userid, library.toJSON()).catch(() => {});
      });
    });
  }

  document.getElementById('mm-mood-select').addEventListener('change', _renderSavedPane);

  // Sync to GitHub
  document.getElementById('mm-sync-gh').addEventListener('click', async () => {
    _setMmStatus('Syncing…');
    try {
      await gh.saveMusicLibrary(cfg.userid, library.toJSON());
      _setMmStatus('Synced to GitHub ✓');
    } catch (err) {
      _setMmStatus(`Sync failed: ${err.message}`);
    }
  });

  // Search pane
  function _preFillSearch() {
    const mood = document.getElementById('mm-search-mood-select').value;
    const inp  = document.getElementById('mm-search-input');
    if (!inp.value) inp.value = MOOD_QUERIES[mood] ?? '';
    const note = document.getElementById('mm-search-note');
    note.textContent = cfg.youtube_api_key
      ? ''
      : 'No YouTube API key configured. Add one in ⚙ Music Settings to enable search.';
  }

  document.getElementById('mm-search-mood-select').addEventListener('change', _preFillSearch);

  document.getElementById('mm-search-btn').addEventListener('click', async () => {
    if (!cfg.youtube_api_key) {
      document.getElementById('mm-search-note').textContent =
        'Add a YouTube Data API key in ⚙ Music Settings to use search.';
      return;
    }
    const query = document.getElementById('mm-search-input').value.trim();
    const mood  = document.getElementById('mm-search-mood-select').value;
    if (!query) return;

    const resultsEl = document.getElementById('mm-search-results');
    resultsEl.innerHTML = '<div class="mm-empty">Searching…</div>';

    try {
      const svc     = new YouTubeSearchService(cfg.youtube_api_key);
      const results = await svc.search(query);
      _renderSearchResults(results, mood);
    } catch (err) {
      resultsEl.innerHTML = `<div class="mm-empty" style="color:var(--danger)">${err.message}</div>`;
    }
  });

  function _renderSearchResults(results, moodKey) {
    const el = document.getElementById('mm-search-results');
    if (!results.length) {
      el.innerHTML = '<div class="mm-empty">No results found.</div>';
      return;
    }

    el.innerHTML = results.map((r, i) => `
      <div class="mm-result-row">
        ${r.thumb ? `<img src="${r.thumb}" class="mm-thumb" alt="" />` : ''}
        <div class="mm-result-info">
          <span class="mm-track-title" title="${r.title}">${r.title}</span>
          <span class="mm-track-ch">${r.channel}</span>
        </div>
        <a class="mm-open-link" href="https://www.youtube.com/watch?v=${r.videoId}" target="_blank" rel="noopener" title="Open on YouTube">↗</a>
        <button class="mm-save-result primary" data-idx="${i}" title="Save for ${MOODS[moodKey]?.name ?? moodKey}">+ Save</button>
      </div>
    `).join('');

    el.querySelectorAll('.mm-save-result').forEach(btn => {
      btn.addEventListener('click', async () => {
        const r     = results[+btn.dataset.idx];
        const added = library.addTrack(moodKey, { videoId: r.videoId, title: r.title, channel: r.channel });
        if (added) {
          btn.textContent  = '✓ Saved';
          btn.disabled     = true;
          btn.classList.remove('primary');
          _setMmStatus(`Saved "${r.title}" for ${MOODS[moodKey]?.name ?? moodKey}`);
          gh?.saveMusicLibrary(cfg.userid, library.toJSON()).catch(() => {});
        } else {
          btn.textContent = 'Already saved';
          btn.disabled    = true;
        }
      });
    });
  }

  function _setMmStatus(msg) {
    const el = document.getElementById('mm-status');
    el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 4000);
  }

  // ── Music settings modal ──────────────────────────────────────────────────

  const musicSettingsModal = document.getElementById('music-settings-modal');

  function openMusicSettingsModal() {
    // Populate form from cfg
    document.getElementById('ms-mode').value          = cfg.music_mode ?? 'procedural';
    document.getElementById('ms-yt-key').value        = cfg.youtube_api_key ?? '';
    document.getElementById('ms-mp3-url').value       = cfg.mp3_service_url ?? '';
    document.getElementById('ms-autosave').checked    = cfg.music_autosave ?? true;
    document.getElementById('ms-autosave-pct').value  = cfg.music_autosave_pct ?? 80;
    document.getElementById('ms-status').textContent  = '';
    musicSettingsModal.classList.remove('hidden');
  }

  document.getElementById('ms-cancel').addEventListener('click', () => {
    musicSettingsModal.classList.add('hidden');
  });
  musicSettingsModal.addEventListener('click', e => {
    if (e.target === musicSettingsModal) musicSettingsModal.classList.add('hidden');
  });

  document.getElementById('ms-save').addEventListener('click', () => {
    cfg.music_mode        = document.getElementById('ms-mode').value;
    cfg.youtube_api_key   = document.getElementById('ms-yt-key').value.trim() || undefined;
    cfg.mp3_service_url   = document.getElementById('ms-mp3-url').value.trim() || undefined;
    cfg.music_autosave    = document.getElementById('ms-autosave').checked;
    cfg.music_autosave_pct = parseInt(document.getElementById('ms-autosave-pct').value, 10) || 80;
    Config.save(cfg);
    document.getElementById('ms-status').textContent = 'Saved. Reloading…';
    setTimeout(() => location.reload(), 800);
  });

  // ── Create Turn modal ─────────────────────────────────────────────────────
  function openCreateTurnModal() {
    const current = world?.turn ?? 1;
    const next    = current + 1;
    document.getElementById('ct-current').value = `Turn ${current} — ${turnToDate(current)}`;
    document.getElementById('ct-next').value    = `Turn ${next} — ${turnToDate(next)}`;
    // Default deadline: 7 days from now at noon UTC
    const dl = new Date();
    dl.setDate(dl.getDate() + 7);
    dl.setHours(12, 0, 0, 0);
    document.getElementById('ct-deadline').value = dl.toISOString().slice(0, 16);
    document.getElementById('ct-status').textContent = '';
    document.getElementById('create-turn-modal').classList.remove('hidden');
  }

  document.getElementById('ct-cancel').addEventListener('click', () => {
    document.getElementById('create-turn-modal').classList.add('hidden');
  });

  document.getElementById('ct-confirm').addEventListener('click', async () => {
    const statusEl  = document.getElementById('ct-status');
    const deadlineEl = document.getElementById('ct-deadline');
    const deadline  = deadlineEl.value ? new Date(deadlineEl.value).toISOString() : null;
    statusEl.textContent = 'Advancing turn…';
    try {
      await gh.advanceTurn(cfg.userid, deadline);
      document.getElementById('create-turn-modal').classList.add('hidden');
      await loadWorld();
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
    }
  });

  loadWorld();
}
