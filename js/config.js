/** Config — stored in localStorage */
export const Config = {
  KEY: 'conspiracy_config',

  load() {
    const raw = localStorage.getItem(this.KEY);
    return raw ? JSON.parse(raw) : null;
  },

  save(cfg) {
    localStorage.setItem(this.KEY, JSON.stringify(cfg));
  },

  clear() {
    localStorage.removeItem(this.KEY);
  },
};
