// 🧹 스캔 정리 — 쪽 그림(회색)에서 빛샘·그늘 무늬와 기울기를 판정한다 (순수 함수, 앱·검사 공용)
// 2026-10-28 사용자 원고(Fuji Xerox D110 600dpi 흑백 1비트 스캔, 267쪽)로 기준을 맞췄다.
//   · 흑백 스캔은 그늘이 '회색'이 아니라 검은 점 무늬로 찍힌다 → 밝기 펴기 대신 무늬를 찾아 흰색으로 덮는다.
//   · pdf.js가 150dpi로 줄여 그리면 점 무늬는 옅은 회색(160~245), 글자·사진은 진한 회색(<130)이 섞인다.
// 입력: g = 회색 바이트(0 검정~255 흰색, 행 우선), w·h, dpi(기본 150). 좌표는 화면에 보이는 방향(/Rotate 반영).
// 출력(mm, 왼쪽 위 원점):
//   edges {top,bottom,left,right} — 가장자리에서 이만큼 흰색으로(0 = 그대로)
//   spots [{x,y,w,h}] — 모서리·가장자리의 옅은 점 무늬(가장자리에서 이어진 것만)
//   angle — 내용이 시계방향으로 기운 각도(°). 바로잡으려면 반시계로 같은 만큼 돌린다
//   deskew — 적용할 각도(믿을 수 있을 때만, 아니면 0), gain — 측정 신뢰(×), ink — 글자 비율(%)
//   review — 사람이 봐야 할 이유 목록
(function (root) {
  'use strict';
  const DEF = {
    dpi: 150,
    dirt: 235,        // 가장자리 줄 판정: 이보다 어두우면 '무늬나 글자'
    dark: 130,        // 이보다 어두우면 진한 점(글자·사진·검은 띠)
    skewInk: 170,     // 기울기 측정: 이보다 어둡고
    edgeLight: 215,   //   2px 옆에 이보다 밝은 점이 있으면 '경계 점'
    clean: 0.005,     // 줄에서 dirt 비율이 이 이하면 깨끗한 여백
    dirty: 0.02,      // 이 이상이면 무늬가 있는 줄
    gapMm: 1.5,       // 무늬 뒤 깨끗한 여백이 이만큼 이어져야 '여백'
    bandDark: 0.35,   // 무늬 구간의 진한 점 평균이 이 이상이면 '검은 띠'(빛샘·종이 밖)
    shadeDark: 0.012, //   이 이하이면서
    shadeLight: 0.03, //   옅은 점이 이 이상이면 '그늘 점 무늬' — 둘 다 아니면 글자 줄이라 그대로
    maxMm: 36,        // 가장자리에서 이 깊이까지만 본다
    sideMaxW: 8,      // 좌우 무늬 폭 상한(mm) — 넘으면 글자일 수 있어 건드리지 않음
    tbMaxW: 9,        // 위아래 무늬 폭 상한
    cornerMm: 35,     // 옅은 점 무늬는 모서리 구역(가장자리 양쪽에서 이 안)에서만
    guardMm: 2,       //   진한 점(글자·사진) 이 안의 칸은 빼고
    spotSeedMm: 8,    // 이 안쪽에서 시작한 무늬만(가장자리에서 이어진 것)
    minDeskew: 0.2, maxDeskew: 2.9, minGain: 1.05, minInk: 1,
    minPeak: 1.15,    // 구역 각도를 믿는 뾰족함(여러 각도 평균 대비)
    maxSpread: 1.2,   // 구역끼리 기울기가 이보다 다르면 '확인 필요'(오려 붙인 원고)
    contentMinBlocks: 2, // 내용 상자: 1mm 칸 줄(가로·세로)에 진한 칸이 이만큼 있어야 내용으로(외톨이 티끌 무시)
    centerMinMm: 2,      // 가운데로 맞출 때 이보다 덜 쏠렸으면 그대로
  };

  // 가장자리 하나 — profile[k]: 가장자리에서 k번째 줄의 무늬 비율. 반환 {depth(px), dirtyW(px)}
  // P = { dirt, dark, light } 줄별 비율. 무늬 구간이 '검은 띠'(진한 점 빽빽) 또는 '그늘 점 무늬'(진한 점 거의 없이 옅은 점)일
  // 때만 지운다 — 가장자리 가까이의 진짜 글자 줄(진한 획이 몇~30% 섞임)은 남긴다(5쪽 위 목차 숫자 줄·15쪽 제목 줄을 지웠다).
  function edgeDepth(P, o, MM) {
    const profile = P.dirt;
    const max = Math.min(profile.length, Math.round(o.maxMm * MM)), gapN = Math.max(2, Math.round(o.gapMm * MM));
    let k0 = 0;
    while (k0 < max && profile[k0] <= o.clean) k0++;   // 스캐너가 둘러 준 맨 바깥 흰 테두리
    let dirty = false, run = 0, sd = 0, sl = 0, n = 0;
    for (let k = k0; k < max; k++) {
      if (profile[k] <= o.clean) {
        if (++run >= gapN) {
          if (!dirty) return { depth: 0, dirtyW: 0 };
          const ad = sd / Math.max(1, n), al = sl / Math.max(1, n);
          const band = ad >= o.bandDark, shade = ad <= o.shadeDark && al >= o.shadeLight;
          if (!band && !shade) return { depth: 0, dirtyW: 0, text: true };   // 글자 줄 — 그대로
          return { depth: k - run + 1 + Math.floor(run / 2), dirtyW: k - run + 1 - k0 };
        }
      } else {
        if (profile[k] >= o.dirty) dirty = true;
        // 여백 직전까지의 무늬 구간 평균 — 중간의 짧은 빈 줄도 구간에 넣는다
        sd += P.dark[k]; sl += P.light[k]; n++;
        run = 0;
      }
    }
    return { depth: 0, dirtyW: 0 };
  }

  function scanAnalyze(g, w, h, opt) {
    const o = Object.assign({}, DEF, opt || {});
    const MM = o.dpi / 25.4, review = [];
    // 줄마다 dirt(무늬·글자)·dark(진한 점)·light(옅은 점) 비율
    const prof = (len, cells, at) => {
      const P = { dirt: new Float32Array(len), dark: new Float32Array(len), light: new Float32Array(len) };
      for (let k = 0; k < len; k++) {
        let di = 0, dk = 0, li = 0;
        for (let c = 0; c < cells; c++) { const v = g[at(k, c)]; if (v < o.dirt) { di++; if (v < o.dark) dk++; else li++; } }
        P.dirt[k] = di / cells; P.dark[k] = dk / cells; P.light[k] = li / cells;
      }
      return P;
    };
    const rowProf = (x0, x1, fromTop) => prof(h, x1 - x0, (k, c) => (fromTop ? k : h - 1 - k) * w + x0 + c);
    const colProf = (y0, y1, fromLeft) => prof(w, y1 - y0, (k, c) => (y0 + c) * w + (fromLeft ? k : w - 1 - k));
    // ① 가장자리 — 위·아래 먼저(좌우 바깥 12%는 빼고: 모서리 무늬는 ②가 맡는다), 그 안에서 좌·우
    const mx = Math.round(w * 0.12);
    const T = edgeDepth(rowProf(mx, w - mx, true), o, MM), B = edgeDepth(rowProf(mx, w - mx, false), o, MM);
    const y0 = Math.max(T.depth, Math.round(h * 0.06)), y1 = Math.min(h - B.depth, Math.round(h * 0.94));
    const L = edgeDepth(colProf(y0, y1, true), o, MM), R = edgeDepth(colProf(y0, y1, false), o, MM);
    const lim = (e, maxW, name) => { if (e.depth && e.dirtyW / MM > maxW) { review.push(name + ' 무늬 폭 큼'); return 0; } return e.depth; };
    const ed = { top: lim(T, o.tbMaxW, '위'), bottom: lim(B, o.tbMaxW, '아래'), left: lim(L, o.sideMaxW, '왼쪽'), right: lim(R, o.sideMaxW, '오른쪽') };

    // ② 옅은 점 무늬 — 1mm 칸마다 진한 점·옅은 점을 세어 '옅은 점만 있는 칸'을 무늬로 본다.
    //    모서리 구역(cornerMm) 안에서, 가장자리 가까이(spotSeedMm)에서 시작해 이어진 무늬 칸만 지운다.
    const bs = Math.max(2, Math.round(MM)), bw = Math.ceil(w / bs), bh = Math.ceil(h / bs);
    const kind = new Uint8Array(bw * bh);   // 0 깨끗 · 1 옅은 무늬 · 2 진한 점(글자·사진·띠)
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      let dk = 0, lt = 0, n = 0;
      for (let y = by * bs; y < Math.min(h, by * bs + bs); y++) for (let x = bx * bs, i = y * w + x; x < Math.min(w, bx * bs + bs); x++, i++) {
        const v = g[i]; n++;
        if (v < o.dark) dk++; else if (v < 245) lt++;
      }
      kind[by * bw + bx] = dk > n * 0.02 ? 2 : (dk <= 1 && lt >= n * 0.05) ? 1 : 0;
    }
    // 모서리 구역에서만 — 위아래·좌우 가장자리 양쪽에서 모두 cornerMm 안. 가장자리 30mm 띠 전체로 찾았더니
    // 가장자리에 붙은 사진의 옅은 하늘(145쪽)·맨 위 작은 글자 줄 근처(169쪽)까지 무늬로 번졌다.
    // 진한 점(글자·사진) guardMm 안의 칸도 뺀다 — 사진·글자 가장자리를 갉아먹지 않게.
    const seedZ = o.spotSeedMm, cz = o.cornerMm, gr = Math.max(1, Math.round(o.guardMm * MM / bs));
    const dV = bx => Math.min(bx, bw - 1 - bx) * bs / MM, dH = by => Math.min(by, bh - 1 - by) * bs / MM;
    const inCorner = (bx, by) => dV(bx) <= cz && dH(by) <= cz;
    const nearDark = new Uint8Array(bw * bh);
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) if (kind[by * bw + bx] === 2) {
      for (let dy = -gr; dy <= gr; dy++) for (let dx = -gr; dx <= gr; dx++) {
        const nx = bx + dx, ny = by + dy;
        if (nx >= 0 && ny >= 0 && nx < bw && ny < bh) nearDark[ny * bw + nx] = 1;
      }
    }
    const ok = k => kind[k] === 1 && !nearDark[k];
    const mark = new Uint8Array(bw * bh), q = [];
    for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
      const k = by * bw + bx;
      if (ok(k) && inCorner(bx, by) && Math.min(dV(bx), dH(by)) <= seedZ) { mark[k] = 1; q.push(k); }
    }
    while (q.length) {
      const k = q.pop(), bx = k % bw, by = (k / bw) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = bx + dx, ny = by + dy;
        if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
        const nk = ny * bw + nx;
        if (mark[nk] || !ok(nk) || !inCorner(nx, ny)) continue;
        mark[nk] = 1; q.push(nk);
      }
    }
    // 가장자리 정리 영역 안의 칸은 빼고, 줄마다 이어진 칸을 사각형으로
    const inEdge = (bx, by) => { const x = bx * bs, y = by * bs; return y < ed.top || y + bs > h - ed.bottom || x < ed.left || x + bs > w - ed.right; };
    const spots = [];
    for (let by = 0; by < bh; by++) {
      let s = -1;
      for (let bx = 0; bx <= bw; bx++) {
        const on = bx < bw && mark[by * bw + bx] && !inEdge(bx, by);
        if (on && s < 0) s = bx;
        if (!on && s >= 0) {
          // 한 칸 바깥까지 살짝 넓혀 덮는다(무늬 끝 반 칸)
          const x0 = Math.max(0, s * bs - bs / 2), x1 = Math.min(w, bx * bs + bs / 2), yy0 = Math.max(0, by * bs - bs / 2), yy1 = Math.min(h, by * bs + bs * 1.5);
          spots.push({ x: x0 / MM, y: yy0 / MM, w: (x1 - x0) / MM, h: (yy1 - yy0) / MM });
          s = -1;
        }
      }
    }

    // ③ 기울기 — 정리한 영역 밖, 진한 점(글자·괘선·사진)으로 각도별 가로·세로 투영의 날카로움
    const pts = [];
    const x0c = ed.left + 2, x1c = w - ed.right - 2, y0c = ed.top + 2, y1c = h - ed.bottom - 2;
    // 기울기 점 = 밝기가 급하게 바뀌는 '경계' 점(글자 획·괘선의 가장자리) — 진한 점을 다 쓰면 줄여 그린 사진이
    // 통째로 진한 덩어리가 되어 방향 정보 없이 점 수만 차지해 각도가 틀렸다(30쪽: 실제 1.7° → 0.5°로 잼,
    // 긴 세로 괘선으로 확인). 사진 안쪽은 경계가 아니라 빠진다.
    let inkN = 0;
    const lt = o.edgeLight, dkE = o.skewInk;
    for (let y = Math.max(2, y0c); y < Math.min(h - 2, y1c); y++) for (let x = Math.max(2, x0c), i = y * w + x; x < Math.min(w - 2, x1c); x++, i++) {
      const v = g[i];
      if (v >= dkE) continue;
      inkN++;
      if (g[i + 2] > lt || g[i - 2] > lt || g[i + 2 * w] > lt || g[i - 2 * w] > lt) pts.push(x, y);
    }
    const ink = inkN / (w * h) * 100;
    const H = new Float64Array(w + h + 4), V = new Float64Array(w + h + 4);
    // P = 점 배열(x,y 번갈아). 각도 a로 돌렸을 때 가로·세로 투영의 날카로움(이웃 칸 차이 제곱합)
    const score = (P, a) => {
      const r = a * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), off = Math.max(w, h) * Math.abs(s);
      H.fill(0); V.fill(0);
      for (let i = 0; i < P.length; i += 2) {
        const x = P[i], y = P[i + 1];
        const yy = Math.round(y * c - x * s + off), xx = Math.round(x * c + y * s + off);
        if (yy >= 0 && yy < H.length) H[yy]++;
        if (xx >= 0 && xx < V.length) V[xx]++;
      }
      let sh = 0; for (let i = 1; i < H.length; i++) { const d1 = H[i] - H[i - 1], d2 = V[i] - V[i - 1]; sh += d1 * d1 + d2 * d2; }
      return sh;
    };
    const measure = P => {
      if (P.length < 400) return null;
      let best = { a: 0, s: -1 }, sum = 0, cnt = 0;
      for (let a = -3; a <= 3.0001; a += 0.25) { const s = score(P, a); sum += s; cnt++; if (s > best.s) best = { a, s }; }
      const a0 = best.a;
      for (let a = a0 - 0.25; a <= a0 + 0.25001; a += 0.05) { const s = score(P, a); if (s > best.s) best = { a: Math.round(a * 100) / 100, s }; }
      // gain = 0° 대비 나아진 정도(돌릴 가치), peak = 여러 각도 평균 대비 뾰족함(각도를 믿을 수 있는 정도).
      // 이미 수평인 구역은 gain이 1이라 gain으로 거르면 빠져 버린다(반은 수평·반은 2° 원고를 통째로 2° 돌림)
      return { a: best.a, gain: best.s / Math.max(1, score(P, 0)), peak: best.s / Math.max(1, sum / cnt), n: P.length / 2 };
    };
    // 쪽 전체 + 네 구역 — 오려 붙인 신문 스크랩은 기사마다 각도가 다르다(30쪽: 구역별 1.25·0.4·1.05·1.75°).
    // 전체로 재면 글자가 빽빽한 한 구역이 좌우하므로, 믿을 만한 구역들의 가중 중앙값을 쓴다.
    const all = measure(pts);
    const cx = (x0c + x1c) / 2, cy = (y0c + y1c) / 2, quad = [[], [], [], []];
    for (let i = 0; i < pts.length; i += 2) quad[(pts[i] < cx ? 0 : 1) + (pts[i + 1] < cy ? 0 : 2)].push(pts[i], pts[i + 1]);
    const parts = quad.map(measure).filter(m => m && m.n >= 2000 && m.peak >= o.minPeak && Math.abs(m.a) < o.maxDeskew);
    let angle = all ? all.a : 0, gain = all ? all.gain : 1, spread = 0;
    if (parts.length >= 2) {
      // 가중치는 점 수만 — 뾰족함까지 곱하면 획이 또렷한 제목 칸 한 구역이 좌우했다(30쪽: 실제 1.7°인데 제목 칸 0.4°로)
      const ws = parts.map(m => ({ a: m.a, wt: m.n })).sort((p, q2) => p.a - q2.a);
      const tot = ws.reduce((t, m) => t + m.wt, 0);
      let acc = 0; for (const m of ws) { acc += m.wt; if (acc >= tot / 2) { angle = m.a; break; } }
      spread = ws[ws.length - 1].a - ws[0].a;
      // 구역끼리 크게 다르면(오려 붙인 원고) 가장 큰 각·작은 각의 가운데 — 어느 부분이든 어긋남이 가장 작다(30쪽: 위 0.2~0.4° · 아래 1.0~1.6° → 0.9°)
      if (spread > o.maxSpread) angle = Math.round((ws[0].a + ws[ws.length - 1].a) / 2 * 20) / 20;
      gain = Math.max(gain, ...parts.map(m => m.gain));
    }
    const aa = Math.abs(angle);
    let deskew = 0;
    if (ink < o.minInk) { /* 빈 쪽 */ }
    else if (aa < o.minDeskew) { /* 수평 */ }
    else if (aa >= o.maxDeskew) review.push(`기울기 ${angle}° 측정 범위 끝`);
    else if (gain < o.minGain && aa >= 0.3) review.push(`기울기 ${angle}° 신뢰 낮음`);
    else deskew = angle;
    if (!(ink < o.minInk) && spread > o.maxSpread) review.push(`부분마다 기울기 다름(${Math.round(spread * 10) / 10}° 차 · 오려 붙인 원고)`);
    const r1 = v => Math.round(v * 10) / 10;
    // ④ 내용 상자(mm, 화면 방향) — 지울 가장자리 띠 안쪽의 진한 칸(글자·사진)만. 가운데로 옮길 거리 = 쪽 가운데 − 내용 가운데
    let content = null, center = null;
    if (!(ink < o.minInk)) {
      const bx0 = Math.ceil(ed.left / bs), bx1 = bw - Math.ceil(ed.right / bs), by0 = Math.ceil(ed.top / bs), by1 = bh - Math.ceil(ed.bottom / bs);
      const colN = new Uint16Array(bw), rowN = new Uint16Array(bh);
      for (let by = by0; by < by1; by++) for (let bx = bx0; bx < bx1; bx++) if (kind[by * bw + bx] === 2) { colN[bx]++; rowN[by]++; }
      let cx0 = -1, cx1 = -1, cy0 = -1, cy1 = -1;
      for (let bx = bx0; bx < bx1; bx++) if (colN[bx] >= o.contentMinBlocks) { if (cx0 < 0) cx0 = bx; cx1 = bx; }
      for (let by = by0; by < by1; by++) if (rowN[by] >= o.contentMinBlocks) { if (cy0 < 0) cy0 = by; cy1 = by; }
      if (cx0 >= 0 && cy0 >= 0) {
        const X0 = cx0 * bs, X1 = Math.min(w, (cx1 + 1) * bs), Y0 = cy0 * bs, Y1 = Math.min(h, (cy1 + 1) * bs);
        content = { x: r1(X0 / MM), y: r1(Y0 / MM), w: r1((X1 - X0) / MM), h: r1((Y1 - Y0) / MM) };
        center = { dx: r1((w - X0 - X1) / 2 / MM), dy: r1((h - Y0 - Y1) / 2 / MM) };
      }
    }
    return {
      content, center,
      edges: { top: r1(ed.top / MM), bottom: r1(ed.bottom / MM), left: r1(ed.left / MM), right: r1(ed.right / MM) },
      spots, angle, deskew, gain: Math.round(gain * 1000) / 1000, ink: r1(ink), review,
      blank: ink < o.minInk,
    };
  }

  // ── 굽기 — 원본 쪽 내용은 그대로(스캔 그림 G4도 그대로) 두고 감싼다 ─────────────────────────
  //   q [회전 cm] q [원래 내용] Q [흰 사각형들] Q
  // 흰 사각형은 판정 좌표(화면 방향·왼쪽 위 원점, mm)이므로 /Rotate와 쪽 상자를 거꾸로 따라 PDF 좌표로 바꾼다.
  // 회전은 쪽 상자 가운데 기준 반시계 deskew°(판정 각도 = 내용이 시계방향으로 기운 각도).
  // plan: { edges:{top,bottom,left,right}, spots:[{x,y,w,h}], deskew, useEdges, useSpots, useDeskew } (mm·°)
  // PDFLib: pdf-lib 모듈(화면에서는 전역 PDFLib). 반환: 실제로 넣은 { rects, angle }
  function scanBoxOf(page) {
    // 판정은 pdf.js 화면(=CropBox 기준)에서 했으므로 같은 상자
    const b = page.getCropBox ? page.getCropBox() : page.getMediaBox();
    return { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height };
  }
  // 화면 좌표(pt, 왼쪽 위 원점, y 아래로) → PDF 사용자 좌표
  function scanDispToUser(box, rot, dx, dy) {
    switch (((rot % 360) + 360) % 360) {
      case 90:  return [box.x0 + dy, box.y0 + dx];
      case 180: return [box.x1 - dx, box.y0 + dy];
      case 270: return [box.x1 - dy, box.y1 - dx];
      default:  return [box.x0 + dx, box.y1 - dy];
    }
  }
  function scanBakePage(PDFLib, doc, pageIndex, plan) {
    const pg = doc.getPage(pageIndex);
    const box = scanBoxOf(pg), rot = pg.getRotation().angle || 0;
    const MMp = 72 / 25.4;
    const dispW = (rot % 180 === 0) ? box.x1 - box.x0 : box.y1 - box.y0;
    const dispH = (rot % 180 === 0) ? box.y1 - box.y0 : box.x1 - box.x0;
    const rects = [];
    const addDisp = (x, y, w, h) => {   // mm
      if (!(w > 0 && h > 0)) return;
      const a = scanDispToUser(box, rot, x * MMp, y * MMp), b2 = scanDispToUser(box, rot, (x + w) * MMp, (y + h) * MMp);
      rects.push([Math.min(a[0], b2[0]), Math.min(a[1], b2[1]), Math.abs(b2[0] - a[0]), Math.abs(b2[1] - a[1])]);
    };
    const Wmm = dispW / MMp, Hmm = dispH / MMp;
    if (plan.useEdges !== false && plan.edges) {
      const e = plan.edges;
      // 회전하면 가장자리 띠가 비스듬해져 끝이 남는다 — 띠는 쪽 밖까지 넉넉히 늘려 덮는다
      const pad = 10;
      if (e.top > 0) addDisp(-pad, -pad, Wmm + 2 * pad, e.top + pad);
      if (e.bottom > 0) addDisp(-pad, Hmm - e.bottom, Wmm + 2 * pad, e.bottom + pad);
      if (e.left > 0) addDisp(-pad, -pad, e.left + pad, Hmm + 2 * pad);
      if (e.right > 0) addDisp(Wmm - e.right, -pad, e.right + pad, Hmm + 2 * pad);
    }
    if (plan.useSpots !== false && Array.isArray(plan.spots)) for (const s of plan.spots) addDisp(s.x, s.y, s.w, s.h);
    // 직접 지운 곳(정리 창에서 끌어 고른 사각형, mm·원래 스캔 기준) — 무늬처럼 내용과 함께 돈다
    // 펜 획 {t:'p', w: 굵기 mm, pts: [[x,y] mm…]} — 둥근 끝 흰 선
    const strokes = [];
    if (Array.isArray(plan.manual)) for (const s of plan.manual) {
      if (s && s.t === 'p') {
        if (!(s.w > 0) || !Array.isArray(s.pts) || !s.pts.length) continue;
        strokes.push({ w: s.w * MMp, pts: s.pts.map(q => scanDispToUser(box, rot, q[0] * MMp, q[1] * MMp)) });
      } else if (s) addDisp(s.x, s.y, s.w, s.h);
    }
    const angle = (plan.useDeskew !== false && plan.deskew) ? +plan.deskew : 0;
    // 이동(가운데로·직접 옮김) — 화면 mm(오른쪽·아래 +) → PDF 좌표 이동량
    let tx = 0, ty = 0;
    if (plan.shift && (plan.shift.x || plan.shift.y)) {
      const a0 = scanDispToUser(box, rot, 0, 0), a1 = scanDispToUser(box, rot, (plan.shift.x || 0) * MMp, (plan.shift.y || 0) * MMp);
      tx = a1[0] - a0[0]; ty = a1[1] - a0[1];
    }
    if (!rects.length && !strokes.length && !angle && !tx && !ty) return { rects: 0, strokes: 0, angle: 0, shift: 0 };
    const f = v => (Math.round(v * 100000) / 100000).toString();   // 회전값은 소수 다섯째 자리까지(셋째면 1.5°가 1.49°)
    let pre = 'q\n';
    // cm은 뒤에 쓴 것이 먼저 적용된다 → 내용: 회전 → 이동
    if (tx || ty) pre += `1 0 0 1 ${f(tx)} ${f(ty)} cm\n`;
    if (angle) {
      const r = angle * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
      const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
      // PDF 좌표(y 위로)의 양수 각 = 반시계. 쪽을 /Rotate로 돌려 보여도 회전 방향은 같다
      pre += `${f(c)} ${f(s)} ${f(-s)} ${f(c)} ${f(cx - c * cx + s * cy)} ${f(cy - s * cx - c * cy)} cm\n`;
    }
    pre += 'q\n';
    let post = 'Q\n';
    if (rects.length) {
      post += '1 g\n';   // 흰색(회색 1) — 흑백 쪽이 컬러로 세지 않게 DeviceGray
      for (const [x, y, w, h] of rects) post += `${f(x)} ${f(y)} ${f(w)} ${f(h)} re\n`;
      post += 'f\n';
    }
    if (strokes.length) {
      post += '1 G\n1 J\n1 j\n';   // 흰 선(회색 1) · 둥근 끝·둥근 이음
      for (const st of strokes) {
        post += `${f(st.w)} w\n${f(st.pts[0][0])} ${f(st.pts[0][1])} m\n`;
        const rest = st.pts.length > 1 ? st.pts.slice(1) : [st.pts[0]];   // 한 번 찍은 점 = 같은 자리로 선(둥근 끝이 점이 된다)
        for (const q of rest) post += `${f(q[0])} ${f(q[1])} l\n`;
        post += 'S\n';
      }
    }
    post += 'Q\n';
    const ctx = doc.context;
    const mk = str => ctx.register(ctx.flateStream(new TextEncoder().encode(str)));
    const preRef = mk(pre), postRef = mk(post);
    const N = PDFLib.PDFName, cur = pg.node.get(N.of('Contents'));
    const list = [];
    if (cur) {
      const v = ctx.lookup(cur);
      if (v instanceof PDFLib.PDFArray) v.asArray().forEach(x => list.push(x)); else list.push(cur);
    }
    pg.node.set(N.of('Contents'), ctx.obj([preRef, ...list, postRef]));
    return { rects: rects.length, strokes: strokes.length, angle, shift: (tx || ty) ? 1 : 0 };
  }

  // 굽기 되돌리기 — 내용 앞뒤에 붙인 감싸기 조각(우리 모양 그대로일 때만)을 떼어 굽기 전 쪽으로.
  // 작업 파일을 다시 열면 '굽기 전 편집본'이 없어 원본에서 다시 구워야 했다(그 사이 내부 편집 내용이 빠짐) →
  // 이걸로 정리 전 상태(내부 편집·K100 포함)를 정확히 되찾는다. 모양이 다르면(다른 처리가 내용을 다시 썼으면) false.
  function scanUnbakePage(PDFLib, doc, pageIndex) {
    const pg = doc.getPage(pageIndex), ctx = doc.context, N = PDFLib.PDFName;
    const cur = pg.node.get(N.of('Contents'));
    const arr = cur && ctx.lookup(cur);
    if (!(arr instanceof PDFLib.PDFArray) || arr.size() < 3) return false;
    const list = arr.asArray();
    const text = ref => {
      try {
        const st = ctx.lookup(ref);
        const b = st instanceof PDFLib.PDFRawStream ? PDFLib.decodePDFRawStream(st).decode() : st.getContents();
        return new TextDecoder('latin1').decode(b);
      } catch (e) { return null; }
    };
    const pre = text(list[0]), post = text(list[list.length - 1]);
    if (!pre || !post) return false;
    if (!/^q\n(?:[-0-9.e]+ [-0-9.e]+ [-0-9.e]+ [-0-9.e]+ [-0-9.e]+ [-0-9.e]+ cm\n){0,2}q\n$/.test(pre)) return false;
    if (!/^Q\n(?:1 g\n(?:[-0-9.e]+ [-0-9.e]+ [-0-9.e]+ [-0-9.e]+ re\n)+f\n)?(?:1 G\n1 J\n1 j\n(?:[-0-9.e]+ w\n[-0-9.e]+ [-0-9.e]+ m\n(?:[-0-9.e]+ [-0-9.e]+ l\n)+S\n)+)?Q\n$/.test(post)) return false;
    const rest = list.slice(1, -1);
    pg.node.set(N.of('Contents'), ctx.obj(rest));   // 굽기가 배열로 만들었으므로 배열 그대로(뜻은 단일과 같다)
    return true;
  }

  const api = { scanAnalyze, scanBakePage, scanUnbakePage, scanDispToUser, SCAN_CLEAN_DEFAULTS: DEF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  Object.assign(root, api);
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
