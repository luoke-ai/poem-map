/* 古诗地图 · 交互
 * 依赖：leaflet、window.POEMS
 */
(function () {
  'use strict';

  /* ============ 区域配色（宣纸系，不刺眼） ============ */
  const REGION_STYLE = {
    '江南':      { c: '#3f6b5c', order: 1 },
    '江淮赣皖':  { c: '#6b7a3f', order: 2 },
    '荆楚':      { c: '#a5563c', order: 3 },
    '巴蜀':      { c: '#7c5c3e', order: 4 },
    '关中河东':  { c: '#8a6a2f', order: 5 },
    '塞外边地':  { c: '#4a5a78', order: 6 },
    '岭海':      { c: '#8c3b52', order: 7 }
  };
  const regionColor = r => (REGION_STYLE[r] || {}).c || '#6b6154';
  const regionOrder = r => (REGION_STYLE[r] || {}).order || 99;

  const POEMS = (window.POEMS || []).slice().sort(
    (a, b) => regionOrder(a.region) - regionOrder(b.region)
  );
  const byId = Object.create(null);
  POEMS.forEach((p, i) => { p._i = i; byId[p.id] = p; });

  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ============ WGS-84 -> GCJ-02（高德底图为 GCJ-02） ============ */
  function wgs2gcj(lat, lng) {
    const a = 6378245.0, ee = 0.00669342162296594323;
    const outOfChina = lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
    if (outOfChina) return [lat, lng];
    const tLat = (x, y) => {
      let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
      r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
      r += (20 * Math.sin(y * Math.PI) + 40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
      r += (160 * Math.sin(y / 12 * Math.PI) + 320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
      return r;
    };
    const tLng = (x, y) => {
      let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
      r += (20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
      r += (20 * Math.sin(x * Math.PI) + 40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
      r += (150 * Math.sin(x / 12 * Math.PI) + 300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
      return r;
    };
    const dLat0 = tLat(lng - 105, lat - 35);
    const dLng0 = tLng(lng - 105, lat - 35);
    const rad = lat / 180 * Math.PI;
    let m = Math.sin(rad); m = 1 - ee * m * m;
    const sq = Math.sqrt(m);
    const dLat = (dLat0 * 180) / ((a * (1 - ee)) / (m * sq) * Math.PI);
    const dLng = (dLng0 * 180) / (a / sq * Math.cos(rad) * Math.PI);
    return [lat + dLat, lng + dLng];
  }

  /* ============ 地图 ============ */
  const isMobile = () => window.matchMedia('(max-width:900px)').matches;

  const map = L.map('map', {
    zoomControl: false,
    attributionControl: false,
    minZoom: 4,
    maxZoom: 14,
    zoomSnap: 0.5,
    worldCopyJump: false,
    inertia: true
  }).setView([33.4, 113.2], isMobile() ? 5 : 5);

  L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
    subdomains: ['1', '2', '3', '4'],
    maxZoom: 18,
    detectRetina: false
  }).addTo(map);

  // 视口限制：中国范围
  L.extend(map.options, {});

  /* ============ 图钉 + 低缩放聚合 ============ */
  const pins = [];             // 全部点位 {poem, place, idx, ll, marker?}
  const pinByPoem = new Map(); // poemId -> [pin]
  const linkLayer = L.layerGroup().addTo(map);
  let activeId = null;

  POEMS.forEach(poem => {
    const arr = [];
    poem.places.forEach((pl, idx) => {
      const ll = wgs2gcj(pl.lat, pl.lon);
      const rec = { poem, place: pl, idx, ll: L.latLng(ll[0], ll[1]), marker: null };
      pins.push(rec); arr.push(rec);
    });
    pinByPoem.set(poem.id, arr);
  });

  const markerLayer = L.layerGroup().addTo(map);

  function pinIcon(poem) {
    const c = regionColor(poem.region);
    return L.divIcon({
      className: 'pin-wrap',
      html: `<div class="pin" style="--c:${c}"></div><span class="pin-label">${esc(poem.title)}</span>`,
      iconSize: [19, 19], iconAnchor: [9.5, 9.5]
    });
  }

  function clusterIcon(n, color) {
    return L.divIcon({
      className: 'pin-wrap',
      html: `<div class="cluster" style="--c:${color}"><b>${n}</b><i>首</i></div>`,
      iconSize: [40, 40], iconAnchor: [20, 20]
    });
  }

  // 距离聚合：按屏幕像素半径合并，避免相邻格子重叠
  function rebuildMarkers() {
    markerLayer.clearLayers();
    pins.forEach(r => { r.marker = null; });

    const zoom = map.getZoom();
    const doCluster = true;
    const radius = zoom < 7.5 ? 62 : 34;   // 高缩放下仍合并同一座山/同一条街上的诗

    // 预投影，聚合时直接用像素判断
    const proj = pins.map(r => ({ r, pt: map.project(r.ll, zoom) }));
    const used = new Array(proj.length).fill(false);
    const clusters = [];
    // 当前选中的诗必须单独显示（否则被并进聚合点，看不出与今地的对应）
    const forced = new Set();
    if (activeId) {
      (pinByPoem.get(activeId) || []).forEach(r => forced.add(r));
    }

    for (let i = 0; i < proj.length; i++) {
      if (used[i]) continue;
      used[i] = true;
      const group = [proj[i].r];
      if (!doCluster || forced.has(proj[i].r)) { clusters.push(group); continue; }
      for (let j = i + 1; j < proj.length; j++) {
        if (used[j] || forced.has(proj[j].r)) continue;
        if (proj[i].pt.distanceTo(proj[j].pt) <= radius) {
          used[j] = true;
          group.push(proj[j].r);
        }
      }
      clusters.push(group);
    }

    clusters.forEach(group => {
      if (group.length === 1) { buildSingle(group[0]); return; }   // 孤点直接落单
      const center = group.reduce((a, r) => a.add(map.project(r.ll, zoom)), L.point(0, 0)).divideBy(group.length);
      const ll = map.unproject(center, zoom);
      const color = regionColor(mostCommon(group.map(r => r.poem.region)));
      const size = group.length >= 8 ? 46 : group.length >= 5 ? 42 : 38;
      const m = L.marker(ll, {
        icon: L.divIcon({
          className: 'pin-wrap',
          html: `<div class="cluster" style="--c:${color};width:${size}px;height:${size}px"><b>${group.length}</b><i>首</i></div>`,
          iconSize: [size, size], iconAnchor: [size / 2, size / 2]
        }),
        zIndexOffset: 600, keyboard: false,
        title: group.map(r => r.poem.title).join('、')
      });
      m.on('click', ev => {
        L.DomEvent.stopPropagation(ev);
        const ids = [...new Set(group.map(r => r.poem.id))];
        if (ids.length === 1) {
          map.flyTo(ll, Math.min(10, zoom + 1.4), { duration: .8 });
          show(ids[0]);
          return;
        }
        if (zoom < 7.5) {
          map.flyTo(ll, Math.min(9, zoom + 2.2), { duration: .85 });
          map.once('moveend', () => openGroupPopup(m, ll, ids, group));
          return;
        }
        openGroupPopup(m, ll, ids, group);
      });
      m.addTo(markerLayer);
    });

    syncActiveClasses();
  }

  function openGroupPopup(marker, ll, ids, group) {
    const c = regionColor(mostCommon(group.map(r => r.poem.region)));
    const items = ids.map(id => {
      const p = byId[id];
      const place = p.places.map(x => x.name).join(' / ');
      return `<button class="pp-item" data-id="${p.id}">
        <span class="pp-t">${esc(p.title)}</span>
        <span class="pp-w">${esc(p.author)} · ${esc(place)}</span>
      </button>`;
    }).join('');
    const html = `<div class="pp">
      <div class="pp-head"><span class="pp-dot" style="background:${c}"></span>这一处有 ${ids.length} 首诗</div>
      <div class="pp-list">${items}</div>
    </div>`;
    const pop = L.popup({
      className: 'poem-popup', closeButton: true, autoPan: true,
      offset: [0, -6], maxWidth: 300, minWidth: 240
    }).setLatLng(ll).setContent(html).openOn(map);

    const el = pop.getElement();
    if (el) {
      el.querySelectorAll('.pp-item').forEach(b => {
        b.addEventListener('click', e => {
          e.stopPropagation();
          map.closePopup();
          show(b.dataset.id);
        });
      });
    }
  }

  function mostCommon(arr) {
    const c = {}; let best = arr[0], n = 0;
    arr.forEach(x => { c[x] = (c[x] || 0) + 1; if (c[x] > n) { n = c[x]; best = x; } });
    return best;
  }

  function buildSingle(r) {
    const m = L.marker(r.ll, {
      icon: pinIcon(r.poem), riseOnHover: true, keyboard: false,
      title: r.poem.title + ' · ' + r.place.name
    });
    m.on('click', ev => { L.DomEvent.stopPropagation(ev); show(r.poem.id, { fly: false }); });
    m.addTo(markerLayer);
    r.marker = m;
  }

  function showGroup(rows, ll) {
    // 高缩放下落仍会拆开；这里先把索引筛选到这几首
    const ids = [...new Set(rows.map(r => r.poem.id))];
    if (ids.length === 1) { show(ids[0]); return; }
    toast(`这一带有 ${ids.length} 首：${ids.map(id => byId[id].title).join('、')}——再放大一层就能分开`);
  }

  let toastT;
  function toast(msg) {
    let el = $('#toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add('in');
    clearTimeout(toastT);
    toastT = setTimeout(() => el.classList.remove('in'), 4200);
  }

  function syncActiveClasses() {
    $$('.pin.active,.pin-wrap.sel').forEach(e => {
      e.classList.remove('active'); e.classList.remove('sel');
    });
    if (!activeId) return;
    (pinByPoem.get(activeId) || []).forEach(r => {
      if (!r.marker) return;
      const el = r.marker.getElement();
      if (!el) return;
      const pin = el.querySelector('.pin');
      if (pin) pin.classList.add('active');
      el.classList.add('sel');
    });
  }

  map.on('moveend zoomend', rebuildMarkers);

  /* ============ 选中态 ============ */
  function clearActive() {
    activeId = null;
    $$('.pin.active').forEach(e => e.classList.remove('active'));
    $$('.pin-wrap.sel').forEach(e => e.classList.remove('sel'));
    linkLayer.clearLayers();
  }

  function markActive(poem) {
    activeId = poem.id;
    syncActiveClasses();

    const recs = pinByPoem.get(poem.id) || [];
    if (recs.length > 1) {
      L.polyline(recs.map(r => r.ll), {
        className: 'link-line',
        color: regionColor(poem.region),
        weight: 1.6, opacity: .8
      }).addTo(linkLayer);
    }
    rebuildMarkers();
  }

  /* ============ 视图：索引 / 详情 ============ */
  const state = { region: 'all', q: '', sel: null };

  function buildChips() {
    const counts = {};
    POEMS.forEach(p => { counts[p.region] = (counts[p.region] || 0) + 1; });
    const regions = Object.keys(counts)
      .filter(r => REGION_STYLE[r] !== undefined)
      .sort((a, b) => regionOrder(a) - regionOrder(b));

    let html = `<button class="chip on" data-r="all">全部<span class="n">${POEMS.length}</span></button>`;
    regions.forEach(r => {
      html += `<button class="chip" data-r="${esc(r)}"><span style="display:inline-block;width:6px;height:6px;border-radius:50%;background:${regionColor(r)};margin-right:5px;vertical-align:1px"></span>${esc(r)}<span class="n">${counts[r]}</span></button>`;
    });
    $('#chips').innerHTML = html;
    $('#chips').addEventListener('click', e => {
      const b = e.target.closest('.chip');
      if (!b) return;
      state.region = b.dataset.r;
      $$('.chip').forEach(c => c.classList.toggle('on', c === b));
      renderList();
    });
  }

  function matches(p) {
    if (state.region !== 'all' && p.region !== state.region) return false;
    const q = state.q.trim();
    if (!q) return true;
    const hay = [
      p.title, p.author, p.dynasty, p.quote,
      p.lines.join(''), p.answer,
      p.places.map(x => x.name + x.city + x.modern).join('')
    ].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every(t => hay.includes(t));
  }

  function renderList() {
    const list = POEMS.filter(matches);
    const ul = $('#list');
    if (!list.length) {
      ul.innerHTML = `<li style="padding:34px 16px;text-align:center;color:#a4977f;font-size:12.5px;letter-spacing:1px">没有找到。换个词试试，比如「明月」「扬州」「长江」。</li>`;
      $('#metaText').textContent = '0 首';
      return;
    }

    let html = '', lastRegion = null;
    list.forEach(p => {
      if (p.region !== lastRegion) {
        const n = list.filter(x => x.region === p.region).length;
        html += `<li class="region-head" aria-hidden="true">
          <span class="dot" style="--c:${regionColor(p.region)};background:${regionColor(p.region)}"></span>
          <span class="nm">${esc(p.region)}</span>
          <span class="line"></span><span class="ct">${n} 首</span></li>`;
        lastRegion = p.region;
      }
      const where = p.places.map(x =>
        `<span>${esc(x.name)}</span>`).join('');
      html += `<li>
        <button class="item${state.sel === p.id ? ' on' : ''}" data-id="${p.id}">
          <span class="t-row">
            <span class="t">${esc(p.title)}</span>
            <span class="who">${esc(p.author)} · ${esc(p.dynasty)}</span>
          </span>
          <span class="q">${esc(p.quote)}</span>
          <span class="where">${where}${p.doubt ? '<span class="doubt">地点存疑</span>' : ''}</span>
        </button>
      </li>`;
    });
    ul.innerHTML = html;
    const total = POEMS.length;
    $('#metaText').textContent = list.length === total
      ? `共 ${total} 首 · ${new Set(POEMS.map(x => x.region)).size} 区`
      : `筛出 ${list.length} / ${total} 首`;
  }

  /* ============ 详情 ============ */
  function verseHtml(p) {
    const hot = p.quote.replace(/[，。？！、；：""''《》…—\s]/g, '');
    return p.lines.map(l => {
      if (/^……$/.test(l) || l === '……') return `<span class="vl ell">· · ·</span>`;
      const plain = l.replace(/[，。？！、；：""''《》…—\s]/g, '');
      const isHot = hot.length > 5 && (hot.includes(plain.slice(0, 8)) || plain.includes(hot.slice(0, 8)));
      return `<span class="vl${isHot ? ' hot' : ''}">${esc(l)}</span>`;
    }).join('');
  }

  function detailHtml(p) {
    const c = regionColor(p.region);
    const tags = [
      `<span class="tag region" style="--c:${c}">${esc(p.region)}</span>`,
      `<span class="tag">${esc(p.dynasty)}·${esc(p.form)}</span>`,
      p.grade && p.grade !== '课外' ? `<span class="tag">${esc(p.grade)}课本</span>` : `<span class="tag">课外</span>`,
      p.doubt ? `<span class="tag doubt">地点存疑</span>` : ''
    ].join('');

    const cmp = p.compare.map((row, i) => `
      <div class="cmp${i ? ' now' : ''}">
        <div class="k"><b>${i ? '今' : '诗'}</b>${i ? '地' : '中'}</div>
        <div class="v">${esc(row[1])}</div>
      </div>`).join('');

    const places = p.places.map(x => {
      const q = encodeURIComponent(`${x.lat},${x.lon}`);
      return `<div class="place">
        <div><span class="nm">${esc(x.name)}</span><span class="city">${esc(x.city)}</span></div>
        <div class="mod">${esc(x.modern)}</div>
        <div class="row">
          <span>${x.lat.toFixed(4)}°N, ${x.lon.toFixed(4)}°E</span>
          <a class="amap" href="https://uri.amap.com/marker?position=${x.lon},${x.lat}&name=${encodeURIComponent(x.name)}&src=poemmap&coordinate=wgs84&callnative=1" target="_blank" rel="noopener">在高德里看 ↗</a>
        </div>
      </div>`;
    }).join('');

    return `
      <div class="tags">${tags}</div>
      <h2 class="d-title">${esc(p.title)}</h2>
      <div class="d-byline"><b>${esc(p.dynasty)}</b> ${esc(p.author)}</div>

      <div class="quote-box">
        <div class="lab">最 被 记 住 的 一 句</div>
        <div class="q">${esc(p.quote)}</div>
      </div>

      <div class="verse-wrap">
        <div class="verse-tools">
          <span class="lab">原 诗</span>
          <button class="vtoggle" id="vtoggle">竖排</button>
        </div>
        <div class="verse" id="verse">${verseHtml(p)}</div>
      </div>

      <div class="sec">
        <div class="sec-h"><span class="cn">这 是 哪 里</span><span class="ln"></span></div>
        <div style="font-size:15px;line-height:1.95;letter-spacing:.9px;color:#2f2822;margin-bottom:14px">${esc(p.answer)}</div>
        <div class="sec-h"><span class="cn">诗 与 今</span><span class="en">then / now</span><span class="ln"></span></div>
        ${cmp}
      </div>

      <div class="sec">
        <div class="sec-h"><span class="cn">今 地 坐 标</span><span class="en">coordinates</span><span class="ln"></span></div>
        <div class="places">${places}</div>
      </div>

      <div class="sec">
        <div class="sec-h"><span class="cn">考 据 与 争 议</span><span class="en">notes</span><span class="ln"></span></div>
        <div class="note-box">
          ${p.doubt ? '<span class="warn">此地点学界或方志有异说，见下文</span><br>' : ''}
          ${esc(p.note)}
        </div>
        <div class="d-src">
          <b>说明</b>：译文式对照为编者自述，原诗依通行本；地名沿革参考历代地理总志与今地方志，
          存疑处不作定论。地图点位取今日可访的遗址、祠庙或景区中心，非诗作原地原坐标。
        </div>
      </div>`;
  }

  function renderDetail(p) {
    const body = $('#dBody');
    body.innerHTML = detailHtml(p);
    body.scrollTop = 0;
    $('#prevBtn').disabled = p._i <= 0;
    $('#nextBtn').disabled = p._i >= POEMS.length - 1;

    const tgl = $('#vtoggle');
    if (tgl) {
      tgl.addEventListener('click', () => {
        const v = $('#verse');
        v.classList.toggle('vert');
        tgl.textContent = v.classList.contains('vert') ? '横排' : '竖排';
      });
    }
  }

  /* ============ 选中 / 飞行 ============ */
  function show(id, opt) {
    opt = opt || {};
    const p = byId[id];
    if (!p) return;

    state.sel = id;
    document.body.classList.add('sel');

    clearActive();
    markActive(p);
    renderDetail(p);

    $$('.item').forEach(b => b.classList.toggle('on', b.dataset.id === id));

    if (opt.fly !== false) {
      const recs = pinByPoem.get(id) || [];
      if (recs.length === 1) {
        flyToPlace(recs[0]);
      } else if (recs.length > 1) {
        const b = L.latLngBounds(recs.map(r => r.ll));
        map.flyToBounds(b.pad(isMobile() ? 0.6 : 0.25), {
          maxZoom: 7.5,
          duration: 1.05,
          paddingTopLeft: [0, 0],
          paddingBottomRight: isMobile() ? [0, Math.round(window.innerHeight * 0.42)] : [0, 0]
        });
      }
    }
    // 手机端把面板拉起后，重新计算尺寸
    setTimeout(() => map.invalidateSize(), 320);
  }

  function flyToPlace(rec, zoom) {
    const cur = map.getZoom();
    const z = zoom != null ? zoom : Math.max(cur, 9.2);
    // #map 已避开面板，直接用点位中心即可
    map.flyTo(rec.ll, z, { duration: 1.0 });
  }

  function close() {
    state.sel = null;
    document.body.classList.remove('sel');
    clearActive();
    $$('.item').forEach(b => b.classList.remove('on'));
  }

  /* ============ 事件 ============ */
  $('#list').addEventListener('click', e => {
    const b = e.target.closest('.item');
    if (b) show(b.dataset.id);
  });

  $('#backBtn').addEventListener('click', close);
  $('#prevBtn').addEventListener('click', () => step(-1));
  $('#nextBtn').addEventListener('click', () => step(1));

  function step(d) {
    const cur = state.sel ? byId[state.sel]._i : -1;
    const n = cur + d;
    if (n < 0 || n >= POEMS.length) return;
    show(POEMS[n].id, { fly: true });
  }

  const qEl = $('#q');
  qEl.addEventListener('input', () => {
    state.q = qEl.value;
    $('#searchWrap').classList.toggle('has', !!state.q);
    renderList();
  });
  $('#clearQ').addEventListener('click', () => {
    qEl.value = ''; state.q = '';
    $('#searchWrap').classList.remove('has');
    renderList(); qEl.focus();
  });

  $('#randBtn').addEventListener('click', () => {
    const pool = POEMS.filter(matches);
    const arr = pool.length ? pool : POEMS;
    const pick = arr[Math.floor(Math.random() * arr.length)];
    show(pick.id);
  });

  map.on('click', () => { if (state.sel) close(); });

  // 键盘
  document.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT') { if (e.key === 'Escape') { e.target.blur(); } return; }
    if (e.key === 'Escape' && state.sel) close();
    if (state.sel && e.key === 'ArrowDown') { e.preventDefault(); step(1); }
    if (state.sel && e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
    if (e.key === '/' ) { e.preventDefault(); qEl.focus(); }
  });

  // 手机：拖动把手切换面板高度
  (function sheetDrag() {
    const grab = $('#sheetGrab');
    const panel = $('#panel');
    let sy = 0, dragging = false, startH = 0;
    const hNow = () => panel.getBoundingClientRect().height;

    const down = e => {
      if (!isMobile()) return;
      dragging = true; sy = (e.touches ? e.touches[0].clientY : e.clientY); startH = hNow();
      panel.style.transition = 'none';
    };
    const move = e => {
      if (!dragging) return;
      const y = (e.touches ? e.touches[0].clientY : e.clientY);
      const h = Math.min(window.innerHeight * 0.95, Math.max(110, startH + (sy - y)));
      panel.style.height = h + 'px';
      if (e.cancelable) e.preventDefault();
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      panel.style.transition = '';
      panel.style.height = '';
      const h = hNow() / window.innerHeight;
      if (h > 0.55 && !state.sel) {
        // 从索引直接拉高：打开第一首？不，保持索引，但停留在高面板
        panel.style.height = '78svh';
        setTimeout(() => { panel.style.height = ''; }, 900);
      } else if (h < 0.28 && state.sel) {
        close();
      }
      setTimeout(() => map.invalidateSize(), 340);
    };
    if (grab) {
      grab.addEventListener('touchstart', down, { passive: true });
      grab.addEventListener('touchmove', move, { passive: false });
      grab.addEventListener('touchend', up);
      grab.addEventListener('mousedown', down);
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
      grab.addEventListener('click', () => {
        if (isMobile() && state.sel) close();
      });
    }
  })();

  /* ============ 计数 / 初始化 ============ */
  const placeCount = POEMS.reduce((a, p) => a + p.places.length, 0);
  const regionCount = new Set(POEMS.map(p => p.region)).size;
  $('#stats').innerHTML = `<b>${POEMS.length}</b> 首 · <b>${placeCount}</b> 处今地 · 跨 <b>${regionCount}</b> 个区域`;
  $('#indexTitle').innerHTML = `${POEMS.length} 首诗<span id="countHint"></span>`;
  $('#q').setAttribute('aria-label', '搜索诗句、诗人或地名');

  buildChips();
  renderList();

  // 初始视角：让长江—黄河之间那片诗最多的地方先入画
  map.setView(isMobile() ? [32.4, 116.6] : [33.8, 113.6], 5);

  // 地图尺寸变化（面板/窗口）
  let rz;
  window.addEventListener('resize', () => {
    clearTimeout(rz);
    rz = setTimeout(() => map.invalidateSize(), 200);
  });

  // 首个渲染完成后，延迟一次 invalidate，避免容器尺寸测量偏差
  setTimeout(() => map.invalidateSize(), 120);

  rebuildMarkers();

  /* 供调试 */
  window.__poemmap = { map, show, close, POEMS };
})();
