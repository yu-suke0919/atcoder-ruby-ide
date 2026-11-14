// The settings of the gear (docs/ui.md#設定歯車), kept in the screen's storage like the pane sizes.
const $ = id => document.getElementById(id);

// Pane sizes and settings are conveniences of this screen, so storage that fails only loses them.
export const storage = {
  get: key => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key, value) => { try { localStorage.setItem(key, value); } catch {} }
};

/** Wires the settings dialog; returns whether to copy on a full match and how to load the domains. */
export function setupSettings(ide, openDialog) {
  // Settings (the gear): copying the code when a run makes every compared sample match is on
  // unless turned off (docs/ui.md).
  const COPY_ON_MATCH_KEY = 'atcoder-ide-copy-on-match';
  const copyOnMatch = () => storage.get(COPY_ON_MATCH_KEY) !== 'off';
  $('settings-open').addEventListener('click', () => {
    $('copy-on-match').checked = copyOnMatch();
    $('origin-message').textContent = '';
    renderOrigins();
    openDialog($('settings-dialog'));
  });
  $('copy-on-match').addEventListener('change', () => storage.set(COPY_ON_MATCH_KEY, $('copy-on-match').checked ? 'on' : 'off'));
  // Domains the browser may open besides AtCoder (D5). The app checks and keeps them as HTTPS
  // origins; what it accepts is saved, so a list it refuses never replaces the saved one.
  const ORIGINS_KEY = 'atcoder-ide-browser-origins';
  let browserOrigins = [];
  function renderOrigins() {
    const item = (origin, removable) => {
      const li = document.createElement('li');
      li.append(origin);
      const button = document.createElement('button');
      if (removable) {
        button.textContent = '削除';
        button.setAttribute('aria-label', `${origin} を削除`);
        button.addEventListener('click', () => setOrigins(browserOrigins.filter(o => o !== origin)).catch(error => { $('origin-message').textContent = error.message; }));
        li.append(button);
      } else {
        const fixed = document.createElement('span');
        fixed.className = 'subtle';
        fixed.textContent = '常に開ける';
        li.append(fixed);
      }
      return li;
    };
    $('browser-origins').replaceChildren(item('https://atcoder.jp', false), ...browserOrigins.map(origin => item(origin, true)));
  }
  async function setOrigins(origins) {
    browserOrigins = await ide.browserSetOrigins(origins);
    storage.set(ORIGINS_KEY, JSON.stringify(browserOrigins));
    renderOrigins();
  }
  async function loadOrigins() {
    let saved = [];
    try { saved = JSON.parse(storage.get(ORIGINS_KEY) ?? '[]'); } catch {}
    if (!Array.isArray(saved) || !saved.every(origin => typeof origin === 'string')) saved = [];
    // A saved list the app cannot read goes back to the default.
    await setOrigins(saved).catch(() => setOrigins([]));
  }
  $('origin-form').addEventListener('submit', async event => {
    event.preventDefault();
    const typed = $('origin-input').value;
    try {
      await setOrigins([...browserOrigins, typed]);
      $('origin-input').value = '';
      $('origin-message').textContent = '';
    } catch (error) { $('origin-message').textContent = error.message; }
  });
  $('settings-close').addEventListener('click', () => $('settings-dialog').close());
  return { copyOnMatch, loadOrigins };
}
