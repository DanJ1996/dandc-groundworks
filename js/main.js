/* D&C Groundworks — interactions */
(function () {
  'use strict';

  /* Sticky nav background on scroll + hide top contact bar */
  const nav = document.getElementById('nav');
  const topbar = document.querySelector('.topbar');
  const onScroll = () => {
    const scrolled = window.scrollY > 40;
    if (nav) nav.classList.toggle('scrolled', scrolled);
    if (topbar) topbar.classList.toggle('hide', scrolled);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* Mobile menu */
  const toggle = document.getElementById('navToggle');
  const links = document.getElementById('navLinks');
  if (toggle && links) {
    toggle.addEventListener('click', () => links.classList.toggle('open'));
    links.querySelectorAll('a').forEach(a => a.addEventListener('click', () => links.classList.remove('open')));
  }

  /* Reveal-on-scroll */
  const reveals = document.querySelectorAll('.reveal');
  const io = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.15 });
  reveals.forEach(r => io.observe(r));

  /* Count-up numbers */
  const counters = document.querySelectorAll('[data-count]');
  const cio = new IntersectionObserver((entries) => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const el = e.target;
      const target = parseFloat(el.getAttribute('data-count'));
      const dur = 1600;
      const start = performance.now();
      const tick = (now) => {
        const p = Math.min((now - start) / dur, 1);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(target * eased).toString();
        if (p < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      cio.unobserve(el);
    });
  }, { threshold: 0.6 });
  counters.forEach(c => cio.observe(c));

  /* Before/After drag sliders */
  function initBA(el) {
    const after = el.querySelector('.ba__after');
    const handle = el.querySelector('.ba__handle');
    if (!after || !handle) return;
    let dragging = false;

    const setPos = (clientX) => {
      const rect = el.getBoundingClientRect();
      let pct = ((clientX - rect.left) / rect.width) * 100;
      pct = Math.max(0, Math.min(100, pct));
      after.style.clipPath = `inset(0 0 0 ${pct}%)`;
      handle.style.left = pct + '%';
    };

    const down = (x) => { dragging = true; setPos(x); };
    const move = (x) => { if (dragging) setPos(x); };
    const up = () => { dragging = false; };

    el.addEventListener('mousedown', e => down(e.clientX));
    window.addEventListener('mousemove', e => move(e.clientX));
    window.addEventListener('mouseup', up);
    el.addEventListener('touchstart', e => down(e.touches[0].clientX), { passive: true });
    el.addEventListener('touchmove', e => move(e.touches[0].clientX), { passive: true });
    el.addEventListener('touchend', up);
  }
  document.querySelectorAll('[data-ba]').forEach(initBA);

  /* Build project panels from data/projects.json (if present) */
  const stage = document.getElementById('projectStage');
  if (stage) {
    fetch('data/projects.json')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => renderProjects(stage, data.projects || []))
      .catch(() => { /* keep the built-in sample panels */ });
  }

  function renderProjects(stage, projects) {
    if (!projects.length) return;
    stage.innerHTML = projects.map(p => `
      <section class="project">
        <div class="project__bg ${p.video || p.bgImage ? '' : 'project__bg--placeholder'}">
          ${p.video ? `<video autoplay muted loop playsinline><source src="${p.video}" type="video/mp4"></video>`
            : p.bgImage ? `<img src="${p.bgImage}" alt="">` : ''}
        </div>
        <div class="container">
          <div class="project__grid">
            <div class="reveal">
              <h2 class="project__title">${p.title}</h2>
              <div class="project__meta">${[p.location, p.type].filter(Boolean).join(' &middot; ')}</div>
              <p class="project__desc">${p.description || ''}</p>
              <div class="project__stats">
                ${(p.stats || []).map(s => `<div><div class="pstat__num" data-count="${s.value}">0</div><div class="pstat__label">${s.label}</div></div>`).join('')}
              </div>
            </div>
            <div class="reveal">
              <div class="ba" data-ba>
                ${!(p.before && p.after) ? '<div class="ba__placeholder">Add before &amp; after photos</div>' : ''}
                ${p.before ? `<img class="ba__before" src="${p.before}" alt="Before">` : ''}
                ${p.after ? `<img class="ba__after" src="${p.after}" alt="After">` : ''}
                <span class="ba__label ba__label--before">Before</span>
                <span class="ba__label ba__label--after">After</span>
                <div class="ba__handle"></div>
              </div>
            </div>
          </div>
        </div>
      </section>`).join('');

    // re-init dynamic elements
    stage.querySelectorAll('[data-ba]').forEach(initBA);
    stage.querySelectorAll('.reveal').forEach(r => io.observe(r));
    stage.querySelectorAll('[data-count]').forEach(c => cio.observe(c));
  }

  /* ---------- Live Projects weekly timeline ---------- */
  const liveStage = document.getElementById('liveStage');
  if (liveStage) {
    fetch('data/live.json')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(renderLive)
      .catch(() => {});
  }
  function esc(s){ return String(s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
  function renderLive(data) {
    // Support the multi-project shape (projects[]) and the old single-project shape
    let projects = data.projects;
    if (!projects) projects = data.project ? [Object.assign({}, data.project, { updates: data.updates || [] })] : [];
    if (!projects.length) return;

    liveStage.innerHTML = projects.map(renderProjectBlock).join('');
    liveStage.querySelectorAll('.reveal').forEach(r => io.observe(r));
    buildLightbox(liveStage.querySelectorAll('[data-zoom]'));
    liveStage.querySelectorAll('.wk__head').forEach(btn => {
      btn.addEventListener('click', () => {
        const open = btn.closest('.wk').classList.toggle('is-open');
        btn.setAttribute('aria-expanded', open);
      });
    });
  }

  function isVideo(u) { return !!(u && (u.video || /\.(mp4|webm|mov|m4v)$/i.test(u.image || ''))); }

  function renderProjectBlock(p) {
    const ups = p.updates || [];
    const firstPhoto = ups.find(u => u.image && !isVideo(u));
    const heroImg = p.image || (firstPhoto && firstPhoto.image) || '';
    const feature = `
      <div class="live__feature bg-blend">
        ${heroImg ? `<div class="bg-blend__media"><img src="${esc(heroImg)}" alt="" onerror="this.remove()"></div>` : ''}
        <div style="position:relative;z-index:1;">
          <span class="live__status"><span class="dot"></span>${esc(p.status || 'On Going')}</span>
          <h2 class="live__ptitle">${esc(p.title)}</h2>
          <div class="live__pmeta">${[p.location, p.type].filter(Boolean).map(esc).join(' &middot; ')}</div>
          <p class="live__psummary">${esc(p.summary)}</p>
        </div>
      </div>`;

    let body;
    if (ups.length) {
      // Group updates by their week label, preserving first-seen order
      const groups = [];
      const seen = {};
      ups.forEach(u => {
        const key = u.week || 'Update';
        if (!(key in seen)) { seen[key] = groups.length; groups.push({ week: key, items: [] }); }
        groups[seen[key]].items.push(u);
      });
      const panels = groups.map((g, gi) => {
        const open = gi === groups.length - 1; // most recent week expanded by default
        const wkNum = (String(g.week).match(/\d+/) || [gi + 1])[0];
        const cards = g.items.map(u => {
          const vid = u.video || (isVideo(u) ? u.image : '');
          const media = vid
            ? `<video class="tl-photo tl-video" src="${esc(vid)}"${u.poster ? ` poster="${esc(u.poster)}"` : ''} controls preload="metadata" playsinline></video>`
            : `<img class="tl-photo" src="${esc(u.image)}" alt="${esc(g.week)} — ${esc(u.caption)}" data-zoom onerror="this.style.display='none'">`;
          return `
          <div class="tl-card${vid ? ' tl-card--video' : ''}">
            ${media}
            <div class="tl-body"><div class="tl-cap">${esc(u.caption)}</div></div>
          </div>`;
        }).join('');
        return `
          <div class="wk reveal${open ? ' is-open' : ''}">
            <button type="button" class="wk__head" aria-expanded="${open}">
              <span class="wk__node">${String(wkNum).padStart(2, '0')}</span>
              <span class="wk__title">${esc(g.week)}</span>
              <span class="wk__meta">${g.items.length} ${g.items.length === 1 ? 'update' : 'updates'}</span>
              <span class="wk__chev" aria-hidden="true"></span>
            </button>
            <div class="wk__panel"><div class="wk__inner"><div class="wk__grid">${cards}</div></div></div>
          </div>`;
      }).join('');
      body = `<div class="wk-accordion">${panels}</div>`;
    } else {
      body = `<div class="wk-empty">Weekly updates coming soon.</div>`;
    }

    return `<div class="live-project reveal">${feature}${body}</div>`;
  }

  /* ---------- Projects gallery (grid + filter + lightbox) ---------- */
  const galleryStage = document.getElementById('galleryStage');
  if (galleryStage) {
    fetch('data/gallery.json')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        const items = (data.images || []).map(x => typeof x === 'string' ? { src: x, cat: '' } : x);
        galleryStage.innerHTML = items.map(it =>
          `<figure data-cat="${esc(it.cat || '')}"><img loading="lazy" src="${esc(it.src)}" alt="D&amp;C Groundworks project" data-zoom></figure>`).join('');
        buildLightbox(galleryStage.querySelectorAll('[data-zoom]'));
        buildGalleryFilter(galleryStage, items);
      })
      .catch(() => {});
  }
  function buildGalleryFilter(stage, items) {
    const bar = document.getElementById('galleryFilter');
    if (!bar) return;
    const labels = { commercial: 'Commercial', excavation: 'Excavation', foundations: 'Foundations', drainage: 'Drainage', driveways: 'Driveways & Patios', extensions: 'Extensions' };
    const order = ['commercial', 'excavation', 'foundations', 'drainage', 'driveways', 'extensions'];
    const present = order.filter(c => items.some(it => it.cat === c));
    if (!present.length) return;
    const cats = ['all', ...present];
    bar.innerHTML = cats.map((c, i) =>
      `<button class="gfilter${i === 0 ? ' active' : ''}" data-cat="${c}">${c === 'all' ? 'All' : labels[c]}</button>`).join('');
    const figs = [...stage.querySelectorAll('figure')];
    bar.addEventListener('click', e => {
      const b = e.target.closest('.gfilter');
      if (!b) return;
      bar.querySelectorAll('.gfilter').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      const cat = b.getAttribute('data-cat');
      figs.forEach(f => { f.style.display = (cat === 'all' || f.getAttribute('data-cat') === cat) ? '' : 'none'; });
    });
  }

  /* ---------- Shared lightbox ---------- */
  let lb, lbImg, lbCount, lbList = [], lbIndex = 0;
  function ensureLightbox() {
    if (lb) return;
    lb = document.createElement('div');
    lb.className = 'lightbox';
    lb.innerHTML = `
      <button class="lightbox__btn" aria-label="Close">&times;</button>
      <button class="lightbox__nav lightbox__prev" aria-label="Previous">&#8249;</button>
      <img alt="">
      <button class="lightbox__nav lightbox__next" aria-label="Next">&#8250;</button>
      <div class="lightbox__count"></div>`;
    document.body.appendChild(lb);
    lbImg = lb.querySelector('img');
    lbCount = lb.querySelector('.lightbox__count');
    const close = () => lb.classList.remove('open');
    lb.querySelector('.lightbox__btn').addEventListener('click', close);
    lb.addEventListener('click', e => { if (e.target === lb) close(); });
    lb.querySelector('.lightbox__prev').addEventListener('click', () => show(lbIndex - 1));
    lb.querySelector('.lightbox__next').addEventListener('click', () => show(lbIndex + 1));
    document.addEventListener('keydown', e => {
      if (!lb.classList.contains('open')) return;
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowLeft') show(lbIndex - 1);
      if (e.key === 'ArrowRight') show(lbIndex + 1);
    });
  }
  function show(i) {
    if (!lbList.length) return;
    lbIndex = (i + lbList.length) % lbList.length;
    lbImg.src = lbList[lbIndex];
    lbCount.textContent = `${lbIndex + 1} / ${lbList.length}`;
    lb.classList.add('open');
  }
  function buildLightbox(nodes) {
    ensureLightbox();
    const arr = [...nodes];
    lbList = arr.map(n => n.getAttribute('src'));
    arr.forEach((n, i) => n.addEventListener('click', () => show(i)));
  }
})();
