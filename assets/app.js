/* Contractor Radar app: city picker, trade/ZIP filters, leaderboard, new contractors, search, profiles, CSV.
   No build step and no libraries. Data: data/meta.json, data/<city>/index.json, data/<city>/c/<shard>.json.
   Routes (hash): #/<city>/leaderboard?trade=&zip=&window=&sort=  #/<city>/new?trade=&zip=
                  #/<city>/search?q=   #/<city>/c/<contractor_key> */
(function () {
  "use strict";

  var PAGE = 50;
  var fmt = new Intl.NumberFormat("en-US");
  var usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  var MOMENTUM = {
    surging: "Surging", growing: "Growing", steady: "Steady", slowing: "Slowing", slowing_sharply: "Slowing sharply",
    gone_quiet: "Gone quiet", new_activity: "New activity", none: "No recent permits"
  };
  var WINDOWS = { n30: "Last 30 days", n90: "Last 90 days", n12: "Last 12 months" };
  var S = { meta: null, idx: {}, shards: {}, norm: {}, tradeIds: [], tradeLabel: {}, route: null, shown: PAGE, lastRows: null };

  // ------------------------------------------------------------------ helpers
  function $(sel, el) { return (el || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function day(iso) {
    if (!iso) return "";
    var d = new Date(iso + "T12:00:00");
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }
  function monthLabel(ym, withYear) {
    var d = new Date(ym + "-15T12:00:00");
    return d.toLocaleDateString("en-GB", withYear ? { month: "short", year: "numeric" } : { month: "short" });
  }
  function norm(s) { return String(s || "").toUpperCase().replace(/&/g, "AND").replace(/[^A-Z0-9]/g, ""); }
  function storageGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function storageSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function announce(msg) { var s = $("#status"); s.textContent = ""; setTimeout(function () { s.textContent = msg; }, 30); }

  function getJSON(url) {
    return fetch(url, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status + " for " + url);
      return r.json();
    });
  }

  function momentum(n90, p90) {
    if (!n90 && !p90) return { cls: "flat", text: "–", label: "no permits in the last 180 days", pct: null };
    if (!p90) return { cls: "up", text: "▲ new", label: "new activity: none in the prior 90 days", pct: null };
    var pct = Math.round(100 * (n90 - p90) / p90);
    if (pct > 0) return { cls: "up", text: "▲ " + pct + "%", label: "up " + pct + " percent", pct: pct };
    if (pct < 0) return { cls: "down", text: "▼ " + Math.abs(pct) + "%", label: "down " + Math.abs(pct) + " percent", pct: pct };
    return { cls: "flat", text: "0%", label: "no change", pct: 0 };
  }
  function momHTML(n90, p90) {
    var m = momentum(n90, p90);
    return '<span class="mom ' + m.cls + '" aria-label="' + esc(m.label) + '">' + esc(m.text) + "</span>";
  }

  // ------------------------------------------------------------------ routing
  function parseRoute() {
    var h = location.hash.replace(/^#\/?/, "");
    var qi = h.indexOf("?");
    var path = qi >= 0 ? h.slice(0, qi) : h;
    var params = new URLSearchParams(qi >= 0 ? h.slice(qi + 1) : "");
    var parts = path.split("/").filter(Boolean).map(function (p) { try { return decodeURIComponent(p); } catch (e) { return p; } });
    var cities = S.meta.cities.map(function (c) { return c.id; });
    var city = cities.indexOf(parts[0]) >= 0 ? parts[0] : null;
    var view = parts[1] || "leaderboard";
    if (["leaderboard", "new", "search", "c"].indexOf(view) < 0) view = "leaderboard";
    return { city: city, view: view, key: view === "c" ? parts[2] : null, params: params };
  }
  function href(city, view, params, key) {
    var h = "#/" + encodeURIComponent(city) + "/" + view + (key ? "/" + encodeURIComponent(key) : "");
    var qs = params ? params.toString() : "";
    return h + (qs ? "?" + qs : "");
  }
  function cleanParams(obj) {
    var p = new URLSearchParams();
    Object.keys(obj).forEach(function (k) { if (obj[k] !== "" && obj[k] != null) p.set(k, obj[k]); });
    return p;
  }

  // ------------------------------------------------------------------ data
  function loadCity(city) {
    if (S.idx[city]) return Promise.resolve(S.idx[city]);
    return getJSON("data/" + city + "/index.json").then(function (ix) {
      ix.byKey = {};
      ix.c.forEach(function (row, i) { ix.byKey[row[0]] = i; });
      S.norm[city] = ix.c.map(function (row) { return norm(row[1]) + "|" + row[0]; });
      S.idx[city] = ix;
      return ix;
    });
  }
  function loadShard(city, ci) {
    var ix = S.idx[city];
    var s = ci % ix.shards;
    var k = city + "/" + s;
    if (S.shards[k]) return Promise.resolve(S.shards[k]);
    return getJSON("data/" + city + "/c/" + s + ".json").then(function (d) { S.shards[k] = d; return d; });
  }

  /* Sum the contractor x trade x ZIP cube for the active filters. ti/zi = null means "all". */
  function aggregate(ix, ti, zi) {
    var n = ix.c.length, cube = ix.cube;
    var a = { n12: new Int32Array(n), n90: new Int32Array(n), p90: new Int32Array(n), n30: new Int32Array(n) };
    for (var i = 0; i < cube.length; i += 7) {
      if (ti !== null && cube[i + 1] !== ti) continue;
      if (zi !== null && cube[i + 2] !== zi) continue;
      var ci = cube[i];
      a.n12[ci] += cube[i + 3]; a.n90[ci] += cube[i + 4]; a.p90[ci] += cube[i + 5]; a.n30[ci] += cube[i + 6];
    }
    return a;
  }
  function filterIndexes(ix, params) {
    var t = params.get("trade") || "";
    var z = params.get("zip") || "";
    var ti = t ? S.tradeIds.indexOf(t) : -1;
    var zi = z ? ix.zips.indexOf(z) : -1;
    return { ti: ti >= 0 ? ti : null, zi: zi >= 0 ? zi : null, trade: ti >= 0 ? t : "", zip: zi >= 0 ? z : "" };
  }

  // ------------------------------------------------------------------ charts
  function barChart(values, months, opts) {
    opts = opts || {};
    var W = 640, H = opts.height || 190, padL = 8, padR = 8, padT = 22, padB = 26;
    var n = values.length, max = Math.max.apply(null, values.concat([1]));
    var bw = (W - padL - padR) / n, gap = Math.min(10, bw * 0.25);
    var lastPartial = !!opts.partialLast;
    var label = (opts.title || "Permits per month") + ": " + values.map(function (v, i) {
      return monthLabel(months[i], true) + " " + fmt.format(v) + (lastPartial && i === n - 1 ? " (month to date)" : "");
    }).join("; ");
    var out = ['<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="' + esc(label) + '">',
      '<defs><pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--line-soft)"/><rect width="3" height="6" fill="var(--accent)"/></pattern></defs>',
      '<line class="base" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + (H - padB) + '" y2="' + (H - padB) + '"/>'];
    values.forEach(function (v, i) {
      var h = Math.round((H - padT - padB) * v / max);
      var x = padL + i * bw + gap / 2, y = H - padB - h;
      var partial = lastPartial && i === n - 1;
      out.push('<rect class="bar' + (partial ? " partial" : "") + '" x="' + x.toFixed(1) + '" y="' + y + '" width="' + (bw - gap).toFixed(1) + '" height="' + Math.max(h, v ? 1 : 0) + '"/>');
      if (bw > 30 && v > 0) out.push('<text class="val" text-anchor="middle" x="' + (x + (bw - gap) / 2).toFixed(1) + '" y="' + (y - 5) + '">' + (v >= 10000 ? (v / 1000).toFixed(0) + "k" : fmt.format(v)) + "</text>");
      if (bw > 30 || i % 2 === 0) out.push('<text class="axis" text-anchor="middle" x="' + (x + (bw - gap) / 2).toFixed(1) + '" y="' + (H - 8) + '">' + esc(monthLabel(months[i])) + "</text>");
    });
    out.push("</svg>");
    return out.join("");
  }
  function hbars(items) { // [label, value]
    var max = Math.max.apply(null, items.map(function (x) { return x[1]; }).concat([1]));
    return items.map(function (x) {
      return '<li><span class="lbl" title="' + esc(x[0]) + '">' + esc(x[0]) + '</span><span class="track" aria-hidden="true"><span class="fill" style="width:' +
        (100 * x[1] / max).toFixed(1) + '%"></span></span><span class="num">' + fmt.format(x[1]) + "</span></li>";
    }).join("");
  }

  // ------------------------------------------------------------------ CSV
  function csvCell(v) {
    var s = v == null ? "" : String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCSV(filename, header, rows) {
    var text = "﻿" + [header].concat(rows).map(function (r) { return r.map(csvCell).join(","); }).join("\r\n") + "\r\n";
    var blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    announce("Downloaded " + filename + " with " + rows.length + " rows.");
  }

  // ------------------------------------------------------------------ city header
  function renderCityHeader(cm, ix) {
    document.title = cm.name + " contractors: Contractor Radar";
    $("#city-title").textContent = cm.name + ", " + cm.state;
    $("#city-sub").innerHTML = "Data as of <strong>" + esc(day(cm.as_of)) + "</strong> &middot; issued permits " +
      esc(day(cm.window.start)) + " to " + esc(day(cm.window.end)) + " &middot; " + esc(cm.pct_with_contractor) + "% name a contractor";
    var st = ix.stats;
    var m = momentum(st.permits_last90, st.permits_prior90);
    $("#kpis").innerHTML = [
      ["Permits, last 12 months", fmt.format(st.permits)],
      ["Permits, last 90 days", fmt.format(st.permits_last90) + ' <span class="mom ' + m.cls + '" style="font-size:15px" aria-label="' + esc(m.label) + ' versus the prior 90 days">' + esc(m.text) + "</span>"],
      ["Contractors active, 12 months", fmt.format(st.contractors)],
      ["New contractors this month", fmt.format(st.new_this_month)]
    ].map(function (k) { return '<div class="kpi"><b>' + k[1] + "</b><span>" + esc(k[0]) + "</span></div>"; }).join("");
    var mo = st.monthly;
    var partial = cm.as_of.slice(0, 7) === mo.months[mo.months.length - 1];
    $("#city-chart").innerHTML = barChart(mo.permits, mo.months, { title: cm.name + " permits issued per month", partialLast: partial });
    $("#city-chart-title").textContent = "Permits issued per month" + (partial ? " (last bar: month to date)" : "");
    var tr = {};
    for (var i = 0; i < ix.cube.length; i += 7) tr[ix.cube[i + 1]] = (tr[ix.cube[i + 1]] || 0) + ix.cube[i + 4];
    var items = Object.keys(tr).map(function (t) { return [S.tradeLabel[S.tradeIds[t]], tr[t]]; })
      .filter(function (x) { return x[1] > 0; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, 8);
    $("#city-trades").innerHTML = hbars(items);
    $("#sources").innerHTML = "<ul>" + cm.sources.map(function (s) {
      return '<li><a href="' + esc(s.page) + '">' + esc(s.name) + "</a> (dataset <span class=\"mono\">" + esc(s.dataset_id) + "</span>" +
        (s.license ? ", licence: " + esc(s.license) : "") + "), city last updated " + esc(day((s.rows_updated_at_utc || "").slice(0, 10))) +
        ", " + fmt.format(s.row_count) + " rows pulled " + esc(day((s.fetched_at_utc || "").slice(0, 10))) + "</li>";
    }).join("") + "</ul><p>Permits naming a contractor: " + fmt.format(cm.permits_with_contractor) + " of " + fmt.format(cm.permits) +
      " (" + esc(cm.pct_with_contractor) + "%). Permits with no named contractor count in the city totals above but can't be attributed to anyone.</p>";
  }

  // ------------------------------------------------------------------ filters
  function tradeOptions(ix, selected) {
    var present = {};
    for (var i = 0; i < ix.cube.length; i += 7) present[ix.cube[i + 1]] = 1;
    return '<option value="">All trades</option>' + S.tradeIds.map(function (t, i) {
      if (!present[i]) return "";
      return '<option value="' + t + '"' + (t === selected ? " selected" : "") + ">" + esc(S.tradeLabel[t]) + "</option>";
    }).join("");
  }
  function zipOptions(ix, selected) {
    var zs = ix.zips.slice().sort();
    return '<option value="">All ZIP codes (' + zs.length + ")</option>" + zs.map(function (z) {
      return '<option value="' + z + '"' + (z === selected ? " selected" : "") + ">" + z + "</option>";
    }).join("");
  }
  function renderFilters(route, ix) {
    var p = route.params, f = filterIndexes(ix, p);
    var box = $("#filters");
    if (route.view === "c") { box.innerHTML = ""; return; }
    if (route.view === "search") {
      box.innerHTML = '<form class="filters" role="search" id="search-form" style="grid-template-columns:minmax(0,1fr) auto"><div class="field">' +
        '<label for="q">Contractor or company name</label><input id="q" type="search" autocomplete="off" value="' + esc(p.get("q") || "") +
        '" placeholder="Type at least 2 letters, e.g. electric"></div><div class="actions"><button class="btn" type="button" id="csv">Download CSV</button></div></form>';
      var q = $("#q");
      var timer;
      q.addEventListener("input", function () {
        clearTimeout(timer);
        timer = setTimeout(function () {
          history.replaceState(null, "", href(route.city, "search", cleanParams({ q: q.value.trim() })));
          S.route = parseRoute();
          S.shown = PAGE;
          renderView(S.route, ix);
        }, 160);
      });
      $("#search-form").addEventListener("submit", function (e) { e.preventDefault(); });
      $("#csv").addEventListener("click", exportCurrent);
      return;
    }
    var win = p.get("window") || "n90", sort = p.get("sort") || "most";
    var html = '<form class="filters" id="filter-form" aria-label="Filters">' +
      '<div class="field"><label for="f-trade">Trade</label><select id="f-trade">' + tradeOptions(ix, f.trade) + "</select></div>" +
      '<div class="field"><label for="f-zip">ZIP code (job site)</label><select id="f-zip">' + zipOptions(ix, f.zip) + "</select></div>";
    if (route.view === "leaderboard") {
      html += '<div class="field"><label for="f-window">Count permits in</label><select id="f-window">' +
        Object.keys(WINDOWS).map(function (k) { return '<option value="' + k + '"' + (k === win ? " selected" : "") + ">" + WINDOWS[k] + "</option>"; }).join("") +
        "</select></div>" +
        '<div class="field"><label for="f-sort">Sort by</label><select id="f-sort">' +
        [["most", "Most permits"], ["risers", "Biggest risers (90 days vs prior 90)"], ["fallers", "Biggest fallers (90 days vs prior 90)"]].map(function (o) {
          return '<option value="' + o[0] + '"' + (o[0] === sort ? " selected" : "") + ">" + o[1] + "</option>";
        }).join("") + "</select></div>";
    } else {
      html += '<div class="field"></div><div class="field"></div>';
    }
    html += '<div class="actions"><button class="btn" type="button" id="csv">Download CSV</button>' +
      (f.trade || f.zip ? '<a class="btn btn-small" href="' + href(route.city, route.view) + '">Clear</a>' : "") + "</div></form>";
    box.innerHTML = html;
    function update() {
      var o = { trade: $("#f-trade").value, zip: $("#f-zip").value };
      if (route.view === "leaderboard") {
        o.window = $("#f-window").value === "n90" ? "" : $("#f-window").value;
        o.sort = $("#f-sort").value === "most" ? "" : $("#f-sort").value;
      }
      location.hash = href(route.city, route.view, cleanParams(o));
    }
    Array.prototype.forEach.call(box.querySelectorAll("select"), function (s) { s.addEventListener("change", update); });
    $("#csv").addEventListener("click", exportCurrent);
  }

  // ------------------------------------------------------------------ views
  function contractorLink(city, row) {
    return '<a href="' + href(city, "c", null, row[0]) + '">' + esc(row[1]) + "</a>" + (row[8] ? '<span class="badge new">New</span>' : "");
  }
  function sinceText(ix, row) {
    var startPlus = new Date(ix.window.start + "T12:00:00"); startPlus.setDate(startPlus.getDate() + 31);
    if (row[8]) return "New this month";
    if (new Date(row[6] + "T12:00:00") <= startPlus) return "Since " + monthLabel(ix.window.start.slice(0, 7), true) + " or earlier";
    return "First permit " + day(row[6]);
  }

  function leaderboardRows(route, ix) {
    var f = filterIndexes(ix, route.params);
    var win = route.params.get("window") || "n90";
    if (!WINDOWS[win]) win = "n90";
    var sort = route.params.get("sort") || "most";
    var a = aggregate(ix, f.ti, f.zi);
    var list = [];
    for (var ci = 0; ci < ix.c.length; ci++) {
      if (!a.n12[ci]) continue;
      if (sort === "most" && !a[win][ci]) continue;
      if (sort === "risers" && a.n90[ci] - a.p90[ci] <= 0) continue;
      if (sort === "fallers" && a.n90[ci] - a.p90[ci] >= 0) continue;
      list.push(ci);
    }
    list.sort(function (x, y) {
      if (sort === "risers") return (a.n90[y] - a.p90[y]) - (a.n90[x] - a.p90[x]) || a.n90[y] - a.n90[x];
      if (sort === "fallers") return (a.n90[x] - a.p90[x]) - (a.n90[y] - a.p90[y]) || a.p90[y] - a.p90[x];
      return a[win][y] - a[win][x] || a.n12[y] - a.n12[x];
    });
    return { list: list, a: a, win: win, sort: sort, f: f };
  }

  function filterLabel(f) {
    return (f.trade ? S.tradeLabel[f.trade] : "all trades") + (f.zip ? " in ZIP " + f.zip : "");
  }

  function renderLeaderboard(route, ix) {
    var r = leaderboardRows(route, ix), city = route.city;
    S.lastRows = { kind: "leaderboard", route: route, data: r };
    var shown = r.list.slice(0, S.shown);
    var sortText = r.sort === "most" ? "most permits, " + WINDOWS[r.win].toLowerCase() : r.sort === "risers" ? "biggest risers" : "biggest fallers";
    var h = '<div class="result-meta"><p><strong>' + fmt.format(r.list.length) + "</strong> contractors &middot; " + esc(filterLabel(r.f)) +
      " &middot; sorted by " + esc(sortText) + '</p><p class="muted">Momentum compares the last 90 days with the 90 days before.</p></div>';
    if (!r.list.length) {
      $("#view").innerHTML = h + '<p class="notice">No contractors match these filters. Try all ZIP codes or a wider time window.</p>';
      announce("No contractors match.");
      return;
    }
    var sortCol = r.sort === "most" ? r.win : "n90";
    function th(label, col, extra) {
      return '<th scope="col" class="n' + (extra || "") + '"' + (col === sortCol ? ' aria-sort="descending"' : "") + ">" + label + (col === sortCol ? " \u2193" : "") + "</th>";
    }
    h += '<div class="table-wrap"><table><caption class="sr-only">Contractor leaderboard for ' + esc(filterLabel(r.f)) + "</caption><thead><tr>" +
      '<th scope="col" class="n">#</th><th scope="col">Contractor</th><th scope="col" class="hide-sm">Main trade</th>' +
      (r.win === "n30" ? th("Last 30 d", "n30") : "") + th("12 mo", "n12", " hide-sm") + th("Last 90 d", "n90") + th("Prior 90 d", "p90", " hide-sm") +
      '<th scope="col" class="n">Momentum</th><th scope="col" class="hide-sm">Top ZIP</th></tr></thead><tbody>';
    shown.forEach(function (ci, i) {
      var row = ix.c[ci];
      var trade = r.f.trade || S.tradeIds[row[9]];
      var zip = r.f.zip || (row[10] >= 0 ? ix.zips[row[10]] : "");
      h += "<tr><td class=\"n\">" + (i + 1) + "</td><td>" + contractorLink(city, row) + '</td><td class="hide-sm"><span class="badge trade">' + esc(S.tradeLabel[trade]) + "</span></td>" +
        (r.win === "n30" ? '<td class="n">' + fmt.format(r.a.n30[ci]) + "</td>" : "") +
        '<td class="n hide-sm">' + fmt.format(r.a.n12[ci]) + '</td><td class="n">' + fmt.format(r.a.n90[ci]) + '</td><td class="n hide-sm">' + fmt.format(r.a.p90[ci]) +
        '</td><td class="n">' + momHTML(r.a.n90[ci], r.a.p90[ci]) + '</td><td class="hide-sm mono">' + esc(zip) + "</td></tr>";
    });
    h += "</tbody></table></div>" + moreControls(r.list.length);
    $("#view").innerHTML = h;
    bindMore();
    announce(fmt.format(r.list.length) + " contractors match " + filterLabel(r.f) + ".");
  }

  function moreControls(total) {
    if (total <= S.shown) return '<div class="more"><span class="muted">Showing all ' + fmt.format(total) + "</span></div>";
    return '<div class="more"><button class="btn" type="button" id="more">Show ' + Math.min(PAGE, total - S.shown) + ' more</button><span class="muted">Showing ' +
      fmt.format(S.shown) + " of " + fmt.format(total) + ". The CSV includes all " + fmt.format(total) + ".</span></div>";
  }
  function bindMore() {
    var b = $("#more");
    if (b) b.addEventListener("click", function () {
      S.shown += PAGE;
      var y = window.scrollY;
      renderView(S.route, S.idx[S.route.city]);
      window.scrollTo(0, y);
      var rows = document.querySelectorAll("#view tbody tr");
      var target = rows[S.shown - PAGE];
      if (target) { var a = target.querySelector("a"); if (a) a.focus(); }
    });
  }

  function newRows(route, ix) {
    var f = filterIndexes(ix, route.params);
    var a = aggregate(ix, f.ti, f.zi);
    var list = [];
    for (var ci = 0; ci < ix.c.length; ci++) if (ix.c[ci][8] && a.n12[ci]) list.push(ci);
    list.sort(function (x, y) { return a.n30[y] - a.n30[x] || (ix.c[y][6] < ix.c[x][6] ? -1 : 1); });
    return { list: list, a: a, f: f };
  }
  function renderNew(route, ix) {
    var r = newRows(route, ix), city = route.city;
    S.lastRows = { kind: "new", route: route, data: r };
    var p = ix.periods.last30;
    var h = '<div class="result-meta"><p><strong>' + fmt.format(r.list.length) + "</strong> new contractors &middot; " + esc(filterLabel(r.f)) +
      '</p><p class="muted">First permit in the 12-month record issued between ' + esc(day(p[0])) + " and " + esc(day(p[1])) + ".</p></div>";
    if (!r.list.length) {
      $("#view").innerHTML = h + '<p class="notice">No new contractors match these filters this month.</p>';
      announce("No new contractors match.");
      return;
    }
    h += '<div class="table-wrap"><table><caption class="sr-only">New contractors this month, ' + esc(filterLabel(r.f)) + "</caption><thead><tr>" +
      '<th scope="col">Contractor</th><th scope="col">First permit</th><th scope="col" class="n">Permits, last 30 d</th><th scope="col" class="hide-sm">Main trade</th><th scope="col" class="hide-sm">Top ZIP</th></tr></thead><tbody>';
    r.list.slice(0, S.shown).forEach(function (ci) {
      var row = ix.c[ci];
      var trade = r.f.trade || S.tradeIds[row[9]];
      var zip = r.f.zip || (row[10] >= 0 ? ix.zips[row[10]] : "");
      h += "<tr><td>" + contractorLink(city, row) + "</td><td>" + esc(day(row[6])) + '</td><td class="n">' + fmt.format(r.a.n30[ci]) +
        '</td><td class="hide-sm"><span class="badge trade">' + esc(S.tradeLabel[trade]) + '</span></td><td class="hide-sm mono">' + esc(zip) + "</td></tr>";
    });
    h += "</tbody></table></div>" + moreControls(r.list.length);
    $("#view").innerHTML = h;
    bindMore();
    announce(fmt.format(r.list.length) + " new contractors.");
  }

  function searchRows(route, ix) {
    var q = norm(route.params.get("q") || "");
    var list = [];
    if (q.length >= 2) {
      var names = S.norm[route.city];
      for (var ci = 0; ci < ix.c.length; ci++) if (names[ci].indexOf(q) >= 0) list.push(ci);
      list.sort(function (x, y) {
        var px = names[x].indexOf(q) === 0 ? 0 : 1, py = names[y].indexOf(q) === 0 ? 0 : 1;
        return px - py || ix.c[y][2] - ix.c[x][2];
      });
    }
    return { list: list, q: route.params.get("q") || "" };
  }
  function renderSearch(route, ix) {
    var r = searchRows(route, ix), city = route.city;
    S.lastRows = { kind: "search", route: route, data: r };
    var cm = cityMeta(city);
    if (norm(r.q).length < 2) {
      $("#view").innerHTML = '<p class="notice">Type at least two letters of a company name. Every contractor named on a ' + esc(cm.name) +
        " permit in the last 12 months is searchable, from the busiest to one-permit shops.</p>";
      return;
    }
    var h = '<div class="result-meta"><p><strong>' + fmt.format(r.list.length) + "</strong> contractors match &ldquo;" + esc(r.q) + "&rdquo; in " + esc(cm.name) + "</p></div>";
    if (!r.list.length) {
      $("#view").innerHTML = h + '<div class="notice"><p>No contractor by that name on a ' + esc(cm.name) + " permit in the last 12 months.</p><p>Try a shorter part of the name (\"radiant\" rather than \"Radiant Plumbing &amp; AC LLC\"). " +
        "Some jobs are permitted under the general contractor's name, and work outside city limits isn't in the city's data. An empty history is not by itself a red flag.</p></div>";
      announce("No matches.");
      return;
    }
    h += '<div class="table-wrap"><table><caption class="sr-only">Search results</caption><thead><tr><th scope="col">Contractor</th><th scope="col" class="n">Permits, 12 mo</th>' +
      '<th scope="col" class="n">Last 90 d</th><th scope="col" class="hide-sm">Main trade</th><th scope="col" class="hide-sm">On record</th><th scope="col" class="hide-sm">Last permit</th></tr></thead><tbody>';
    r.list.slice(0, S.shown).forEach(function (ci) {
      var row = ix.c[ci];
      h += "<tr><td>" + contractorLink(city, row) + '</td><td class="n">' + fmt.format(row[2]) + '</td><td class="n">' + fmt.format(row[3]) +
        '</td><td class="hide-sm"><span class="badge trade">' + esc(S.tradeLabel[S.tradeIds[row[9]]]) + '</span></td><td class="hide-sm">' + esc(sinceText(ix, row)) +
        '</td><td class="hide-sm">' + esc(day(row[7])) + "</td></tr>";
    });
    h += "</tbody></table></div>" + moreControls(r.list.length);
    $("#view").innerHTML = h;
    bindMore();
    announce(fmt.format(r.list.length) + " matches.");
  }

  function renderProfile(route, ix) {
    var city = route.city, key = route.key, cm = cityMeta(city);
    var ci = ix.byKey[key];
    if (ci == null) {
      $("#view").innerHTML = '<a class="back" href="' + href(city, "search") + '">&larr; Search ' + esc(cm.name) + '</a><div class="notice" style="margin-top:14px"><p>No contractor with that key on a ' +
        esc(cm.name) + " permit in the last 12 months.</p></div>";
      return;
    }
    $("#view").innerHTML = '<p class="notice">Loading profile&hellip;</p>';
    loadShard(city, ci).then(function (shard) {
      if (S.route.key !== key) return;
      var p = shard[key];
      S.lastRows = { kind: "profile", route: route, data: p };
      var months = ix.months;
      var active = p.months.filter(function (x) { return x > 0; }).length;
      var partial = cm.as_of.slice(0, 7) === months[months.length - 1];
      var mom = momentum(p.n90, p.p90);
      var topTrade = p.trades[0];
      var tradeShare = Math.round(100 * topTrade[1] / p.n12);
      var row = ix.c[ci];
      var status = p.is_new ? '<span class="badge new">New this month</span>' : '<span class="badge">' + esc(sinceText(ix, row)) + "</span>";
      var h = '<a class="back" href="' + href(city, "leaderboard") + '">&larr; ' + esc(cm.name) + " leaderboard</a>" +
        '<div class="profile-head"><div><p class="eyebrow">Contractor profile &middot; ' + esc(cm.name) + ", " + esc(cm.state) + "</p>" +
        '<h2 id="profile-title" tabindex="-1">' + esc(p.name) + "</h2><p>" + status + ' <span class="badge">' + esc(MOMENTUM[p.momentum] || p.momentum) + "</span></p></div>" +
        '<div class="actions" style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-small" type="button" id="csv-jobs">Jobs CSV</button><button class="btn btn-small" type="button" id="csv-months">Monthly CSV</button></div></div>';
      h += '<div class="kpis">' + [
        [fmt.format(p.n12), "permits, last 12 months"],
        [fmt.format(p.n90) + ' <span class="mom ' + mom.cls + '" style="font-size:15px" aria-label="' + esc(mom.label) + ' versus prior 90 days">' + esc(mom.text) + "</span>", "permits, last 90 days (prior 90: " + fmt.format(p.p90) + ")"],
        [active + " / " + months.length, "months with at least one permit"],
        [fmt.format(p.zip_count), "ZIP codes worked in"]
      ].map(function (k) { return '<div class="kpi"><b>' + k[0] + "</b><span>" + esc(k[1]) + "</span></div>"; }).join("") + "</div>";
      var zipsTxt = p.zips.slice(0, 3).map(function (z) { return z[0]; }).join(", ");
      h += '<div class="verdict"><p><strong>On the record:</strong> ' + fmt.format(p.n12) + " permits issued by the City of " + esc(cm.name.replace("New York City", "New York")) + " naming " +
        esc(p.name) + " between " + esc(day(p.first)) + " and " + esc(day(p.last)) + ", active in " + active + " of the last " + months.length + " months. " +
        "Mostly " + esc(S.tradeLabel[S.tradeIds[topTrade[0]]].toLowerCase()) + " (" + tradeShare + "% of permits)" + (zipsTxt ? ", mainly in ZIP " + esc(zipsTxt) : "") + ".</p>" +
        '<p class="muted">First permit date is the first one in our 12-month window, not the company\'s founding date. This is a permit history, not a licence check: verify licence and insurance with the state.</p></div>';
      h += '<div class="profile-grid"><div class="chart-box"><h3>Permits per month' + (partial ? " (last bar: month to date)" : "") + '</h3><div class="chart">' +
        barChart(p.months, months, { title: p.name + " permits per month", partialLast: partial, height: 170 }) + "</div></div>" +
        '<div class="chart-box"><h3>Trade mix, 12 months</h3><ul class="hbars">' + hbars(p.trades.slice(0, 8).map(function (t) { return [S.tradeLabel[S.tradeIds[t[0]]], t[1]]; })) + "</ul></div></div>";
      h += '<div class="profile-grid"><div class="chart-box"><h3>Top ZIP codes (job site)</h3><ul class="hbars">' + hbars(p.zips.slice(0, 8)) + "</ul>" +
        (p.zip_count > 8 ? '<p class="muted" style="font-size:14px">+ ' + (p.zip_count - 8) + " more ZIP codes</p>" : "") + "</div>" +
        '<div class="chart-box"><h3>Details</h3><ul style="padding-left:1.1em;margin:0">' +
        "<li>First permit in window: " + esc(day(p.first)) + "</li><li>Latest permit: " + esc(day(p.last)) + "</li>" +
        "<li>Declared job value: " + (p.value_n ? usd.format(p.value_sum) + " across " + fmt.format(p.value_n) + " permit" + (p.value_n > 1 ? "s" : "") + " that state one" : "none stated on these permits") + "</li>" +
        (p.variants.length > 1 ? "<li>Also recorded as: " + p.variants.slice(1).map(esc).join("; ") + "</li>" : "") +
        (p.also_in.length ? "<li>Same name also on permits in (may be a different company): " + p.also_in.map(function (c) { var o = cityMeta(c); return o ? '<a href="' + href(c, "c", null, key) + '">' + esc(o.name) + "</a>" : ""; }).join(", ") + "</li>" : "") +
        "</ul></div></div>";
      h += '<h3 style="margin-top:22px">Most recent permits</h3><div class="table-wrap"><table><caption class="sr-only">Most recent permits for ' + esc(p.name) + "</caption><thead><tr>" +
        '<th scope="col">Issued</th><th scope="col">Trade</th><th scope="col">ZIP</th><th scope="col">Work description (as filed)</th><th scope="col" class="n hide-sm">Declared value</th><th scope="col" class="hide-sm">Permit</th></tr></thead><tbody>';
      p.recent.forEach(function (j) {
        h += "<tr><td style=\"white-space:nowrap\">" + esc(day(j[0])) + "</td><td>" + esc(S.tradeLabel[S.tradeIds[j[1]]]) + '</td><td class="mono">' + esc(j[2]) + "</td><td>" + esc(j[3]) +
          '</td><td class="n hide-sm">' + (j[4] ? usd.format(j[4]) : "–") + '</td><td class="mono hide-sm">' + esc(j[5]) + "</td></tr>";
      });
      h += "</tbody></table></div><p class=\"muted\" style=\"font-size:14px\">Showing the latest " + p.recent.length + " of " + fmt.format(p.n12) + " permits. Street addresses, phone numbers and emails are removed from descriptions.</p>";
      $("#view").innerHTML = h;
      document.title = p.name + " (" + cm.name + "): Contractor Radar";
      $("#csv-jobs").addEventListener("click", function () {
        downloadCSV("radar_" + city + "_" + key.toLowerCase() + "_recent_permits.csv",
          ["city", "contractor", "contractor_key", "issued_date", "trade", "zip", "work_description", "declared_value_usd", "permit_id", "data_as_of"],
          p.recent.map(function (j) { return [cm.name, p.name, key, j[0], S.tradeLabel[S.tradeIds[j[1]]], j[2], j[3], j[4] || "", j[5], cm.as_of]; }));
      });
      $("#csv-months").addEventListener("click", function () {
        downloadCSV("radar_" + city + "_" + key.toLowerCase() + "_monthly.csv", ["city", "contractor", "contractor_key", "month", "permits", "data_as_of"],
          p.months.map(function (n, i) { return [cm.name, p.name, key, months[i], n, cm.as_of]; }));
      });
      var t = $("#profile-title");
      if (t && S.focusProfile) { t.focus(); S.focusProfile = false; }
      announce("Profile loaded: " + p.name);
    }).catch(showError);
  }

  function exportCurrent() {
    var L = S.lastRows;
    if (!L) return;
    var city = L.route.city, ix = S.idx[city], cm = cityMeta(city);
    var stamp = cm.as_of;
    if (L.kind === "leaderboard") {
      var r = L.data;
      downloadCSV("radar_" + city + "_leaderboard_" + (r.f.trade || "all") + (r.f.zip ? "_" + r.f.zip : "") + "_" + stamp + ".csv",
        ["rank", "city", "contractor", "contractor_key", "main_trade", "permits_" + r.win, "permits_last_90d", "permits_prior_90d", "momentum_pct",
          "permits_last_12m", "first_permit_in_window", "last_permit", "top_zip", "new_this_month", "filter_trade", "filter_zip", "data_as_of"],
        r.list.map(function (ci, i) {
          var row = ix.c[ci], m = momentum(r.a.n90[ci], r.a.p90[ci]);
          return [i + 1, cm.name, row[1], row[0], S.tradeLabel[r.f.trade || S.tradeIds[row[9]]], r.a[r.win][ci], r.a.n90[ci], r.a.p90[ci],
            m.pct == null ? "" : m.pct, r.a.n12[ci], row[6], row[7], r.f.zip || (row[10] >= 0 ? ix.zips[row[10]] : ""), row[8] ? "yes" : "", r.f.trade, r.f.zip, stamp];
        }));
    } else if (L.kind === "new") {
      var n = L.data;
      downloadCSV("radar_" + city + "_new_contractors_" + (n.f.trade || "all") + (n.f.zip ? "_" + n.f.zip : "") + "_" + stamp + ".csv",
        ["city", "contractor", "contractor_key", "first_permit_in_window", "permits_last_30d", "main_trade", "top_zip", "filter_trade", "filter_zip", "data_as_of"],
        n.list.map(function (ci) {
          var row = ix.c[ci];
          return [cm.name, row[1], row[0], row[6], n.a.n30[ci], S.tradeLabel[n.f.trade || S.tradeIds[row[9]]], n.f.zip || (row[10] >= 0 ? ix.zips[row[10]] : ""), n.f.trade, n.f.zip, stamp];
        }));
    } else if (L.kind === "search") {
      var s = L.data;
      downloadCSV("radar_" + city + "_search_" + norm(s.q).toLowerCase().slice(0, 30) + "_" + stamp + ".csv",
        ["city", "contractor", "contractor_key", "permits_last_12m", "permits_last_90d", "permits_prior_90d", "main_trade", "first_permit_in_window", "last_permit", "new_this_month", "data_as_of"],
        s.list.map(function (ci) {
          var row = ix.c[ci];
          return [cm.name, row[1], row[0], row[2], row[3], row[4], S.tradeLabel[S.tradeIds[row[9]]], row[6], row[7], row[8] ? "yes" : "", stamp];
        }));
    }
  }

  function cityMeta(id) {
    for (var i = 0; i < S.meta.cities.length; i++) if (S.meta.cities[i].id === id) return S.meta.cities[i];
    return null;
  }

  function renderTabs(route) {
    Array.prototype.forEach.call(document.querySelectorAll("#tabs a"), function (a) {
      var v = a.getAttribute("data-view");
      var keep = new URLSearchParams();
      if (v !== "search") ["trade", "zip"].forEach(function (k) { if (route.params.get(k)) keep.set(k, route.params.get(k)); });
      a.setAttribute("href", href(route.city, v, keep));
      if (v === route.view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
  }

  function renderView(route, ix) {
    if (route.view === "leaderboard") renderLeaderboard(route, ix);
    else if (route.view === "new") renderNew(route, ix);
    else if (route.view === "search") renderSearch(route, ix);
    else if (route.view === "c") renderProfile(route, ix);
  }

  function showError(err) {
    $("#view").innerHTML = '<div class="notice error"><p><strong>Couldn\'t load the data.</strong> ' + esc(err && err.message) +
      "</p><p>If you opened this file directly from disk, serve the folder instead: <span class=\"mono\">cd site &amp;&amp; python3 -m http.server</span> and open http://localhost:8000/app.html</p></div>";
  }

  function onRoute() {
    var route = parseRoute();
    if (!route.city) {
      var last = storageGet("radar.city");
      var c = cityMeta(last) ? last : S.meta.cities[0].id;
      location.replace(href(c, route.view === "c" ? "leaderboard" : route.view, route.params));
      return;
    }
    S.shown = PAGE;
    S.route = route;
    storageSet("radar.city", route.city);
    $("#city").value = route.city;
    renderTabs(route);
    loadCity(route.city).then(function (ix) {
      if (S.route !== route) return;
      renderCityHeader(cityMeta(route.city), ix);
      var hadFocus = document.activeElement && document.activeElement.id === "q";
      renderFilters(route, ix);
      if (hadFocus && $("#q")) { var q = $("#q"); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
      if (route.view === "c") S.focusProfile = true;
      renderView(route, ix);
    }).catch(showError);
  }

  function init() {
    getJSON("data/meta.json").then(function (meta) {
      S.meta = meta;
      S.tradeIds = meta.trades.map(function (t) { return t[0]; });
      meta.trades.forEach(function (t) { S.tradeLabel[t[0]] = t[1]; });
      var sel = $("#city");
      sel.innerHTML = meta.cities.map(function (c) { return '<option value="' + c.id + '">' + esc(c.name + ", " + c.state) + "</option>"; }).join("");
      sel.addEventListener("change", function () {
        var r = parseRoute();
        var keep = new URLSearchParams();
        if (r.params.get("trade")) keep.set("trade", r.params.get("trade"));
        if (r.view === "search" && r.params.get("q")) keep.set("q", r.params.get("q"));
        location.hash = href(sel.value, r.view === "c" ? "leaderboard" : r.view, keep);
      });
      // no-JS landing form fallback: app.html?city=austin&q=radiant
      var qs = new URLSearchParams(location.search);
      if (qs.get("q") && cityMeta(qs.get("city"))) {
        history.replaceState(null, "", "app.html" + href(qs.get("city"), "search", cleanParams({ q: qs.get("q") })));
      }
      window.addEventListener("hashchange", onRoute);
      onRoute();
    }).catch(showError);
  }
  init();
})();
