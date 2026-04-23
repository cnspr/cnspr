/**
 * regionorders.js — Region Orders widget (right panel of map selection overlay).
 * Shows agents present in the selected region with inline mission assignment,
 * plus quick region-level action buttons that queue orders.
 */

const MISSION_TYPES = [
  { value: 'infiltrate',          label: 'Infiltrate' },
  { value: 'propagandise',        label: 'Propagandise' },
  { value: 'fabricate_evidence',  label: 'Fabricate Evidence' },
  { value: 'sponsor_conspiracy',  label: 'Sponsor a Conspiracy' },
  { value: 'blackmail',           label: 'Blackmail' },
  { value: 'assassinate',         label: 'Assassinate (Form K-7/R required)' },
  { value: 'audit',               label: 'Audit' },
  { value: 'recruit_cultists',    label: 'Recruit Cultists' },
];

const REGION_ACTIONS = [
  {
    label:  'Levy Tax',
    type:   'levy_tax',
    params: r => ({ region_id: r.id, amount: 10 }),
  },
  {
    label:  'Sponsor Construction',
    type:   'build',
    params: r => ({ region_id: r.id, structure: 'fort' }),
  },
  {
    label:  'Dispatch Agent',
    type:   'recruit_hero',
    params: r => ({ name: '', role: 'agent', region_id: r.id }),
  },
];

export class RegionOrdersPanel {
  constructor(el, addOrderFn) {
    this.el          = el;
    this._addOrder   = addOrderFn;   // fn(type, params) → void
    this._region     = null;
    this._world      = null;
    this._expandedId = null;         // hero id whose mission form is open
    this._staged     = 0;            // orders queued for this region this session
  }

  show(region, world) {
    this._region     = region;
    this._world      = world;
    this._expandedId = null;
    this._staged     = 0;
    this._render();
  }

