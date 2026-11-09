/* Contractor Radar landing page: live numbers + this week's signals from data/meta.json. */
(function () {
  "use strict";
  var fmt = new Intl.NumberFormat("en-US");
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function day(iso) { var d = new Date(iso + "T12:00:00"); return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }); }

  // Subscribe buttons: until the founder pastes real checkout links over {LINK_1CITY}/{LINK_3CITY},
  // keep the buttons from navigating to a literal "{LINK_...}" URL.
  Array.prototype.forEach.call(document.querySelectorAll("a.subscribe"), function (a) {
    if (/^\{LINK_/.test(a.getAttribute("href") || "")) {
      a.setAttribute("aria-disabled", "true");
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var note = a.parentNode.querySelector(".plan-note");
        if (note) note.textContent = "Checkout opens at launch. The free radar works today.";
      });
    }
  });

  // Vet form -> app search route (works without JS too: app.js reads ?city=&q=)
  var form = document.getElementById("vet-form");
  if (form) form.addEventListener("submit", function (e) {
    e.preventDefault();
    var city = document.getElementById("vet-city").value;
    var q = document.getElementById("vet-q").value.trim();
    if (q.length < 2) { document.getElementById("vet-q").focus(); return; }
    location.href = "app.html#/" + encodeURIComponent(city) + "/search?q=" + encodeURIComponent(q);
  });

  fetch("data/meta.json", { cache: "no-cache" }).then(function (r) {
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }).then(function (meta) {
    var trades = {};
    meta.trades.forEach(function (t) { trades[t[0]] = t[1]; });
    var ticker = document.getElementById("ticker");
    ticker.innerHTML = meta.cities.map(function (c) {
      return '<li><a class="city" href="app.html#/' + c.id + '">' + esc(c.name) + '</a>' +
        '<span class="big">' + fmt.format(c.permits) + '</span><small>permits, last 12 months</small>' +
        '<small><b>' + fmt.format(c.contractors) + '</b> contractors &middot; <b>' + fmt.format(c.new_this_month) + '</b> new this month</small>' +
        '<small>as of ' + esc(day(c.as_of)) + '</small></li>';
    }).join("") + '<li><span class="city">More cities</span><small>Added when the city\'s official data names the contractor on most permits.</small></li>';
    var sig = [];
    meta.cities.forEach(function (c) {
      var m = c.teaser_movers && c.teaser_movers[0];
      if (m) sig.push('<div class="signal"><p class="eyebrow">' + esc(c.name) + ' &middot; momentum</p><p><a href="app.html#/' + c.id + '/c/' + encodeURIComponent(m.key) + '"><strong>' + esc(m.name) + '</strong></a> pulled <b class="num">' + fmt.format(m.n90) + '</b> permits in the last 90 days, up from <b class="num">' + fmt.format(m.p90) + '</b> in the 90 days before (' + esc(trades[m.trade] || m.trade) + ').</p></div>');
      var n = c.teaser_new && c.teaser_new[0];
      if (n) sig.push('<div class="signal"><p class="eyebrow">' + esc(c.name) + ' &middot; new entrant</p><p><a href="app.html#/' + c.id + '/c/' + encodeURIComponent(n.key) + '"><strong>' + esc(n.name) + '</strong></a> pulled its first permit in 12 months within the last 30 days and already has <b class="num">' + fmt.format(n.n30) + '</b> (' + esc(trades[n.trade] || n.trade) + ').</p></div>');
    });
    document.getElementById("signals").innerHTML = sig.join("");
  }).catch(function () {
    document.getElementById("ticker").innerHTML = '<li><span class="city">Live numbers unavailable</span><small>Open this page through a web server (e.g. python3 -m http.server) so data/meta.json can load.</small></li>';
    document.getElementById("signals").innerHTML = '<p class="notice error">Couldn\'t load this week\'s data.</p>';
  });
})();
