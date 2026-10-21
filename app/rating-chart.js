// The rating chart: a player's rating after each counted result, with lines
// at the official levels. Used by My Rating and Developers > Ratings.
window.RatingChart = (function () {
  const { esc, fmtPlayDate } = STA;
  const fine = r => Number(r).toFixed(2);
  const level = r => Number(r).toFixed(1);
  const signed = x => (x >= 0 ? '+' : '−') + Math.abs(Number(x)).toFixed(3);
  const score = sets => sets.map(s => `${s[0]}-${s[1]}`).join(', ');

  // box: an empty element; summary: what my_rating / dev_rating_history
  // return (player.start and history); startSub: the hover text for Start.
  function draw(box, summary, startSub) {
    const hs = summary.history.filter(h => h.rated);
    const pts = [{ y: Number(summary.player.start), label: 'Start', sub: startSub }]
      .concat(hs.map(h => ({ y: Number(h.rating_after), label: fmtPlayDate(h.played_on),
        sub: `${score(h.sets)} · ${signed(h.change)}`, official: Number(h.official_after) })));
    const W = 720, H = 260, L = 40, R = 52, T = 14, B = 26;
    const ys = pts.map(p => p.y);
    const lo = Math.floor((Math.min(...ys) - 0.15) * 2) / 2, hi = Math.ceil((Math.max(...ys) + 0.15) * 2) / 2;
    const x = i => L + (pts.length === 1 ? 0 : i * (W - L - R) / (pts.length - 1));
    const y = v => T + (hi - v) * (H - T - B) / (hi - lo);
    let grid = '';
    for (let v = lo; v <= hi + 1e-9; v += 0.5) {
      grid += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#e6e8eb" stroke-width="1"/>
        <text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#6b7280">${level(v)}</text>`;
    }
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join('');
    const dots = pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.y)}" r="4" fill="var(--accent)" stroke="#fff" stroke-width="2"/>`).join('');
    const last = pts[pts.length - 1];
    box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Rating after each result, from ${fine(pts[0].y)} to ${fine(last.y)}">
      ${grid}
      <line x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}" stroke="#d5d9de" stroke-width="1"/>
      <text x="${L}" y="${H - 8}" font-size="11" fill="#6b7280">Start</text>
      <text x="${W - R}" y="${H - 8}" font-size="11" fill="#6b7280" text-anchor="end">${esc(last.label)}</text>
      <path d="${path}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <line class="cross" y1="${T}" y2="${H - B}" stroke="#9aa1ab" stroke-width="1" visibility="hidden"/>
      ${dots}
      <text x="${x(pts.length - 1) + 8}" y="${y(last.y) + 4}" font-size="12" font-weight="600" fill="#1f2933">${fine(last.y)}</text>
      <rect x="${L - 10}" y="0" width="${W - L - R + 20}" height="${H}" fill="transparent"/>
    </svg><div class="tip" hidden></div>`;
    const svg = box.querySelector('svg'), tip = box.querySelector('.tip'), cross = box.querySelector('.cross');
    const show = ev => {
      const r = svg.getBoundingClientRect();
      const px = (ev.clientX - r.left) * W / r.width;
      let i = Math.round((px - L) / ((W - L - R) / Math.max(1, pts.length - 1)));
      i = Math.max(0, Math.min(pts.length - 1, i));
      const p = pts[i];
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
      tip.innerHTML = `<strong>${fine(p.y)}</strong>${p.official != null ? ` (level ${level(p.official)})` : ''}<br>${esc(p.label)}<br><span class="muted">${esc(p.sub)}</span>`;
      tip.hidden = false;
      const left = x(i) * r.width / W, top = y(p.y) * r.height / H;
      tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), r.width - tip.offsetWidth) + 'px';
      tip.style.top = Math.max(0, top - tip.offsetHeight - 12) + 'px';
    };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
  }

  return { draw, fine, level, signed, score };
})();