  showCountry(info, world) {
    this._region     = null;
    this._world      = world;
    this._expandedId = null;
    this._staged     = 0;

    const { country, archetype, regions, factionInfluence } = info;
    const factionMap = {};
    for (const f of (world?.factions ?? [])) factionMap[f.id] = f;

    const stagedBadge = this._staged > 0
      ? `<span class="wi-staged-badge">${this._staged} staged</span>`
      : '';

    // Show all factions with their country-wide influence totals
    const factionEntries = Object.entries(factionInfluence ?? {}).sort((a, b) => b[1] - a[1]);
    const factionsHtml = factionEntries.length
      ? factionEntries.map(([fid, total]) => {
          const f   = factionMap[fid];
          const avg = regions.length ? (total / regions.length * 100).toFixed(0) : '0';
          return `<div class="wo-faction-row">
            <span class="wo-faction-name">${f?.name ?? fid}</span>
            <span class="wo-faction-type wi-muted">${f?.type ?? ''}</span>
            <span class="wo-faction-inf">${avg}%</span>
            <button class="wo-action-btn" data-faction-id="${fid}" data-action="propaganda">
              Fund Propaganda
            </button>
          </div>`;
        }).join('')
      : `<div class="wo-empty">No factions active in ${country}.</div>`;

    // First region of this country used as target for country-wide actions
    const anyRegionId = regions[0]?.id ?? '';

    this.el.innerHTML = `
      <div class="wi-header">
        <span class="wi-title">Gov't Orders — ${country}</span>
        ${stagedBadge}
      </div>

      <div class="wi-section-title">Active Factions</div>
      <div id="wo-factions">${factionsHtml}</div>

      <div class="wi-section-title">Country Actions</div>
      <div class="wo-action-grid">
        <button class="wo-action-btn" data-country-action="levy" data-region-id="${anyRegionId}">Levy Tax</button>
        <button class="wo-action-btn" data-country-action="agent" data-region-id="${anyRegionId}">Dispatch Agent</button>
        <button class="wo-action-btn" data-country-action="build" data-region-id="${anyRegionId}">Sponsor Build</button>
      </div>
    `;

    // Propaganda per faction
    this.el.querySelectorAll('[data-action="propaganda"]').forEach(btn => {
      btn.addEventListener('click', () => {
        const fid = btn.dataset.factionId;
        this._addOrder('set_propaganda', { faction_id: fid, value: 5 });
        this._staged++;
        this._renderStagedBadge();
      });
    });

    // Country-level actions (target first region as anchor)
    this.el.querySelectorAll('[data-country-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const rid = btn.dataset.regionId;
        switch (btn.dataset.countryAction) {
          case 'levy':  this._addOrder('levy_tax',     { region_id: rid, amount: 10 }); break;
          case 'agent': this._addOrder('recruit_hero', { name: '', role: 'agent', region_id: rid }); break;
          case 'build': this._addOrder('build',        { region_id: rid, structure: 'fort' }); break;
        }
        this._staged++;
        this._renderStagedBadge();
      });
    });
  }

  _renderStagedBadge() {
    const header = this.el.querySelector('.wi-header');
    if (!header) return;
    let badge = header.querySelector('.wi-staged-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'wi-staged-badge';
      header.appendChild(badge);
    }
    badge.textContent = `${this._staged} staged`;
  }

  hide() {
    this.el.innerHTML = '';
    this._region     = null;
    this._expandedId = null;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  _render() {
    const region = this._region;
    const heroes = (this._world?.heroes ?? []).filter(h => h.region_id === region.id);

    const stagedBadge = this._staged > 0
      ? `<span class="wi-staged-badge">${this._staged} staged</span>`
      : '';

    const rosterHtml = heroes.length
      ? heroes.map(h => this._heroRowHtml(h)).join('')
      : `<div class="wo-empty">No agents in region.
           <button class="wo-link-btn" data-action="dispatch">Dispatch one</button>
         </div>`;

    this.el.innerHTML = `
      <div class="wi-header">
        <span class="wi-title">Orders — ${region.name ?? region.id}</span>
        ${stagedBadge}
      </div>

      <div class="wi-section-title">Agents in Region</div>
      <div id="wo-roster">${rosterHtml}</div>

      <div class="wi-section-title">Region Actions</div>
      <div class="wo-action-grid">
        ${REGION_ACTIONS.map((a, i) =>
          `<button class="wo-action-btn" data-action-idx="${i}">${a.label}</button>`
        ).join('')}
      </div>
    `;

    this._wire();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  _wire() {
    // Toggle mission form per hero
    this.el.querySelectorAll('.wo-assign-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.heroId;
        this._expandedId = this._expandedId === id ? null : id;
        this._render();
      });
    });

    // Submit mission form
    this.el.querySelectorAll('.wo-mission-submit').forEach(btn => {
      btn.addEventListener('click', () => {
        const heroId      = btn.dataset.heroId;
        const selectEl    = this.el.querySelector(`#wo-mt-${heroId}`);
        const missionType = selectEl?.value;
        if (!heroId || !missionType) return;
        this._addOrder('assign_hero', {
          hero_id:      heroId,
          target_id:    this._region.id,
          mission_type: missionType,
        });
        this._staged++;
        this._expandedId = null;
        this._render();
      });
    });

    // Region-level action buttons
    this.el.querySelectorAll('.wo-action-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = REGION_ACTIONS[parseInt(btn.dataset.actionIdx)];
        if (!action) return;
        this._addOrder(action.type, action.params(this._region));
        this._staged++;
        this._render();
      });
    });

    // Dispatch shortcut from empty-roster state
    this.el.querySelector('[data-action="dispatch"]')?.addEventListener('click', () => {
      this._addOrder('recruit_hero', { name: '', role: 'agent', region_id: this._region.id });
      this._staged++;
      this._render();
    });
  }

  // ── Hero row HTML ─────────────────────────────────────────────────────────

  _heroRowHtml(hero) {
    const isExpanded = this._expandedId === hero.id;

    const statusColors = {
      idle:       '#27ae60',
      on_mission: '#e6a820',
      in_transit: '#4a9eff',
      injured:    '#e67e22',
      missing:    '#c0392b',
    };
    const statusColor = statusColors[hero.status] ?? 'var(--muted)';
    const statusLabel = (hero.status ?? 'idle').replace(/_/g, ' ');
    const missionNote = hero.current_mission ? ` · ${hero.current_mission}` : '';

    const loyaltyBadge  = hero.loyalty  != null ? `<span class="wo-stat-badge">♥ ${hero.loyalty}</span>`  : '';
    const paranoiaBadge = hero.paranoia != null ? `<span class="wo-stat-badge">⚠ ${hero.paranoia}</span>` : '';

    const missionForm = isExpanded ? `
      <div class="wo-mission-form">
        <label class="wo-form-label">Mission type
          <select id="wo-mt-${hero.id}">
            ${MISSION_TYPES.map(m =>
              `<option value="${m.value}">${m.label}</option>`
            ).join('')}
          </select>
        </label>
        <div class="wo-risk-note">
          Target: <strong>${this._region?.name ?? '—'}</strong>
          &nbsp;·&nbsp; Risk: heuristic only — engine decides
        </div>
        <button class="wo-mission-submit primary" data-hero-id="${hero.id}">Add to Queue</button>
      </div>
    ` : '';

    return `
      <div class="wo-hero-row${isExpanded ? ' expanded' : ''}">
        <div class="wo-hero-main">
          <span class="wo-hero-name">${hero.name ?? hero.id}</span>
          <span class="wo-hero-role">${hero.role ?? ''}</span>
          <span class="wo-hero-status" style="color:${statusColor}">${statusLabel}${missionNote}</span>
          <span class="wo-hero-badges">${loyaltyBadge}${paranoiaBadge}</span>
          <button class="wo-assign-btn${isExpanded ? ' active' : ''}" data-hero-id="${hero.id}">
            ${isExpanded ? 'Cancel' : 'Assign Mission'}
          </button>
        </div>
        ${missionForm}
      </div>
    `;
  }
}
