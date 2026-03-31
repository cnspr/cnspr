/**
 * youtubemusic.js — YouTube-backed music system.
 *
 * Classes: MusicLibrary, YouTubePlayer, YouTubeSearchService, Mp3ExtractService, YTMusicPlayer
 *
 * YTMusicPlayer implements the same public API as MusicPlayer:
 *   update(world), skip(), triggerResolution(), triggerWorldEvent()
 *
 * See docs/music.md — "YouTube Playlist Variant" for design intent.
 */

import { resolveMood, MOODS } from './musicplayer.js';

// ── Default search queries per mood ──────────────────────────────────────────

export const MOOD_QUERIES = {
  BUREAU_NORMAL:      'bureaucratic ambient ost soundtrack institutional',
  PARANOID_STABILITY: 'paranoia dark ambient drone soundtrack ost',
  THE_MEMO_ARRIVES:   'tense cinematic build orchestral ost',
  PRODUCTIVE_DECLINE: 'melancholic synthwave ost soundtrack',
  ACTIVE_UNREST:      'industrial glitch electronic ost soundtrack',
  WORLD_EVENT:        'cinematic sting dramatic orchestral ost',
  COLLAPSE_IMMINENT:  'dark noise atonal experimental ost',
  BUREAU_DISSOLVES:   'minimal ambient silence piano ost',
};

// ── Music Library ─────────────────────────────────────────────────────────────

const LS_KEY = 'conspiracy_music';

/**
 * Per-mood track list. Backed by localStorage; synced to GitHub externally.
 * Track shape: { videoId, title, channel?, addedAt }
 */
export class MusicLibrary {
  constructor() {
    this._tracks = {};
    for (const key of Object.keys(MOODS)) this._tracks[key] = [];
    this._loadLS();
  }

  /** Overwrite with data from external source (e.g. GitHub). */
  loadData(data) {
    for (const [key, tracks] of Object.entries(data ?? {})) {
      if (Array.isArray(tracks)) this._tracks[key] = tracks;
    }
    this._saveLS();
  }

  toJSON() {
    return { ...this._tracks };
  }

  tracksForMood(moodKey) {
    return this._tracks[moodKey] ?? [];
  }

  /** Returns true if track was newly added. */
  addTrack(moodKey, track) {
    if (!this._tracks[moodKey]) this._tracks[moodKey] = [];
    const exists = this._tracks[moodKey].some(t => t.videoId === track.videoId);
    if (exists) return false;
    this._tracks[moodKey].push({
      videoId:  track.videoId,
      title:    track.title ?? track.videoId,
      channel:  track.channel ?? '',
      addedAt:  new Date().toISOString().slice(0, 10),
    });
    this._saveLS();
    return true;
  }

  removeTrack(moodKey, videoId) {
    if (!this._tracks[moodKey]) return;
    this._tracks[moodKey] = this._tracks[moodKey].filter(t => t.videoId !== videoId);
    this._saveLS();
  }

  totalCount() {
    return Object.values(this._tracks).reduce((s, arr) => s + arr.length, 0);
  }

  _loadLS() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) this.loadData(JSON.parse(raw));
    } catch {}
  }

  _saveLS() {
    try { localStorage.setItem(LS_KEY, JSON.stringify(this._tracks)); } catch {}
  }
}

// ── YouTube IFrame API wrapper ────────────────────────────────────────────────

