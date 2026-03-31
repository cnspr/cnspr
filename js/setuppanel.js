/**
 * setuppanel.js — Onboarding: fork → modify → PR.
 *
 * Three sequential steps a new player completes once:
 *  1. Fork the canonical conspiracy repo
 *  2. Create an initial world file on the fork (sample modification)
 *  3. Open a PR from the fork back to the canonical repo
 */
export class SetupPanel {
  /**
   * @param {object} els  - DOM elements
   * @param {GitHubClient} gh
   * @param {string} userid
   */
  constructor({ forkBtn, forkStatus, initBtn, initStatus, prBtn, prStatus }, gh, userid) {
    this.gh     = gh;
    this.userid = userid;
    this.branch = null;  // set after initWorldBranch()

    forkBtn.addEventListener('click', () => this._fork(forkBtn, forkStatus, initBtn));
    initBtn.addEventListener('click', () => this._init(initBtn, initStatus, prBtn));
    prBtn.addEventListener('click',   () => this._pr(prBtn, prStatus));
  }

  async _fork(btn, statusEl, nextBtn) {
    btn.disabled = true;
    this._set(statusEl, 'Forking…');
    try {
      await this.gh.forkCanonical();

      // GitHub forks are async — poll until the fork is accessible
      this._set(statusEl, 'Waiting for fork to be ready…');
      await this._waitForFork();

      this._set(statusEl, 'Fork created.', 'ok');
      nextBtn.disabled = false;
    } catch (err) {
      this._set(statusEl, `Error: ${err.message}`, 'error');
      btn.disabled = false;
    }
  }

  async _init(btn, statusEl, nextBtn) {
    btn.disabled = true;
    this._set(statusEl, 'Creating initial world file…');
    try {
      this.branch = await this.gh.initWorldBranch(this.userid);
      this._set(statusEl, `Branch "${this.branch}" created with ${this.userid}/turn.json.`, 'ok');
      nextBtn.disabled = false;
    } catch (err) {
      this._set(statusEl, `Error: ${err.message}`, 'error');
      btn.disabled = false;
    }
  }

  async _pr(btn, statusEl) {
    if (!this.branch) { this._set(statusEl, 'Complete step 2 first.', 'error'); return; }
    btn.disabled = true;
    this._set(statusEl, 'Opening PR…');
    try {
      const pr = await this.gh.submitJoinPR(this.userid, this.branch);
      this._set(statusEl, `PR opened: <a href="${pr.html_url}" target="_blank">${pr.html_url}</a>`, 'ok', true);
    } catch (err) {
      this._set(statusEl, `Error: ${err.message}`, 'error');
      btn.disabled = false;
    }
  }

  async _waitForFork() {
    const delay = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      await delay(3000);
      if (await this.gh.isForkReady(this.userid)) return;
    }
    throw new Error('Fork did not become available after 60 s');
  }

  _set(el, msg, level = 'info', html = false) {
    if (html) { el.innerHTML = msg; }
    else      { el.textContent = msg; }
    el.className = `setup-step-status ${level}`;
  }
}
