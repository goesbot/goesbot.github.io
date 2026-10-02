(function () {
  'use strict';
  const DATA = window.GOESBOT;
  const TYPE_LABEL = { METEOROLOGICAL: 'Meteorological', MIXED: 'Mixed (meteorological and hydrological)' };
  const TYPE_EMOJI = { METEOROLOGICAL: '🌤️', MIXED: '🌤️🌊' };
  const REGION_LABEL = { ON: 'Ontario', QC: 'Quebec' };
  const COLOR = { inside: '#2a6fdb', outside: '#c2570c' };
  const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

  const $ = id => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const coords = s => s.lat == null ? '' : `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}`;

  // Downtown Ottawa (Parliament Hill): with no place searched, the list goes from nearest to farthest from here
  const CENTER = { lat: 45.4236, lon: -75.7009 };
  const GEO = window.Gazetteer;
  const gaz = GEO && window.GOESBOT_PLACES ? GEO.Gazetteer(window.GOESBOT_PLACES.places) : null;
  const SUGGESTIONS = 6;

  const state = { text: '', sensor: '', type: '', sort: 'km', desc: false, selected: null, near: null, others: [] };
  const SORTS = {
    km: s => s.km,
    name: s => (s.name || s.id).toLowerCase(),
    id: s => s.id,
    place: s => (s.place || s.region || '').toLowerCase() || null,
    sensors: s => s.sensors.length,
  };
  const COLUMNS = [['name', 'Station'], ['id', 'ID'], ['place', 'Located in'], ['km', 'Distance'], ['sensors', 'Sensors']];

  function view() {
    const text = state.text.trim();
    const matching = q => DATA.stations.filter(s => (!state.type || s.type === state.type)
      && (!state.sensor || s.sensors.some(e => e.code === state.sensor))
      && (!q || [s.name, s.id, s.agency, s.place, s.region].some(v => v && v.toLowerCase().includes(q))));
    const places = gaz && !state.near && text.length >= 2 ? gaz.search(text, SUGGESTIONS) : [];
    let stations = matching(state.near ? '' : text.toLowerCase());
    let near = state.near, guessed = false;
    if (!near && text && !stations.length && places.length) {
      near = places[0];
      guessed = true;
      stations = matching('');
    }
    const from = near || CENTER;
    DATA.stations.forEach(s => {
      const located = s.lat != null && s.lon != null;
      s.km = located ? GEO.distanceKm(from.lat, from.lon, s.lat, s.lon) : null;
      s.bearing = located && near ? GEO.bearing(from.lat, from.lon, s.lat, s.lon) : null;
    });
    const key = guessed ? SORTS.km : SORTS[state.sort];
    const desc = !guessed && state.desc;
    const rows = stations.map(s => [key(s), s])
      .sort(([a], [b]) => a == null ? (b == null ? 0 : 1) : b == null ? -1
        : (a < b ? -1 : a > b ? 1 : 0) * (desc ? -1 : 1))
      .map(r => r[1]);
    return { rows, near, guessed, places, text, others: guessed ? places.slice(1) : state.others,
      hint: near && `From ${near.label}` };
  }

  function pick(place, others) {
    Object.assign(state, { near: place, others: others.filter(p => p.id !== place.id), text: '', sort: 'km', desc: false });
    $('search').value = place.label;
    render();
  }

  // Frame the pin and its three nearest stations
  function focusNear(v) {
    const bounds = new maplibregl.LngLatBounds([v.near.lon, v.near.lat], [v.near.lon, v.near.lat]);
    v.rows.filter(s => s.lat != null).slice(0, 3).forEach(s => bounds.extend([s.lon, s.lat]));
    // One zoom level out from the tight fit, to show the surroundings too
    const cam = map.cameraForBounds(bounds, { padding: 60, maxZoom: 11 });
    map.easeTo({ center: cam.center, zoom: cam.zoom - 1, duration: 600 });
  }

  function clearPlace() {
    const was = idle();
    Object.assign(state, { near: null, others: [], text: '' });
    $('search').value = '';
    render();
    homeIfIdle(was);
    $('search').focus();
  }

  function renderNear(v) {
    const box = $('near');
    const link = (place, all) => {
      const b = el('button', 'link', place.label);
      b.type = 'button';
      b.addEventListener('click', () => pick(place, all));
      return b;
    };
    const list = (places, all) => places.flatMap((p, i) => [i ? ', ' : '', link(p, all)]);
    box.hidden = !v.near && !v.places.length;
    if (v.near) {
      const all = [v.near, ...v.others];
      box.replaceChildren(v.guessed ? `No station matches “${v.text}”. Nearest to ` : 'Nearest to ',
        el('b', null, v.near.label), v.near.match === 'fuzzy' ? ' (closest spelling)' : '');
      if (v.others.length) box.append(' · or ', ...list(v.others, all));
      if (!v.guessed) {
        const clear = el('button', 'link', 'clear');
        clear.type = 'button';
        clear.addEventListener('click', clearPlace);
        box.append(' · ', clear);
      }
    } else if (v.places.length) {
      box.replaceChildren('Stations nearest to ', ...list(v.places, v.places));
    }
  }

  function sensorOptions() {
    const codes = new Map();
    for (const s of DATA.stations) {
      for (const code of new Set(s.sensors.map(e => e.code).filter(Boolean))) {
        const c = codes.get(code) || { code, n: 0, labels: new Map() };
        c.n++;
        const label = s.sensors.find(e => e.code === code).label;
        c.labels.set(label, (c.labels.get(label) || 0) + 1);
        codes.set(code, c);
      }
    }
    return [...codes.values()].sort((a, b) => b.n - a.n || a.code.localeCompare(b.code))
      .map(c => ({ ...c, label: [...c.labels].sort((a, b) => b[1] - a[1])[0][0] }));
  }

  function sensorItems(sensors) {
    const byCode = new Map();
    sensors.forEach(e => byCode.set(e.code, [...(byCode.get(e.code) || []), e]));
    return [...byCode].map(([code, group]) => {
      const li = el('li', group.every(e => e.cat === 'D') ? 'diag' : null);
      li.title = group.map(e => e.label + (e.unit ? ` (${e.unit})` : '')).join('\n');
      li.append(group[0].emoji);
      if (code) li.append(' ', el('code', null, code));
      return li;
    });
  }

  function row(s, near, hint) {
    const tr = el('tr', s.id === state.selected ? 'sel' : null);
    tr.tabIndex = 0;
    tr.dataset.id = s.id;
    tr.setAttribute('aria-selected', s.id === state.selected);

    const station = el('td', 'c-station');
    const about = el('div', 'muted sub');
    if (s.agency) {
      const agency = el('span', 'tip', s.agency);
      agency.title = 'Agency';
      about.append(agency, ' · ');
    }
    const type = el('span', 'tip', TYPE_EMOJI[s.type] || s.type);
    type.title = TYPE_LABEL[s.type] || s.type;
    about.append(type);
    station.append(el('div', 'name', s.name || s.id), about);

    const id = el('td', 'c-id');
    id.append(el('span', 'label', 'ID'), el('span', 'mono id', s.id));
    id.title = 'Station id, as in the bot commands !station <id> and !info <id>';

    const place = el('td', 'c-place');
    place.append(el('div', null, s.place || REGION_LABEL[s.region] || s.region || '—'));
    if (s.lat != null) place.append(el('div', 'muted sub mono', coords(s)));
    if (!s.inside) place.append(el('div', 'muted sub', `outside the ${DATA.region.code} region`));

    const sensors = el('td', 'c-sensors');
    if (s.sensors.length) {
      const list = el('ul', 'sensors');
      list.append(...sensorItems(s.sensors));
      sensors.append(list);
    } else {
      sensors.append(el('span', 'muted', 'none reported'));
    }

    tr.append(station, id, place);
    if (near) {
      const km = el('td', 'c-km');
      if (s.km != null) km.append(el('span', 'label', 'Distance'), `${Math.round(s.km)} km ${s.bearing}`);
      km.title = hint;
      tr.append(km);
    }
    tr.append(sensors);
    return tr;
  }

  function renderHead(near, hint) {
    const head = $('head');
    head.replaceChildren(...COLUMNS.filter(([key]) => near || key !== 'km').map(([key, label]) => {
      const th = el('th', key === 'km' ? 'c-km' : null);
      if (key === 'km') th.title = hint;
      if (state.sort === key) th.setAttribute('aria-sort', state.desc ? 'descending' : 'ascending');
      const b = el('button', null, label + (state.sort === key ? (state.desc ? ' ▾' : ' ▴') : ''));
      b.type = 'button';
      b.addEventListener('click', () => {
        state.desc = state.sort === key ? !state.desc : key === 'sensors';
        state.sort = key;
        render();
      });
      th.append(b);
      return th;
    }));
  }

  let map = null, mapReady = false, popup = null, pin = null, pinAt = null, home = null;

  // Nothing searched and no station selected: the map belongs back on the whole region
  const idle = () => !state.text.trim() && !state.near && !state.selected;
  function homeIfIdle(was) {
    if (mapReady && !was && idle()) map.fitBounds(home, { padding: 36, duration: 600 });
  }

  function render() {
    const v = view();
    const rows = v.rows;
    renderHead(!!v.near, v.hint);
    renderNear(v);
    $('rows').replaceChildren(...rows.map(s => row(s, !!v.near, v.hint)));
    $('empty').hidden = rows.length > 0;
    const n = DATA.stations.length;
    // and how many location names the search box knows
    const names = window.GOESBOT_PLACES ? ` / ${window.GOESBOT_PLACES.places.length} location names` : '';
    $('stations-status').textContent = (rows.length === n ? `${n} stations` : `${rows.length} of ${n} stations`)
      + names;
    if (mapReady) {
      map.getSource('stations').setData(features(rows.filter(s => s.lat != null)));
      paintSelected();
      // Only a pin that moved re-frames the map, so sorting or filtering leaves the view alone
      const at = v.near ? `${v.near.lat},${v.near.lon}` : null;
      if (at !== pinAt) {
        if (pin) pin.remove();
        pin = v.near && new maplibregl.Marker({ color: '#1b2a38', scale: 0.8 }).setLngLat([v.near.lon, v.near.lat]).addTo(map);
        pinAt = at;
        if (v.near) focusNear(v);
      }
    }
    return v;
  }

  const features = stations => ({
    type: 'FeatureCollection',
    features: stations.map(s => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
      properties: { id: s.id, name: s.name || s.id, inside: s.inside, type: TYPE_LABEL[s.type] || s.type },
    })),
  });

  function paintSelected() {
    map.setFilter('selected', ['==', ['get', 'id'], state.selected || '']);
  }

  function select(id, from) {
    const was = idle();
    state.selected = id;
    document.querySelectorAll('#rows tr').forEach(tr => {
      const on = tr.dataset.id === id;
      tr.classList.toggle('sel', on);
      tr.setAttribute('aria-selected', on);
      if (on && from === 'map') tr.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
    if (!mapReady) return;
    paintSelected();
    const s = DATA.stations.find(x => x.id === id);
    if (from === 'list' && s && s.lat != null) {
      map.easeTo({ center: [s.lon, s.lat], zoom: Math.max(map.getZoom(), 8), duration: 600 });
    }
    homeIfIdle(was);
  }

  function initMap() {
    const note = text => { $('map').replaceChildren(el('div', 'map-note', text)); };
    if (!window.maplibregl) return note('The map could not be loaded.');
    const ring = DATA.region.polygon.map(([lat, lon]) => [lon, lat]);
    const bounds = home = new maplibregl.LngLatBounds();
    ring.forEach(p => bounds.extend(p));
    try {
      map = new maplibregl.Map({
        container: 'map', style: MAP_STYLE, bounds, fitBoundsOptions: { padding: 36 },
        minZoom: 3, maxZoom: 14, attributionControl: { compact: true },
      });
    } catch (e) {
      return note('The map needs WebGL, which this browser does not provide.');
    }
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    map.on('load', () => {
      map.addSource('region', { type: 'geojson', data: { type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } } });
      map.addLayer({ id: 'region-fill', type: 'fill', source: 'region', paint: { 'fill-color': '#7ec8e3', 'fill-opacity': 0.1 } });
      map.addLayer({ id: 'region-line', type: 'line', source: 'region', paint: { 'line-color': '#1f6f93', 'line-width': 2, 'line-dasharray': [3, 2.5] } });
      map.addSource('stations', { type: 'geojson', data: features([]) });
      const fill = ['case', ['get', 'inside'], COLOR.inside, COLOR.outside];
      map.addLayer({ id: 'stations', type: 'circle', source: 'stations',
        paint: { 'circle-radius': 5.5, 'circle-color': fill, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.2 } });
      map.addLayer({ id: 'selected', type: 'circle', source: 'stations', filter: ['==', ['get', 'id'], ''],
        paint: { 'circle-radius': 7, 'circle-color': fill, 'circle-stroke-color': '#0c1828', 'circle-stroke-width': 3 } });
      popup = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 10 });
      map.on('mousemove', 'stations', e => {
        const p = e.features[0].properties;
        map.getCanvas().style.cursor = 'pointer';
        const body = el('div');
        body.append(el('b', null, p.name), el('span', null, `ID ${p.id} · ${p.type}`
          + (p.inside ? '' : ` · outside ${DATA.region.code}`)));
        popup.setLngLat(e.features[0].geometry.coordinates).setDOMContent(body).addTo(map);
      });
      map.on('mouseleave', 'stations', () => { map.getCanvas().style.cursor = ''; popup.remove(); });
      map.on('click', 'stations', e => select(e.features[0].properties.id, 'map'));
      mapReady = true;
      render();
    });
  }

  function init() {
    if (!DATA) {
      $('empty').hidden = false;
      $('empty').textContent = 'The station list could not be loaded.';
      return;
    }
    const sensor = $('sensor');
    sensorOptions().forEach(c => {
      const o = el('option', null, `${c.code} · ${c.label} (${c.n})`);
      o.value = c.code;
      sensor.append(o);
    });
    $('emoji').replaceChildren(...DATA.emoji.flatMap(([title, rows]) => {
      const list = el('ul', 'emoji-list');
      list.append(...rows.map(([emoji, meaning]) => {
        const li = el('li');
        li.append(el('span', 'glyph', emoji), el('span', null, meaning));
        return li;
      }));
      return [el('h3', 'emoji-group', title), list];
    }));
    if (gaz) $('credit').textContent = `Place names: ${window.GOESBOT_PLACES.attribution}`;
    $('search').addEventListener('input', e => {
      const was = idle();
      Object.assign(state, { text: e.target.value, near: null, others: [] });
      render();
      homeIfIdle(was);
    });
    $('search').addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      const v = view();
      if (!state.near && v.places.length) pick(v.places[0], v.places);
    });
    sensor.addEventListener('change', e => { state.sensor = e.target.value; render(); });
    $('type').addEventListener('change', e => { state.type = e.target.value; render(); });
    $('rows').addEventListener('click', e => {
      const tr = e.target.closest('tr');
      if (tr && !String(window.getSelection()).trim()) select(tr.dataset.id === state.selected ? null : tr.dataset.id, 'list');
    });
    // A click anywhere outside the list (rows and column headers) and the map deselects. The
    // event's path, because sorting re-renders the header the click landed on
    const keep = [$('map'), document.querySelector('.table')];
    document.addEventListener('click', e => {
      if (state.selected && !e.composedPath().some(n => keep.includes(n))) select(null, 'page');
    });
    $('rows').addEventListener('keydown', e => {
      const tr = e.target.closest('tr');
      if (tr && e.key === 'Enter') select(tr.dataset.id === state.selected ? null : tr.dataset.id, 'list');
    });
    render();
    initMap();
  }

  init();
})();