/** Lazy-loads the YT IFrame API and wraps it for audio-only playback. */
export class YouTubePlayer {
  constructor(containerEl) {
    this._container  = containerEl;
    this._player     = null;
    this._ready      = false;
    this._readyCbs   = [];
    this._onEndedCb  = null;
    this._startTime  = null;

    this._loadAPI();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Play a video by its YouTube ID. Returns a promise that resolves once playback starts. */
  play(videoId) {
    return new Promise(resolve => {
      const doPlay = () => {
        this._startTime = Date.now();
        this._player.loadVideoById(videoId);
        resolve();
      };
      if (this._ready) doPlay();
      else this._readyCbs.push(doPlay);
    });
  }

  pause()  { try { this._player?.pauseVideo(); } catch {} }
  resume() { try { this._player?.playVideo();  } catch {} }
  stop()   { try { this._player?.stopVideo();  } catch {} }

  /** Seconds elapsed since playback started (wall-clock estimate). */
  get elapsed() {
    return this._startTime ? (Date.now() - this._startTime) / 1000 : 0;
  }

  /** Duration in seconds; null until the video has loaded. */
  get duration() {
    try { return this._player?.getDuration() || null; } catch { return null; }
  }

  get paused() {
    try {
      const state = this._player?.getPlayerState?.();
      return state !== window.YT?.PlayerState?.PLAYING;
    } catch { return true; }
  }

  /**
   * Register a callback fired when the video ends.
   * Only fires once; re-register before each play() call.
   * Callback receives: { elapsed, duration, error? }
   */
  onEnded(cb) { this._onEndedCb = cb; }

  // ── IFrame API bootstrap ──────────────────────────────────────────────────

  _loadAPI() {
    if (window.YT?.Player) { this._initPlayer(); return; }

    // Queue our init behind any existing callback
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      this._initPlayer();
    };

    if (!document.getElementById('yt-api-script')) {
      const s = document.createElement('script');
      s.id    = 'yt-api-script';
      s.src   = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
  }

  _initPlayer() {
    this._player = new window.YT.Player(this._container, {
      width:  '0',
      height: '0',
      playerVars: { autoplay: 0, controls: 0, iv_load_policy: 3, rel: 0 },
      events: {
        onReady: () => {
          this._ready = true;
          this._readyCbs.forEach(cb => cb());
          this._readyCbs = [];
        },
        onStateChange: e => {
          if (e.data === window.YT.PlayerState.ENDED) {
            const cb = this._onEndedCb;
            this._onEndedCb = null;
            cb?.({ elapsed: this.elapsed, duration: this.duration });
          }
        },
        onError: e => {
          const cb = this._onEndedCb;
          this._onEndedCb = null;
          cb?.({ elapsed: this.elapsed, duration: this.duration, error: e.data });
        },
      },
    });
  }
}

// ── YouTube Data API search ───────────────────────────────────────────────────

export class YouTubeSearchService {
  constructor(apiKey) { this.apiKey = apiKey; }

  /**
   * Search YouTube for music videos.
   * Returns: [{ videoId, title, channel, thumb }]
   */
  async search(query, maxResults = 12) {
    if (!this.apiKey) throw new Error('No YouTube API key configured — add one in Music Settings.');

    const params = new URLSearchParams({
      part:            'snippet',
      type:            'video',
      q:               query,
      maxResults:      String(maxResults),
      videoCategoryId: '10',   // Music
      key:             this.apiKey,
    });

    const res  = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`YouTube API ${res.status}: ${body.slice(0, 120)}`);
    }
    const data = await res.json();
    return (data.items ?? []).map(item => ({
      videoId: item.id.videoId,
      title:   item.snippet.title,
      channel: item.snippet.channelTitle,
      thumb:   item.snippet.thumbnails?.default?.url ?? null,
    }));
  }
}

// ── MP3 extract service ───────────────────────────────────────────────────────

/**
 * Calls a configurable HTTP service that takes a YouTube URL and returns an audio URL.
 * Expected API: GET {endpoint}?url={ytUrl} → { "url": "https://..." }
 *
 * Compatible with yt-dlp HTTP wrappers and similar tools.
 */
export class Mp3ExtractService {
  constructor(endpointUrl) { this.endpoint = endpointUrl; }

  async getAudioUrl(videoId) {
    if (!this.endpoint) throw new Error('No MP3 service endpoint configured.');
    const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const res   = await fetch(`${this.endpoint}?url=${encodeURIComponent(ytUrl)}`);
    if (!res.ok) throw new Error(`MP3 service ${res.status}`);
    const data  = await res.json();
    if (!data?.url) throw new Error('MP3 service returned no audio URL.');
    return data.url;
  }
}

