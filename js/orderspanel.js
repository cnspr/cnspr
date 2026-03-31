/**
 * orderspanel.js — Order composition and PR submission.
 */

const ORDER_TYPES = [
  'army_directive',
  'raise_army',
  'recruit_hero',
  'assign_hero',
  'set_propaganda',
  'levy_tax',
  'begin_research',
  'build',
];

const PARAM_HINTS = {
  army_directive:  '{"army_id": "army_1st", "directive": "hold"}',
  raise_army:      '{"name": "2nd Legion", "region_id": "reg_england_wales", "doctrine": "maneuver"}',
  recruit_hero:    '{"name": "Vera", "role": "agent", "region_id": "reg_england_wales"}',
  assign_hero:     '{"hero_id": "h001", "target_id": "reg_france_north"}',
  set_propaganda:  '{"faction_id": "fac_bureau", "value": 5}',
  levy_tax:        '{"region_id": "reg_england_wales", "amount": 20}',
  begin_research:  '{"scholar_hero_id": "h001", "tech": "civic_intelligence"}',
  build:           '{"region_id": "reg_england_wales", "structure": "fort"}',
};

export class OrdersPanel {
  constructor({ typeEl, paramsEl, listEl, countEl, statusEl, addBtn, clearBtn, submitBtn }) {
    this.typeEl    = typeEl;
    this.paramsEl  = paramsEl;
    this.listEl    = listEl;
    this.countEl   = countEl;
    this.statusEl  = statusEl;
    this._orders   = [];

    // Populate order type dropdown
    ORDER_TYPES.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      typeEl.appendChild(opt);
    });
    this.paramsEl.value = PARAM_HINTS[ORDER_TYPES[0]];

    typeEl.addEventListener('change', () => {
      paramsEl.value = PARAM_HINTS[typeEl.value] ?? '{}';
    });

    addBtn.addEventListener('click', () => this._addOrder());
    clearBtn.addEventListener('click', () => this._clear());
    submitBtn.addEventListener('click', () => this._submit(submitBtn));
  }

  setContext(gh, userid, turn, { onSubmit } = {}) {
    this.gh       = gh;
    this.userid   = userid;
    this.turn     = turn;
    this.onSubmit = onSubmit ?? null;
  }

  addOrder(type, params) {
    this._orders.push({ type, params });
    const li = document.createElement('li');
    li.textContent = `${type} — ${JSON.stringify(params)}`;
    this.listEl.appendChild(li);
    this.countEl.textContent = `(${this._orders.length})`;
    this._status(`${this._orders.length} order(s) queued.`);
  }

  _addOrder() {
    const type = this.typeEl.value;
    let params;
    try {
      params = JSON.parse(this.paramsEl.value);
    } catch {
      this._status('Invalid JSON params.', 'error');
      return;
    }
    this.addOrder(type, params);
  }

  _clear() {
    this._orders = [];
    this.listEl.innerHTML = '';
    this.countEl.textContent = '(0)';
    this._status('Orders cleared.');
  }

  async _submit(btn) {
    if (!this._orders.length) { this._status('No orders to submit.', 'error'); return; }
    if (!this.gh)             { this._status('Not connected to GitHub.', 'error'); return; }

    btn.disabled = true;
    this._status('Submitting PR…');
    try {
      const payload = { userid: this.userid, turn: this.turn, orders: this._orders };
      const url = await this.gh.submitOrders(this.userid, this.turn, payload);
      this._clear();
      this._status(`PR opened: ${url}`);
      this.onSubmit?.();
    } catch (err) {
      this._status(`Error: ${err.message}`, 'error');
    } finally {
      btn.disabled = false;
    }
  }

  _status(msg, level = 'info') {
    this.statusEl.textContent = msg;
    this.statusEl.style.color = level === 'error' ? '#c0392b' : '#7878a0';
  }
}
