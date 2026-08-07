/**
 * PDF 조립(병합 등) Web Worker
 * pdf-lib 문서 레벨 연산(load/copyPages/addPage/save)을 메인 스레드 밖에서 수행한다.
 */

importScripts('./libs/pdf-lib.min.js', './libs/fontkit.umd.min.js');

// ── 레이아웃 변환에 쓰이는 순수 계산 헬퍼 (index.html의 동명 함수와 동일) ──
const PT_PER_MM = 72 / 25.4;
const mm2pt = mm => mm * PT_PER_MM;
const PAPER_MM = {
  A0:[841,1189], A1:[594,841], A2:[420,594], A3:[297,420], A4:[210,297], A5:[148,210], A6:[105,148],
  B0:[1030,1456], B1:[728,1030], B2:[515,728], B3:[364,515], B4:[257,364], B5:[182,257], B6:[128,182],
  '8K':[270,390], '16K-1':[194,267], '16K-2':[195,270],
  Letter:[216,279], Legal:[216,356], Tabloid:[279,432],
};
const NUP_GRID = { 1:[1,1], 2:[1,2], 4:[2,2], 6:[2,3], 8:[2,4], 9:[3,3], 16:[4,4] };

function paperSizePt(name, orient, refW, refH) {
  const mm = PAPER_MM[name] || PAPER_MM.A4;
  const w = mm2pt(mm[0]), h = mm2pt(mm[1]);
  let landscape;
  if (orient === 'landscape') landscape = true;
  else if (orient === 'portrait') landscape = false;
  else landscape = (refW != null && refH != null) ? (refW > refH) : false;
  return landscape ? [h, w] : [w, h];
}

function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

function formatPageNumber(style, page, total) {
  switch (style | 0) {
    case 0: return `${page}`;
    case 2: return `- ${page} -`;
    case 3: return `Page ${page}`;
    case 4: return `${page} 페이지`;
    case 1:
    default: return `${page} / ${total}`;
  }
}

function resolveHF(tpl, ctx) {
  // 로마자 페이지(ctx.roman — 목차·지정 앞붙이)는 번호 토큰이 i, ii…로 치환된다.
  // 번호 시작 페이지(hf.start) 이전의 일반 페이지는 ctx.page ≤ 0 — 번호 토큰만 비운다(다른 문구는 유지).
  return (tpl || '')
    .replace(/\{n\}/g, ctx.roman ? ctx.roman : (ctx.page > 0 ? formatPageNumber(ctx.pnumStyle, ctx.page, ctx.total) : ''))
    .replace(/\{page\}/g, ctx.roman ? ctx.roman : (ctx.page > 0 ? ctx.page : ''))
    .replace(/\{total\}/g, ctx.total)
    .replace(/\{date\}/g, ctx.date)
    .replace(/\{filename\}/g, ctx.filename);
}

// 텍스트 → PNG (OffscreenCanvas 사용 — index.html의 textToPngEmbed와 동일 로직, DOM 없이 포팅)
async function textToPngEmbed(outDoc, text, opt, cache) {
  const key = JSON.stringify([text, opt]);
  if (cache && cache.has(key)) return cache.get(key);
  const SS = 3;
  const fpx = opt.size * SS;
  const font = `${opt.bold ? '600 ' : ''}${fpx}px "Malgun Gothic", -apple-system, "맑은 고딕", sans-serif`;
  const meas = new OffscreenCanvas(10, 10).getContext('2d');
  meas.font = font;
  const tw = Math.ceil(meas.measureText(text).width);
  const padX = Math.ceil(fpx * 0.15), lineH = Math.ceil(fpx * 1.32);
  let cw = tw + padX * 2, ch = lineH;
  const ang = ((opt.angle || 0) * Math.PI) / 180;
  let W = cw, H = ch;
  if (ang) {
    W = Math.ceil(Math.abs(cw * Math.cos(ang)) + Math.abs(ch * Math.sin(ang)));
    H = Math.ceil(Math.abs(cw * Math.sin(ang)) + Math.abs(ch * Math.cos(ang)));
  }
  const c = new OffscreenCanvas(W, H);
  const ctx = c.getContext('2d');
  ctx.translate(W / 2, H / 2);
  if (ang) ctx.rotate(ang);
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillStyle = opt.css || '#000';
  ctx.fillText(text, 0, 0);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const png = await outDoc.embedPng(buf);
  const res = { png, w: W / SS, h: H / SS };
  if (cache) cache.set(key, res);
  return res;
}

