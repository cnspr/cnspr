/**
 * eventviewer.js — Renders the narrative event log.
 * Region IDs (reg_*) in event text are rendered as clickable links.
 */
export class EventViewer {
  constructor(listEl, filterEl, onRegionClick) {
    this.listEl        = listEl;
    this.filterEl      = filterEl;
    this.onRegionClick = onRegionClick ?? null;
    this._entries      = [];
    filterEl.addEventListener('input', () => this._render(filterEl.value));
  }

  load(entries) {
    this._entries = entries;
    this._render('');
  }

  _render(query) {
    const q = query.toLowerCase();
    this.listEl.innerHTML = '';
    for (const entry of this._entries) {
      if (q && !entry.toLowerCase().includes(q)) continue;
      const li = document.createElement('li');
      if (entry.startsWith('==='))            li.className = 'turn-header';
      else if (entry.startsWith('[WORLD EVENT]')) li.className = 'world-event';
      else                                    li.className = 'normal';
      this._appendWithLinks(li, entry);
      this.listEl.appendChild(li);
    }
  }

  /** Splits text on reg_* tokens and injects clickable <span> elements. */
  _appendWithLinks(li, text) {
    if (!this.onRegionClick) { li.textContent = text; return; }
    const parts = text.split(/(reg_[a-z0-9_]+)/g);
    for (const part of parts) {
      if (/^reg_[a-z0-9_]+$/.test(part)) {
        const span = document.createElement('span');
        span.textContent = part;
        span.className   = 'region-link';
        span.addEventListener('click', () => this.onRegionClick(part));
        li.appendChild(span);
      } else {
        li.appendChild(document.createTextNode(part));
      }
    }
  }
}
