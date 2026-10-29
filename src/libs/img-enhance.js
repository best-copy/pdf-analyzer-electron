// 🖼 이미지 업스케일·벡터화 — 순수 계산(화면·워커·노드 검사 공용, DOM 없음)
//  · upscalePlan: 몇 배로 키울지(AI 모델은 2·3·4배) — '인쇄 크기에서 300dpi' 목표
//  · 윤곽(imagetracer 결과) → PDF 경로 명령 / SVG
//    imagetracer는 색마다 따로 윤곽을 따서 이웃한 색 사이에 머리카락 같은 틈이 생긴다 →
//    같은 색으로 얇게 테두리를 함께 그려(seam) 메운다. 거의 무채색인 색은 회색(g)으로 —
//    RGB 회색을 rg로 쓰면 프린터가 컬러로 셀 수 있다(함정 15·16과 같은 이유).
(function (root) {
  const PT_PER_MM = 72 / 25.4;

  // 원본 srcW×srcH 를 어떻게 키울까 → { run: AI 배율(1이면 안 돌림), outW, outH, need: 필요한 배율, capped }
  //  opts.mode: 2|3|4(그 배율) | 'dpi'(인쇄 폭 printWmm 에서 targetDpi 가 되게, 4배 넘으면 4배)
  //  opts.maxSide: 결과 긴 변 상한(기본 16000px), opts.maxPixels: 결과 화소 상한(기본 1.2억)
  function upscalePlan(srcW, srcH, opts) {
    opts = opts || {};
    const maxSide = opts.maxSide || 16000, maxPix = opts.maxPixels || 120e6;
    let need;
    if (opts.mode === 'dpi') {
      const wMm = opts.printWmm > 0 ? opts.printWmm : srcW / 300 * 25.4;
      need = (opts.targetDpi || 300) * (wMm / 25.4) / srcW;
    } else need = +opts.mode || 2;
    let f = Math.min(4, need);
    const capSide = maxSide / Math.max(srcW, srcH), capPix = Math.sqrt(maxPix / (srcW * srcH));
    let capped = false;
    if (f > capSide || f > capPix) { f = Math.min(capSide, capPix); capped = true; }
    if (f <= 1.02) return { run: 1, outW: srcW, outH: srcH, need, capped, factor: 1 };
    const run = f <= 2 ? 2 : f <= 3 ? 3 : 4;
    return { run, outW: Math.round(srcW * f), outH: Math.round(srcH * f), need, capped, factor: f };
  }

  // 불투명 화소가 거의 모두 무채색이면 true (흑백 사진은 DeviceGray로 담아야 컬러로 안 센다)
  function isNeutralRgba(data, tol, step) {
    tol = tol == null ? 6 : tol; step = step || 1;
    let bad = 0, n = 0;
    for (let i = 0; i < data.length; i += 4 * step) {
      if (data[i + 3] < 8) continue;
      n++;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (Math.max(r, g, b) - Math.min(r, g, b) > tol) bad++;
    }
    return n > 0 && bad <= n * 0.001;
  }

  // 오츠 문턱값 — 흑백(2색) 벡터화 전 이진화
  function otsu(hist, total) {
    let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = 0, thr = 128;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = total - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    return thr;
  }
  // RGBA → 흑/백 RGBA(투명은 흰색). thr 없으면 오츠. 반환 { data, thr }
  function binarizeRgba(data, thr) {
    const n = data.length >> 2, g = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const a = data[j + 3] / 255;
      const v = Math.round(((data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8) * a + 255 * (1 - a));
      g[i] = v; hist[v]++;
    }
    if (thr == null) thr = otsu(hist, n);
    const out = new Uint8ClampedArray(data.length);
    for (let i = 0, j = 0; i < n; i++, j += 4) { const v = g[i] <= thr ? 0 : 255; out[j] = out[j + 1] = out[j + 2] = v; out[j + 3] = 255; }
    return { data: out, thr };
  }

  // ── 색 줄이기(벡터화 앞) ──
  // imagetracer 기본 색 고르기는 경계의 중간색(글자 테두리 회색, AI로 키운 그림의 번진 띠)이 색 자리를 차지해
  // 검정과 빨강이 한 색으로 합쳐지고, 검정·흰색 경계의 회색이 엉뚱한 파랑으로 칠해져 테두리가 생겼다(합성 로고 실측).
  // ① 대표색 = '고른 화소'(이웃 4개와 색 차 작음)만 모아 비슷한 색끼리 묶고(자동이면 묶음 수가 곧 색 수) 몇 번 다듬기
  // ② 대표색에 아주 가깝거나 고른 화소는 그 색, 나머지(경계 띠)는 이웃 영역에서 번져 들어오며 **이웃한 색 중에서만** 고른다
  //    → 경계가 두 영역 중 하나로 갈리고 다른 색 테두리가 생기지 않는다.
  // 반환 { data: 대표색으로 칠한 RGBA, pal: [{r,g,b,a}] (투명 있으면 마지막에 a:0), k: 불투명 색 수 }
  function quantizeRgba(data, w, h, k) {
    const n = w * h, FLAT = 30, CLOSE = 18;   // CLOSE: 고르지 않은 화소는 대표색과 거의 같을 때만 씨앗(45면 흐린 경계가 이웃 아닌 색(초록)으로 칠해져 테두리가 생겼다)
    const dist = (i, c) => Math.abs(data[i] - c.r) + Math.abs(data[i + 1] - c.g) + Math.abs(data[i + 2] - c.b);
    const flat = new Uint8Array(n);
    const bins = new Map();
    let nFlat = 0, anyClear = false;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      if (data[i + 3] < 128) { anyClear = true; continue; }
      let f = true;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = (yy * w + xx) * 4;
        if (data[j + 3] < 128 || Math.abs(data[j] - data[i]) + Math.abs(data[j + 1] - data[i + 1]) + Math.abs(data[j + 2] - data[i + 2]) > FLAT) { f = false; break; }
      }
      if (!f) continue;
      flat[p] = 1; nFlat++;
      const key = (data[i] >> 3) << 10 | (data[i + 1] >> 3) << 5 | (data[i + 2] >> 3);
      let b = bins.get(key); if (!b) bins.set(key, b = [0, 0, 0, 0]);
      b[0]++; b[1] += data[i]; b[2] += data[i + 1]; b[3] += data[i + 2];
    }
    if (!nFlat) {   // 고른 화소가 없는 그림(잡음 사진) — 전부로
      for (let p = 0; p < n; p++) { const i = p * 4; if (data[i + 3] < 128) continue; const key = (data[i] >> 3) << 10 | (data[i + 1] >> 3) << 5 | (data[i + 2] >> 3); let b = bins.get(key); if (!b) bins.set(key, b = [0, 0, 0, 0]); b[0]++; b[1] += data[i]; b[2] += data[i + 1]; b[3] += data[i + 2]; nFlat++; }
    }
    const binArr = [...bins.values()].map(b => ({ n: b[0], r: b[1] / b[0], g: b[2] / b[0], b: b[3] / b[0] })).sort((a, b) => b.n - a.n);
    const MERGE = k ? 24 : 56;
    const cl = [];
    for (const b of binArr) {
      let best = -1, bd = MERGE;
      for (let q = 0; q < cl.length; q++) { const m = cl[q], d = Math.abs(m.r / m.n - b.r) + Math.abs(m.g / m.n - b.g) + Math.abs(m.b / m.n - b.b); if (d < bd) { bd = d; best = q; } }
      if (best >= 0) { const m = cl[best]; m.n += b.n; m.r += b.r * b.n; m.g += b.g * b.n; m.b += b.b * b.n; }
      else cl.push({ n: b.n, r: b.r * b.n, g: b.g * b.n, b: b.b * b.n });
    }
    cl.sort((a, b) => b.n - a.n);
    let K = k ? Math.min(k, cl.length) : Math.max(1, Math.min(24, cl.filter(c => c.n >= nFlat * 0.002).length));
    let pal = cl.slice(0, Math.max(1, K)).map(c => ({ r: c.r / c.n, g: c.g / c.n, b: c.b / c.n }));
    for (let it = 0; it < 5; it++) {   // 다듬기(묶음 칸 가중 k-평균)
      const acc = pal.map(() => [0, 0, 0, 0]);
      for (const b of binArr) {
        let best = 0, bd = Infinity;
        for (let q = 0; q < pal.length; q++) { const c = pal[q], d = Math.abs(c.r - b.r) + Math.abs(c.g - b.g) + Math.abs(c.b - b.b); if (d < bd) { bd = d; best = q; } }
        const a = acc[best]; a[0] += b.n; a[1] += b.r * b.n; a[2] += b.g * b.n; a[3] += b.b * b.n;
      }
      pal = pal.map((c, q) => acc[q][0] ? { r: acc[q][1] / acc[q][0], g: acc[q][2] / acc[q][0], b: acc[q][3] / acc[q][0] } : c);
    }
    pal = pal.map(c => ({ r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: 255 }));
    const CLEAR = pal.length;
    // 칠하기: 씨앗(투명·고른 화소·대표색에 아주 가까운 화소) → 나머지는 이웃 씨앗에서 번져 들어오며 이웃한 색 중 가까운 것
    const lab = new Int16Array(n).fill(-1);
    let queue = [];
    for (let p = 0; p < n; p++) {
      const i = p * 4;
      if (data[i + 3] < 128) { lab[p] = CLEAR; continue; }
      let best = 0, bd = Infinity;
      for (let q = 0; q < pal.length; q++) { const d = dist(i, pal[q]); if (d < bd) { bd = d; best = q; } }
      if (flat[p] || bd <= CLOSE) lab[p] = best;
    }
    for (let p = 0; p < n; p++) if (lab[p] < 0) queue.push(p);
    let guard = 0;
    while (queue.length && guard++ < 4096) {
      const next = [], set = [];
      for (const p of queue) {
        const x = p % w, y = (p - x) / w, i = p * 4;
        let best = -1, bd = Infinity;
        for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const l = lab[yy * w + xx]; if (l < 0 || l === CLEAR) continue;
          const d = dist(i, pal[l]); if (d < bd) { bd = d; best = l; }
        }
        if (best >= 0) set.push(p, best); else next.push(p);
      }
      for (let s = 0; s < set.length; s += 2) lab[set[s]] = set[s + 1];   // 한 겹씩(같은 겹 안에서는 서로 영향 없게)
      if (next.length === queue.length) {   // 더 번질 곳이 없다(사방이 투명 등) — 가장 가까운 색
        for (const p of next) { const i = p * 4; let best = 0, bd = Infinity; for (let q = 0; q < pal.length; q++) { const d = dist(i, pal[q]); if (d < bd) { bd = d; best = q; } } lab[p] = best; }
        break;
      }
      queue = next;
    }
    const out = new Uint8ClampedArray(n * 4);
    for (let p = 0; p < n; p++) {
      const l = lab[p], j = p * 4;
      if (l === CLEAR || l < 0) { out[j] = out[j + 1] = out[j + 2] = 255; out[j + 3] = 0; continue; }
      const c = pal[l]; out[j] = c.r; out[j + 1] = c.g; out[j + 2] = c.b; out[j + 3] = 255;
    }
    const full = anyClear ? pal.concat([{ r: 255, g: 255, b: 255, a: 0 }]) : pal;
    return { data: out, pal: full, k: pal.length };
  }

  // 색: { r,g,b,a } → 회색으로 볼지(tol 안)·흰색인지
  function colorInfo(c, tol) {
    const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b);
    const neutral = mx - mn <= (tol == null ? 10 : tol);
    const gray = (c.r * 77 + c.g * 150 + c.b * 29) / 256;
    return { neutral, gray, white: neutral && gray >= 245, clear: c.a != null && c.a < 128 };
  }

  // imagetracer 결과 → 칠할 모양 목록(넓은 색 먼저) — 모양 = { color, info, subs:[{x,y,segs:[['L',x,y]|['Q',cx,cy,x,y]]}] }
  function traceShapes(td, opts) {
    opts = opts || {};
    const tol = opts.neutralTol == null ? 10 : opts.neutralTol;
    const layers = [];
    td.layers.forEach((layer, li) => {
      const c = td.palette[li], info = colorInfo(c, tol);
      if (info.clear || (opts.dropWhite && info.white)) return;
      const shapes = []; let area = 0;
      layer.forEach(p => {
        if (p.isholepath || !p.segments || !p.segments.length) return;
        const subs = [outerSub(p)];
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        p.segments.forEach(s => { bx0 = Math.min(bx0, s.x1); by0 = Math.min(by0, s.y1); bx1 = Math.max(bx1, s.x1); by1 = Math.max(by1, s.y1); });
        area += Math.max(0, bx1 - bx0) * Math.max(0, by1 - by0);
        (p.holechildren || []).forEach(hi => { const h = layer[hi]; if (h && h.segments && h.segments.length) subs.push(holeSub(h)); });
        shapes.push(subs);
      });
      if (shapes.length) layers.push({ color: c, info, area, shapes });
    });
    layers.sort((a, b) => b.area - a.area);
    return layers;
  }
  function outerSub(p) {
    const s0 = p.segments[0], segs = [];
    p.segments.forEach(s => segs.push(s.type === 'Q' ? ['Q', s.x2, s.y2, s.x3, s.y3] : ['L', s.x2, s.y2]));
    return { x: s0.x1, y: s0.y1, segs };
  }
  function holeSub(h) {   // 구멍은 거꾸로 돈다(imagetracer와 같은 방향) — 짝홀 규칙으로 칠하므로 방향은 상관없다
    const last = h.segments[h.segments.length - 1], segs = [];
    const sx = last.type === 'Q' ? last.x3 : last.x2, sy = last.type === 'Q' ? last.y3 : last.y2;
    for (let k = h.segments.length - 1; k >= 0; k--) {
      const s = h.segments[k];
      segs.push(s.type === 'Q' ? ['Q', s.x2, s.y2, s.x1, s.y1] : ['L', s.x1, s.y1]);
    }
    return { x: sx, y: sy, segs };
  }

  const fmt = v => { const r = Math.round(v * 1000) / 1000; return Object.is(r, -0) ? '0' : String(r); };
  function pdfColor(L, stroke) {
    if (L.info.neutral) return `${fmt(L.info.gray / 255)} ${stroke ? 'G' : 'g'}`;
    const c = L.color;
    return `${fmt(c.r / 255)} ${fmt(c.g / 255)} ${fmt(c.b / 255)} ${stroke ? 'RG' : 'rg'}`;
  }

  // 윤곽 → PDF 쪽 내용(쪽 크기 pageW×pageH pt, 이미지 td.width×td.height 가 쪽 전체)
  //  opts.seam: 틈 메우기 테두리 폭(이미지 화소, 기본 0.7 · 0이면 칠하기만)
  function tracePdfOps(td, opts) {
    opts = opts || {};
    const sx = opts.pageW / td.width, sy = opts.pageH / td.height, H = opts.pageH;
    const seam = opts.seam == null ? 0.7 : opts.seam;
    const X = x => fmt(x * sx), Y = y => fmt(H - y * sy);
    const out = ['q'];
    if (seam > 0) out.push(`${fmt(seam * (sx + sy) / 2)} w 1 j`);
    for (const L of traceShapes(td, opts)) {
      out.push(pdfColor(L, false) + (seam > 0 ? ' ' + pdfColor(L, true) : ''));
      for (const subs of L.shapes) {
        for (const s of subs) {
          let px = s.x, py = s.y;
          out.push(`${X(px)} ${Y(py)} m`);
          for (const g of s.segs) {
            if (g[0] === 'L') { out.push(`${X(g[1])} ${Y(g[2])} l`); px = g[1]; py = g[2]; }
            else {   // 2차 → 3차 베지어
              const [, cx, cy, x, y] = g;
              const c1x = px + 2 / 3 * (cx - px), c1y = py + 2 / 3 * (cy - py), c2x = x + 2 / 3 * (cx - x), c2y = y + 2 / 3 * (cy - y);
              out.push(`${X(c1x)} ${Y(c1y)} ${X(c2x)} ${Y(c2y)} ${X(x)} ${Y(y)} c`); px = x; py = y;
            }
          }
          out.push('h');
        }
        out.push(seam > 0 ? 'B*' : 'f*');
      }
    }
    out.push('Q');
    return out.join('\n');
  }

  // 윤곽 → SVG 문서(크기 wMm×hMm, 좌표는 이미지 화소)
  function traceSvg(td, opts) {
    opts = opts || {};
    const seam = opts.seam == null ? 0.7 : opts.seam;
    const parts = [`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${fmt(opts.wMm)}mm" height="${fmt(opts.hMm)}mm" viewBox="0 0 ${td.width} ${td.height}">`];
    for (const L of traceShapes(td, opts)) {
      const c = L.info.neutral ? { r: Math.round(L.info.gray), g: Math.round(L.info.gray), b: Math.round(L.info.gray) } : L.color;
      const col = '#' + [c.r, c.g, c.b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
      const d = [];
      for (const subs of L.shapes) for (const s of subs) {
        d.push(`M${fmt(s.x)} ${fmt(s.y)}`);
        for (const g of s.segs) d.push(g[0] === 'L' ? `L${fmt(g[1])} ${fmt(g[2])}` : `Q${fmt(g[1])} ${fmt(g[2])} ${fmt(g[3])} ${fmt(g[4])}`);
        d.push('Z');
      }
      parts.push(`<path fill="${col}" fill-rule="evenodd"${seam > 0 ? ` stroke="${col}" stroke-width="${fmt(seam)}" stroke-linejoin="round"` : ''} d="${d.join(' ')}"/>`);
    }
    parts.push('</svg>');
    return parts.join('\n');
  }

  // 결과 요약 — { colors, shapes, points }
  function traceStats(td, opts) {
    let shapes = 0, points = 0;
    const layers = traceShapes(td, opts);
    layers.forEach(L => L.shapes.forEach(subs => { shapes++; subs.forEach(s => { points += s.segs.length; }); }));
    return { colors: layers.length, shapes, points, gray: layers.every(L => L.info.neutral) };
  }

  const api = { PT_PER_MM, upscalePlan, isNeutralRgba, otsu, binarizeRgba, quantizeRgba, colorInfo, traceShapes, tracePdfOps, traceSvg, traceStats };
  root.ImgEnhance = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : typeof window !== 'undefined' ? window : globalThis);