// srcBytes: 순서·회전·흑백이 이미 반영된 base PDF.
// groups: [{mask, es}] — mask는 base 페이지 순서 기준 boolean[], 그룹끼리 겹치지 않는다
//   (합본 문서에서 챕터별로 다른 es를 쓸 수 있도록 전역 설정 + 챕터별 개별 설정을 그룹으로 분리해 전달).
// fontBytesMap: 머리글/바닥글용 폰트 경로 → 바이트(메인 스레드에서 미리 읽어 전달, 없으면 이미지 폴백).
async function handleLayoutTransform(payload) {
  // adjust: base 페이지 순서 기준 [{rot(도, 반시계+), dx, dy(pt, 원본 크기 기준)} | null]
  //   — 기울기 보정·가운데 정렬의 페이지별 최종 보정값 (메인 스레드에서 측정·계산해 전달)
  // roman: base 페이지 순서 기준 [로마자 문자열 | null] — 목차·지정 페이지의 {n}/{page} 치환용
  // pageOffset/totalPages: 표본 미리보기(문서 일부만 조립)에서 홀짝·번호시작·{total}을 문서 전체
  // 기준(절대 페이지 번호)으로 계산하기 위한 값 — 전체 조립이면 0/미지정.
  const { srcBytes, groups, fontBytesMap, fileName, baseSig, adjust, roman, pageOffset, totalPages } = payload;
  const pageOff = pageOffset | 0;
  // base(순서·회전·흑백)가 그대로면 파싱한 문서를 재사용 — 레이아웃 옵션(규격·N-up·테두리·
  // 머리글바닥글·워터마크)만 바꾸는 실시간 편집에서 매번 전체 PDF를 다시 파싱하지 않는다.
  // 라이브 미리보기는 직렬 실행되고 워커풀이 방금 반납된 워커를 다시 꺼내므로(LIFO) 같은
  // 워커가 연속 처리 → 캐시가 거의 항상 적중. base가 바뀌면 sig가 달라져 새로 파싱한다.
  // (src는 embedPage 대상으로만 읽고 변형하지 않으므로 여러 출력 문서가 공유해도 안전.)
  let src;
  if (baseSig && self.__srcCache && self.__srcCache.sig === baseSig && self.__srcCache.doc) {
    src = self.__srcCache.doc;
  } else {
    src = await PDFLib.PDFDocument.load(srcBytes);
    if (baseSig) self.__srcCache = { sig: baseSig, doc: src };
  }
  const out = await PDFLib.PDFDocument.create();
  const pages = src.getPages();
  const N = pages.length;

  // groupIds[i] = groups 배열의 인덱스, 또는 -1(그대로 복사 = 어떤 그룹에도 속하지 않음)
  const groupIds = new Array(N).fill(-1);
  groups.forEach((g, gi) => { g.mask.forEach((v, i) => { if (v) groupIds[i] = gi; }); });

  const embCache = new Map();
  // Contents가 없거나 깨진(허상 참조) 페이지는 embedPage가 "missing Contents"로 실패 →
  // embedPage와 같은 판정(normalizedEntries)으로 검사·복구 (app-process ensurePageContents와 동일 규약).
  const ensureContents = (pg, force) => {
    try {
      let broken = !!force;
      if (!broken) {
        try { broken = !pg.node.normalizedEntries().Contents; } catch (e) { broken = true; }
      }
      if (broken) {
        try { pg.node.delete(PDFLib.PDFName.of('Contents')); } catch (e) {}
        pg.drawRectangle({ x: 0, y: 0, width: 0.01, height: 0.01, opacity: 0, borderOpacity: 0 });
      }
    } catch (e) {}
  };
  const emb = async i => {
    if (!embCache.has(i)) {
      ensureContents(pages[i]);
      let e2;
      try { e2 = await out.embedPage(pages[i]); }
      catch (err) { ensureContents(pages[i], true); e2 = await out.embedPage(pages[i]); }   // 강제 복구 후 1회 재시도
      embCache.set(i, e2);
    }
    return embCache.get(i);
  };
  const angOf = i => (((pages[i].getRotation().angle || 0) % 360) + 360) % 360;

  function sheetSizeFor(es, refW, refH) {
    if (es.scaling.mode === 'standard') return paperSizePt(es.scaling.paper, es.scaling.orient, refW, refH);
    if (es.scaling.mode === 'percent') {   // 배율: 페이지 크기 자체를 N%로 확대·축소
      const k = Math.max(0.1, Math.min(4, (parseFloat(es.scaling.percent) || 100) / 100));
      return [refW * k, refH * k];
    }
    if (es.scaling.mode === 'custom') {
      let w = mm2pt(es.scaling.customW || 210), h = mm2pt(es.scaling.customH || 297);
      const o = es.scaling.orient;
      if (o === 'landscape' && w < h) { const t = w; w = h; h = t; }
      else if (o === 'portrait' && w > h) { const t = w; w = h; h = t; }
      else if (o === 'auto' && refW != null && (refW > refH) !== (w > h)) { const t = w; w = h; h = t; }
      return [w, h];
    }
    return [refW, refH];
  }

  // adj: {rot, dx, dy} 페이지별 보정(기울기·정렬), exDx/exDy: 제본여백 '밀기' 등 추가 이동(pt).
  // /Rotate N = 뷰어가 '시계방향' N도 회전 표시. embedPage는 /Rotate를 무시하므로 같은
  // 시계방향으로 그려야 한다 — pdf-lib rotate는 반시계(+)라서 90↔270을 바꿔 쓴다.
  // 임의 각도(기울기 보정) 지원을 위해 앵커를 일반식으로 계산한다: drawPage의 rotate는
  // (x,y)를 중심으로 돌므로, 콘텐츠 중심이 rect 중앙(+보정 이동)에 오도록 앵커를 역산.
  function drawFit(outPage, e, ang, rect, adj, exDx, exDy) {
    const ew = e.width, eh = e.height;
    const swap = (ang === 90 || ang === 270);
    const cw = swap ? eh : ew, ch = swap ? ew : eh;
    const scale = Math.min(rect.w / cw, rect.h / ch);
    const baseRot = ang === 90 ? -90 : ang === 180 ? 180 : ang === 270 ? 90 : 0;
    const rot = baseRot + ((adj && adj.rot) || 0);
    // dx/dy는 원본(뷰어 방향) pt 기준 → 배치 배율만큼 함께 축소·확대
    const cx0 = rect.x + rect.w / 2 + ((adj && adj.dx) || 0) * scale + (exDx || 0);
    const cy0 = rect.y + rect.h / 2 + ((adj && adj.dy) || 0) * scale + (exDy || 0);
    const rad = rot * Math.PI / 180;
    const ux = scale * (ew / 2 * Math.cos(rad) - eh / 2 * Math.sin(rad));
    const uy = scale * (ew / 2 * Math.sin(rad) + eh / 2 * Math.cos(rad));
    const o = { x: cx0 - ux, y: cy0 - uy, xScale: scale, yScale: scale };
    if (rot) o.rotate = PDFLib.degrees(rot);
    outPage.drawPage(e, o);
  }

  // 제본여백(축소 방식): 제본쪽 가장자리를 bPt만큼 비운 rect 반환
  function shrinkRectForBind(rect, side, bPt) {
    const r = { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
    if (side === 'left')       { r.x += bPt; r.w = Math.max(10, r.w - bPt); }
    else if (side === 'right') { r.w = Math.max(10, r.w - bPt); }
    else if (side === 'top')   { r.h = Math.max(10, r.h - bPt); }
    else if (side === 'bottom'){ r.y += bPt; r.h = Math.max(10, r.h - bPt); }
    return r;
  }
  // 홀짝 교대(alt): 짝수쪽은 제본이 반대편 — 좌↔우, 상↔하
  function bindSideFor(bind, pageNo) {
    let side = bind.side || 'left';
    if (bind.alt !== false && pageNo % 2 === 0) {
      side = side === 'left' ? 'right' : side === 'right' ? 'left'
           : side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : side;
    }
    return side;
  }

  function drawCropMarks(p, x, y, w, h) {
    const L = mm2pt(4), off = mm2pt(1.5), lw = 0.5, col = PDFLib.rgb(0, 0, 0);
    const line = (x1, y1, x2, y2) => p.drawLine({ start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness:lw, color:col });
    line(x - off - L, y, x - off, y);             line(x, y - off - L, x, y - off);
    line(x + w + off, y, x + w + off + L, y);     line(x + w, y - off - L, x + w, y - off);
    line(x - off - L, y + h, x - off, y + h);     line(x, y + h + off, x, y + h + off + L);
    line(x + w + off, y + h, x + w + off + L, y + h); line(x + w, y + h + off, x + w, y + h + off + L);
  }
  function drawBorder(border, p, x, y, w, h) {
    if (border === 'none') return;
    if (border === 'crop') { drawCropMarks(p, x, y, w, h); return; }
    const lw = border === 'medium' ? 2 : border === 'thin' ? 0.75 : 1;
    const opt = { x, y, width: w, height: h, borderColor: PDFLib.rgb(0, 0, 0), borderWidth: lw };
    if (border === 'dotted') opt.borderDashArray = [lw * 2.5, lw * 2.5];
    p.drawRectangle(opt);
  }

  // 한 그룹(전역 또는 특정 챕터) 내의 in-scope 페이지를 그 그룹의 es로 시트에 방출.
  // flags[]: 출력 페이지가 오버레이 대상인지, flagEs[]: 그 출력 페이지를 만든 es(오버레이에 사용).
  async function flushBucket(es, bucket, flags, flagEs) {
    if (!bucket.length) return;
    const adjOf = idx => (adjust && adjust[idx]) || null;
    const nUp = Math.max(1, es.nUp | 0);
    const [cols, rows] = NUP_GRID[nUp] || [1, 1];
    const m = es.margins;
    const mgOn = !!(m && m.enabled); // 여백 체크박스가 켜졌을 때만 적용
    const mT = mgOn ? mm2pt(m.top) : 0, mB = mgOn ? mm2pt(m.bottom) : 0,
          mL = mgOn ? mm2pt(m.left) : 0, mR = mgOn ? mm2pt(m.right) : 0;
    const fa = angOf(bucket[0]);
    const fsize = pages[bucket[0]].getSize();
    const refW = (fa === 90 || fa === 270) ? fsize.height : fsize.width;
    const refH = (fa === 90 || fa === 270) ? fsize.width  : fsize.height;
    const [sw, sh] = sheetSizeFor(es, refW, refH);

    if (nUp === 1) {
      const marginRect = { x: mL, y: mB, w: Math.max(10, sw - mL - mR), h: Math.max(10, sh - mT - mB) };
      const fullRect   = { x: 0,  y: 0,  w: sw, h: sh };
      const noScale = es.scaling.mode === 'none';
      const bind = (es.bind && es.bind.enabled && (es.bind.size || 0) > 0) ? es.bind : null;
      // ── 빠른 경로: 규격화 없음 + 회전 0 페이지는 원본을 그대로 copyPages 하고 오버레이(머리글/바닥글·워터마크·
      //    테두리)만 얹는다. embedPage(무거운 재-임베드)를 건너뛰어 머리글/바닥글만 켰을 때 대폭 빨라진다.
      //    회전된 페이지는 좌표 정규화가 필요하므로 기존 embedPage 경로 유지.
      //    기울기·정렬 보정(adj)이나 제본여백이 걸린 페이지는 다시 그려야 하므로 빠른 경로 제외.
      const copyIdx = noScale ? bucket.filter(idx => angOf(idx) === 0 && !adjOf(idx) && !bind) : [];
      const copyMap = new Map();
      if (copyIdx.length) {
        const cps = await out.copyPages(src, copyIdx);
        copyIdx.forEach((idx, j) => copyMap.set(idx, cps[j]));
      }
      for (const idx of bucket) {
        let p;
        if (copyMap.has(idx)) {
          p = out.addPage(copyMap.get(idx));
          if (es.border !== 'none') {
            const ps = p.getSize();
            drawBorder(es.border, p, mL, mB, Math.max(10, ps.width - mL - mR), Math.max(10, ps.height - mT - mB));
          }
        } else {
          // 규격화 없음(noScale)이면 시트를 각 페이지의 원본 크기로 — 보정·제본여백 때문에
          // embedPage 경로로 와도 페이지 크기는 원본 그대로 유지한다.
          let psw = sw, psh = sh, mRect = marginRect, fRect = fullRect;
          if (noScale) {
            const a = angOf(idx), sz = pages[idx].getSize();
            psw = (a === 90 || a === 270) ? sz.height : sz.width;
            psh = (a === 90 || a === 270) ? sz.width  : sz.height;
            fRect = { x: 0, y: 0, w: psw, h: psh };
            mRect = { x: mL, y: mB, w: Math.max(10, psw - mL - mR), h: Math.max(10, psh - mT - mB) };
          }
          p = out.addPage([psw, psh]);
          let contentRect = noScale ? fRect : (es.scaling.fitMargins ? mRect : fRect);
          let exDx = 0, exDy = 0;
          if (bind) {
            const bPt = mm2pt(bind.size || 0);
            const side = bindSideFor(bind, flags.length + 1 + pageOff); // 절대 페이지 번호 기준 홀짝 (표본 창 보정)
            if (bind.method === 'shift') {
              // 밀기: 크기 유지, 제본 반대쪽으로 이동 (반대쪽 가장자리는 잘릴 수 있음)
              if (side === 'left') exDx = bPt; else if (side === 'right') exDx = -bPt;
              else if (side === 'top') exDy = -bPt; else exDy = bPt;
            } else {
              contentRect = shrinkRectForBind(contentRect, side, bPt);
            }
          }
          drawFit(p, await emb(idx), angOf(idx), contentRect, adjOf(idx), exDx, exDy);
          if (es.border !== 'none') drawBorder(es.border, p, mRect.x, mRect.y, mRect.w, mRect.h);
        }
        flags.push(true); flagEs.push(es);
      }
      return;
    }

    const gut = mm2pt(es.gutter || 0);
    const innerW = Math.max(10, sw - mL - mR), innerH = Math.max(10, sh - mT - mB);
    const cellW = Math.max(5, (innerW - gut * (cols - 1)) / cols);
    const cellH = Math.max(5, (innerH - gut * (rows - 1)) / rows);
    for (let g = 0; g < bucket.length; g += nUp) {
      const p = out.addPage([sw, sh]);
      for (let k = 0; k < nUp; k++) {
        const idx = bucket[g + k];
        if (idx == null) break;
        const col = k % cols, row = (k / cols) | 0;
        const rect = {
          x: mL + col * (cellW + gut),
          y: mB + innerH - (row + 1) * cellH - row * gut,
          w: cellW, h: cellH,
        };
        drawFit(p, await emb(idx), angOf(idx), rect, adjOf(idx));
        if (es.border !== 'none') drawBorder(es.border, p, rect.x, rect.y, rect.w, rect.h);
      }
      flags.push(true); flagEs.push(es);
    }
  }

  const outScope = [];
  for (let i = 0; i < N; i++) if (groupIds[i] === -1) outScope.push(i);
  const copied = new Map();
  if (outScope.length) {
    const cps = await out.copyPages(src, outScope);
    outScope.forEach((idx, j) => copied.set(idx, cps[j]));
  }

  const flags = [];   // 출력 페이지가 in-scope(오버레이 대상)인지
  const flagEs = [];  // 그 출력 페이지를 만든 그룹의 es (오버레이용, pass-through면 null)
  let bucket = [];
  let bucketGid = -1;
  for (let i = 0; i < N; i++) {
    const gid = groupIds[i];
    if (gid !== -1 && gid === bucketGid) {
      bucket.push(i);
    } else {
      if (bucket.length) await flushBucket(groups[bucketGid].es, bucket, flags, flagEs);
      bucket = [];
      if (gid === -1) { out.addPage(copied.get(i)); flags.push(false); flagEs.push(null); }
      else bucket.push(i);
      bucketGid = gid;
    }
    self.postMessage({ id: self.__currentId, progress: (i + 1) / N * 0.6 });
  }
  if (bucket.length) await flushBucket(groups[bucketGid].es, bucket, flags, flagEs);

  // ── 오버레이 패스: 그룹(챕터)별 머리글/바닥글 + 워터마크 (in-scope 출력 페이지에만) ──
  const outPages = out.getPages();
  const total = outPages.length;
  const cache = new Map();
  const td = new Date();
  const dateStr = td.getFullYear() + '-' + String(td.getMonth() + 1).padStart(2, '0') + '-' + String(td.getDate()).padStart(2, '0');
  const fname = fileName || '';
  const fontCache = new Map(); // 폰트 경로 → PDFFont (그룹 간 동일 폰트는 1회만 임베드)
  let fontkitRegistered = false;
  async function embedHfFont(fontSel) {
    if (fontCache.has(fontSel)) return fontCache.get(fontSel);
    const bytes = fontBytesMap && fontBytesMap[fontSel];
    let font = null;
    if (bytes) {
      try {
        if (!fontkitRegistered) { out.registerFontkit(self.fontkit); fontkitRegistered = true; }
        font = await out.embedFont(bytes, { subset: true });
      } catch (e) { font = null; }
    }
    fontCache.set(fontSel, font);
    return font;
  }
  // ASCII(숫자·영문·기호)만 있는 텍스트는 13MB 시스템 폰트를 파싱·서브셋할 필요 없이 내장 표준폰트(Helvetica)로
  // 즉시 그린다 — 페이지번호 '1 / 10', 날짜, 영문 파일명 등 대부분의 머리글/바닥글이 여기 해당한다.
  let stdFont = null;
  const isAsciiText = s => /^[\x20-\x7E]*$/.test(s);
  async function getStdFont() {
    if (!stdFont) stdFont = await out.embedFont(PDFLib.StandardFonts.Helvetica);
    return stdFont;
  }
  for (let i = 0; i < total; i++) {
    const es = flagEs[i];
    if (!es) { self.postMessage({ id: self.__currentId, progress: 0.6 + (i + 1) / total * 0.4 }); continue; }
    const hf = es.hf, wm = es.wm;
    const someHf = a => a.some(s => s && s.trim());
    const hfOn = hf && hf.enabled && (
      someHf([hf.hL, hf.hC, hf.hR, hf.fL, hf.fC, hf.fR])
      || someHf([hf.oHL, hf.oHC, hf.oHR, hf.oFL, hf.oFC, hf.oFR])
      || someHf([hf.eHL, hf.eHC, hf.eHR, hf.eFL, hf.eFC, hf.eFR]));
    const wmOn = wm && wm.enabled && wm.text.trim();
    if (!hfOn && !wmOn) { self.postMessage({ id: self.__currentId, progress: 0.6 + (i + 1) / total * 0.4 }); continue; }
    const p = outPages[i];
    const ps = p.getSize(), pw = ps.width, ph = ps.height;
    if (wmOn) {
      const im = await textToPngEmbed(out, wm.text, { size: wm.size, css: wm.color, angle: wm.angle, bold: true }, cache);
      const op = Math.max(0.02, Math.min(1, (wm.opacity || 30) / 100));
      if (wm.mode === 'tile') {
        const stepX = Math.max(20, im.w * 1.5), stepY = Math.max(20, im.h * 2.0);
        for (let yy = -im.h; yy < ph + im.h; yy += stepY)
          for (let xx = -im.w; xx < pw + im.w; xx += stepX)
            p.drawImage(im.png, { x: xx, y: yy, width: im.w, height: im.h, opacity: op });
      } else {
        p.drawImage(im.png, { x: (pw - im.w) / 2, y: (ph - im.h) / 2, width: im.w, height: im.h, opacity: op });
      }
    }
    if (hfOn) {
      // 절대 페이지 번호(문서 전체 기준) — 표본 미리보기(pageOffset>0)에서도 홀짝·번호시작이
      // 최종 생성물과 동일하게 계산된다. (이전엔 창 내 상대 번호라 미리보기에서 홀짝이 뒤집히거나
      // 번호가 사라져 "짝수쪽만 생성된다"로 보였음)
      const absPage = i + 1 + pageOff;
      const even = absPage % 2 === 0;
      // 홀·짝 전용 칸(o*/e*)에 값이 하나라도 있으면 그쪽 페이지는 전용 칸으로 인쇄, 비어 있으면
      // 공통 칸으로 폴백 — 전용 칸만 채워도 반대쪽 페이지가 비어버리지 않는다.
      // 폴백된 짝수 페이지에는 홀짝 좌우 교대(alt)가 적용된다(책 바깥쪽 번호).
      const oddSet  = { hL: hf.oHL, hC: hf.oHC, hR: hf.oHR, fL: hf.oFL, fC: hf.oFC, fR: hf.oFR };
      const evenSet = { hL: hf.eHL, hC: hf.eHC, hR: hf.eHR, fL: hf.eFL, fC: hf.eFC, fR: hf.eFR };
      let hfEff = hf;
      if (!even && someHf(Object.values(oddSet)))      hfEff = Object.assign({}, hf, oddSet);
      else if (even && someHf(Object.values(evenSet))) hfEff = Object.assign({}, hf, evenSet);
      else if (even && hf.alt) hfEff = Object.assign({}, hf, { hL: hf.hR, hR: hf.hL, fL: hf.fR, fR: hf.fL });
      // 번호 시작 페이지(start): 그 출력 페이지가 {n}=1 — 표지·목차를 번호에서 빼는 용도.
      // 시작 전 페이지는 page ≤ 0 → resolveHF가 번호 토큰을 비워 번호 없이 인쇄된다.
      const hfStart = Math.max(1, (hf.start | 0) || 1);
      // 로마자 배열은 base 페이지 순서 기준 — 출력 페이지와 1:1일 때만 사용(N-up 등으로 수가 다르면 무시)
      const rn = (roman && roman.length === total) ? roman[i] : null;
      const totalAll = totalPages || total;
      const ctx = { page: absPage - (hfStart - 1), total: Math.max(1, totalAll - (hfStart - 1)), roman: rn, date: dateStr, filename: fname, pnumStyle: hf.pnumStyle || 0 };
      const mgOn = !!(es.margins && es.margins.enabled);
      const mL = mgOn ? mm2pt(es.margins.left) : 0, mR = mgOn ? mm2pt(es.margins.right) : 0;
      const segs = [
        ['hL', mL,      'left',   true],  ['hC', pw / 2,  'center', true],  ['hR', pw - mR, 'right', true],
        ['fL', mL,      'left',   false], ['fC', pw / 2,  'center', false], ['fR', pw - mR, 'right', false],
      ];
      const mHF = mm2pt(hf.margin || 0);
      // 위치 미세조절 (mm): +X=오른쪽, +Y=아래 — 머리글·바닥글 여섯 칸 전체에 적용
      const offX = mm2pt(parseFloat(hf.offX) || 0), offY = mm2pt(parseFloat(hf.offY) || 0);
      for (const [key, ax, align, isHeader] of segs) {
        const txt = resolveHF(hfEff[key], ctx);
        if (!txt || !txt.trim()) continue;
        // ASCII면 내장 표준폰트(임베드 불필요), 한글 등 포함 시에만 시스템 폰트 서브셋 임베드
        const font = isAsciiText(txt) ? await getStdFont() : await embedHfFont(hf.font);
        if (font) {
          const w = font.widthOfTextAtSize(txt, hf.size);
          const x = (align === 'left' ? ax : align === 'center' ? (ax - w / 2) : (ax - w)) + offX;
          const y = (isHeader ? (ph - mHF - hf.size) : mHF) - offY;
          p.drawText(txt, { x, y, size: hf.size, font, color: hexToRgb(hf.color) });
        } else {
          const im = await textToPngEmbed(out, txt, { size: hf.size, css: hf.color, angle: 0 }, cache);
          const x = (align === 'left' ? ax : align === 'center' ? (ax - im.w / 2) : (ax - im.w)) + offX;
          const y = (isHeader ? (ph - mHF - im.h) : mHF) - offY;
          p.drawImage(im.png, { x, y, width: im.w, height: im.h });
        }
      }
    }
    self.postMessage({ id: self.__currentId, progress: 0.6 + (i + 1) / total * 0.4 });
  }

  return out.save({ useObjectStreams: false });
}

async function handleMerge(payload) {
  const { buffers } = payload;
  const mergedDoc = await PDFLib.PDFDocument.create();
  const counts = [];
  const total = buffers.length;
  for (let i = 0; i < total; i++) {
    const src = await PDFLib.PDFDocument.load(buffers[i]);
    const indices = src.getPageIndices();
    const copied = await mergedDoc.copyPages(src, indices);
    copied.forEach(p => mergedDoc.addPage(p));
    counts.push(indices.length);
    self.postMessage({ id: self.__currentId, progress: (i + 1) / total });
  }
  const bytes = await mergedDoc.save();
  return { bytes, counts };
}

self.onmessage = async function (e) {
  const { id, type, payload } = e.data;
  self.__currentId = id;
  try {
    if (type === 'merge') {
      const { bytes, counts } = await handleMerge(payload);
      self.postMessage({ id, result: { bytes, counts } }, [bytes.buffer]);
    } else if (type === 'layout-transform') {
      const bytes = await handleLayoutTransform(payload);
      self.postMessage({ id, result: bytes }, [bytes.buffer]);
    } else {
      throw new Error('알 수 없는 작업 타입: ' + type);
    }
  } catch (err) {
    self.postMessage({ id, error: err && err.message ? err.message : String(err) });
  }
};
