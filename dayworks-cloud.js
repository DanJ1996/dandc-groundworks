/* ==================================================================
   D&C Day Works — cloud layer (login + dashboard + role gating)
   Depends on: window.DW (from dayworks.html), window.DW_CONFIG, supabase-js
   If Supabase keys aren't filled in, this stays dormant and the sheet
   works exactly as before (fill / save-link / PDF / offline).
   ================================================================== */
(function(){
  "use strict";
  var cfg = window.DW_CONFIG || {};
  var configured =
    typeof cfg.SUPABASE_URL === 'string' && cfg.SUPABASE_URL.indexOf('http') === 0 &&
    typeof cfg.SUPABASE_ANON_KEY === 'string' && cfg.SUPABASE_ANON_KEY.length > 20 &&
    cfg.SUPABASE_URL.indexOf('PASTE') === -1 && cfg.SUPABASE_ANON_KEY.indexOf('PASTE') === -1;

  if (!configured) {
    console.info('[DayWorks] Cloud not configured — running in link-only mode.');
    return;
  }
  if (!window.supabase) { console.warn('[DayWorks] supabase-js failed to load.'); return; }

  function boot(){ if(window.DW) start(); else document.addEventListener('dw-ready', start, {once:true}); }

  function start(){
    var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,       // keep the session in localStorage
        autoRefreshToken: true,     // silently refresh so it doesn't expire while in use
        detectSessionInUrl: true,
        storageKey: 'dandc-auth'
      }
    });
    var session = null, profile = null, currentId = null, currentJob = null;
    var activeKind = 'dayworks';   // which module the user picked: 'dayworks' or 'variation'
    var EMBED = /[?&]embed=1/.test(location.search);  // running inside the Site Office as an iframe
    function kindLabel(k){ return k==='variation' ? 'Variation' : 'Day Works Sheet'; }
    function kindLabelPlural(k){ return k==='variation' ? 'Variations' : 'Day Works Sheets'; }

    injectStyles();
    var login = buildLogin();
    var menu  = buildMenu();
    var dash  = buildDashboard();
    var home  = buildHome();
    var jobView = buildJobView();

    /* -------- take over the Save button to save to the cloud -------- */
    DW.onSaveClick(saveToCloud);

    /* -------- auth flow -------- */
    sb.auth.getSession().then(function(r){ handleSession(r.data.session); });
    sb.auth.onAuthStateChange(function(_e, s){ handleSession(s); });

    function handleSession(s){
      session = s;
      if (!s) { profile = null; showLogin(); return; }
      loadProfile().then(function(){
        hideLogin();
        DW.setRole(profile.role);
        updateChip();
        if (EMBED) { routeEmbed(); return; }
        // land on the company home menu unless opening a specific shared-link sheet
        if (!currentId && !DW.hasHashData()) openMenu();
      });
    }

    /* -------- embedded mode: launched from the Site Office, go straight
       to the editor (new sheet for a job, or open an existing one). -------- */
    function routeEmbed(){
      document.body.classList.add('dw-embed');
      [login, menu, dash, home, jobView].forEach(function(o){ if(o) o.style.display='none'; });
      var p = {};
      location.hash.replace(/^#/,'').split('&').forEach(function(kv){
        if(!kv) return; var a = kv.split('='); p[a[0]] = decodeURIComponent((a[1]||'').replace(/\+/g,' '));
      });
      if (p.open){ openSheet(p.open); return; }
      activeKind = (p.mode || p.new) === 'variation' ? 'variation' : 'dayworks';
      if (p.job){
        sb.from('jobs').select('id, title, client, location').eq('id', p.job).single()
          .then(function(r){ currentJob = r.data || null; startNewSheet(currentJob); });
      } else {
        currentJob = p.project ? { title:p.project, client:p.client||'', location:p.location||'' } : null;
        startNewSheet(currentJob);
      }
    }
    function startNewSheet(job){
      currentId = null; DW.blank(); DW.setMode(activeKind);
      var pf = document.getElementById('f_project'); if(pf) pf.value = job ? (job.title||'') : '';
      var cf = document.getElementById('f_client');  if(cf && job && job.client) cf.value = job.client;
      var sf = document.getElementById('f_site');    if(sf && job && job.location) sf.value = job.location;
      window.scrollTo(0,0);
    }

    function loadProfile(){
      return sb.from('profiles').select('full_name, role').eq('id', session.user.id).single()
        .then(function(r){
          if (r.data) profile = r.data;
          else profile = { full_name: session.user.email, role: 'crew' };
        })
        .catch(function(){ profile = { full_name: session.user.email, role: 'crew' }; });
    }

    /* ================= LOGIN ================= */
    function buildLogin(){
      var el = document.createElement('div');
      el.className = 'dw-overlay'; el.id = 'dwLogin';
      el.innerHTML =
        '<div class="dw-card">'+
          '<div class="dw-logo"><img src="assets/logo.png" alt=""></div>'+
          '<h2>D&amp;C Groundworks &amp; Civils Ltd</h2>'+
          '<p class="dw-sub">Team sign-in</p>'+
          '<label>Email / username</label>'+
          '<input id="dwEmail" type="email" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="you@dandcgroundworks.co.uk">'+
          '<label>Password</label>'+
          '<div class="dw-passwrap">'+
            '<input id="dwPass" type="password" autocomplete="current-password" placeholder="Your password">'+
            '<button type="button" class="dw-eye" id="dwEye" aria-label="Show password">'+
              '<svg viewBox="0 0 24 24"><path d="M12 5c-5 0-9 4.5-10 7 1 2.5 5 7 10 7s9-4.5 10-7c-1-2.5-5-7-10-7zm0 11a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm0-2a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"/></svg>'+
            '</button>'+
          '</div>'+
          '<button class="dw-btn" id="dwSignin">Sign in</button>'+
          '<div class="dw-err" id="dwErr"></div>'+
        '</div>';
      document.body.appendChild(el);
      var email = el.querySelector('#dwEmail'), pass = el.querySelector('#dwPass'),
          btn = el.querySelector('#dwSignin'), err = el.querySelector('#dwErr');
      function submit(){
        err.textContent = ''; btn.disabled = true; btn.textContent = 'Signing in…';
        sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value })
          .then(function(r){
            btn.disabled = false; btn.textContent = 'Sign in';
            if (r.error) err.textContent = r.error.message || 'Sign-in failed';
            else pass.value = '';
          });
      }
      btn.addEventListener('click', submit);
      pass.addEventListener('keydown', function(e){ if(e.key==='Enter') submit(); });
      var eye = el.querySelector('#dwEye');
      eye.addEventListener('click', function(){
        var show = pass.type === 'password';
        pass.type = show ? 'text' : 'password';
        eye.classList.toggle('on', show);
        eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        pass.focus();
      });
      return el;
    }
    function showLogin(){ login.style.display='flex'; dash.style.display='none'; }
    function hideLogin(){ login.style.display='none'; }

    /* ================= TOP CHIP (user + nav) ================= */
    var chip = document.createElement('div');
    chip.className = 'dw-chip';
    chip.innerHTML =
      '<button class="dw-chip-btn" id="dwHomeBtn" title="Home">'+
        '<svg viewBox="0 0 24 24"><path d="M12 3l9 8h-3v9h-4v-6h-4v6H6v-9H3z"/></svg><span>Home</span></button>'+
      '<button class="dw-chip-btn" id="dwJobsBtn" title="Jobs">'+
        '<svg viewBox="0 0 24 24"><path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"/></svg><span>Jobs</span></button>'+
      '<button class="dw-chip-btn" id="dwSheetsBtn" title="All sheets">'+
        '<svg viewBox="0 0 24 24"><path d="M4 5h16v2H4V5zm0 6h16v2H4v-2zm0 6h16v2H4v-2z"/></svg><span>Sheets</span></button>'+
      '<span class="dw-user" id="dwUser"></span>'+
      '<button class="dw-chip-btn ghost" id="dwLogout" title="Sign out">'+
        '<svg viewBox="0 0 24 24"><path d="M16 13v-2H7V8l-5 4 5 4v-3h9zM20 3h-8v2h8v14h-8v2h8a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z"/></svg></button>';
    var tb = document.querySelector('.topbar'); if(tb) tb.appendChild(chip);
    chip.querySelector('#dwHomeBtn').addEventListener('click', openMenu);
    chip.querySelector('#dwJobsBtn').addEventListener('click', openHome);
    chip.querySelector('#dwSheetsBtn').addEventListener('click', openDashboard);
    chip.querySelector('#dwLogout').addEventListener('click', function(){
      sb.auth.signOut(); currentId=null; DW.blank();
    });
    function updateChip(){
      chip.querySelector('#dwUser').textContent =
        (profile.full_name||'') + (profile.role==='director' ? ' · Director' : '');
    }

    /* ================= DASHBOARD ================= */
    function buildDashboard(){
      var el = document.createElement('div');
      el.className = 'dw-overlay'; el.id = 'dwDash'; el.style.display='none';
      el.innerHTML =
        '<div class="dw-dash">'+
          '<div class="dw-dash-head">'+
            '<h2 id="dwDashTitle">My Sheets</h2>'+
            '<div class="dw-dash-actions">'+
              '<button class="dw-btn sm" id="dwNew">+ New sheet</button>'+
              '<button class="dw-btn sm ghost" id="dwClose">Close</button>'+
            '</div>'+
          '</div>'+
          '<input class="dw-search" id="dwSearch" placeholder="Search job, client or sheet no…">'+
          '<div class="dw-list" id="dwList"></div>'+
        '</div>';
      document.body.appendChild(el);
      el.querySelector('#dwClose').addEventListener('click', openMenu);
      el.querySelector('#dwNew').addEventListener('click', function(){
        currentId=null; DW.blank(); DW.setMode(activeKind); el.style.display='none'; DW.toast('New blank sheet');
      });
      el.querySelector('#dwSearch').addEventListener('input', function(){ renderList(this.value.trim().toLowerCase()); });
      return el;
    }

    var cacheRows = [];
    function openDashboard(){
      menu.style.display='none'; home.style.display='none'; jobView.style.display='none';
      dash.style.display='flex';
      dash.querySelector('#dwDashTitle').textContent = profile.role==='director' ? 'All Sheets' : 'My Sheets';
      dash.querySelector('#dwList').innerHTML = '<div class="dw-empty">Loading…</div>';
      sb.from('sheets')
        .select('id, project, client, sheet_no, work_date, day, grand, creator_name, updated_at, mode:data->>mode')
        .order('work_date', { ascending:false }).order('updated_at', { ascending:false })
        .then(function(r){
          cacheRows = r.data || [];
          renderList('');
        });
    }

    function renderList(q){
      var list = dash.querySelector('#dwList');
      var rows = cacheRows.filter(function(x){
        if(!q) return true;
        return ((x.project||'')+' '+(x.client||'')+' '+(x.sheet_no||'')+' '+(x.creator_name||'')).toLowerCase().indexOf(q)>-1;
      });
      if(!rows.length){ list.innerHTML = '<div class="dw-empty">No sheets yet. Tap “+ New sheet”.</div>'; return; }
      // group by project
      var groups = {};
      rows.forEach(function(x){ var k=x.project||'(No job named)'; (groups[k]=groups[k]||[]).push(x); });
      var html='';
      Object.keys(groups).forEach(function(job){
        html += '<div class="dw-group"><div class="dw-group-h">'+esc(job)+'</div>';
        groups[job].forEach(function(x){
          var date = x.work_date ? new Date(x.work_date+'T00:00').toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short'}) : '';
          var money = (profile.role==='director' && x.grand) ? '<span class="dw-money">£'+Number(x.grand).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})+'</span>' : '';
          var who = (profile.role==='director' && x.creator_name) ? '<span class="dw-who">'+esc(x.creator_name)+'</span>' : '';
          var badge = (x.mode==='variation') ? '<span class="dw-tag">Variation</span>' : '';
          html += '<div class="dw-row">'+
            '<button class="dw-item" data-id="'+x.id+'">'+
              '<div class="dw-item-main"><b>'+esc(x.sheet_no||'Sheet')+'</b>'+badge+(x.client?'<span class="dw-cl">'+esc(x.client)+'</span>':'')+'</div>'+
              '<div class="dw-item-meta">'+date+' '+who+'</div>'+ money +
            '</button>'+
            (profile.role==='director' ? '<button class="dw-del" data-delsheet="'+x.id+'" title="Delete">×</button>' : '')+
          '</div>';
        });
        html += '</div>';
      });
      list.innerHTML = html;
      Array.prototype.forEach.call(list.querySelectorAll('.dw-item'), function(b){
        b.addEventListener('click', function(){ openSheet(b.dataset.id); });
      });
      Array.prototype.forEach.call(list.querySelectorAll('[data-delsheet]'), function(b){
        b.addEventListener('click', function(){ deleteSheet(b.getAttribute('data-delsheet'), function(){ openDashboard(); }); });
      });
    }

    function deleteSheet(id, after){
      if(profile.role!=='director'){ DW.toast('Only directors can delete'); return; }
      if(!confirm('Delete this sheet for everyone? This cannot be undone.')) return;
      sb.from('sheets').delete().eq('id', id).then(function(r){
        if(r.error){ DW.toast('Delete failed: '+(r.error.message||'')); return; }
        if(currentId===id) currentId=null;
        DW.toast('Sheet deleted');
        if(after) after();
      });
    }

    function openSheet(id){
      dash.querySelector('#dwList').innerHTML = '<div class="dw-empty">Opening…</div>';
      sb.from('sheets').select('data').eq('id', id).single().then(function(r){
        if(r.error || !r.data){ DW.toast('Could not open sheet'); return; }
        currentId = id;
        DW.restore(r.data.data || {});
        menu.style.display='none'; home.style.display='none'; jobView.style.display='none'; dash.style.display='none';
        window.scrollTo(0,0);
        DW.toast('Sheet opened');
      });
    }

    /* ================= COMPANY HOME MENU ================= */
    function buildMenu(){
      var el = document.createElement('div');
      el.className = 'dw-overlay'; el.id = 'dwMenu'; el.style.display='none';
      el.innerHTML =
        '<div class="dw-dash">'+
          '<div class="dw-dash-head">'+
            '<h2>D&amp;C Groundworks &amp; Civils</h2>'+
            '<div class="dw-dash-actions">'+
              '<button class="dw-btn sm ghost" id="dwMenuClose">Close</button>'+
              '<button class="dw-btn sm ghost danger" id="dwMenuLogout">Sign out</button>'+
            '</div>'+
          '</div>'+
          '<div class="dw-menu-who" id="dwMenuWho"></div>'+
          '<p class="dw-menu-hi" id="dwMenuHi"></p>'+
          '<div class="dw-menu">'+
            '<button class="dw-tile" data-mod="dayworks">'+
              '<span class="dw-tile-ic"><svg viewBox="0 0 24 24"><path d="M6 2h9l5 5v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm8 1.5V8h4.5M8 13h8v1.5H8V13zm0 4h8v1.5H8V17z"/></svg></span>'+
              '<span class="dw-tile-tx"><b>Day Works Sheets</b><em>Fill in &amp; view day works</em></span>'+
              '<span class="dw-chev">\u203a</span></button>'+
            '<button class="dw-tile" data-mod="variation">'+
              '<span class="dw-tile-ic"><svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></span>'+
              '<span class="dw-tile-tx"><b>Variations</b><em>Record a change to the agreed works</em></span>'+
              '<span class="dw-chev">\u203a</span></button>'+
            '<button class="dw-tile" data-mod="hours">'+
              '<span class="dw-tile-ic"><svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm.9 5h-1.8v5.4l4.5 2.7.9-1.5-3.6-2.1z"/></svg></span>'+
              '<span class="dw-tile-tx"><b>Hours</b><em>Log your working hours</em></span>'+
              '<span class="dw-soon">Soon</span></button>'+
            '<button class="dw-tile" data-mod="holiday">'+
              '<span class="dw-tile-ic"><svg viewBox="0 0 24 24"><path d="M7 2h10a1 1 0 0 1 1 1v18l-6-3-6 3V3a1 1 0 0 1 1-1z"/></svg></span>'+
              '<span class="dw-tile-tx"><b>Holiday Request</b><em>Request time off</em></span>'+
              '<span class="dw-soon">Soon</span></button>'+
          '</div>'+
        '</div>';
      document.body.appendChild(el);
      el.querySelector('#dwMenuClose').addEventListener('click', function(){ el.style.display='none'; });
      el.querySelector('#dwMenuLogout').addEventListener('click', function(){
        sb.auth.signOut(); currentId=null; DW.blank();
      });
      Array.prototype.forEach.call(el.querySelectorAll('.dw-tile'), function(b){
        b.addEventListener('click', function(){
          var mod = b.dataset.mod;
          if (mod==='dayworks') { activeKind='dayworks'; openHome(); }
          else if (mod==='variation') { activeKind='variation'; openHome(); }
          else if (mod==='hours') DW.toast('Hours — coming soon');
          else if (mod==='holiday') DW.toast('Holiday requests — coming soon');
        });
      });
      return el;
    }

    function openMenu(){
      dash.style.display='none'; home.style.display='none'; jobView.style.display='none';
      menu.querySelector('#dwMenuHi').textContent =
        'Hi ' + ((profile.full_name||'').split(' ')[0] || 'there') + ' — what do you need?';
      menu.querySelector('#dwMenuWho').textContent =
        (profile.full_name||'') + (profile.role==='director' ? ' · Director' : ' · Crew');
      menu.style.display='flex';
    }

    /* ================= JOBS HOME ================= */
    function buildHome(){
      var el = document.createElement('div');
      el.className = 'dw-overlay'; el.id = 'dwHome'; el.style.display='none';
      el.innerHTML =
        '<div class="dw-dash">'+
          '<div class="dw-dash-head">'+
            '<h2 id="dwHomeTitle">Jobs</h2>'+
            '<div class="dw-dash-actions">'+
              '<button class="dw-btn sm" id="dwNewJob">+ New job</button>'+
              '<button class="dw-btn sm ghost" id="dwHomeClose">Close</button>'+
            '</div>'+
          '</div>'+
          '<div class="dw-newjob" id="dwNewJobForm">'+
            '<input id="njTitle" placeholder="Job title (e.g. Lyndhurst Park Hotel)" autocapitalize="words">'+
            '<input id="njClient" placeholder="Client (optional)">'+
            '<input id="njLoc" placeholder="Location (optional)">'+
            '<div class="dw-newjob-actions">'+
              '<button class="dw-btn sm" id="njCreate">Create job</button>'+
              '<button class="dw-btn sm ghost" id="njCancel">Cancel</button>'+
            '</div>'+
            '<div class="dw-err dark" id="njErr"></div>'+
          '</div>'+
          '<input class="dw-search" id="dwJobSearch" placeholder="Search jobs…">'+
          '<div class="dw-list" id="dwJobList"></div>'+
        '</div>';
      document.body.appendChild(el);
      el.querySelector('#dwHomeClose').addEventListener('click', openMenu);
      var form = el.querySelector('#dwNewJobForm');
      el.querySelector('#dwNewJob').addEventListener('click', function(){
        form.classList.add('show'); el.querySelector('#njErr').textContent=''; el.querySelector('#njTitle').focus();
      });
      el.querySelector('#njCancel').addEventListener('click', function(){ form.classList.remove('show'); });
      el.querySelector('#njCreate').addEventListener('click', createJob);
      el.querySelector('#njTitle').addEventListener('keydown', function(e){ if(e.key==='Enter') createJob(); });
      el.querySelector('#dwJobSearch').addEventListener('input', function(){ renderJobs(this.value.trim().toLowerCase()); });
      return el;
    }

    var cacheJobs = [];
    function openHome(){
      menu.style.display='none'; dash.style.display='none'; jobView.style.display='none';
      home.style.display='flex';
      home.querySelector('#dwHomeTitle').textContent = 'Jobs — ' + kindLabelPlural(activeKind);
      home.querySelector('#dwNewJobForm').classList.remove('show');
      home.querySelector('#dwJobList').innerHTML = '<div class="dw-empty">Loading…</div>';
      sb.from('jobs').select('id, title, client, location, creator_name, created_at')
        .order('created_at', { ascending:false })
        .then(function(r){ cacheJobs = r.data || []; renderJobs(''); });
    }

    function createJob(){
      var t = home.querySelector('#njTitle').value.trim();
      var err = home.querySelector('#njErr');
      if(!t){ err.textContent = 'Please enter a job title'; return; }
      var rec = {
        title: t,
        client: home.querySelector('#njClient').value.trim() || null,
        location: home.querySelector('#njLoc').value.trim() || null,
        created_by: session.user.id,
        creator_name: profile.full_name
      };
      err.textContent = '';
      sb.from('jobs').insert(rec).select('*').single().then(function(r){
        if(r.error){ err.textContent = 'Could not create: '+(r.error.message||''); return; }
        home.querySelector('#njTitle').value=''; home.querySelector('#njClient').value=''; home.querySelector('#njLoc').value='';
        home.querySelector('#dwNewJobForm').classList.remove('show');
        cacheJobs.unshift(r.data);
        renderJobs('');
        DW.toast('Job created');
      });
    }

    function renderJobs(q){
      var list = home.querySelector('#dwJobList');
      var rows = cacheJobs.filter(function(x){
        if(!q) return true;
        return ((x.title||'')+' '+(x.client||'')+' '+(x.location||'')).toLowerCase().indexOf(q)>-1;
      });
      if(!rows.length){ list.innerHTML = '<div class="dw-empty">No jobs yet. Tap “+ New job” to add one.</div>'; return; }
      var html='';
      rows.forEach(function(x){
        var meta = [x.client, x.location].filter(Boolean).map(esc).join(' · ');
        html += '<div class="dw-row">'+
          '<button class="dw-item dw-jobitem" data-job="'+x.id+'">'+
            '<div class="dw-item-main"><b>'+esc(x.title)+'</b></div>'+
            (meta?'<div class="dw-item-meta">'+meta+'</div>':'')+
            '<span class="dw-chev">›</span>'+
          '</button>'+
          (profile.role==='director' ? '<button class="dw-del" data-deljob="'+x.id+'" title="Delete job">×</button>' : '')+
        '</div>';
      });
      list.innerHTML = html;
      Array.prototype.forEach.call(list.querySelectorAll('.dw-jobitem'), function(b){
        b.addEventListener('click', function(){
          var job = cacheJobs.filter(function(j){return j.id===b.dataset.job;})[0];
          if(job) openJob(job);
        });
      });
      Array.prototype.forEach.call(list.querySelectorAll('[data-deljob]'), function(b){
        b.addEventListener('click', function(){ deleteJob(b.getAttribute('data-deljob')); });
      });
    }

    function deleteJob(id){
      if(profile.role!=='director'){ DW.toast('Only directors can delete'); return; }
      var job = cacheJobs.filter(function(j){return j.id===id;})[0];
      if(!confirm('Delete '+(job?('“'+job.title+'”'):'this job')+' and all its drawings for everyone?\n(The day works sheets stay saved.) This cannot be undone.')) return;
      sb.from('jobs').delete().eq('id', id).then(function(r){
        if(r.error){ DW.toast('Delete failed: '+(r.error.message||'')); return; }
        cacheJobs = cacheJobs.filter(function(j){return j.id!==id;});
        renderJobs(home.querySelector('#dwJobSearch').value.trim().toLowerCase());
        DW.toast('Job deleted');
      });
    }

    /* ================= JOB DETAIL (drawings + sheets) ================= */
    function buildJobView(){
      var el = document.createElement('div');
      el.className = 'dw-overlay'; el.id = 'dwJob'; el.style.display='none';
      el.innerHTML =
        '<div class="dw-dash">'+
          '<div class="dw-dash-head">'+
            '<button class="dw-back" id="jvBack">‹ Jobs</button>'+
            '<h2 id="jvTitle"></h2>'+
            '<div class="dw-dash-actions"><button class="dw-btn sm ghost" id="jvClose">Close</button></div>'+
          '</div>'+
          '<div class="dw-jobbody">'+
            '<div class="dw-sec">'+
              '<div class="dw-sec-h">Drawings &amp; Info'+
                '<span id="jvUpload" class="dw-upwrap"></span>'+
              '</div>'+
              '<div class="dw-files" id="jvFiles"></div>'+
            '</div>'+
            '<div class="dw-sec">'+
              '<div class="dw-sec-h"><span id="jvSheetsHead">Day Works Sheets</span>'+
                '<button class="dw-btn sm" id="jvNewSheet">+ New</button>'+
              '</div>'+
              '<div class="dw-list" id="jvSheets"></div>'+
            '</div>'+
          '</div>'+
        '</div>';
      document.body.appendChild(el);
      el.querySelector('#jvBack').addEventListener('click', openHome);
      el.querySelector('#jvClose').addEventListener('click', openMenu);
      el.querySelector('#jvNewSheet').addEventListener('click', function(){
        currentId = null; DW.blank(); DW.setMode(activeKind);
        var pf = document.getElementById('f_project'); if(pf) pf.value = currentJob ? currentJob.title : '';
        var cf = document.getElementById('f_client'); if(cf && currentJob && currentJob.client) cf.value = currentJob.client;
        el.style.display='none'; window.scrollTo(0,0);
        DW.toast('New '+kindLabel(activeKind).toLowerCase()+' for '+(currentJob?currentJob.title:'job'));
      });
      return el;
    }

    function openJob(job){
      currentJob = job;
      jobView.style.display='flex'; home.style.display='none';
      jobView.querySelector('#jvTitle').textContent = job.title;
      jobView.querySelector('#jvSheetsHead').textContent = kindLabelPlural(activeKind);
      // director-only upload control
      var up = jobView.querySelector('#jvUpload');
      if(profile.role==='director'){
        up.innerHTML = '<button class="dw-btn sm" id="jvUpBtn">+ Upload</button>'+
          '<input type="file" id="jvFile" multiple style="display:none" accept="application/pdf,image/*">';
        up.querySelector('#jvUpBtn').addEventListener('click', function(){ up.querySelector('#jvFile').click(); });
        up.querySelector('#jvFile').addEventListener('change', function(){ uploadFiles(this.files); this.value=''; });
      } else { up.innerHTML=''; }
      loadFiles(job.id);
      loadJobSheets(job.title);
    }

    function loadFiles(jobId){
      var box = jobView.querySelector('#jvFiles');
      box.innerHTML = '<div class="dw-empty sm">Loading…</div>';
      sb.from('job_files').select('id, name, path, mime, created_at').eq('job_id', jobId)
        .order('created_at', { ascending:false })
        .then(function(r){ renderFiles(r.data || []); });
    }

    function renderFiles(files){
      var box = jobView.querySelector('#jvFiles');
      if(!files.length){
        box.innerHTML = '<div class="dw-empty sm">'+(profile.role==='director'
          ? 'No drawings yet. Tap “+ Upload” to add PDFs or images.'
          : 'No drawings uploaded yet.')+'</div>';
        return;
      }
      var html='';
      files.forEach(function(f){
        var isImg = (f.mime||'').indexOf('image/')===0;
        var icon = isImg
          ? '<path d="M21 19V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8.5 13.5l2.5 3 3.5-4.5 4.5 6H5l3.5-4.5z"/>'
          : '<path d="M6 2h9l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm8 1.5V8h4.5L14 3.5z"/>';
        html += '<div class="dw-file" data-id="'+f.id+'" data-path="'+esc(f.path)+'">'+
            '<svg viewBox="0 0 24 24">'+icon+'</svg>'+
            '<span class="dw-file-name">'+esc(f.name)+'</span>'+
            '<button class="dw-file-open" data-open="'+esc(f.path)+'">Open</button>'+
            (profile.role==='director' ? '<button class="dw-file-del" data-del="'+f.id+'" data-delpath="'+esc(f.path)+'" title="Delete">×</button>' : '')+
          '</div>';
      });
      box.innerHTML = html;
      Array.prototype.forEach.call(box.querySelectorAll('[data-open]'), function(b){
        b.addEventListener('click', function(){ openFile(b.getAttribute('data-open')); });
      });
      Array.prototype.forEach.call(box.querySelectorAll('[data-del]'), function(b){
        b.addEventListener('click', function(){ deleteFile(b.getAttribute('data-del'), b.getAttribute('data-delpath')); });
      });
    }

    function openFile(path){
      sb.storage.from('job-files').createSignedUrl(path, 3600).then(function(r){
        if(r.error || !r.data){ DW.toast('Could not open file'); return; }
        window.open(r.data.signedUrl, '_blank');
      });
    }

    function uploadFiles(files){
      if(!files || !files.length) return;
      var jobId = currentJob.id, done=0, total=files.length;
      DW.toast('Uploading '+total+' file'+(total>1?'s':'')+'…');
      Array.prototype.forEach.call(files, function(file){
        var safe = file.name.replace(/[^a-zA-Z0-9._-]+/g,'_');
        var path = jobId + '/' + Date.now() + '-' + safe;
        sb.storage.from('job-files').upload(path, file, { contentType: file.type || 'application/octet-stream' })
          .then(function(up){
            if(up.error){ DW.toast('Upload failed: '+(up.error.message||'')); return; }
            return sb.from('job_files').insert({
              job_id: jobId, name: file.name, path: path, mime: file.type || null, size: file.size || null
            });
          })
          .then(function(){ done++; if(done===total){ DW.toast('Uploaded ✓'); loadFiles(jobId); } });
      });
    }

    function deleteFile(id, path){
      if(!confirm('Delete this file for everyone?')) return;
      sb.storage.from('job-files').remove([path]).then(function(){
        return sb.from('job_files').delete().eq('id', id);
      }).then(function(){ DW.toast('File deleted'); loadFiles(currentJob.id); });
    }

    function loadJobSheets(title){
      var box = jobView.querySelector('#jvSheets');
      var kind = activeKind;
      box.innerHTML = '<div class="dw-empty sm">Loading…</div>';
      sb.from('sheets').select('id, sheet_no, client, work_date, grand, creator_name, updated_at, mode:data->>mode')
        .eq('project', title)
        .order('work_date', { ascending:false }).order('updated_at', { ascending:false })
        .then(function(r){
          var rows = (r.data || []).filter(function(x){ return (x.mode||'dayworks')===kind; });
          if(!rows.length){ box.innerHTML = '<div class="dw-empty sm">No '+kindLabelPlural(kind).toLowerCase()+' yet. Tap “+ New”.</div>'; return; }
          var html='';
          rows.forEach(function(x){
            var date = x.work_date ? new Date(x.work_date+'T00:00').toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short'}) : '';
            // money ONLY for directors — crew never see a cost
            var money = (profile.role==='director' && x.grand) ? '<span class="dw-money">£'+Number(x.grand).toLocaleString('en-GB',{minimumFractionDigits:2,maximumFractionDigits:2})+'</span>' : '';
            var who = (profile.role==='director' && x.creator_name) ? '<span class="dw-who">'+esc(x.creator_name)+'</span>' : '';
            html += '<div class="dw-row">'+
              '<button class="dw-item" data-id="'+x.id+'">'+
                '<div class="dw-item-main"><b>'+esc(x.sheet_no||kindLabel(kind))+'</b></div>'+
                '<div class="dw-item-meta">'+date+' '+who+'</div>'+ money +
              '</button>'+
              (profile.role==='director' ? '<button class="dw-del" data-delsheet="'+x.id+'" title="Delete">×</button>' : '')+
            '</div>';
          });
          box.innerHTML = html;
          Array.prototype.forEach.call(box.querySelectorAll('.dw-item'), function(b){
            b.addEventListener('click', function(){ jobView.style.display='none'; openSheet(b.dataset.id); });
          });
          Array.prototype.forEach.call(box.querySelectorAll('[data-delsheet]'), function(b){
            b.addEventListener('click', function(){ deleteSheet(b.getAttribute('data-delsheet'), function(){ loadJobSheets(title); }); });
          });
        });
    }

    /* ================= SAVE ================= */
    function saveToCloud(){
      if(!session){ showLogin(); return; }
      var m = DW.meta();
      var rec = {
        creator_name: profile.full_name,
        project: m.project || null,
        client: m.client || null,
        sheet_no: m.sheet || null,
        work_date: m.date || null,
        day: m.day || null,
        grand: m.grand || 0,
        data: DW.collect(),
        updated_at: new Date().toISOString()
      };
      var p;
      if(currentId){
        p = sb.from('sheets').update(rec).eq('id', currentId).select('id').single();
      } else {
        rec.created_by = session.user.id;
        p = sb.from('sheets').insert(rec).select('id').single();
      }
      p.then(function(r){
        if(r.error){ DW.toast('Save failed: '+(r.error.message||'')); return; }
        if(r.data) currentId = r.data.id;
        DW.toast('Saved to cloud ✓');
        if(EMBED && window.parent !== window){
          try { window.parent.postMessage({ dwSaved:true, id:currentId, mode:DW.meta().mode, project:DW.meta().project }, location.origin); } catch(e){}
        }
      });
    }

    function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];}); }
  }

  /* ================= styles ================= */
  function injectStyles(){
    var css =
    '.dw-embed .topbar,.dw-embed .install,.dw-embed #dwChip{display:none!important}'+
    '.dw-embed .wrap{padding-top:10px}'+
    '.dw-overlay{position:fixed;inset:0;z-index:200;background:linear-gradient(160deg,#273E57,#1B2C3E);'+
      'display:none;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 14px;font-family:Montserrat,sans-serif}'+
    '.dw-card{width:100%;max-width:380px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);'+
      'border-radius:18px;padding:30px 24px;text-align:center;margin-top:8vh;box-shadow:0 24px 60px rgba(0,0,0,.4)}'+
    '.dw-logo{width:84px;height:84px;border-radius:50%;background:#EDE7DF;margin:0 auto 16px;overflow:hidden;display:flex;align-items:center;justify-content:center}'+
    '.dw-logo img{width:100%;height:100%;object-fit:contain}'+
    '.dw-card h2{font-family:Oswald,sans-serif;color:#fff;font-size:1.35rem;letter-spacing:.5px}'+
    '.dw-sub{color:#D8CFC2;font-size:.8rem;margin:4px 0 20px}'+
    '.dw-card label{display:block;text-align:left;color:#D8CFC2;font-size:.68rem;font-weight:700;letter-spacing:.6px;text-transform:uppercase;margin:12px 0 5px}'+
    '.dw-card input{width:100%;padding:12px;border-radius:9px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.95);font-size:1rem;color:#222831}'+
    '.dw-passwrap{position:relative}'+
    '.dw-passwrap input{padding-right:46px}'+
    '.dw-eye{position:absolute;top:0;right:0;height:100%;width:44px;display:flex;align-items:center;justify-content:center;'+
      'background:transparent;border:none;cursor:pointer;padding:0}'+
    '.dw-eye svg{width:22px;height:22px;fill:#8a95a1}'+
    '.dw-eye.on svg{fill:#273E57}'+
    '.dw-btn{width:100%;margin-top:20px;padding:13px;border:none;border-radius:11px;background:#E08A2B;color:#fff;'+
      'font-family:Oswald,sans-serif;font-weight:600;font-size:1rem;letter-spacing:.6px;text-transform:uppercase;cursor:pointer}'+
    '.dw-btn:disabled{opacity:.6}'+
    '.dw-btn.sm{width:auto;margin:0;padding:9px 14px;font-size:.82rem;border-radius:9px}'+
    '.dw-btn.ghost{background:transparent;border:1px solid rgba(255,255,255,.35)}'+
    '.dw-err{color:#ffb4b4;font-size:.82rem;margin-top:12px;min-height:16px}'+
    /* chip */
    '.dw-chip{display:flex;align-items:center;gap:8px;margin-left:auto}'+
    '.dw-chip-btn{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.12);color:#fff;'+
      'border:1px solid rgba(255,255,255,.2);border-radius:999px;padding:7px 12px;font-size:.8rem;font-weight:600;cursor:pointer}'+
    '.dw-chip-btn svg{width:16px;height:16px;fill:#fff}'+
    '.dw-chip-btn.ghost{padding:7px 9px}'+
    '.dw-user{color:#EDE7DF;font-size:.74rem;font-weight:600;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'+
    '@media(max-width:560px){.dw-user{display:none}.dw-chip-btn span{display:none}}'+
    /* dashboard */
    '.dw-dash{width:100%;max-width:720px;background:#F7F4EF;border-radius:16px;margin-top:4vh;overflow:hidden;box-shadow:0 24px 60px rgba(0,0,0,.4)}'+
    '.dw-dash-head{display:flex;align-items:center;gap:10px;background:#273E57;color:#fff;padding:14px 18px}'+
    '.dw-dash-head h2{font-family:Oswald,sans-serif;font-size:1.15rem;letter-spacing:.5px;flex:1}'+
    '.dw-dash-actions{display:flex;gap:8px}'+
    /* home menu */
    '.dw-btn.sm.ghost.danger{border-color:rgba(255,140,140,.6);color:#ffb0b0}'+
    '.dw-menu-who{display:flex;align-items:center;gap:8px;padding:14px 18px 0;color:#273E57;font-weight:700;font-size:.9rem}'+
    '.dw-menu-who:before{content:"";width:9px;height:9px;border-radius:50%;background:#57d38a;flex:none;box-shadow:0 0 0 3px rgba(87,211,138,.25)}'+
    '.dw-menu-hi{font-family:Oswald,sans-serif;color:#3E5975;font-size:1rem;padding:6px 18px 4px}'+
    '.dw-menu{padding:8px 14px 18px;display:grid;gap:10px}'+
    '.dw-tile{display:flex;align-items:center;gap:14px;text-align:left;background:#fff;border:1px solid #c7d1dd;'+
      'border-radius:12px;padding:16px;cursor:pointer}'+
    '.dw-tile:active{transform:scale(.995)}'+
    '.dw-tile-ic{width:44px;height:44px;flex:none;border-radius:10px;background:#273E57;display:flex;align-items:center;justify-content:center}'+
    '.dw-tile-ic svg{width:24px;height:24px;fill:#EDE7DF}'+
    '.dw-tile-tx{flex:1;display:flex;flex-direction:column}'+
    '.dw-tile-tx b{font-family:Oswald,sans-serif;font-size:1.02rem;color:#222831;letter-spacing:.3px}'+
    '.dw-tile-tx em{font-style:normal;color:#3E5975;font-size:.8rem;margin-top:2px}'+
    '.dw-soon{background:#EDE7DF;color:#3E5975;font-size:.68rem;font-weight:700;letter-spacing:.5px;'+
      'text-transform:uppercase;border-radius:999px;padding:3px 9px}'+
    '.dw-search{width:calc(100% - 28px);margin:14px;padding:11px 12px;border:1px solid #c7d1dd;border-radius:9px;font-size:.95rem;background:#fff}'+
    '.dw-list{padding:0 14px 18px;max-height:62vh;overflow:auto}'+
    '.dw-group{margin-bottom:16px}'+
    '.dw-group-h{font-family:Oswald,sans-serif;color:#273E57;font-size:.95rem;letter-spacing:.4px;padding:6px 2px;border-bottom:2px solid #D8CFC2;margin-bottom:8px}'+
    '.dw-item{width:100%;display:grid;grid-template-columns:1fr auto;gap:4px 12px;align-items:center;text-align:left;'+
      'background:#fff;border:1px solid #c7d1dd;border-radius:10px;padding:11px 14px;margin-bottom:8px;cursor:pointer}'+
    '.dw-item:active{transform:scale(.995)}'+
    '.dw-item-main b{font-size:.95rem;color:#222831}'+
    '.dw-item-main .dw-cl{color:#3E5975;font-size:.82rem;margin-left:8px}'+
    '.dw-item-meta{grid-column:1;color:#3E5975;font-size:.76rem}'+
    '.dw-who{background:#EDE7DF;border-radius:999px;padding:1px 8px;margin-left:6px;font-weight:600}'+
    '.dw-money{grid-column:2;grid-row:1 / span 2;font-family:Oswald,sans-serif;font-weight:600;color:#273E57;font-size:1rem}'+
    '.dw-empty{text-align:center;color:#3E5975;padding:30px 10px;font-size:.9rem}'+
    '.dw-empty.sm{padding:16px 10px;font-size:.82rem}'+
    '.dw-chev{grid-column:2;grid-row:1 / span 2;color:#9bb0c6;font-size:1.4rem;line-height:1}'+
    /* new job form */
    '.dw-newjob{display:none;margin:0 14px 4px;background:#fff;border:1px solid #c7d1dd;border-radius:11px;padding:12px}'+
    '.dw-newjob.show{display:block}'+
    '.dw-newjob input{width:100%;box-sizing:border-box;padding:10px 11px;margin-bottom:8px;border:1px solid #c7d1dd;border-radius:8px;font-size:.95rem;background:#fff}'+
    '.dw-newjob-actions{display:flex;gap:8px}'+
    '.dw-err.dark{color:#c0392b}'+
    /* job detail */
    '.dw-back{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);color:#fff;border-radius:999px;padding:6px 12px;font-size:.82rem;font-weight:600;cursor:pointer}'+
    '.dw-jobbody{padding:14px;max-height:72vh;overflow:auto}'+
    '.dw-sec{margin-bottom:18px}'+
    '.dw-sec-h{display:flex;align-items:center;justify-content:space-between;font-family:Oswald,sans-serif;color:#273E57;font-size:1rem;letter-spacing:.4px;padding:6px 2px;border-bottom:2px solid #D8CFC2;margin-bottom:10px}'+
    '.dw-upwrap{display:inline-flex}'+
    '.dw-files{display:flex;flex-direction:column;gap:8px}'+
    '.dw-file{display:flex;align-items:center;gap:10px;background:#fff;border:1px solid #c7d1dd;border-radius:10px;padding:10px 12px}'+
    '.dw-file svg{width:22px;height:22px;fill:#273E57;flex:none}'+
    '.dw-file-name{flex:1;font-size:.9rem;color:#222831;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'+
    '.dw-file-open{background:#273E57;color:#fff;border:none;border-radius:8px;padding:7px 14px;font-size:.8rem;font-weight:600;cursor:pointer}'+
    '.dw-file-del{background:#f3e6e6;color:#c0392b;border:none;border-radius:8px;width:30px;height:30px;font-size:1.1rem;line-height:1;cursor:pointer}'+
    /* list row + director delete button */
    '.dw-row{display:flex;gap:8px;align-items:stretch;margin-bottom:8px}'+
    '.dw-row .dw-item{flex:1;margin-bottom:0}'+
    '.dw-del{flex:none;width:42px;border:1px solid #e7cccc;background:#f8ecec;color:#c0392b;border-radius:10px;font-size:1.4rem;line-height:1;cursor:pointer}'+
    '.dw-del:active{transform:scale(.96)}'+
    '.dw-tag{display:inline-block;background:#E08A2B;color:#fff;font-size:.6rem;font-weight:700;letter-spacing:.5px;text-transform:uppercase;border-radius:999px;padding:2px 7px;margin-left:8px;vertical-align:middle}'+
    '@media print{.dw-overlay,.dw-chip{display:none !important}}';
    var s = document.createElement('style'); s.textContent = css; document.head.appendChild(s);
  }

  boot();
})();