// ── Simple HTML5 audio player (for MP3 mode) ─────────────────────────────────

class SimpleAudioPlayer {
  constructor() { this._el = null; }

  async play(url) {
    this._stop();
    this._el = new Audio(url);
    this._el.crossOrigin = 'anonymous';
    await this._el.play();
  }

  pause()  { this._el?.pause(); }
  resume() { this._el?.play().catch(() => {}); }
  _stop()  { if (this._el) { this._el.pause(); this._el.src = ''; this._el = null; } }

  get paused() { return !this._el || this._el.paused; }

  /** Fire cb once when the currently playing track ends. */
  onEnded(cb) {
    if (this._el) this._el.addEventListener('ended', () => cb({ elapsed: this._el?.currentTime, duration: this._el?.duration }), { once: true });
  }
}

// ── YTMusicPlayer ─────────────────────────────────────────────────────────────

/**
 * Drop-in replacement for MusicPlayer when cfg.music_mode is 'youtube' or 'mp3'.
 * Public API mirrors MusicPlayer: update(world), skip(), triggerResolution(), triggerWorldEvent()
 */
export class YTMusicPlayer {
  /**
   * @param {object} opts
   * @param {HTMLElement}   opts.playBtn
   * @param {HTMLElement}   opts.skipBtn
   * @param {HTMLElement}   opts.titleEl
   * @param {MusicLibrary}  opts.library
   * @param {YouTubePlayer} opts.ytPlayer      — shared YT player instance
   * @param {'youtube'|'mp3'} opts.mode
   * @param {string}        [opts.mp3ServiceUrl]
   * @param {boolean}       [opts.autosave]     — auto-save on track end
   * @param {number}        [opts.autosavePct]  — threshold 0–100 (default 80)
   * @param {function}      [opts.onAutoSave]   — async fn(moodKey, track) called when track qualifies
   */
  constructor({ playBtn, skipBtn, titleEl, library, ytPlayer, mode, mp3ServiceUrl, autosave, autosavePct, onAutoSave }) {
    this.playBtn     = playBtn;
    this.skipBtn     = skipBtn;
    this.titleEl     = titleEl;
    this.library     = library;
    this.mode        = mode;
    this.autosave    = autosave    ?? true;
    this.autosavePct = autosavePct ?? 80;
    this.onAutoSave  = onAutoSave  ?? null;

    this.mood  = MOODS.BUREAU_NORMAL;
    this.world = null;

    this._ytPlayer      = ytPlayer;
    this._audioPlayer   = mode === 'mp3' ? new SimpleAudioPlayer() : null;
    this._mp3Service    = mode === 'mp3' ? new Mp3ExtractService(mp3ServiceUrl ?? '') : null;

    this._currentTrack  = null;
    this._trackStarted  = null;   // Date.now() when current track started
    this._trackIndices  = {};     // { [moodKey]: number } — round-robin cursor
    this._prevMood      = null;   // for triggerResolution / triggerWorldEvent
    this._playing       = false;

    playBtn?.addEventListener('click', () => this._togglePlay());
    skipBtn?.addEventListener('click', () => this.skip());

    this._updateUI();
  }

  // ── Public API ────────────────────────────────────────────────────────────

  update(world) {
    this.world = world;
    const newMood     = resolveMood(world);
    const moodChanged = newMood.key !== this.mood.key;
    this.mood = newMood;
    if (moodChanged && this._playing) this._playNext();
  }

  async skip() {
    this._maybeAutoSave();
    await this._playNext();
  }

