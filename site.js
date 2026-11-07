// Landing page scripts (moved out of index.html so the Content-Security-Policy can
// refuse inline scripts).
  // Tabs: without this script the tab bar stays hidden and every panel shows, so nothing is lost.
  (function () {
    var bar = document.querySelector('.tabs'); if (!bar) return;
    var tabs = [].slice.call(bar.querySelectorAll('[role=tab]'));
    function pick(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', on ? 'true' : 'false');
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
      });
      try { sessionStorage.setItem('hs-tab', tab.id); } catch (e) {}
      if (focus) tab.focus();
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { pick(t); });
      t.addEventListener('keydown', function (e) {
        var n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
        if (n === null) return;
        e.preventDefault();
        pick(tabs[(n + tabs.length) % tabs.length], true);
      });
    });
    bar.hidden = false;
    var saved = null;
    try { saved = document.getElementById(sessionStorage.getItem('hs-tab')); } catch (e) {}
    pick(tabs.indexOf(saved) > -1 ? saved : tabs[0]);
  })();

  // Refresh: return to the same spot. Kept only for this tab and never sent anywhere.
  (function () {
    var y = null;
    try { y = sessionStorage.getItem('hs-y'); } catch (e) {}
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    function go() { if (y !== null) scrollTo({ top: +y, behavior: 'instant' }); }
    function save() { try { sessionStorage.setItem('hs-y', String(Math.round(scrollY))); } catch (e) {} }
    go();
    addEventListener('load', function () {
      go();
      y = null;
      var timer;
      addEventListener('scroll', function () { clearTimeout(timer); timer = setTimeout(save, 150); }, { passive: true });
    });
    addEventListener('pagehide', save);
  })();

  // Menu bar: a thin line appears once the page has scrolled, so the bar reads as separate from the content.
  (function () {
    var nav = document.querySelector('.nav');
    function mark() { nav.classList.toggle('is-stuck', scrollY > 8); }
    addEventListener('scroll', mark, { passive: true });
    mark();
  })();

  // Motion: everything is visible until this runs, and none of it runs under reduced motion.
  (function () {
    if (!window.IntersectionObserver || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    document.documentElement.classList.add('js');
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        e.target.classList.add('in');
        io.unobserve(e.target);
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -6% 0px' });
    document.querySelectorAll('.story h2, .chapter, .menu h2, .member-grid > div, .channels h2, .tile, .branch-grid > *, .card-mock').forEach(function (el) {
      if (!el.classList.contains('card-mock')) el.classList.add('reveal');
      if (el.classList.contains('tile')) el.style.setProperty('--i', [].indexOf.call(el.parentNode.parentNode.children, el.parentNode));
      io.observe(el);
    });
    var hand = document.querySelector('.hero-photo'), queued = false;
    if (innerWidth > 860) addEventListener('scroll', function () {
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        hand.style.translate = '0 ' + Math.round(-scrollY * 0.07) + 'px';
        queued = false;
      });
    }, { passive: true });
  })();

  /* The member card (member/) remembers who is signed in on this browser. */
  (function () {
    var m = null;
    try { m = JSON.parse(localStorage.getItem('hs-member')); } catch (e) { m = null; }
    if (!m || !m.first) return;
    document.querySelectorAll('[data-member-link]').forEach(function (a) { a.textContent = 'Kartu saya'; });
    var cta = document.querySelector('[data-member-cta]');
    if (cta) { cta.textContent = 'Buka kartu saya'; cta.setAttribute('href', 'member/'); }
    var hello = document.querySelector('[data-member-hello]');
    if (hello) {
      var ready = m.ready > 0 ? ', ' + m.ready + ' hadiah siap ditukar' : '';
      hello.textContent = 'Halo, ' + m.first + '. Kartu Kakak sudah ' + m.position + ' dari ' + m.size + ' stempel' + ready + '.';
      hello.hidden = false;
    }
  })();
