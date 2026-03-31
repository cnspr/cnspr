/**
 * statspanel.js — Chart.js graphs for world metrics over time.
 */
export class StatsPanel {
  constructor() {
    this._charts = {};
  }

  render(snapshots) {
    if (!snapshots.length) return;

    const labels = snapshots.map(s => `T${s.turn ?? '?'}`);

    this._make('chart-trust', 'Trust', labels,
      snapshots.map(s => s.trust ?? 0), '#7c5cbf');

    this._make('chart-belief', 'Belief Index', labels,
      snapshots.map(s => s.belief ?? 0), '#4a9eff');

    this._make('chart-army', 'Army Strength', labels,
      snapshots.map(s => s.army_strength ?? 0), '#e74c3c');

    this._make('chart-unrest', 'Avg Unrest', labels,
      snapshots.map(s => s.unrest ?? 0), '#e67e22');
  }

  _make(id, label, labels, data, color) {
    // Destroy old chart if it exists
    if (this._charts[id]) {
      this._charts[id].destroy();
    }

    const ctx = document.getElementById(id).getContext('2d');
    this._charts[id] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label,
          data,
          borderColor: color,
          backgroundColor: color + '22',
          borderWidth: 2,
          pointRadius: 3,
          tension: 0.3,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: '#d4d4e8', font: { size: 12 } } },
        },
        scales: {
          x: { ticks: { color: '#7878a0' }, grid: { color: '#2e2e42' } },
          y: { ticks: { color: '#7878a0' }, grid: { color: '#2e2e42' },
               min: 0 },
        },
      },
    });
  }
}