  /** Play a specific track immediately. Advances round-robin past this track. */
  async playTrack(moodKey, track) {
    if (MOODS[moodKey]) this.mood = MOODS[moodKey];
    this._currentTrack = track;
    this._trackStarted = Date.now();
    this._playing = true;
    const tracks = this.library.tracksForMood(moodKey);
    const idx    = tracks.findIndex(t => t.videoId === track.videoId);
    this._trackIndices[moodKey] = (idx + 1) % Math.max(tracks.length, 1);
    this._updateUI(track.title);
    if (this.mode === 'youtube') await this._playViaYT(track.videoId);
    else                         await this._playViaMp3(track.videoId);
  }

  async triggerResolution() {
    this._prevMood = this.mood;
    this.mood      = MOODS.THE_MEMO_ARRIVES;
    await this._playNext();
    setTimeout(() => { this.mood = this._prevMood ?? MOODS.BUREAU_NORMAL; this._playNext(); }, 90_000);
  }

  async triggerWorldEvent() {
    this._prevMood = this.mood;
    this.mood      = MOODS.WORLD_EVENT;
    await this._playNext();
    setTimeout(() => { this.mood = this._prevMood ?? MOODS.BUREAU_NORMAL; this._playNext(); }, 45_000);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  async _playNext() {
    const tracks = this.library.tracksForMood(this.mood.key);
    if (!tracks.length) {
      this._updateUI(`No tracks for "${this.mood.name}" — open ♫ to add`);
      return;
    }

    const idx = (this._trackIndices[this.mood.key] ?? 0) % tracks.length;
    this._trackIndices[this.mood.key] = idx + 1;
    this._currentTrack = tracks[idx];
    this._trackStarted = Date.now();
    this._playing      = true;

    this._updateUI(this._currentTrack.title);

    if (this.mode === 'youtube') {
      await this._playViaYT(this._currentTrack.videoId);
    } else {
      await this._playViaMp3(this._currentTrack.videoId);
    }
  }

  async _playViaYT(videoId) {
    this._ytPlayer.onEnded(({ error } = {}) => {
      if (!error && this.autosave) this._autoSaveCurrentTrack();
      this._playNext();
    });
    await this._ytPlayer.play(videoId);
  }

  async _playViaMp3(videoId) {
    try {
      const url = await this._mp3Service.getAudioUrl(videoId);
      this._audioPlayer.onEnded(() => {
        if (this.autosave) this._autoSaveCurrentTrack();
        this._playNext();
      });
      await this._audioPlayer.play(url);
    } catch (err) {
      // Fall back to YouTube IFrame if MP3 service fails
      this._updateUI(`MP3 service error — falling back to YouTube`);
      await this._playViaYT(videoId);
    }
  }

  _maybeAutoSave() {
    if (!this._currentTrack || !this._trackStarted || !this.autosave) return;
    const elapsed  = (Date.now() - this._trackStarted) / 1000;
    const duration = this.mode === 'youtube' ? this._ytPlayer.duration : null;
    const pct      = duration ? (elapsed / duration) * 100 : 0;
    if (pct >= this.autosavePct) this._autoSaveCurrentTrack();
  }

  _autoSaveCurrentTrack() {
    if (!this._currentTrack) return;
    this.onAutoSave?.(this.mood.key, this._currentTrack);
  }

  get _paused() {
    if (this.mode === 'youtube') return this._ytPlayer?.paused ?? true;
    return this._audioPlayer?.paused ?? true;
  }

  _togglePlay() {
    if (this._paused) {
      if (!this._currentTrack) {
        this._playNext();
      } else {
        if (this.mode === 'youtube') this._ytPlayer.resume();
        else this._audioPlayer.resume();
      }
    } else {
      if (this.mode === 'youtube') this._ytPlayer.pause();
      else this._audioPlayer.pause();
    }
    this._updateUI();
  }

  _updateUI(status) {
    if (this.titleEl) {
      const label = status ?? this._currentTrack?.title ?? this.mood.name;
      this.titleEl.textContent = `♪ ${label}`;
    }
    if (this.playBtn) this.playBtn.textContent = this._paused ? '▶' : '⏸';
  }
}
