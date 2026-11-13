// Owner sidebar: a collapsible icon rail like the VireoPOS back office (Glenn, 11 Nov 2026).
// Expanded, it is the grouped list from owner.js with an icon before each group. Collapsed,
// each group is one icon; a group with several items opens a small list beside the rail.
// Every choice clicks the real tab button, so tabs() in lib.js keeps the hash, aria-selected
// and loading. Under 56rem wide the CSS turns the menu into one scrolling row and hides all this.

const P = (d) => `<path d="${d}"/>`;

// Gear drawn from numbers: 8 teeth on a ring, a hole in the middle.
const gear = (() => {
  const pts = [];
  const n = 8, rOut = 10, rIn = 7.6, half = Math.PI / n;
  for (let i = 0; i < n; i++) {
    const a = (i * 2 * Math.PI) / n;
    [[a - half * 0.95, rIn], [a - half * 0.45, rOut], [a + half * 0.45, rOut], [a + half * 0.95, rIn]]
      .forEach(([t, r]) => pts.push(`${(12 + r * Math.cos(t)).toFixed(2)} ${(12 + r * Math.sin(t)).toFixed(2)}`));
  }
  return P(`M${pts.join('L')}Z`) + '<circle cx="12" cy="12" r="3"/>';
})();

const ICONS = {
  home: P('M3.5 10.5 12 3.5l8.5 7') + P('M5.5 9v10.5a1 1 0 0 0 1 1h3.5v-6h4v6h3.5a1 1 0 0 0 1-1V9'),
  doc: P('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z') + P('M14 3v5h5') + P('M9 13h6M9 17h6'),
  tag: P('M12.6 3H4a1 1 0 0 0-1 1v8.6a1 1 0 0 0 .3.7l8.4 8.4a1 1 0 0 0 1.4 0l8.6-8.6a1 1 0 0 0 0-1.4l-8.4-8.4a1 1 0 0 0-.7-.3z') + '<circle cx="7.5" cy="7.5" r="1.5"/>',
  box: P('M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7z') + P('M3.5 7 12 11.5 20.5 7M12 11.5v10'),
  stack: P('M12 3 3 7.5l9 4.5 9-4.5z') + P('m3 12 9 4.5 9-4.5') + P('m3 16.5 9 4.5 9-4.5'),
  person: '<circle cx="12" cy="8" r="4"/>' + P('M4 21a8 8 0 0 1 16 0'),
  team: '<circle cx="9" cy="8" r="3.5"/>' + P('M2.5 20.5a6.5 6.5 0 0 1 13 0') + P('M16 4.6a3.5 3.5 0 0 1 0 6.8') + P('M18 14.3a6.5 6.5 0 0 1 3.5 6.2'),
  gear,
  dot: '<rect x="4.5" y="4.5" width="15" height="15" rx="3"/>',
  // Laporan (bars), Transaksi (two arrows) and Akunting (open book), 12 Nov 2026.
  chart: P('M5 20V13') + P('M10 20V8') + P('M15 20v-9') + P('M20 20V5') + P('M3 20.5h18'),
  swap: P('M4 8h14l-3.5-3.5') + P('M20 16H6l3.5 3.5'),
  book: P('M12 6.5C10 5 7 4.5 3.5 5v13.5c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5z') + P('M12 6.5V20'),
};
const CHEV = P('m9 6 6 6-6 6');
const svg = (body, cls = 'side-i') => `<svg class="${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

// Until every group carries data-icon, guess from the heading or the first tab.
const GUESS = { beranda: 'home', ringkasan: 'home', penjualan: 'doc', promo: 'tag', produk: 'box', stok: 'stack', member: 'person', tim: 'team', pengaturan: 'gear',
  laporan: 'chart', transaksi: 'swap', akunting: 'book' };
const KEY = 'hs-owner-rail';
const store = { get() { try { return localStorage.getItem(KEY); } catch { return null; } }, set(v) { try { localStorage.setItem(KEY, v); } catch { /* private window */ } } };

let seq = 0;

export function sideRail(nav) {
  if (!nav || nav.dataset.rail) return;
  nav.dataset.rail = 'on';
  nav.id ||= 'owner-side';
  const shell = nav.parentElement;
  const label = (t) => (t.querySelector('.side-t')?.textContent || t.textContent).trim();

  const groups = [...nav.querySelectorAll('.side-g')].map((g) => {
    // Shortcut items (.side-link, owner.js) sit with the tabs: they open a view of another group.
    const tabs = [...g.querySelectorAll('[role="tab"], .side-link')];
    const head = g.querySelector('.side-h');
    const name = head ? head.textContent.trim() : label(tabs[0] || g);
    const key = (g.dataset.icon || GUESS[(g.dataset.group || '').toLowerCase()] || GUESS[name.toLowerCase().split(' ')[0]] || GUESS[tabs[0]?.dataset.tab] || 'dot');
    const icon = ICONS[key] || ICONS.dot;

    // Expanded: icon before the heading, or inside a heading-less group's only item.
    if (head) { head.insertAdjacentHTML('afterbegin', svg(icon)); g.classList.add('has-h'); }
    else tabs.forEach((t) => t.insertAdjacentHTML('afterbegin', svg(icon)));

    // Collapsed: one icon button per group, and a list for groups with several items.
    const id = `side-fly-${++seq}`;
    const multi = tabs.length > 1;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'side-rb';
    btn.dataset.tip = name;
    btn.setAttribute('aria-label', name);
    // Tiered menu (Glenn, 12 Nov 2026, like VireoPOS): open, the button is a row with the
    // group's name and a chevron, and its items open in the list beside it; in the rail only the icon shows.
    btn.innerHTML = `${svg(icon)}<span class="side-rb-t">${name.replace(/[<&>]/g, '')}</span>${multi ? svg(CHEV, 'side-rb-chev') : ''}`;
    if (multi) { btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', id); }
    g.prepend(btn);

    let fly = null;
    if (multi) {
      fly = document.createElement('div');
      fly.className = 'side-fly';
      fly.id = id;
      fly.hidden = true;
      fly.setAttribute('role', 'group');
      fly.setAttribute('aria-label', name);
      fly.innerHTML = `<p class="side-fly-h" aria-hidden="true">${name.replace(/[<&>]/g, '')}</p><ul>${tabs.map((t, i) => `<li><button type="button" data-i="${i}">${label(t).replace(/[<&>]/g, '')}</button></li>`).join('')}</ul>`;
      // On the page itself, not inside the sticky sidebar, so the content never paints over it.
      document.body.append(fly);
      fly.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-i]');
        if (!b) return;
        close(true);
        tabs[b.dataset.i].click();
      });
      fly.addEventListener('keydown', (e) => {
        const items = [...fly.querySelectorAll('button')];
        const i = items.indexOf(document.activeElement);
        const k = { ArrowDown: 1, ArrowUp: -1 }[e.key];
        if (k) { e.preventDefault(); items[(i + k + items.length) % items.length].focus(); }
        if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
        if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
      });
    }
    btn.addEventListener('click', () => {
      if (!multi) return tabs[0]?.click();
      if (open && open.btn === btn) return close(true);
      show({ btn, fly, tabs });
    });
    btn.addEventListener('keydown', (e) => {
      if (multi && (e.key === 'ArrowRight' || e.key === 'ArrowDown') && !(open && open.btn === btn)) { e.preventDefault(); show({ btn, fly, tabs }); }
    });
    return { g, btn, tabs };
  });

  // The open list, if any.
  let open = null;
  function place(o) {
    const r = o.btn.getBoundingClientRect();
    o.fly.style.left = `${Math.round(r.right + 12)}px`;
    const h = o.fly.offsetHeight;
    o.fly.style.top = `${Math.round(Math.max(8, Math.min(r.top, innerHeight - h - 8)))}px`;
  }
  function show(o) {
    close(false);
    open = o;
    o.fly.hidden = false;
    o.fly.classList.toggle('is-rail', nav.classList.contains('is-rail'));
    o.btn.setAttribute('aria-expanded', 'true');
    place(o);
    const cur = o.tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true' || t.getAttribute('aria-current') === 'page');
    const items = o.fly.querySelectorAll('button');
    items.forEach((b, i) => (i === cur ? b.setAttribute('aria-current', 'true') : b.removeAttribute('aria-current')));
    items[Math.max(0, cur)].focus();
  }
  function close(refocus) {
    if (!open) return;
    const o = open;
    open = null;
    o.fly.hidden = true;
    o.btn.setAttribute('aria-expanded', 'false');
    if (refocus) o.btn.focus();
  }
  document.addEventListener('pointerdown', (e) => { if (open && !open.fly.contains(e.target) && !open.btn.contains(e.target)) close(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { e.preventDefault(); close(true); } });
  nav.addEventListener('focusout', (e) => { if (open && e.relatedTarget && !open.fly.contains(e.relatedTarget) && e.relatedTarget !== open.btn) close(false); });
  addEventListener('resize', () => close(false));
  addEventListener('scroll', () => open && place(open), { passive: true });

  // Collapse / expand toggle at the top.
  const tog = document.createElement('button');
  tog.type = 'button';
  tog.className = 'side-tog';
  tog.setAttribute('aria-controls', nav.id);
  tog.innerHTML = svg(CHEV, 'side-chev');
  nav.prepend(tog);
  const set = (rail, save) => {
    close(false);
    nav.classList.toggle('is-rail', rail);
    shell?.classList.toggle('is-rail', rail);
    tog.setAttribute('aria-expanded', String(!rail));
    tog.setAttribute('aria-label', rail ? 'Buka menu' : 'Ciutkan menu');
    tog.dataset.tip = rail ? 'Buka menu' : 'Ciutkan menu';
    if (save) store.set(rail ? '1' : '0');
  };
  tog.addEventListener('click', () => set(!nav.classList.contains('is-rail'), true));
  // Starts collapsed like VireoPOS (Glenn, 11 Nov); an opened menu stays open on this device.
  set(store.get() !== '0', false);

  // Red tile on the group that holds the open tab.
  const mark = () => groups.forEach(({ btn, tabs }) => {
    const on = tabs.some((t) => t.getAttribute('aria-selected') === 'true');
    btn.classList.toggle('is-on', on);
    btn.setAttribute('aria-label', on ? `${btn.dataset.tip}, sedang dibuka` : btn.dataset.tip);
  });
  new MutationObserver(mark).observe(nav, { subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
  mark();
}
