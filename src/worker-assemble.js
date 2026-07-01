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
  return (tpl || '')
    .replace(/\{n\}/g, formatPageNumber(ctx.pnumStyle, ctx.page, ctx.total))
    .replace(/\{page\}/g, ctx.page)
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

// srcBytes: 순서·회전·흑백이 이미 반영된 base PDF. scopeMask: base 페이지 순서 기준.
// fontBytes: 머리글/바닥글용 폰트 바이트(메인 스레드에서 미리 읽어 전달, 없으면 이미지 폴백).
async function handleLayoutTransform(payload) {
  const { srcBytes, es, scopeMask, fontBytes, fileName } = payload;
  const src = await PDFLib.PDFDocument.load(srcBytes);
  const out = await PDFLib.PDFDocument.create();
  const pages = src.getPages();
  const N = pages.length;
  const mask = (scopeMask && scopeMask.length === N) ? scopeMask : pages.map(() => true);
  const nUp  = Math.max(1, es.nUp | 0);
  const [cols, rows] = NUP_GRID[nUp] || [1, 1];
  const m = es.margins;
  const mT = mm2pt(m.top), mB = mm2pt(m.bottom), mL = mm2pt(m.left), mR = mm2pt(m.right);

  const embCache = new Map();
  const emb = async i => { if (!embCache.has(i)) embCache.set(i, await out.embedPage(pages[i])); return embCache.get(i); };
  const angOf = i => (((pages[i].getRotation().angle || 0) % 360) + 360) % 360;

  function sheetSizeFor(refW, refH) {
    if (es.scaling.mode === 'standard') return paperSizePt(es.scaling.paper, es.scaling.orient, refW, refH);
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

  function drawFit(outPage, e, ang, rect) {
    const ew = e.width, eh = e.height;
    const swap = (ang === 90 || ang === 270);
    const cw = swap ? eh : ew, ch = swap ? ew : eh;
    const scale = Math.min(rect.w / cw, rect.h / ch);
    const dw = cw * scale, dh = ch * scale;
    const cx = rect.x + (rect.w - dw) / 2, cy = rect.y + (rect.h - dh) / 2;
    const o = { xScale: scale, yScale: scale };
    if (ang === 0)        { o.x = cx;      o.y = cy; }
    else if (ang === 90)  { o.x = cx + dw; o.y = cy;      o.rotate = PDFLib.degrees(90); }
    else if (ang === 180) { o.x = cx + dw; o.y = cy + dh; o.rotate = PDFLib.degrees(180); }
    else                  { o.x = cx;      o.y = cy + dh; o.rotate = PDFLib.degrees(270); }
    outPage.drawPage(e, o);
  }

  function drawCropMarks(p, x, y, w, h) {
    const L = mm2pt(4), off = mm2pt(1.5), lw = 0.5, col = PDFLib.rgb(0, 0, 0);
    const line = (x1, y1, x2, y2) => p.drawLine({ start:{x:x1,y:y1}, end:{x:x2,y:y2}, thickness:lw, color:col });
    line(x - off - L, y, x - off, y);             line(x, y - off - L, x, y - off);
    line(x + w + off, y, x + w + off + L, y);     line(x + w, y - off - L, x + w, y - off);
    line(x - off - L, y + h, x - off, y + h);     line(x, y + h + off, x, y + h + off + L);
    line(x + w + off, y + h, x + w + off + L, y + h); line(x + w, y + h + off, x + w, y + h + off + L);
  }
  function drawBorder(p, x, y, w, h) {
    const b = es.border;
    if (b === 'none') return;
    if (b === 'crop') { drawCropMarks(p, x, y, w, h); return; }
    const lw = b === 'medium' ? 2 : b === 'thin' ? 0.75 : 1;
    const opt = { x, y, width: w, height: h, borderColor: PDFLib.rgb(0, 0, 0), borderWidth: lw };
    if (b === 'dotted') opt.borderDashArray = [lw * 2.5, lw * 2.5];
    p.drawRectangle(opt);
  }

  // in-scope 페이지를 시트로 방출. flags[]: 출력 페이지가 in-scope(오버레이 대상)인지
  async function flushBucket(bucket, flags) {
    if (!bucket.length) return;
    const fa = angOf(bucket[0]);
    const fsize = pages[bucket[0]].getSize();
    const refW = (fa === 90 || fa === 270) ? fsize.height : fsize.width;
    const refH = (fa === 90 || fa === 270) ? fsize.width  : fsize.height;
    const [sw, sh] = sheetSizeFor(refW, refH);

    if (nUp === 1) {
      const marginRect = { x: mL, y: mB, w: Math.max(10, sw - mL - mR), h: Math.max(10, sh - mT - mB) };
      const fullRect   = { x: 0,  y: 0,  w: sw, h: sh };
      for (const idx of bucket) {
        const p = out.addPage([sw, sh]);
        const contentRect = (es.scaling.mode === 'none')
          ? fullRect
          : (es.scaling.fitMargins ? marginRect : fullRect);
        drawFit(p, await emb(idx), angOf(idx), contentRect);
        if (es.border !== 'none') drawBorder(p, marginRect.x, marginRect.y, marginRect.w, marginRect.h);
        flags.push(true);
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
        drawFit(p, await emb(idx), angOf(idx), rect);
        if (es.border !== 'none') drawBorder(p, rect.x, rect.y, rect.w, rect.h);
      }
      flags.push(true);
    }
  }

  const outScope = [];
  for (let i = 0; i < N; i++) if (!mask[i]) outScope.push(i);
  const copied = new Map();
  if (outScope.length) {
    const cps = await out.copyPages(src, outScope);
    outScope.forEach((idx, j) => copied.set(idx, cps[j]));
  }

  const flags = [];
  let bucket = [];
  for (let i = 0; i < N; i++) {
    if (mask[i]) bucket.push(i);
    else { await flushBucket(bucket, flags); bucket = []; out.addPage(copied.get(i)); flags.push(false); }
    self.postMessage({ id: self.__currentId, progress: (i + 1) / N * 0.6 });
  }
  await flushBucket(bucket, flags);

  // ── 오버레이 패스: 머리글/바닥글 + 워터마크 (in-scope 출력 페이지에만) ──
  const hf = es.hf, wm = es.wm;
  const hfOn = hf && hf.enabled && [hf.hL, hf.hC, hf.hR, hf.fL, hf.fC, hf.fR].some(s => s && s.trim());
  const wmOn = wm && wm.enabled && wm.text.trim();
  if (hfOn || wmOn) {
    const outPages = out.getPages();
    const total = outPages.length;
    const cache = new Map();
    const td = new Date();
    const dateStr = td.getFullYear() + '-' + String(td.getMonth() + 1).padStart(2, '0') + '-' + String(td.getDate()).padStart(2, '0');
    const fname = fileName || '';
    let hfFont = null;
    if (hfOn && fontBytes) {
      try {
        out.registerFontkit(self.fontkit);
        hfFont = await out.embedFont(fontBytes, { subset: true });
      } catch (e) { hfFont = null; }
    }
    const hfColorRgb = hfOn ? hexToRgb(hf.color) : null;
    for (let i = 0; i < total; i++) {
      if (!flags[i]) continue;
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
        const ctx = { page: i + 1, total, date: dateStr, filename: fname, pnumStyle: hf.pnumStyle || 0 };
        const segs = [
          ['hL', mL,      'left',   true],  ['hC', pw / 2,  'center', true],  ['hR', pw - mR, 'right', true],
          ['fL', mL,      'left',   false], ['fC', pw / 2,  'center', false], ['fR', pw - mR, 'right', false],
        ];
        const mHF = mm2pt(hf.margin || 0);
        for (const [key, ax, align, isHeader] of segs) {
          const txt = resolveHF(hf[key], ctx);
          if (!txt || !txt.trim()) continue;
          if (hfFont) {
            const w = hfFont.widthOfTextAtSize(txt, hf.size);
            const x = align === 'left' ? ax : align === 'center' ? (ax - w / 2) : (ax - w);
            const y = isHeader ? (ph - mHF - hf.size) : mHF;
            p.drawText(txt, { x, y, size: hf.size, font: hfFont, color: hfColorRgb });
          } else {
            const im = await textToPngEmbed(out, txt, { size: hf.size, css: hf.color, angle: 0 }, cache);
            const x = align === 'left' ? ax : align === 'center' ? (ax - im.w / 2) : (ax - im.w);
            const y = isHeader ? (ph - mHF - im.h) : mHF;
            p.drawImage(im.png, { x, y, width: im.w, height: im.h });
          }
        }
      }
      self.postMessage({ id: self.__currentId, progress: 0.6 + (i + 1) / total * 0.4 });
    }
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
