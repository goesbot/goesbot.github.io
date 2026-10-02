(function (root) {
  'use strict';
  const ARTICLES = ['the ', 'le ', 'la ', 'les ', 'l '];
  const TYPE_RANK = { city: 0, town: 1, suburb: 2, village: 3, municipality: 4, neighbourhood: 5, hamlet: 6, county: 7, locality: 8 };
  const MATCH_RANK = { exact: 0, alias: 1, prefix: 2, contains: 3, fuzzy: 4 };
  const PROVINCE = { on: 'ON', ont: 'ON', ontario: 'ON', qc: 'QC', que: 'QC', quebec: 'QC', pq: 'QC' };
  const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const WORD = { saint: 'st', sainte: 'st', ste: 'st', st: 'st', mount: 'mt' };

  function norm(s) {
    return s.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/&/g, ' and ')
      .replace(/[^a-z0-9]/g, ' ').split(' ').filter(Boolean).map(w => WORD[w] || w).join(' ');
  }

  function keys(name) {
    const k = norm(name);
    const out = k ? [k] : [];
    for (const a of ARTICLES) if (k.startsWith(a) && k.length > a.length) out.push(k.slice(a.length));
    return out;
  }

  function distanceKm(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const a = Math.sin((lat2 - lat1) * rad / 2) ** 2
      + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const p1 = lat1 * rad, p2 = lat2 * rad, dl = (lon2 - lon1) * rad;
    const deg = (Math.atan2(Math.sin(dl) * Math.cos(p2),
      Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) / rad + 360) % 360;
    return COMPASS[Math.floor((deg + 11.25) / 22.5) % 16];
  }

  function ratio(a, b) {
    const total = a.length + b.length;
    if (!total) return 1;
    let matched = 0;
    const queue = [[0, a.length, 0, b.length]];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop();
      let besti = alo, bestj = blo, best = 0, run = new Map();
      for (let i = alo; i < ahi; i++) {
        const next = new Map();
        for (let j = blo; j < bhi; j++) {
          if (b[j] !== a[i]) continue;
          const k = (run.get(j - 1) || 0) + 1;
          next.set(j, k);
          if (k > best) { besti = i + 1 - k; bestj = j + 1 - k; best = k; }
        }
        run = next;
      }
      if (best > 0) {
        matched += best;
        if (alo < besti && blo < bestj) queue.push([alo, besti, blo, bestj]);
        if (besti + best < ahi && bestj + best < bhi) queue.push([besti + best, ahi, bestj + best, bhi]);
      }
    }
    return 2 * matched / total;
  }

  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

  function Gazetteer(rows) {
    const places = rows.map(([id, name, type, lat, lon, city, county, province, population, aliases]) => ({
      id, name, type, lat, lon, city, county, province, population, aliases,
      label: [name, city, province].filter(Boolean).join(', '),
      cityKey: norm(city || ''), countyKey: norm(county || ''),
    }));
    const nameKeys = new Map(), aliasKeys = new Map();
    const add = (m, k, i) => { if (!m.has(k)) m.set(k, []); m.get(k).push(i); };
    places.forEach((p, i) => keys(p.name).forEach(k => add(nameKeys, k, i)));
    places.forEach((p, i) => p.aliases.forEach(a => keys(a).forEach(k => {
      if (!(nameKeys.get(k) || []).includes(i)) add(aliasKeys, k, i);
    })));
    const allKeys = [...new Set([...nameKeys.keys(), ...aliasKeys.keys()])].sort();
    const both = k => [...(nameKeys.get(k) || []), ...(aliasKeys.get(k) || [])];

    function qualifies(p, quals) {
      let n = 0;
      for (const q of quals) {
        if (PROVINCE[q] === p.province) n++;
        else if ([p.cityKey, p.countyKey].some(f => f === q || (q.length >= 3 && f.startsWith(q)))) n++;
      }
      return n;
    }

    function candidates(key) {
      const seen = new Set(), out = [];
      const take = (kind, list) => list.forEach(i => { if (!seen.has(i)) { seen.add(i); out.push([kind, i]); } });
      const ks = [key];
      for (const a of ARTICLES) if (key.startsWith(a) && key.length > a.length) ks.push(key.slice(a.length));
      ks.forEach(k => take('exact', nameKeys.get(k) || []));
      ks.forEach(k => take('alias', aliasKeys.get(k) || []));
      if (key.length >= 2) allKeys.filter(k => k.startsWith(key)).forEach(k => take('prefix', both(k)));
      if (key.length >= 3) allKeys.filter(k => k.includes(' ' + key)).forEach(k => take('contains', both(k)));
      if (key.length >= 4) {
        allKeys.filter(k => k[0] === key[0]).map(k => [ratio(k, key), k]).filter(([r]) => r >= 0.85)
          .sort((a, b) => b[0] - a[0] || cmp(b[1], a[1])).slice(0, 8).forEach(([, k]) => take('fuzzy', both(k)));
      }
      return out;
    }

    function search(query, limit = 10) {
      const parts = query.split(',').map(norm).filter(Boolean);
      if (!parts.length) return [];
      let cands = candidates(parts[0]);
      const quals = parts.slice(1);
      if (quals.length) {
        const hits = cands.filter(([, i]) => qualifies(places[i], quals) > 0);
        if (hits.length) {
          cands = hits;
        } else {
          const whole = candidates(parts.join(' ')).filter(([k]) => k === 'exact' || k === 'alias');
          if (whole.length) cands = whole;
        }
      }
      const rank = ([kind, i]) => {
        const p = places[i];
        return [MATCH_RANK[kind], -qualifies(p, quals), TYPE_RANK[p.type] ?? 9, -p.population, p.name];
      };
      return cands.map(c => [rank(c), c]).sort(([a], [b]) => {
        for (let n = 0; n < a.length; n++) { const d = cmp(a[n], b[n]); if (d) return d; }
        return 0;
      }).slice(0, limit).map(([, [kind, i]]) => ({ ...places[i], match: kind }));
    }

    return { places, search };
  }

  root.Gazetteer = { Gazetteer, norm, keys, ratio, distanceKm, bearing };
})(self);
