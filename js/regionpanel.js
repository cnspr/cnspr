/**
 * regionpanel.js — Region Info widget (left panel of map selection overlay).
 * Read-only display of the selected region's world-state data.
 */

const FACTION_COLORS = { federation: '#4a9eff', syndicate: '#e6a820', conspiracy: '#9b59b6' };

const TYPE_LABELS = {
  core_homeland:       'Core Homeland',
  colony:              'Colony',
  occupied_territory:  'Occupied',
  'sub-conspiracy':    'Sub-conspiracy',
  digital_enclave:     'Digital Enclave',
};

function stabColor(v)  { return v > 60 ? '#27ae60' : v > 30 ? '#e67e22' : '#c0392b'; }
function entColor(v)   { return v > 75 ? '#c0392b' : v > 50 ? '#e67e22' : '#7c5cbf'; }
function unrestColor(v){ return v > 60 ? '#c0392b' : v > 30 ? '#e67e22' : '#27ae60'; }

function bar(pct, color) {
  return `<div class="wi-bar-wrap"><div class="wi-bar" style="width:${Math.min(pct,100)}%;background:${color}"></div></div>`;
}

function barWithThresholds(pct, color, thresholds) {
  const marks = thresholds.map(t =>
    `<div class="wi-threshold" style="left:${t}%"></div>`
  ).join('');
  return `<div class="wi-bar-wrap wi-bar-rel">${marks}<div class="wi-bar" style="width:${Math.min(pct,100)}%;background:${color}"></div></div>`;
}

export class RegionInfoPanel {
  constructor(el, { onDismiss } = {}) {
    this.el        = el;
    this.onDismiss = onDismiss ?? null;
  }

  show(region, world) {
    const factionMap = {};
    for (const f of (world?.factions ?? [])) factionMap[f.id] = f;

    // Dominant faction = highest influence share
    const inf = region.faction_influence ?? {};
    const sorted = Object.entries(inf).sort((a, b) => b[1] - a[1]);
    const [domId, domShare] = sorted[0] ?? [null, 0];
    const domFaction  = factionMap[domId] ?? null;
    const factionCol  = FACTION_COLORS[domFaction?.type] ?? '#7c5cbf';

    const stability = region.stability ?? region.prosperity ?? 0;
    const entropy   = region.entropy   ?? 0;
    const unrest    = region.unrest    ?? 0;
    const popStr    = region.population >= 1000
      ? `${(region.population / 1000).toFixed(1)}B`
      : `${region.population ?? 0}M`;

    const typeLabel = TYPE_LABELS[region.type] ?? (region.type ?? '');

    // Belief composition
    const belief = region.belief_composition ?? {};
    const beliefEntries = Object.entries(belief).sort((a, b) => b[1] - a[1]);
    const beliefHtml = beliefEntries.length
      ? beliefEntries.map(([id, share]) =>
          `<span class="wi-tag">${id.replace(/_/g,' ')} ${Math.round(share * 100)}%</span>`
        ).join('')
      : '<span class="wi-muted">—</span>';

    // Policies
    const policies = region.active_policies ?? [];
    const policiesHtml = policies.length
      ? policies.map(p => `<span class="wi-tag">${p.name ?? p}</span>`).join('')
      : '<span class="wi-muted">none</span>';

    // Events
    const events = region.events_active ?? [];
    const eventsHtml = events.length
      ? events.map(e => `<div class="wi-event">${e.name ?? e}</div>`).join('')
      : '<span class="wi-muted">none</span>';

    // Unique modifier
    const modHtml = region.unique_modifier
      ? `<div class="wi-section-title">Modifier</div>
         <div class="wi-modifier">${region.unique_modifier}</div>`
      : '';

    const adjacent = (region.adjacent_region_ids ?? []).join(', ') || '—';

    // Influence breakdown HTML
    const influenceHtml = sorted.length
      ? sorted.map(([fid, share]) => {
          const f   = factionMap[fid];
          const col = FACTION_COLORS[f?.type] ?? '#7c5cbf';
          const pct = Math.round(share * 100);
          return `<div class="wi-row">
            <span class="wi-label" style="color:${col}">${f?.name ?? fid}</span>
            <span class="wi-val" style="color:${col}">${pct}%</span>
          </div>
          <div class="wi-bar-wrap"><div class="wi-bar" style="width:${pct}%;background:${col}"></div></div>`;
        }).join('')
      : '<span class="wi-muted">No faction influence recorded</span>';

    this.el.innerHTML = `
      <div class="wi-header">
        <span class="wi-title" style="color:${factionCol}">${region.name ?? region.id}</span>
        ${typeLabel ? `<span class="wi-type-badge">${typeLabel}</span>` : ''}
        <button class="wi-close" id="wi-close-btn" title="Dismiss">✕</button>
      </div>

      <div class="wi-section-title">Faction Influence</div>
      ${influenceHtml}

      <div class="wi-section-title">Stability &amp; Entropy</div>
      <div class="wi-row">
        <span class="wi-label">Stability</span>
        <span class="wi-val" style="color:${stabColor(stability)}">${stability}</span>
      </div>
      ${bar(stability, stabColor(stability))}
      <div class="wi-row">
        <span class="wi-label">Entropy</span>
        <span class="wi-val" style="color:${entColor(entropy)}">${entropy}</span>
      </div>
      ${barWithThresholds(entropy, entColor(entropy), [50, 75, 90])}
      ${unrest > 0 ? `<div class="wi-row">
        <span class="wi-label">Unrest</span>
        <span class="wi-val" style="color:${unrestColor(unrest)}">${unrest}</span>
      </div>` : ''}

      <div class="wi-section-title">Economy</div>
      <div class="wi-row"><span class="wi-label">Trust / turn</span><span class="wi-val">${region.trust_output ?? '—'}</span></div>
      <div class="wi-row"><span class="wi-label">Industry</span><span class="wi-val">${region.infrastructure_level ?? '—'}</span></div>
      <div class="wi-row"><span class="wi-label">Population</span><span class="wi-val">${popStr}</span></div>
      <div class="wi-row"><span class="wi-label">Adjacent</span><span class="wi-val wi-adjacent">${adjacent}</span></div>

      <div class="wi-section-title">Belief</div>
      <div class="wi-tags">${beliefHtml}</div>

      <div class="wi-section-title">Policies</div>
      <div class="wi-tags">${policiesHtml}</div>

      <div class="wi-section-title">Active Events</div>
      <div class="wi-events">${eventsHtml}</div>

      ${modHtml}
    `;

    this.el.querySelector('#wi-close-btn').addEventListener('click', () => {
      this.onDismiss?.();
    });
  }

  hide() {
    this.el.innerHTML = '';
  }
}
