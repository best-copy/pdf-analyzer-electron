// ════════════════════════════════════════════════════════════════════════
// 🖼 이미지 업스케일 · ✒ 벡터화 (2026-10-29)
//   이미지 파일을 AI로 키우거나(Real-ESRGAN ncnn Vulkan — main 'upscale:run', GPU) 윤곽을 따서 벡터로
//   (worker-trace.js · imagetracer) 바꾼 뒤, 앱에서 바로 열거나(인쇄 크기 그대로의 1쪽 PDF) 파일로 저장한다.
//   계산(배율·윤곽 → PDF/SVG)은 libs/img-enhance.js(순수 — img-enhance.test.js).
//   app-ui.js 뒤에 읽는다(최상위 즉시 실행문 없음 — 모두 버튼·이벤트에서 부른다).
//   ⚠ 흑백 이미지는 결과도 DeviceGray로(1성분 JPEG·회색 경로) — RGB 회색은 프린터가 컬러로 셀 수 있다(함정 15).
// ════════════════════════════════════════════════════════════════════════
const IE_MODELS = [
  { v: 'realesrgan-x4plus', label: '사진', title: '사진·스캔한 컬러 사진 — 질감을 살리며 선명하게' },
  { v: 'realesrgan-x4plus-anime', label: '일러스트·로고·글자', title: '선이 또렷한 그림 — 경계를 깨끗하게 (사진에 쓰면 그림처럼 뭉개질 수 있어요)' },
  { v: 'realesr-animevideov3', label: '일러스트 (빠르게)', title: '일러스트용 가벼운 모델 — 큰 그림을 빨리' },
];
const IE_SIZES = [
  { v: 'dpi', label: '인쇄 크기에서 300dpi', title: '아래 인쇄 폭에서 300dpi가 되도록 (최대 4배) — 이미 300dpi 이상이면 키우지 않습니다' },
  { v: '2', label: '2배' }, { v: '3', label: '3배' }, { v: '4', label: '4배' },
];
const IE_COLORS = [
  { v: 0, label: '자동', title: '그림에 실제로 쓰인 색 수를 찾아 그대로 (권장)' },
  { v: 2, label: '흑백 2색', title: '검정·흰색 두 가지 — 도장·서명·흑백 로고 (가장 깔끔)' },
  { v: 4, label: '4색' }, { v: 8, label: '8색' }, { v: 16, label: '16색' }, { v: 32, label: '32색', title: '색이 많은 일러스트 — 모양이 많아져 파일이 커집니다' },
];
const IE_SMOOTH = [{ v: 0.5, label: '정밀' }, { v: 1, label: '보통' }, { v: 2, label: '매끄럽게' }, { v: 4, label: '아주 매끄럽게' }];
const IE_SPECK = [{ v: 0, label: '그대로' }, { v: 8, label: '작은 잡티' }, { v: 32, label: '보통' }, { v: 96, label: '큰 잡티까지' }];
const IE_PT_PER_MM = 72 / 25.4;
let _ieState = null;   // 열린 창 상태(한 번에 하나)

function ieStem(name) { return String(name || 'image').replace(/\.[^.\\/]+$/, ''); }
function ieDirOf(p) { const s = String(p || ''); const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')); return i > 0 ? s.slice(0, i) : ''; }
function ieLs(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
function ieLsSet(k, v) { try { localStorage.setItem(k, String(v)); } catch (e) {} }
function ieCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
function ieBlob(c, type, q) { return new Promise((ok, bad) => c.toBlob(b => b ? ok(b) : bad(new Error('그림 굽기 실패 — 그림이 너무 큽니다')), type, q)); }
const ieFmtN = n => Number(n).toLocaleString('ko-KR');

// 그림을 w×h로(부드럽게) — 크게 줄일 때는 반씩 여러 번(한 번에 줄이면 계단이 생긴다)
function ieResize(src, w, h) {
  let cur = src, cw = src.width, ch = src.height, tmp = null;
  while (cw / 2 > w && ch / 2 > h) {
    const nw = Math.max(w, Math.round(cw / 2)), nh = Math.max(h, Math.round(ch / 2));
    const c = ieCanvas(nw, nh), x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, nw, nh);
    if (tmp) tmp.width = tmp.height = 0;
    tmp = c; cur = c; cw = nw; ch = nh;
  }
  const c = ieCanvas(w, h), x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(cur, 0, 0, w, h);
  if (tmp) tmp.width = tmp.height = 0;
  return c;
}
function iePixels(src, w, h) {
  const c = ieCanvas(w || src.width, h || src.height), x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height);
  c.width = c.height = 0;
  return d;
}

// ── 파일 해상도 기록(JFIF·pHYs) — 다른 프로그램에서도 같은 인쇄 크기로 열리게 ──
function ieJpegSetDpi(u8, dpi) {
  if (u8[2] === 0xFF && u8[3] === 0xE0 && u8[6] === 0x4A && u8[7] === 0x46 && u8[8] === 0x49 && u8[9] === 0x46) {
    const d = Math.max(1, Math.min(65535, Math.round(dpi)));
    u8[13] = 1; u8[14] = d >> 8; u8[15] = d & 255; u8[16] = d >> 8; u8[17] = d & 255;
  }
  return u8;
}
let _ieCrc = null;
function ieCrc32(u8, s, e) {
  if (!_ieCrc) { _ieCrc = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; _ieCrc[n] = c >>> 0; } }
  let c = 0xFFFFFFFF; for (let i = s; i < e; i++) c = _ieCrc[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function iePngSetDpi(u8, dpi) {
  if (!(u8[0] === 0x89 && u8[1] === 0x50)) return u8;
  const ppm = Math.round(dpi / 0.0254);
  const ch = new Uint8Array(21), dv = new DataView(ch.buffer);
  dv.setUint32(0, 9); ch.set([0x70, 0x48, 0x59, 0x73], 4); dv.setUint32(8, ppm); dv.setUint32(12, ppm); ch[16] = 1;
  dv.setUint32(17, ieCrc32(ch, 4, 17));
  // IHDR(8 + 25) 뒤에 넣는다 — 이미 pHYs가 있으면 그대로 둔다
  for (let p = 8; p + 8 < u8.length;) {
    const len = (u8[p] << 24 | u8[p + 1] << 16 | u8[p + 2] << 8 | u8[p + 3]) >>> 0;
    const t = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
    if (t === 'pHYs') return u8;
    if (t === 'IDAT') break;
    p += 12 + len;
  }
  const out = new Uint8Array(u8.length + 21);
  out.set(u8.subarray(0, 33), 0); out.set(ch, 33); out.set(u8.subarray(33), 54);
  return out;
}

// ── 이미지 읽기 ──
async function ieLoadItem(it) {
  const u8 = new Uint8Array(window.electronAPI.readFile(it.path));
  const isPng = u8[0] === 0x89 && u8[1] === 0x50, isJpg = u8[0] === 0xFF && u8[1] === 0xD8;
  const dpi = isPng ? pngDpi(u8) : isJpg ? jpegDpi(u8) : null;
  const blob = new Blob([u8]);
  let bmp;
  try { bmp = await createImageBitmap(blob); }
  catch (e) { throw new Error(`'${it.name}' 이미지를 읽을 수 없습니다 — 지원하지 않는 형식이거나 손상된 파일입니다.`); }
  const w = bmp.width, h = bmp.height;
  const fb = Math.max(w, h) >= 1000 ? 300 : 96;   // imageToPdfBytes와 같은 기본값(기록이 없을 때)
  const dx = dpi && dpi.x > 1 ? dpi.x : fb;
  const k = Math.min(1, 800 / Math.max(w, h));
  const sm = iePixels(bmp, Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)));
  let alpha = false; for (let i = 3; i < sm.data.length; i += 4) if (sm.data[i] < 250) { alpha = true; break; }
  return {
    it, name: it.name, path: it.path, dir: ieDirOf(it.path), bmp, w, h, dpiKnown: !!(dpi && dpi.x > 1),
    url: URL.createObjectURL(blob), wMm: w * 25.4 / dx,
    gray: ImgEnhance.isNeutralRgba(sm.data, 6), alpha, up: null, vec: null, err: null,
  };
}
function ieFreeItem(S) {
  try { URL.revokeObjectURL(S.url); } catch (e) {}
  try { S.bmp && S.bmp.close && S.bmp.close(); } catch (e) {}
  try { S.bmpA && S.bmpA.close && S.bmpA.close(); } catch (e) {}
  ieFreeUp(S.up); S.up = null; ieFreeVec(S.vec); S.vec = null;
}
function ieFreeUp(r) { if (!r) return; try { URL.revokeObjectURL(r.url); } catch (e) {} try { r.bmp && r.bmp.close && r.bmp.close(); } catch (e) {} }
function ieFreeVec(r) { if (!r) return; try { URL.revokeObjectURL(r.url); } catch (e) {} }

// ── 🔍 업스케일 ── o: { model, size('dpi'|'2'|'3'|'4'), wMm } → 결과 { bmp, bytes(PNG), url, w, h, method:'ai'|'interp'|'none', gpu, ms, plan }
async function ieUpscale(S, o, onProg) {
  const plan = ImgEnhance.upscalePlan(S.w, S.h, { mode: o.size === 'dpi' ? 'dpi' : +o.size, printWmm: o.wMm, targetDpi: 300 });
  const api = window.electronAPI, t0 = Date.now();
  if (plan.run === 1) return { none: true, plan };
  let inPath = null, outPath = null, off = null, aiBmp = null, method = 'ai', gpu = '', note = '';
  try {
    // ⚠ realesrgan-x4plus·x4plus-anime은 4배 전용 — '-s 2'로 돌리면 결과가 조각조각 뒤섞인다(실측). 항상 4배로 돌려 목표로 줄인다.
    //   4배 결과가 너무 크면(긴 변 16000px·2억 화소 넘음 — 캔버스 한계) 입력을 미리 줄인다.
    const native = /^realesrgan-x4plus/.test(o.model) ? 4 : plan.run;
    const kIn = Math.min(1, 16000 / (Math.max(S.w, S.h) * native), Math.sqrt(200e6 / (S.w * S.h * native * native)));
    const inW = Math.max(1, Math.round(S.w * kIn)), inH = Math.max(1, Math.round(S.h * kIn));
    // 엔진 입력: 원본을 PNG로(그림 형식·CMYK JPEG·방향 기록을 브라우저가 풀어 준 그대로)
    const c0 = kIn < 1 ? ieResize(S.bmp, inW, inH) : ieCanvas(S.w, S.h);
    if (kIn >= 1) c0.getContext('2d').drawImage(S.bmp, 0, 0);
    const png0 = new Uint8Array(await (await ieBlob(c0, 'image/png')).arrayBuffer()); c0.width = c0.height = 0;
    inPath = api.writeTempFile(png0, 'png'); outPath = api.tempPath('png');
    if (api.onUpscaleProgress) off = api.onUpscaleProgress(p => { if (onProg) onProg(Math.max(0, Math.min(1, p / 100))); });
    const r = api.upscaleRun ? await api.upscaleRun({ inPath, outPath, model: o.model, scale: native }) : { ok: false, missing: true };
    if (r.canceled) return { canceled: true };
    if (r.ok) { aiBmp = await createImageBitmap(new Blob([api.readFile(outPath)], { type: 'image/png' })); gpu = r.gpu || ''; }
    else if (r.noGpu || r.missing) { method = 'interp'; note = r.missing ? 'AI 엔진이 없어' : '이 PC에서 GPU(Vulkan)를 쓸 수 없어'; }
    else throw new Error('AI 업스케일 실패 — ' + (r.error || '알 수 없는 오류'));
  } finally {
    if (off) off();
    try { if (inPath) api.removeTempFile(inPath); } catch (e) {}
    try { if (outPath) api.removeTempFile(outPath); } catch (e) {}
  }
  // AI는 2·3·4배 — 목표가 그 사이면 맞춰 줄인다. 일반 보간은 원본에서 바로.
  const src = aiBmp || S.bmp;
  let bmp = aiBmp, blob;
  if (src.width !== plan.outW || src.height !== plan.outH) {
    const c = ieResize(src, plan.outW, plan.outH);
    blob = await ieBlob(c, 'image/png'); c.width = c.height = 0;
    if (aiBmp) aiBmp.close();
    bmp = await createImageBitmap(blob);
  } else {
    const c = ieCanvas(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0);
    blob = await ieBlob(c, 'image/png'); c.width = c.height = 0;
  }
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bmp, bytes, url: URL.createObjectURL(blob), w: bmp.width, h: bmp.height, method, note, gpu, ms: Date.now() - t0, plan, model: o.model, size: o.size };
}

// ── 🔤 글자 또렷하게(쪽 업스케일 뒤) — 바탕(종이 색·질감)은 그대로 두고 글자만 (사용자 결정 2026-10-30)
//    ① 진하게: 바탕 밝기(밝기 중앙값)보다 충분히 어두운 곳(T 아래)만 검정 쪽으로 펴고, T 위(바탕)는 손대지 않는다(T에서 이어짐)
//    ② 선명하게: 3×3 평균과의 차이를 0.8배 더함(언샤프) — 글자 둘레(그 점이나 평균이 T 아래)에만. 바탕 잡티는 키우지 않는다.
//    사진 위주 쪽(밝기 중앙값 < 150)은 ⓪①을 건너뛰고 ②만.
async function ieTextBoost(r, orig) {
  const w = r.w, h = r.h, c = ieCanvas(w, h), x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(r.bmp, 0, 0);
  const id = x.getImageData(0, 0, w, h), d = id.data;
  const hist = new Uint32Array(256); let cnt = 0;
  for (let i = 0; i < d.length; i += 16) { hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; cnt++; }
  const pct = q => { let a = 0; for (let v = 0; v < 256; v++) { a += hist[v]; if (a >= cnt * q) return v; } return 255; };
  // ⓪ 바탕 되돌리기 — AI(특히 일러스트 모델)는 누런·회색 종이를 하얗게 만든다(실측 245 → 254). 원본 쪽 그림의 밝기 분포에
  //    맞춰(분위수 맞춤) 바탕 쪽 밝기만 원래대로 — 글자 쪽(어두운 쪽)은 AI 결과 그대로 두고 경계 20단계는 섞는다.
  if (orig) {
    const oc = ieCanvas(Math.min(orig.width, 1200), Math.max(1, Math.round(orig.height * Math.min(1, 1200 / orig.width))));
    const ox = oc.getContext('2d', { willReadFrequently: true }); ox.drawImage(orig, 0, 0, oc.width, oc.height);
    const od = ox.getImageData(0, 0, oc.width, oc.height).data; oc.width = oc.height = 0;
    const oh = new Uint32Array(256); let on = 0;
    for (let i = 0; i < od.length; i += 4) { oh[(od[i] * 77 + od[i + 1] * 150 + od[i + 2] * 29) >> 8]++; on++; }
    const rc = new Float64Array(256), occ = new Float64Array(256);
    let a = 0; for (let v = 0; v < 256; v++) { a += hist[v]; rc[v] = a / cnt; }
    a = 0; for (let v = 0; v < 256; v++) { a += oh[v]; occ[v] = a / on; }
    const rMed = pct(0.5);
    if (rMed >= 150) {
      const T0 = rMed - 45, match = new Uint8ClampedArray(256);
      for (let v = 0; v < 256; v++) {
        let u = 0; while (u < 255 && occ[u] < rc[v]) u++;
        const t = v >= T0 ? 1 : v <= T0 - 20 ? 0 : (v - (T0 - 20)) / 20;
        match[v] = v + (u - v) * t;
      }
      for (let i = 0; i < d.length; i += 4) { d[i] = match[d[i]]; d[i + 1] = match[d[i + 1]]; d[i + 2] = match[d[i + 2]]; }
      hist.fill(0); cnt = 0;
      for (let i = 0; i < d.length; i += 16) { hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++; cnt++; }
    }
  }
  const bp = Math.min(90, pct(0.005)), med = pct(0.5);
  const paper = med >= 150;
  const T = paper ? Math.max(bp + 40, med - 45) : 256;   // 이 밝기 아래 = 글자
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = !paper || v >= T ? v : (v - bp) * T / (T - bp);
  if (paper) for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; }
  await uiYield();
  const src = new Uint8ClampedArray(d), K = 0.8, row = w * 4, edge = paper ? T + 10 : 256;
  for (let y = 1; y < h - 1; y++) {
    for (let xx = 1; xx < w - 1; xx++) {
      const o = y * row + xx * 4;
      for (let ch = 0; ch < 3; ch++) {
        const p = o + ch;
        const m9 = (src[p - row - 4] + src[p - row] + src[p - row + 4] + src[p - 4] + src[p] + src[p + 4] + src[p + row - 4] + src[p + row] + src[p + row + 4]) / 9;
        if (src[p] < edge || m9 < edge) d[p] = src[p] + K * (src[p] - m9);
      }
    }
    if ((y & 255) === 0) await uiYield();
  }
  x.putImageData(id, 0, 0);
  const blob = await ieBlob(c, 'image/png');
  const bmp = await createImageBitmap(c); c.width = c.height = 0;
  return { bmp, bytes: new Uint8Array(await blob.arrayBuffer()), url: URL.createObjectURL(blob), boost: { bp, T, paper } };
}

// ── ✒ 벡터화 — 작업 스레드(끝나기 전에 새로 시작하면 앞 작업은 버린다) ──
let _ieWorker = null, _ieWorkerReject = null;
function ieTraceCancel() {
  if (_ieWorker) { try { _ieWorker.terminate(); } catch (e) {} _ieWorker = null; }
  if (_ieWorkerReject) { const r = _ieWorkerReject; _ieWorkerReject = null; const e = new Error('취소'); e.canceled = true; r(e); }
}
function ieTraceInWorker(buf, w, h, opts) {
  ieTraceCancel();
  const wk = _ieWorker = new Worker('./worker-trace.js');
  return new Promise((ok, bad) => {
    _ieWorkerReject = bad;
    const done = () => { try { wk.terminate(); } catch (e) {} if (_ieWorker === wk) { _ieWorker = null; _ieWorkerReject = null; } };
    wk.onmessage = e => { done(); const d = e.data || {}; d.error ? bad(new Error(d.error)) : ok(d); };
    wk.onerror = e => { if (e && e.preventDefault) e.preventDefault(); done(); bad(new Error((e && e.message) || '벡터화 작업 오류')); };
    wk.postMessage({ id: 1, rgba: buf, w, h, opts }, [buf]);
  });
}
// o: { colors, smooth, speck, dropWhite, aiFirst } → { td, tw, th, ms, stats, url(SVG), src: '원본'|'AI n배', aiMs }
async function ieVectorize(S, o, onStage) {
  // PDF 안 그림에 투명(SMask)이 있으면 투명까지 그린 그림으로 — 투명한 곳은 칠하지 않는다(AI는 투명을 모르니 건너뜀)
  let src = S.bmpA || S.bmp, srcLbl = '원본', aiMs = 0, aiNote = '';
  const long0 = Math.max(S.w, S.h);
  if (o.aiFirst && long0 < 1600 && !S.bmpA) {
    // 작은 로고는 AI(일러스트 모델)로 먼저 키우면 윤곽이 훨씬 매끄럽다 — 긴 변 약 2400px까지
    const want = Math.min(4, Math.max(2, Math.ceil(2400 / long0)));
    const reuse = S.up && !S.up.none && S.up.method === 'ai' && S.up.w >= S.w * 2 ? S.up : null;
    if (reuse) { src = reuse.bmp; srcLbl = `AI ${Math.round(reuse.w / S.w * 10) / 10}배`; }
    else {
      if (onStage) onStage('AI로 먼저 키우는 중…');
      const r = await ieUpscale(S, { model: 'realesrgan-x4plus-anime', size: String(want), wMm: S.wMm }, p => onStage && onStage(`AI로 먼저 키우는 중… ${Math.round(p * 100)}%`));
      if (r.canceled) { const e = new Error('취소'); e.canceled = true; throw e; }
      if (r.method === 'ai') { src = r.bmp; srcLbl = `AI ${want}배`; aiMs = r.ms; S._aiTmp && ieFreeUp(S._aiTmp); S._aiTmp = r; }
      else { aiNote = r.note; ieFreeUp(r); }
    }
  }
  // 윤곽 따는 크기: 긴 변 1200~2400px (작으면 부드럽게 키우고, 크면 줄인다 — 클수록 오래 걸리고 모양이 잘아진다)
  const long = Math.max(src.width, src.height);
  const k = long > 2400 ? 2400 / long : long < 1200 ? 1200 / long : 1;
  const tw = Math.max(1, Math.round(src.width * k)), th = Math.max(1, Math.round(src.height * k));
  const id = iePixels(src, tw, th);
  if (onStage) onStage('윤곽 따는 중…');
  const r = await ieTraceInWorker(id.data.buffer, tw, th, { colors: o.colors, smooth: o.smooth, speck: o.speck });
  const td = r.td, hMm = S.wMm * S.h / S.w;
  const vo = { dropWhite: o.dropWhite, wMm: S.wMm, hMm };
  const svg = ImgEnhance.traceSvg(td, vo);
  return { td, tw, th, ms: r.ms, aiMs, aiNote, src: srcLbl, stats: ImgEnhance.traceStats(td, vo), url: URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), svgLen: svg.length, opts: Object.assign({}, o) };
}

// ── 결과 → PDF(인쇄 크기 그대로 1쪽) ──
// 그림: 투명이 있으면 무손실(Flate + SMask), 없으면 JPEG(흑백이면 1성분 JPEG = DeviceGray)
async function ieImagePdfBytes(S) {
  const r = S.up, wPt = S.wMm * IE_PT_PER_MM, hPt = wPt * S.h / S.w;
  const doc = await PDFLib.PDFDocument.create();
  doc.setTitle(ieStem(S.name)); doc.setProducer('PDF Editor');
  const page = doc.addPage([wPt, hPt]);
  const ctx = doc.context, PN = PDFLib.PDFName;
  const w = r.w, h = r.h;
  let imgRef;
  if (S.alpha) {
    const px = iePixels(r.bmp).data, n = w * h, a = new Uint8Array(n), col = new Uint8Array(n * (S.gray ? 1 : 3));
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      a[i] = px[j + 3];
      if (S.gray) col[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
      else { col[i * 3] = px[j]; col[i * 3 + 1] = px[j + 1]; col[i * 3 + 2] = px[j + 2]; }
    }
    const sm = ctx.register(ctx.flateStream(a, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
    imgRef = ctx.register(ctx.flateStream(col, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: S.gray ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8, SMask: sm }));
  } else {
    let jpg;
    if (S.gray) {
      const px = iePixels(r.bmp).data, g = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
      jpg = encodeGrayJpeg(g, w, h, 90);
    } else {
      const c = ieCanvas(w, h); c.getContext('2d').drawImage(r.bmp, 0, 0);
      jpg = new Uint8Array(await (await ieBlob(c, 'image/jpeg', 0.92)).arrayBuffer()); c.width = c.height = 0;
    }
    const emb = await doc.embedJpg(jpg);
    page.drawImage(emb, { x: 0, y: 0, width: wPt, height: hPt });
    return await savePdfDoc(doc);
  }
  page.node.setXObject(PN.of('Im0'), imgRef);
  const ops = `q ${wPt.toFixed(3)} 0 0 ${hPt.toFixed(3)} 0 0 cm /Im0 Do Q`;
  page.node.set(PN.of('Contents'), ctx.register(ctx.flateStream(ops)));
  return await savePdfDoc(doc);
}
async function ieVectorPdfBytes(S) {
  const v = S.vec, wPt = S.wMm * IE_PT_PER_MM, hPt = wPt * S.h / S.w;
  const doc = await PDFLib.PDFDocument.create();
  doc.setTitle(ieStem(S.name)); doc.setProducer('PDF Editor');
  const page = doc.addPage([wPt, hPt]);
  const ops = ImgEnhance.tracePdfOps(v.td, { pageW: wPt, pageH: hPt, dropWhite: v.opts.dropWhite });
  page.node.set(PDFLib.PDFName.of('Contents'), doc.context.register(doc.context.flateStream(ops)));
  return await savePdfDoc(doc);
}

// ── 창 ──
// pdfOpt(2단계 · PDF 안 그림): { items: 이미 읽은 그림(iePdfFind 결과), onApply(골라 실행한 그림들) → true면 창을 닫는다 }
async function openImageEnhance(items, pdfOpt) {
  if (_ieState) { if (items && items.length && !pdfOpt) _ieState.add(items); return; }
  if (!pdfOpt && (!items || !items.length)) {
    // 문서가 열려 있으면 — 그 PDF 안의 저해상도 그림인지, 이미지 파일인지 묻는다
    if (typeof originalPdfBytes !== 'undefined' && originalPdfBytes) {
      const undoN = iePdfUndoCount();
      const c = await askChoice('🖼 이미지 업스케일·벡터화 — 무엇을 고칠까요?', [
        { label: '취소', value: null },
        ...(undoN ? [{ label: `↺ 마지막 바꿔 넣기 되돌리기 (${undoN}${({ page: '쪽', typo: '곳' })[iePdfUndoKind()] || '개'})`, value: 'undo', title: '이 문서에서 마지막으로 바꿔 넣은 그림·쪽을 원래대로 돌립니다' }] : []),
        { label: '🖼 이미지 파일 고르기', value: 'file', title: '이미지 파일(PNG·JPG…)을 골라 키우거나 벡터로 바꿉니다' },
        { label: '🖼 PDF 안 저해상도 그림', value: 'pdf', title: '열린 문서에서 300dpi 미만 그림(사진·로고)을 하나하나 찾아 키우거나 벡터로 바꿔 넣습니다' },
        { label: (typeof selectedPages !== 'undefined' && selectedPages.size) ? `📄 고른 ${selectedPages.size}쪽 전체 업스케일` : '📄 저해상도 쪽 전체 업스케일', value: 'page', primary: true,
          title: '스캔본처럼 쪽 전체가 저해상도 그림인 쪽을 찾아, 쪽마다 통째로 AI로 키워 300dpi로 바꿉니다 — 쪽을 골라 두면 그 쪽만 (Enter)' },
      ]);
      if (!c) return;
      if (c === 'undo') { await iePdfUndo(); return; }
      if (c === 'pdf') { await openPdfImageEnhance(); return; }
      if (c === 'page') { await openPdfPageUpscale(); return; }
    }
    items = await window.electronAPI.openFile({ kind: 'image' });
    if (!items || !items.length) return;
  }
  if (!pdfOpt) {
    items = items.filter(it => IMG_RE.test(it.name || it.path || ''));
    if (!items.length) { showError('이미지 파일(PNG·JPG·GIF·BMP·WEBP)을 골라 주세요.'); return; }
  }
  const PDFM = !!pdfOpt;

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const opt = (arr, cur) => arr.map(o => `<option value="${o.v}"${String(o.v) === String(cur) ? ' selected' : ''}${o.title ? ` title="${esc(o.title)}"` : ''}>${esc(o.label)}</option>`).join('');
  const P = {   // 기억하는 설정
    mode: !(pdfOpt && pdfOpt.pageMode) && ieLs('ieMode', 'up') === 'vec' ? 'vec' : 'up',
    model: IE_MODELS.some(m => m.v === ieLs('ieModel', '')) ? ieLs('ieModel', '') : 'realesrgan-x4plus',
    size: IE_SIZES.some(m => m.v === ieLs('ieSize', '')) ? ieLs('ieSize', '') : 'dpi',
    colors: IE_COLORS.some(c => String(c.v) === ieLs('ieColors', '0')) ? +ieLs('ieColors', '0') : 0, smooth: +ieLs('ieSmooth', 1) || 1, speck: +ieLs('ieSpeck', 8),
    dropWhite: ieLs('ieDropWhite', '0') === '1', aiFirst: ieLs('ieAiFirst', '1') !== '0', textBoost: ieLs('ieTextBoost', '1') !== '0',
  };
  if (!IE_SPECK.some(s => s.v === P.speck)) P.speck = 8;

  const ov = document.createElement('div');
  ov.className = 'merge-overlay';
  ov.innerHTML =
    '<div class="merge-modal rbv-modal rbv-full ie-modal">'
    + '<div class="rbv-titlebar"><h3 class="merge-title"><span class="ic">🖼</span> 이미지 업스케일 · 벡터화</h3></div>'
    + '<p class="merge-sub" id="ieSub"></p>'
    + '<div class="rbv-tools">'
    + '<button class="merge-cancel rbv-btn ie-tab" data-mode="up" title="AI로 해상도를 높입니다 — 흐린 사진·작은 이미지를 인쇄용으로">🔍 업스케일</button>'
    + '<button class="merge-cancel rbv-btn ie-tab" data-mode="vec" title="윤곽을 따서 벡터(선·면)로 바꿉니다 — 로고·도장·일러스트를 어떤 크기로도 깨끗하게">✒ 벡터로 바꾸기</button>'
    + '<span class="rbv-sep"></span>'
    + '<span class="ie-grp" data-for="up"><label class="ie-lbl">종류 <select class="es-input" id="ieModel">' + opt(IE_MODELS, P.model) + '</select></label>'
    + '<label class="ie-lbl">크기 <select class="es-input" id="ieSize">' + opt(IE_SIZES, P.size) + '</select></label>'
    + '<label class="sc-opt" id="ieTextBoostWrap" style="display:none" title="키운 뒤 글자만 진하게, 획 가장자리를 선명하게 합니다 — 종이 바탕 색·질감은 그대로 (바꾸면 다시 실행)"><input type="checkbox" id="ieTextBoost"' + (P.textBoost ? ' checked' : '') + '> 글자 또렷하게</label></span>'
    + '<span class="ie-grp" data-for="vec"><label class="ie-lbl">색 <select class="es-input" id="ieColors">' + opt(IE_COLORS, P.colors) + '</select></label>'
    + '<label class="ie-lbl" title="곡선을 얼마나 단순하게 할지 — 정밀은 원본에 가깝지만 점이 많고, 매끄럽게는 깔끔하지만 작은 모서리가 둥글어집니다">선 <select class="es-input" id="ieSmooth">' + opt(IE_SMOOTH, P.smooth) + '</select></label>'
    + '<label class="ie-lbl" title="이 크기보다 작은 점·얼룩은 버립니다">잡티 <select class="es-input" id="ieSpeck">' + opt(IE_SPECK, P.speck) + '</select></label>'
    + '<label class="sc-opt" title="흰색 부분을 칠하지 않고 비워 둡니다(투명) — 다른 그림 위에 얹을 로고에"><input type="checkbox" id="ieDropWhite"' + (P.dropWhite ? ' checked' : '') + '> 흰색 비우기</label>'
    + '<label class="sc-opt" title="작은 이미지(긴 변 1600px 미만)는 AI(일러스트 모델)로 먼저 키운 뒤 윤곽을 땁니다 — 곡선이 훨씬 매끄러워집니다"><input type="checkbox" id="ieAiFirst"' + (P.aiFirst ? ' checked' : '') + '> 작으면 AI로 먼저 키우기</label></span>'
    + '<span class="rbv-sep"></span>'
    + '<label class="ie-lbl" title="인쇄할 폭 — 결과 PDF의 쪽 크기이고, 300dpi 목표의 기준입니다(높이는 비율대로)">인쇄 폭 <input type="number" class="es-input ie-mm" id="ieWmm" min="5" max="5000" step="0.1"><span class="split-dim">mm</span></label>'
    + '<span class="split-dim" id="ieHmm"></span>'
    + '<span class="rbv-sep"></span>'
    + '<button class="merge-confirm rbv-btn" id="ieRun" title="지금 이미지에 실행 (Enter)">▶ 실행</button>'
    + '<button class="merge-cancel rbv-btn" id="ieRunAll" title="목록의 모든 이미지에 같은 설정으로 실행">▶▶ 모두 실행</button>'
    + '<button class="merge-cancel rbv-btn" id="ieAdd" title="이미지를 더 추가합니다 (창에 끌어다 놓아도 됩니다)">＋ 이미지 추가</button>'
    + '</div>'
    + '<div class="rbv-body"><div class="rbv-list ie-list" id="ieList"></div>'
    + '<div class="rbv-view"><div class="ie-panes" id="iePanes">'
    + '<div class="ie-pane" id="ieL"><img class="ie-img" id="ieImgL" draggable="false" alt=""><div class="ie-cap" id="ieCapL"></div></div>'
    + '<div class="ie-pane" id="ieR"><img class="ie-img" id="ieImgR" draggable="false" alt=""><div class="ie-cap" id="ieCapR"></div><div class="ie-empty" id="ieEmpty"></div></div>'
    + '</div>'
    + '<div class="rbv-legend"><span class="split-dim">마우스 휠 = 확대·축소(두 그림 같이) · 끌기 = 이동 · 두 번 클릭 = 맞춤</span>'
    + '<button class="merge-cancel rbv-btn" id="ieFit">맞춤</button><button class="merge-cancel rbv-btn" id="ie100" title="결과 그림의 화소 하나 = 화면 화소 하나">100%</button><span class="rbv-zoom" id="ieZoom"></span></div>'
    + '</div></div>'
    + '<p class="split-dim rb-note" id="ieNote"></p>'
    + '<div class="merge-actions"><span class="split-dim ie-info" id="ieInfo"></span>'
    + '<button class="merge-cancel" id="ieClose">닫기</button>'
    + '<select class="es-input ie-fmt" id="ieFmt"></select>'
    + '<button class="merge-cancel" id="ieSave" title="결과를 파일로 저장합니다(원본 이미지가 있던 폴더부터)">💾 저장</button>'
    + '<button class="merge-confirm" id="ieOpen" title="결과를 인쇄 크기 그대로의 PDF로 만들어 앱에서 엽니다 — 지금 열린 문서가 있으면 챕터·새 탭을 묻습니다">📂 앱에서 열기</button></div>'
    + '</div>';
  document.body.appendChild(ov);
  const $ = id => ov.querySelector('#' + id);
  if (PDFM) {   // PDF 안 그림: 추가·파일 저장 없음, 인쇄 폭은 PDF에 놓인 크기 그대로, 결과는 PDF에 바꿔 넣기
    ov.querySelector('.merge-title').innerHTML = '<span class="ic">🖼</span> PDF 안 그림 업스케일 · 벡터화';
    $('ieAdd').style.display = 'none'; $('ieFmt').style.display = 'none'; $('ieSave').style.display = 'none';
    $('ieWmm').disabled = true; $('ieWmm').title = 'PDF에 놓인 크기(가장 크게 놓인 곳 기준) — 바꿀 수 없습니다';
    $('ieOpen').textContent = '✔ 저장';
    $('ieOpen').title = '실행한 그림(목록에 ✔ 표시)을 원본 PDF 안의 그 그림과 바꿉니다 — 같은 그림을 쓰는 모든 쪽에 반영 · 되돌리기 가능';
  }
  const PAGEM = !!(pdfOpt && pdfOpt.pageMode);   // 📄 쪽 전체 업스케일 — 업스케일만(쪽을 벡터로 바꾸지 않는다)
  if (PAGEM) {
    ov.querySelector('.merge-title').innerHTML = '<span class="ic">📄</span> 저해상도 쪽 전체 업스케일';
    ov.querySelector('.ie-tab[data-mode="vec"]').style.display = 'none';
    $('ieWmm').title = 'PDF 쪽의 폭 — 바꿀 수 없습니다';
    $('ieOpen').title = '실행한 쪽(목록에 ✔ 표시)의 내용을 키운 그림 한 장으로 바꿉니다 — 원본 파일은 그대로, 다운로드는 _이미지-Up 사본 이름 · 되돌리기 가능';
    $('ieTextBoostWrap').style.display = '';
  }
  if (typeof decolorEmojiIn === 'function') { try { decolorEmojiIn(ov); } catch (e) {} }
  const list = PDFM ? items.slice() : [];   // ieLoadItem 결과 (PDF 모드는 iePdfFind가 읽어 둔 그림)
  let cur = 0, busy = false, closed = false;
  const view = { z: 1, cx: 0.5, cy: 0.5 };

  const St = {
    add: async (more) => {
      const seen = new Set(list.map(S => S.path));
      for (const it of more) {
        if (closed || !IMG_RE.test(it.name || it.path || '') || seen.has(it.path)) continue;
        try { list.push(await ieLoadItem(it)); seen.add(it.path); }
        catch (e) { showError(e.message || String(e)); }
      }
      if (!closed) { renderList(); show(); }
    },
  };
  _ieState = St;
  const close = async () => {
    if (closed) return;
    closed = true; _ieState = null;
    ieTraceCancel();
    if (busy) { try { await window.electronAPI.upscaleCancel(); } catch (e) {} }
    document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', layout);
    ov.remove();
    list.forEach(S => { ieFreeItem(S); if (S._aiTmp) ieFreeUp(S._aiTmp); });
  };
  $('ieClose').onclick = close;
  const onKey = e => {
    if (document.querySelector('.pt-box')) return;   // 위에 묻는 창(askChoice·promptText)이 떠 있으면 그쪽 키
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (busy) cancelRun(); else close(); }
    else if (e.key === 'Enter' && !(e.target && /^(SELECT|TEXTAREA)$/.test(e.target.tagName))) { e.preventDefault(); e.stopPropagation(); if (!busy) run([cur]); }
    else if ((e.key === 'PageDown' || e.key === 'PageUp') && list.length > 1) { e.preventDefault(); cur = Math.max(0, Math.min(list.length - 1, cur + (e.key === 'PageDown' ? 1 : -1))); renderList(); show(); }
  };
  document.addEventListener('keydown', onKey, true);

  const S0 = () => list[cur];
  const curRes = S => S && (P.mode === 'up' ? S.up : S.vec);
  function setMode(m) {
    if (PAGEM) m = 'up';
    P.mode = m; if (!PAGEM) ieLsSet('ieMode', m);
    ov.querySelectorAll('.ie-tab').forEach(b => b.classList.toggle('ie-on', b.dataset.mode === m));
    ov.querySelectorAll('.ie-grp').forEach(g => { g.style.display = g.dataset.for === m ? '' : 'none'; });
    $('ieFmt').innerHTML = m === 'up'
      ? '<option value="pdf">PDF (인쇄 크기)</option><option value="png">PNG (무손실)</option><option value="jpg">JPG (작은 용량)</option>'
      : '<option value="pdf">PDF (벡터)</option><option value="svg">SVG</option>';
    const f = ieLs(m === 'up' ? 'ieFmtUp' : 'ieFmtVec', 'pdf'); if ([...$('ieFmt').options].some(o => o.value === f)) $('ieFmt').value = f;
    $('ieNote').innerHTML = m === 'up'
      ? 'AI가 <b>없는 디테일을 그려 넣습니다</b> — 사람 얼굴·작은 글자는 원본과 달라질 수 있으니 확대해 확인하세요. 흑백 1비트 스캔·글자 위주 그림은 좋아지지 않습니다. 흑백 사진은 흑백(먹 1도)으로 담습니다.'
      : '윤곽을 따서 면으로 칠합니다 — 로고·도장·일러스트에 알맞고 사진은 알맞지 않습니다. 색이 적을수록 깔끔하고 파일이 작습니다. 회색·검정은 먹(회색)으로 담아 흑백 과금이 됩니다.';
    if (PAGEM) $('ieNote').innerHTML = 'AI가 <b>없는 디테일을 그려 넣습니다</b> — 작은 글자·얼굴은 확대해 원본과 비교하세요. 글자 위주 스캔은 <b>일러스트·로고·글자</b> 종류가 획을 더 또렷하게 합니다. 흑백 쪽은 흑백(먹 1도)으로 담습니다.'
      + '<br>📄 ' + esc(pdfOpt.note || '') + ' · 실행한 쪽(✔)만 바꿔 넣습니다 · 쪽이 그림 한 장이 되므로 글자 선택·검색은 사라집니다';
    else if (PDFM) $('ieNote').innerHTML += '<br>📄 300dpi 미만 그림만 골랐습니다(낮은 순) · 같은 그림을 여러 쪽에서 쓰면 모두 바뀝니다 · 실행한 그림(✔)만 바꿔 넣습니다'
      + (pdfOpt.skipped ? ' · 바꿀 수 없어 뺀 그림: ' + esc(pdfOpt.skipped) : '');
    renderList(); show();
  }
  ov.querySelectorAll('.ie-tab').forEach(b => b.onclick = () => { if (!busy) setMode(b.dataset.mode); });
  const bindSel = (id, key, ls, num) => { $(id).onchange = e => { P[key] = num ? +e.target.value : e.target.value; ieLsSet(ls, P[key]); show(); }; };
  bindSel('ieModel', 'model', 'ieModel'); bindSel('ieSize', 'size', 'ieSize');
  bindSel('ieColors', 'colors', 'ieColors', true); bindSel('ieSmooth', 'smooth', 'ieSmooth', true); bindSel('ieSpeck', 'speck', 'ieSpeck', true);
  $('ieDropWhite').onchange = e => { P.dropWhite = e.target.checked; ieLsSet('ieDropWhite', P.dropWhite ? 1 : 0); show(); };
  $('ieAiFirst').onchange = e => { P.aiFirst = e.target.checked; ieLsSet('ieAiFirst', P.aiFirst ? 1 : 0); show(); };
  $('ieTextBoost').onchange = e => { P.textBoost = e.target.checked; ieLsSet('ieTextBoost', P.textBoost ? 1 : 0); show(); };
  $('ieFmt').onchange = e => ieLsSet(P.mode === 'up' ? 'ieFmtUp' : 'ieFmtVec', e.target.value);
  $('ieWmm').onchange = e => {
    const S = S0(); if (!S) return;
    const v = parseFloat(e.target.value); if (v > 0) S.wMm = Math.max(5, Math.min(5000, v));
    show();   // 결과는 그대로 — PDF 쪽 크기·SVG mm는 저장할 때 지금 인쇄 폭으로 만든다
  };
  $('ieAdd').onclick = async () => { if (busy) return; const more = await window.electronAPI.openFile({ kind: 'image' }); if (more && more.length) St.add(more); };
  ov.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); });
  ov.addEventListener('drop', e => {
    e.preventDefault(); e.stopPropagation();
    const fs = [...(e.dataTransfer && e.dataTransfer.files || [])].map(f => ({ name: f.name, path: window.electronAPI.getPathForFile(f) })).filter(x => x.path);
    if (fs.length && !busy && !PDFM) St.add(fs);
  });

  // 목록
  function tagOf(S) {
    const t = [];
    if (S.up && !S.up.none) t.push(`<span class="rb-tag" title="업스케일 결과">🔍 ${S.up.w}×${S.up.h}</span>`);
    if (S.up && S.up.none) t.push('<span class="rb-tag" title="이미 300dpi 이상">🔍 충분</span>');
    if (S.vec) t.push(`<span class="rb-tag" title="벡터 결과">✒ ${S.vec.stats.colors}색</span>`);
    if (S.err) t.push(`<span class="rb-tag sc-t-warn" title="${esc(S.err)}">⚠</span>`);
    if (PDFM && S.pick && (S.pick === 'up' ? S.up && !S.up.none : S.vec)) t.push(`<span class="rb-tag rb-done" title="'✔ 저장'을 누르면 이 결과로 바뀝니다 (마지막에 실행한 것)">✔ ${S.pick === 'up' ? '업스케일' : '벡터'}로</span>`);
    return t.join(' ');
  }
  function renderList() {
    $('ieList').innerHTML = list.map((S, i) => `<div class="rbv-pghead ie-row${i === cur ? ' cur' : ''}" data-i="${i}"><img class="ie-thumb" src="${S.url}" alt=""><span class="ie-rowtxt"><b>${esc(S.name)}</b><br><span class="split-dim">${S.w}×${S.h}px · ${Math.round(ieDpiOf(S, S.w))}dpi</span> ${tagOf(S)}</span></div>`).join('')
      || '<div class="split-dim" style="padding:10px">이미지가 없습니다 — ＋ 이미지 추가</div>';
    $('ieList').style.display = list.length > 1 ? '' : 'none';
    $('ieRunAll').style.display = list.length > 1 ? '' : 'none';
  }
  $('ieList').addEventListener('click', e => { const r = e.target.closest('.ie-row'); if (!r || busy) return; cur = +r.dataset.i; renderList(); show(); });
  const ieDpiOf = (S, px) => px / (S.wMm / 25.4);

  // 보기(두 그림 같이)
  function layout() {
    const S = S0(), L = $('ieL'), R = $('ieR');
    if (!S) return;
    const PW = L.clientWidth, PH = L.clientHeight; if (!PW || !PH) return;
    const fit = Math.min(PW / S.w, PH / S.h) * 0.96;
    const dw = S.w * fit * view.z, dh = S.h * fit * view.z;
    for (const img of [$('ieImgL'), $('ieImgR')]) {
      img.style.width = dw + 'px'; img.style.height = dh + 'px';
      img.style.left = (PW / 2 - view.cx * dw) + 'px'; img.style.top = (PH / 2 - view.cy * dh) + 'px';
    }
    const r = curRes(S), rw = r && !r.none ? (r.w || r.tw || S.w) : S.w;
    $('ieZoom').textContent = Math.round(dw / rw * 100) + '%';
    void R;
  }
  window.addEventListener('resize', layout);
  const panes = $('iePanes');
  panes.addEventListener('wheel', e => {
    const S = S0(); if (!S) return;
    e.preventDefault();
    const pane = e.target.closest('.ie-pane') || $('ieL');
    const rc = pane.getBoundingClientRect(), PW = rc.width, PH = rc.height;
    const fit = Math.min(PW / S.w, PH / S.h) * 0.96, dw = S.w * fit * view.z, dh = S.h * fit * view.z;
    const mx = e.clientX - rc.left, my = e.clientY - rc.top;
    const ux = view.cx + (mx - PW / 2) / dw, uy = view.cy + (my - PH / 2) / dh;   // 마우스 아래 그림 위치(0~1)
    const z2 = Math.max(0.2, Math.min(200, view.z * Math.pow(1.0015, -e.deltaY)));
    const dw2 = S.w * fit * z2, dh2 = S.h * fit * z2;
    view.z = z2; view.cx = ux - (mx - PW / 2) / dw2; view.cy = uy - (my - PH / 2) / dh2;
    layout();
  }, { passive: false });
  panes.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    const S = S0(); if (!S) return;
    e.preventDefault();
    const rc = $('ieL').getBoundingClientRect(), fit = Math.min(rc.width / S.w, rc.height / S.h) * 0.96;
    const dw = S.w * fit * view.z, dh = S.h * fit * view.z, x0 = e.clientX, y0 = e.clientY, cx0 = view.cx, cy0 = view.cy;
    panes.classList.add('ie-panning');
    const mv = ev => { view.cx = cx0 - (ev.clientX - x0) / dw; view.cy = cy0 - (ev.clientY - y0) / dh; layout(); };
    const up = () => { panes.classList.remove('ie-panning'); window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
  });
  const fitView = () => { view.z = 1; view.cx = view.cy = 0.5; layout(); };
  panes.addEventListener('dblclick', fitView);
  $('ieFit').onclick = fitView;
  $('ie100').onclick = () => {
    const S = S0(); if (!S) return;
    const L = $('ieL'), fit = Math.min(L.clientWidth / S.w, L.clientHeight / S.h) * 0.96;
    const r = curRes(S), rw = r && !r.none && r.w ? r.w : (r && r.tw) || S.w;
    view.z = rw / (S.w * fit); layout();
  };

  function show() {
    const S = S0();
    if (!S) { $('ieSub').textContent = '이미지를 추가하세요.'; return; }
    const hMm = S.wMm * S.h / S.w;
    if (document.activeElement !== $('ieWmm')) $('ieWmm').value = (Math.round(S.wMm * 10) / 10);
    $('ieHmm').textContent = `× ${Math.round(hMm * 10) / 10}mm`;
    const dpi0 = ieDpiOf(S, S.w);
    $('ieSub').innerHTML = `<b>${esc(S.name)}</b> · ${S.w}×${S.h}px · 인쇄 ${Math.round(S.wMm)}×${Math.round(hMm)}mm에서 <b>${Math.round(dpi0)}dpi</b>`
      + (S.dpiKnown ? '' : ' <span class="split-dim">(파일에 해상도 기록 없음 — 인쇄 폭을 맞춰 주세요)</span>')
      + (S.gray ? ' · 흑백' : '') + (S.alpha ? ' · 투명 배경' : '')
      + (dpi0 < 150 ? ' · <span class="ie-warn">⚠ 인쇄하면 흐릿합니다</span>' : dpi0 < 280 ? ' · <span class="split-dim">조금 낮음</span>' : '');
    $('ieImgL').src = S.url;
    $('ieCapL').textContent = `원본 ${S.w}×${S.h}px · ${Math.round(dpi0)}dpi`;
    const r = curRes(S);
    const R = $('ieImgR'), E = $('ieEmpty');
    if (r && !r.none) {
      R.src = r.url; R.style.display = ''; E.style.display = 'none';
      $('ieCapR').textContent = P.mode === 'up'
        ? `결과 ${r.w}×${r.h}px · ${Math.round(ieDpiOf(S, r.w))}dpi · ${r.method === 'ai' ? 'AI ' + (IE_MODELS.find(m => m.v === r.model) || {}).label : '일반 보간'}${r.boost ? ' · 글자 또렷하게' : ''}`
        : `벡터 · 색 ${r.stats.colors} · 모양 ${ieFmtN(r.stats.shapes)} · 점 ${ieFmtN(r.stats.points)}${r.stats.gray ? ' · 먹(회색)만' : ''}`;
    } else {
      R.removeAttribute('src'); R.style.display = 'none'; E.style.display = '';
      $('ieCapR').textContent = '';
      if (P.mode === 'up') {
        const plan = ImgEnhance.upscalePlan(S.w, S.h, { mode: P.size === 'dpi' ? 'dpi' : +P.size, printWmm: S.wMm, targetDpi: 300 });
        E.innerHTML = '<div>' + (r && r.none || plan.run === 1
          ? `이미 인쇄 폭에서 <b>${Math.round(dpi0)}dpi</b>라 키울 필요가 없습니다.<br><span class="split-dim">더 키우려면 '크기'를 2·3·4배로 고르세요.</span>`
          : `▶ 실행하면 <b>${plan.outW}×${plan.outH}px</b>(${Math.round(ieDpiOf(S, plan.outW))}dpi)로 키웁니다.<br><span class="split-dim">AI ${plan.run}배${plan.factor < plan.run ? ` → ${Math.round(plan.factor * 100) / 100}배로 맞춤` : ''}${plan.capped ? ' · 결과가 너무 커서 줄였습니다' : ''}${plan.need > 4 ? ` · 300dpi까지 ${Math.round(plan.need * 10) / 10}배가 필요하지만 4배까지만` : ''}</span>`) + '</div>';
      } else E.innerHTML = '<div>▶ 실행하면 윤곽을 따서 벡터로 바꿉니다.' + (P.aiFirst && Math.max(S.w, S.h) < 1600 ? '<br><span class="split-dim">작은 이미지라 AI로 먼저 키운 뒤 땁니다.</span>' : '') + '</div>';
    }
    const ready = !!(r && !r.none);
    $('ieSave').disabled = !ready || busy;
    $('ieOpen').disabled = busy || (PDFM ? !list.some(ieHasPick) : !ready);
    $('ieRun').disabled = $('ieRunAll').disabled = busy;
    $('ieInfo').textContent = ready ? infoOf(S, r) : '';
    layout();
  }
  function infoOf(S, r) {
    if (P.mode === 'up') return `${r.method === 'ai' ? `AI ${(r.ms / 1000).toFixed(1)}초${r.gpu ? ' · ' + r.gpu : ''}` : `일반 보간 (${r.note || 'AI 없음'})`}`;
    return `${r.src} → 윤곽 ${r.tw}×${r.th}px · ${((r.ms + (r.aiMs || 0)) / 1000).toFixed(1)}초${r.aiNote ? ` · ${r.aiNote} AI 없이` : ''}`;
  }

  // 실행
  let runToken = 0;
  function cancelRun() { runToken++; ieTraceCancel(); try { window.electronAPI.upscaleCancel(); } catch (e) {} }
  async function run(idxs) {
    if (busy || !idxs.length) return;
    busy = true; const tok = ++runToken; show();
    showLoading(P.mode === 'up' ? '🔍 AI 업스케일 중…' : '✒ 벡터로 바꾸는 중…');
    let done = 0, fails = 0, interp = '';
    try {
      for (const i of idxs) {
        const S = list[i]; if (!S || closed || tok !== runToken) break;
        const nth = idxs.length > 1 ? ` (${done + 1}/${idxs.length}) ${S.name}` : '';
        const prog = (p, msg) => { updateProgress(Math.round(((done + p) / idxs.length) * 100)); if (typeof loadingMsg !== 'undefined') loadingMsg.textContent = (msg || (P.mode === 'up' ? '🔍 AI 업스케일 중…' : '✒ 벡터로 바꾸는 중…')) + nth; };
        prog(0);
        try {
          S.err = null;
          if (P.mode === 'up') {
            const r = await ieUpscale(S, { model: P.model, size: P.size, wMm: S.wMm }, p => prog(p, `🔍 AI 업스케일 중… ${Math.round(p * 100)}%`));
            if (r.canceled || tok !== runToken) { if (!r.canceled) ieFreeUp(r); break; }
            if (!r.none && PAGEM && P.textBoost) { prog(0.95, '🔤 글자 또렷하게…'); const b = await ieTextBoost(r, S.bmp); ieFreeUp(r); Object.assign(r, b); }
            ieFreeUp(S.up); S.up = r; if (!r.none) S.pick = 'up';
            if (r.method === 'interp') interp = r.note;
          } else {
            const r = await ieVectorize(S, { colors: P.colors, smooth: P.smooth, speck: P.speck, dropWhite: P.dropWhite, aiFirst: P.aiFirst }, msg => prog(0.3, msg));
            if (tok !== runToken) { ieFreeVec(r); break; }
            ieFreeVec(S.vec); S.vec = r; S.pick = 'vec';
          }
        } catch (e) {
          if (e && e.canceled) break;
          S.err = (e && e.message) || String(e); fails++;
          if (idxs.length === 1) showError((P.mode === 'up' ? '업스케일 실패: ' : '벡터화 실패: ') + S.err);
        }
        done++;
        if (!closed && i === cur) { renderList(); show(); }
      }
    } finally {
      busy = false; hideLoading();
      if (!closed) { renderList(); fitView(); show(); }
    }
    if (closed) return;
    if (interp) showError(`${interp} AI 대신 일반 보간으로 키웠습니다 — 선명해지지는 않습니다. (그래픽 드라이버를 최신으로 하면 AI를 쓸 수 있습니다)`);
    else if (done && !fails) {
      const S = S0(), r = curRes(S);
      if (r && !r.none) showSuccess(P.mode === 'up'
        ? `🔍 ${done > 1 ? done + '개 ' : ''}업스케일 완료${PDFM ? ' — 확대해 비교한 뒤 ✔ 저장' : ''} — ${r.w}×${r.h}px (${Math.round(ieDpiOf(S, r.w))}dpi)\n확대해서 원본과 비교한 뒤 → ${PDFM ? "'✔ 저장'(문서에 반영 — 원본 파일은 그대로)" : "'📂 앱에서 열기'(인쇄 크기 PDF) 또는 '💾 저장'"}.`
        : `✒ ${done > 1 ? done + '개 ' : ''}벡터로 바꿨습니다 — 색 ${r.stats.colors} · 모양 ${ieFmtN(r.stats.shapes)}\n확대해 윤곽을 확인하고(거칠면 '선'·'잡티'·'색'을 바꿔 다시 실행) → '📂 앱에서 열기' 또는 '💾 저장'(PDF·SVG).`);
    }
  }
  $('ieRun').onclick = () => run([cur]);
  $('ieRunAll').onclick = () => run(list.map((_, i) => i));

  // 저장·열기
  const suffix = () => P.mode === 'up' ? '_업스케일' : '_벡터';
  async function bytesFor(S, fmt) {
    if (P.mode === 'vec') {
      if (fmt === 'svg') return new TextEncoder().encode(ImgEnhance.traceSvg(S.vec.td, { dropWhite: S.vec.opts.dropWhite, wMm: S.wMm, hMm: S.wMm * S.h / S.w }));
      return await ieVectorPdfBytes(S);
    }
    const dpi = ieDpiOf(S, S.up.w);
    if (fmt === 'png') return iePngSetDpi(S.up.bytes, dpi);
    if (fmt === 'jpg') {
      let jpg;
      if (S.gray) { const px = iePixels(S.up.bmp).data, g = new Uint8Array(S.up.w * S.up.h); for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8; jpg = encodeGrayJpeg(g, S.up.w, S.up.h, 92); }
      else { const c = ieCanvas(S.up.w, S.up.h), x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(S.up.bmp, 0, 0); jpg = new Uint8Array(await (await ieBlob(c, 'image/jpeg', 0.92)).arrayBuffer()); c.width = c.height = 0; }
      return ieJpegSetDpi(jpg, dpi);
    }
    return await ieImagePdfBytes(S);
  }
  $('ieSave').onclick = async () => {
    const S = S0(), r = curRes(S); if (!S || !r || r.none || busy) return;
    const fmt = $('ieFmt').value;
    busy = true; show(); showLoading('💾 저장할 파일을 만드는 중…');
    let bytes;
    try { bytes = await bytesFor(S, fmt); }
    catch (e) { hideLoading(); busy = false; show(); showError('파일 만들기 실패: ' + ((e && e.message) || e)); return; }
    hideLoading(); busy = false; show();
    const saved = await window.electronAPI.saveFile({ defaultName: ieStem(S.name) + suffix() + '.' + fmt, buffer: bytes, kind: fmt, defaultDir: S.dir });
    if (saved) showSuccess(`💾 저장했습니다 — ${String(saved).split(/[\\/]/).pop()} (${(bytes.length / 1048576).toFixed(1)}MB)\n${fmt === 'pdf' ? `인쇄 크기 ${Math.round(S.wMm)}×${Math.round(S.wMm * S.h / S.w)}mm 그대로입니다 → 앱에서 열어 임포징·인쇄하세요.` : `파일에 해상도(${Math.round(ieDpiOf(S, r.w || S.w))}dpi)를 기록해 다른 프로그램에서도 같은 인쇄 크기로 열립니다.`}`);
  };
  $('ieOpen').onclick = async () => {
    if (busy) return;
    if (PDFM) {
      const picks = list.filter(ieHasPick);
      if (!picks.length) return;
      busy = true; show();
      let done = false;
      try { done = await pdfOpt.onApply(picks); } finally { busy = false; if (!closed) show(); }
      if (done) await close();
      return;
    }
    const targets = list.filter(S => { const r = curRes(S); return r && !r.none; });
    const S = S0();
    const pick = targets.length > 1 && targets.includes(S) ? await askChoice(`결과가 있는 이미지가 ${targets.length}개입니다. 무엇을 열까요?`, [
      { label: '취소', value: null }, { label: '지금 이미지만', value: 'one' }, { label: `📚 ${targets.length}개 모두`, value: 'all', primary: true },
    ]) : 'one';
    if (!pick) return;
    const go = pick === 'all' ? targets : [S];
    busy = true; show(); showLoading('📂 PDF로 만드는 중…');
    const items = [];
    try {
      for (const X of go) {
        const bytes = P.mode === 'up' ? await ieImagePdfBytes(X) : await ieVectorPdfBytes(X);
        const tmp = window.electronAPI.writeTempFile(bytes, 'pdf');
        items.push({ name: ieStem(X.name) + suffix() + '.pdf', path: tmp, archivePath: X.path });
      }
    } catch (e) { hideLoading(); busy = false; show(); showError('PDF 만들기 실패: ' + ((e && e.message) || e)); return; }
    hideLoading(); busy = false;
    await close();
    if (items.length > 1) showOpenOrderDialog(items);
    else await openExternalItems(items);
  };

  ov.__ieTest = { list, P, run, setMode, show, view, cur: () => cur, busy: () => busy, bytesFor, layout };   // e2e(img-enhance.e2e.js)
  setMode(P.mode);
  if (PDFM) { renderList(); show(); }
  else { showLoading('🖼 이미지를 읽는 중…'); try { await St.add(items); } finally { hideLoading(); } }
  if (!list.length) { close(); return; }
  requestAnimationFrame(fitView);
}

// ════════════════════════════════════════════════════════════════════════
// 📄 2단계 — PDF 안 저해상도 그림 (2026-10-29)
//   ① 찾기: 쪽 내용(q/Q/cm/Do, 폼 안까지)을 따라가 그림마다 놓인 크기 → 실효 해상도(가장 크게 놓인 곳 기준)
//   ② 꺼내기: 그림 하나만 담은 임시 PDF(쪽 = 그림 화소, 1:1)를 pdf.js로 그린다 — 필터·색공간·Decode·CMYK JPEG를 pdf.js가 푼다
//   ③ 바꿔 넣기: 원본 PDF 끝에 **증분 저장**(같은 객체 번호의 새 그림 + 새 xref)을 덧붙인다 → 원본을 읽는 모든 경로
//      (썸네일·적용·다운로드·인쇄·내부 편집기·작업 파일)가 새 그림을 쓰고, 되돌리기는 덧붙인 만큼 잘라 내면 된다.
//      이미 구운 쪽 편집본(K100·스캔 정리·내부 편집)에 들어 있는 같은 그림(내용 지문)도 함께 바꾼다.
//   업스케일 = 같은 그림 객체를 더 큰 그림으로(SMask·Mask 그대로 — 해상도가 달라도 규격상 된다)
//   벡터 = 그림 객체를 폼(BBox 0 0 w h · Matrix 1/w 1/h — 그림의 단위 사각형과 같은 자리)으로
// ════════════════════════════════════════════════════════════════════════
const ieHasPick = S => !!(S && S.pick && (S.pick === 'up' ? (S.up && !S.up.none) : S.vec));
const IE_PDF_DPI = 300;
const ieN = n => PDFLib.PDFName.of(n);
const ieNum = v => { try { return v && v.asNumber ? v.asNumber() : (typeof v === 'number' ? v : NaN); } catch (e) { return NaN; } };
function ieFnv(u8) { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i++) { h ^= u8[i]; h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + ':' + u8.length; }
const ieMul = (m, a) => [m[0] * a[0] + m[2] * a[1], m[1] * a[0] + m[3] * a[1], m[0] * a[2] + m[2] * a[3], m[1] * a[2] + m[3] * a[3], m[0] * a[4] + m[2] * a[5] + m[4], m[1] * a[4] + m[3] * a[5] + m[5]];

// 내용 스트림 훑기(그림 배치만) — 문자열·주석·사전·인라인 그림은 건너뛴다. onOp(op, 피연산자[])
function ieWalkOps(u8, onOp) {
  const n = u8.length, WS = c => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
  const DL = c => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
  let i = 0, ops = [];
  while (i < n) {
    const c = u8[i];
    if (WS(c)) { i++; continue; }
    if (c === 37) { while (i < n && u8[i] !== 10 && u8[i] !== 13) i++; continue; }
    if (c === 40) { let d = 1; i++; while (i < n && d) { const x = u8[i]; if (x === 92) i++; else if (x === 40) d++; else if (x === 41) d--; i++; } ops.push(null); continue; }
    if (c === 60) { if (u8[i + 1] === 60) { i += 2; continue; } while (i < n && u8[i] !== 62) i++; i++; ops.push(null); continue; }
    if (c === 62) { i += (u8[i + 1] === 62) ? 2 : 1; continue; }
    if (c === 91 || c === 93 || c === 123 || c === 125) { i++; continue; }
    if (c === 47) { let j = i + 1; while (j < n && !WS(u8[j]) && !DL(u8[j])) j++; let s = ''; for (let k = i + 1; k < j; k++) s += String.fromCharCode(u8[k]); ops.push({ name: s.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) }); i = j; continue; }
    let j = i; while (j < n && !WS(u8[j]) && !DL(u8[j])) j++;
    if (j === i) { i++; continue; }
    let t = ''; for (let k = i; k < j; k++) t += String.fromCharCode(u8[k]);
    i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) { ops.push(+t); continue; }
    if (t === 'BI') {   // 인라인 그림: ID 뒤 자료는 'EI'(앞뒤 공백)까지 건너뛴다
      while (i < n - 1 && !(u8[i] === 73 && u8[i + 1] === 68 && WS(u8[i - 1]) && (i + 2 >= n || WS(u8[i + 2])))) i++;
      i += 3;
      while (i < n - 1 && !(WS(u8[i - 1]) && u8[i] === 69 && u8[i + 1] === 73 && (i + 2 >= n || WS(u8[i + 2])))) i++;
      i += 2; ops = []; continue;
    }
    onOp(t, ops); ops = [];
  }
}
function ieStreamBytes(st) {
  try { return PDFLib.decodePDFRawStream(st).decode(); } catch (e) { return null; }
}
// 그림 객체 설명 — 바꿀 수 없는 것은 why에 이유
function ieImgInfo(ctx, st) {
  const d = st.dict, g = k => d.get(ieN(k)), lk = k => { try { return d.lookup(ieN(k)); } catch (e) { return null; } };
  const w = ieNum(lk('Width')), h = ieNum(lk('Height')), bpc = ieNum(lk('BitsPerComponent'));
  const filt = String(lk('Filter') || '');
  const info = { w, h, bpc, filter: filt, kind: 'rgb', why: null, smask: !!g('SMask') };
  if (String(lk('ImageMask')) === 'true') info.why = '마스크(한 색 무늬)';
  else if (bpc === 1) info.why = '1비트(흑백 스캔)';
  else if (/JPX/.test(filt)) info.why = 'JPEG 2000';
  else if (lk('Mask') instanceof PDFLib.PDFArray) info.why = '색 키 마스크';
  if (info.why) return info;
  const kindOf = cs => {
    if (!cs) return 'rgb';
    if (cs instanceof PDFLib.PDFName) { const s = String(cs); return /Gray/.test(s) ? 'gray' : /RGB/.test(s) ? 'rgb' : /CMYK/.test(s) ? 'cmyk' : 'other'; }
    if (cs instanceof PDFLib.PDFArray) {
      const t = String(cs.get(0));
      if (t === '/ICCBased') { try { const n = ieNum(ctx.lookup(cs.get(1)).dict.lookup(ieN('N'))); return n === 1 ? 'gray' : n === 3 ? 'rgb' : n === 4 ? 'cmyk' : 'other'; } catch (e) { return 'other'; } }
      if (t === '/Indexed' || t === '/I') { const b = kindOf(ctx.lookup(cs.get(1))); return b === 'gray' || b === 'rgb' ? b : 'other'; }
      if (t === '/CalGray') return 'gray';
      if (t === '/CalRGB') return 'rgb';
      return 'other';
    }
    return 'other';
  };
  info.kind = kindOf(lk('ColorSpace'));
  if (info.kind === 'cmyk') info.why = 'CMYK(바꾸면 RGB가 됨)';
  else if (info.kind === 'other') info.why = '별색·Lab 등 특수 색';
  return info;
}
// ① 찾기 — 쪽들(원본 쪽 번호)에서 그림 객체마다 놓인 곳·실효 해상도. 반환 { found: Map(key → {ref, st, info, places, dpi}), skipped: {이유: 개수} }
function iePdfFind(src, pageIdxs, onProg, opt) {
  const ALL = !!(opt && opt.all);   // 쪽 전체 업스케일용 — 바꿀 수 없는 그림(1비트·CMYK…)도 놓인 곳·해상도를 센다
  const ctx = src.context, found = new Map(), skipped = {};
  const seenSkip = new Set();
  const walk = (u8, res, m0, pageIdx, depth) => {
    if (!u8 || depth > 8) return;
    let m = m0.slice(); const stack = [];
    let xo = null; try { xo = res && res.lookupMaybe ? res.lookupMaybe(ieN('XObject'), PDFLib.PDFDict) : null; } catch (e) {}
    ieWalkOps(u8, (op, a) => {
      if (op === 'q') stack.push(m.slice());
      else if (op === 'Q') m = stack.pop() || m0.slice();
      else if (op === 'cm' && a.length >= 6) { const v = a.slice(-6); if (v.every(x => typeof x === 'number')) m = ieMul(m, v); }
      else if (op === 'Do' && xo && a.length && a[a.length - 1] && a[a.length - 1].name) {
        const ref = xo.get(ieN(a[a.length - 1].name));
        if (!(ref instanceof PDFLib.PDFRef)) return;
        const st = ctx.lookup(ref);
        if (!st || !st.dict) return;
        const sub = String(st.dict.get(ieN('Subtype')));
        if (sub === '/Form') {
          let fm = [1, 0, 0, 1, 0, 0]; try { const mm = st.dict.lookup(ieN('Matrix')); if (mm instanceof PDFLib.PDFArray) fm = mm.asArray().map(ieNum); } catch (e) {}
          let fres = null; try { fres = st.dict.lookupMaybe(ieN('Resources'), PDFLib.PDFDict); } catch (e) {}
          walk(ieStreamBytes(st), fres || res, ieMul(m, fm), pageIdx, depth + 1);
        } else if (sub === '/Image') {
          const key = ref.objectNumber + ' ' + ref.generationNumber;
          const wPt = Math.hypot(m[0], m[1]), hPt = Math.hypot(m[2], m[3]);
          if (wPt < 6 || hPt < 6) return;   // 아이콘급 미세 배치
          let f = found.get(key);
          if (!f) {
            if (seenSkip.has(key)) return;
            const info = ieImgInfo(ctx, st);
            if (ALL ? !(info.w * info.h >= 16 * 16) : (info.why || !(info.w * info.h >= 64 * 64) || info.w * info.h > 40e6)) {
              seenSkip.add(key); const why = info.why || (info.w * info.h > 40e6 ? '너무 큼' : '아주 작은 그림'); skipped[why] = (skipped[why] || 0) + 1;
              return;
            }
            f = { key, ref, st, info, places: [], dpi: Infinity, wPt: 0 };
            found.set(key, f);
          }
          const dpi = Math.min(f.info.w / (wPt / 72), f.info.h / (hPt / 72));
          f.places.push({ pageIdx, wPt, hPt, dpi });
          if (dpi < f.dpi) { f.dpi = dpi; f.wPt = f.info.w / dpi * 72; }
        }
      }
    });
  };
  pageIdxs.forEach((pi, k) => {
    try {
      const page = src.getPage(pi), node = page.node;
      const res = node.Resources();
      const c = node.Contents();
      const parts = !c ? [] : c instanceof PDFLib.PDFArray ? c.asArray().map(r => ctx.lookup(r)) : [c];
      const bufs = parts.map(ieStreamBytes).filter(Boolean);
      const tot = bufs.reduce((s, b) => s + b.length + 1, 0), all = new Uint8Array(tot);
      let o = 0; for (const b of bufs) { all.set(b, o); o += b.length; all[o++] = 10; }
      walk(all, res, [1, 0, 0, 1, 0, 0], pi, 0);
    } catch (e) { console.warn('그림 찾기 실패(쪽 ' + (pi + 1) + '):', e); }
    if (onProg) onProg((k + 1) / pageIdxs.length);
  });
  return { found, skipped };
}
// ② 꺼내기 — 그림들을 1:1로 그린다(마스크 없이 색만 · SMask가 있으면 투명까지 따로). 반환 [{ bmp, bmpA, url }]
async function iePdfDecode(src, cands, onProg) {
  const out = [];
  for (let k = 0; k < cands.length; k += 8) {   // 8개씩 임시 PDF 하나
    const part = cands.slice(k, k + 8);
    const tmp = await PDFLib.PDFDocument.create();
    const copy = PDFLib.PDFObjectCopier.for(src.context, tmp.context).copy;
    const pages = [];
    const add = (s, f) => {
      const r = tmp.context.register(s);
      const pg = tmp.addPage([f.info.w, f.info.h]);
      pg.node.setXObject(ieN('Im0'), r);
      pg.node.set(ieN('Contents'), tmp.context.register(tmp.context.flateStream(`q ${f.info.w} 0 0 ${f.info.h} 0 0 cm /Im0 Do Q`)));
      return tmp.getPageCount();
    };
    for (const f of part) {
      const st = copy(f.st);
      const plain = PDFLib.PDFRawStream.of(st.dict.clone(tmp.context), st.contents);
      plain.dict.delete(ieN('SMask')); plain.dict.delete(ieN('Mask'));
      pages.push({ c: add(plain, f), a: f.info.smask ? add(st, f) : 0 });
    }
    const bytes = await tmp.save();
    const pdf = await openPdfDoc({ data: bytes }).promise;
    try {
      for (let q = 0; q < part.length; q++) {
        const f = part[q];
        const draw = async (pn, transparent) => {
          const page = await pdf.getPage(pn), vp = page.getViewport({ scale: 1 });
          const c = ieCanvas(f.info.w, f.info.h), x = c.getContext('2d');
          if (!transparent) { x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); }
          await page.render({ canvasContext: x, viewport: vp, background: transparent ? 'rgba(0,0,0,0)' : '#ffffff' }).promise;
          page.cleanup();
          return c;
        };
        const cc = await draw(pages[q].c, false);
        const blob = await ieBlob(cc, 'image/png');
        const bmp = await createImageBitmap(cc); cc.width = cc.height = 0;
        let bmpA = null;
        if (pages[q].a) { const ca = await draw(pages[q].a, true); bmpA = await createImageBitmap(ca); ca.width = ca.height = 0; }
        out.push({ bmp, bmpA, url: URL.createObjectURL(blob) });
        if (onProg) onProg(out.length / cands.length);
      }
    } finally { try { await pdf.destroy(); } catch (e) {} }
  }
  return out;
}
// 쪽 번호 표시(화면 순서) — 원본 쪽 번호 → 지금 목록의 쪽 번호
function iePagesLabel(places) {
  const shown = [...new Set(places.map(p => { const r = pageResults.find(x => x && !x.isBlank && x.originalIdx === p.pageIdx); return r ? r.pageNum : p.pageIdx + 1; }))].sort((a, b) => a - b);
  return shown.length > 3 ? `${shown.slice(0, 3).join('·')}쪽 외 ${shown.length - 3}` : shown.join('·') + '쪽';
}
async function openPdfImageEnhance() {
  if (!originalPdfBytes) { showError('먼저 PDF를 여세요.'); return; }
  showLoading('📄 PDF 안 그림을 찾는 중…');
  let src, res, dec;
  const pageIdxs = [...new Set(pageResults.filter(r => r && !r.isBlank && r.originalIdx != null).map(r => r.originalIdx))].sort((a, b) => a - b);
  try {
    src = await getSourceDoc();
    if (src.context.trailerInfo.Encrypt) throw new Error('암호가 걸린 PDF는 그림을 바꿔 넣을 수 없습니다.');
    res = iePdfFind(src, pageIdxs, p => updateProgress(Math.round(p * 30)));
  } catch (e) { hideLoading(); showError('그림 찾기 실패: ' + ((e && e.message) || e)); return; }
  // 내용이 똑같은 그림(객체만 따로 — 같은 로고를 쪽마다 새로 실은 PDF)은 한 줄로: 한 번 실행해 모두 바꾼다
  const groups = new Map();
  for (const f of res.found.values()) {
    const g = ieFnv(f.st.contents) + '|' + f.info.w + 'x' + f.info.h;
    const o = groups.get(g);
    if (!o) { f.refs = [f.ref]; groups.set(g, f); continue; }
    o.refs.push(f.ref); o.places.push(...f.places);
    if (f.dpi < o.dpi) { o.dpi = f.dpi; o.wPt = f.wPt; }
  }
  const all = [...groups.values()];
  const low = all.filter(f => f.dpi < IE_PDF_DPI).sort((a, b) => a.dpi - b.dpi).slice(0, 200);
  const skipTxt = Object.entries(res.skipped).map(([k, v]) => `${k} ${v}`).join(' · ');
  if (!low.length) {
    hideLoading();
    showSuccess(`📄 300dpi 미만 그림이 없습니다 — 그림 ${all.length}개 모두 인쇄 해상도가 충분합니다.` + (skipTxt ? `\n(바꿀 수 없는 그림은 뺐습니다: ${skipTxt})` : ''));
    return;
  }
  try {
    if (typeof loadingMsg !== 'undefined') loadingMsg.textContent = `📄 그림 ${low.length}개를 꺼내는 중…`;
    dec = await iePdfDecode(src, low, p => updateProgress(30 + Math.round(p * 70)));
  } catch (e) { hideLoading(); showError('그림 꺼내기 실패: ' + ((e && e.message) || e)); return; }
  hideLoading();
  const items = low.map((f, i) => {
    const d = dec[i], k = Math.min(1, 400 / Math.max(f.info.w, f.info.h));
    const sm = iePixels(d.bmp, Math.max(1, Math.round(f.info.w * k)), Math.max(1, Math.round(f.info.h * k)));
    return {
      it: null, name: `${iePagesLabel(f.places)} · 그림 ${f.info.w}×${f.info.h}`, path: 'pdf:' + f.key, dir: '',
      bmp: d.bmp, bmpA: d.bmpA, w: f.info.w, h: f.info.h, url: d.url, dpiKnown: true, wMm: f.wPt * 25.4 / 72,
      gray: f.info.kind === 'gray' || ImgEnhance.isNeutralRgba(sm.data, 6), alpha: !!d.bmpA, up: null, vec: null, err: null,
      pdf: f,
    };
  });
  await openImageEnhance(items, { onApply: picks => iePdfApply(picks), skipped: skipTxt });
}

// ③ 바꿔 넣기 — 새 그림(또는 폼) 만들기
async function iePdfRep(S) {
  const f = S.pdf;
  if (S.pick === 'vec') {
    const v = S.vec, ops = ImgEnhance.tracePdfOps(v.td, { pageW: v.td.width, pageH: v.td.height, dropWhite: v.opts.dropWhite });
    return { kind: 'vec', tw: v.td.width, th: v.td.height, bytes: pako.deflate(new TextEncoder().encode(ops)) };
  }
  const r = S.up, w = r.w, h = r.h;
  if (S.gray) {
    const px = iePixels(r.bmp).data, g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
    return { kind: 'img', w, h, cs: 'DeviceGray', filter: 'DCTDecode', bytes: encodeGrayJpeg(g, w, h, 90) };
  }
  if (!/DCT/.test(f.info.filter) && w * h <= 4e6) {   // 원래 무손실(로고·화면 갈무리)이고 크지 않으면 무손실 그대로
    const px = iePixels(r.bmp).data, rgb = new Uint8Array(w * h * 3);
    for (let i = 0, j = 0; j < px.length; i += 3, j += 4) { rgb[i] = px[j]; rgb[i + 1] = px[j + 1]; rgb[i + 2] = px[j + 2]; }
    return { kind: 'img', w, h, cs: 'DeviceRGB', filter: 'FlateDecode', bytes: pako.deflate(rgb) };
  }
  const c = ieCanvas(w, h); c.getContext('2d').drawImage(r.bmp, 0, 0);
  const jpg = new Uint8Array(await (await ieBlob(c, 'image/jpeg', 0.92)).arrayBuffer()); c.width = c.height = 0;
  return { kind: 'img', w, h, cs: 'DeviceRGB', filter: 'DCTDecode', bytes: jpg };
}
// ctx 안에 새 객체 — 그림은 원래 SMask·Mask·Intent를 이어받는다
function ieRepObj(ctx, oldDict, rep) {
  if (rep.kind === 'vec') {
    const d = ctx.obj({ Type: 'XObject', Subtype: 'Form', FormType: 1, BBox: [0, 0, rep.tw, rep.th], Matrix: [1 / rep.tw, 0, 0, 1 / rep.th, 0, 0], Filter: 'FlateDecode' });
    return PDFLib.PDFRawStream.of(d, rep.bytes);
  }
  const d = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: rep.w, Height: rep.h, ColorSpace: rep.cs, BitsPerComponent: 8, Filter: rep.filter });
  for (const k of ['SMask', 'Mask', 'Intent']) { const v = oldDict.get(ieN(k)); if (v && !(v instanceof PDFLib.PDFArray)) d.set(ieN(k), v); }
  return PDFLib.PDFRawStream.of(d, rep.bytes);
}
function ieObjBytes(obj) { const b = new Uint8Array(obj.sizeInBytes()); obj.copyBytesInto(b, 0); return b; }
// 증분 저장 덧붙이기 — base(원본 바이트) 끝에 objs([{ref, obj}]) + xref(원본이 표면 표, 흐름이면 흐름) → 새 바이트
function ieAppendUpdate(base, src, objs) {
  const tr = src.context.trailerInfo;
  if (tr.Encrypt) throw new Error('암호가 걸린 PDF');
  const tail = new TextDecoder('latin1').decode(base.subarray(Math.max(0, base.length - 4096)));
  const sx = tail.lastIndexOf('startxref');
  const prev = sx >= 0 ? parseInt(tail.slice(sx + 9).trim(), 10) : NaN;
  if (!(prev >= 0 && prev < base.length)) throw new Error('원본의 상호 참조 위치(startxref)를 찾지 못했습니다');
  let p = prev; while (p < base.length && (base[p] === 32 || base[p] === 10 || base[p] === 13 || base[p] === 9)) p++;
  const classic = base[p] === 0x78 && base[p + 1] === 0x72 && base[p + 2] === 0x65 && base[p + 3] === 0x66;   // 'xref'
  const enc = s => new TextEncoder().encode(s);
  const parts = [enc('\n')], offs = [];
  let at = base.length + 1;
  const push = u8 => { parts.push(u8); at += u8.length; };
  for (const { ref, obj } of objs) {
    offs.push({ num: ref.objectNumber, gen: ref.generationNumber, off: at });
    push(enc(`${ref.objectNumber} ${ref.generationNumber} obj\n`)); push(ieObjBytes(obj)); push(enc('\nendobj\n'));
  }
  // ⚠ pdf-lib의 largestObjectNumber에는 원본의 xref 흐름·객체 묶음(ObjStm) 번호가 빠진다 — 그 번호를 새 xref 흐름에 쓰면
  //   원본 객체 묶음을 덮어 Root를 못 찾는다(pdf.js 'Invalid Root reference', 실측). 원본 마지막 xref의 /Size를 직접 읽는다.
  let sizeOrig = 0;
  try {
    const t = new TextDecoder('latin1').decode(base.subarray(p, Math.min(base.length, p + 8 * 1024 * 1024)));
    const m = (classic ? t.slice(Math.max(0, t.indexOf('trailer'))) : t).match(/\/Size\s+(\d+)/);
    if (m) sizeOrig = +m[1];
  } catch (e) {}
  const size0 = Math.max(src.context.largestObjectNumber + 1, sizeOrig, ...objs.map(o => o.ref.objectNumber + 1));   // 새 객체(ieOrigSize로 받은 번호)까지
  const extra = (tr.Root ? ` /Root ${tr.Root}` : '') + (tr.Info ? ` /Info ${tr.Info}` : '') + (tr.ID ? ` /ID ${tr.ID}` : '');
  const xrefAt = at;
  if (classic) {
    offs.sort((a, b) => a.num - b.num);
    let s = 'xref\n';
    for (let i = 0; i < offs.length;) {
      let j = i; while (j + 1 < offs.length && offs[j + 1].num === offs[j].num + 1) j++;
      s += `${offs[i].num} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) s += `${String(offs[k].off).padStart(10, '0')} ${String(offs[k].gen).padStart(5, '0')} n\r\n`;
      i = j + 1;
    }
    s += `trailer\n<< /Size ${size0}${extra} /Prev ${prev} >>\nstartxref\n${xrefAt}\n%%EOF\n`;
    push(enc(s));
  } else {
    const xnum = size0;
    offs.push({ num: xnum, gen: 0, off: xrefAt });
    offs.sort((a, b) => a.num - b.num);
    const rows = new Uint8Array(offs.length * 7);
    offs.forEach((e, i) => { const o = i * 7; rows[o] = 1; rows[o + 1] = (e.off >>> 24) & 255; rows[o + 2] = (e.off >>> 16) & 255; rows[o + 3] = (e.off >>> 8) & 255; rows[o + 4] = e.off & 255; rows[o + 5] = (e.gen >> 8) & 255; rows[o + 6] = e.gen & 255; });
    const index = offs.map(e => `${e.num} 1`).join(' ');
    push(enc(`${xnum} 0 obj\n<< /Type /XRef /Size ${xnum + 1} /W [1 4 2] /Index [${index}]${extra} /Prev ${prev} /Length ${rows.length} >>\nstream\n`));
    push(rows);
    push(enc(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`));
  }
  const out = new Uint8Array(at);
  out.set(base, 0);
  let o = base.length; for (const u of parts) { out.set(u, o); o += u.length; }
  return out;
}
// 새 객체에 쓸 첫 번호 — ieAppendUpdate와 같은 규칙(원본 마지막 xref의 /Size 이상 · pdf-lib 번호에는 xref 흐름·객체 묶음이 빠진다)
function ieOrigSize(base, src) {
  const tail = new TextDecoder('latin1').decode(base.subarray(Math.max(0, base.length - 4096)));
  const sx = tail.lastIndexOf('startxref');
  const prev = sx >= 0 ? parseInt(tail.slice(sx + 9).trim(), 10) : NaN;
  let size = src.context.largestObjectNumber + 1;
  if (prev >= 0 && prev < base.length) {
    let p = prev; while (p < base.length && (base[p] === 32 || base[p] === 10 || base[p] === 13 || base[p] === 9)) p++;
    const classic = base[p] === 0x78 && base[p + 1] === 0x72;
    const t = new TextDecoder('latin1').decode(base.subarray(p, Math.min(base.length, p + 8 * 1024 * 1024)));
    const m = (classic ? t.slice(Math.max(0, t.indexOf('trailer'))) : t).match(/\/Size\s+(\d+)/);
    if (m) size = Math.max(size, +m[1]);
  }
  return size + 1;   // +1 = 원본 /Size 번호는 ieAppendUpdate가 새 xref 흐름에 쓸 수 있어 비워 둔다
}

// ══ 📄 쪽 전체 업스케일 (2026-10-30 사용자 요청 — 그림 하나하나가 아니라 쪽마다) ══
//   스캔본·저해상도 쪽: 쪽을 그 쪽 그림의 원래 해상도로 통째로 그려(pdf.js · 이음매 보정 · 주석 제외) AI로 키운 뒤,
//   그 쪽의 내용을 '키운 그림 한 장'으로 바꾼다(원본 바이트 끝에 증분 저장 — 그림 바꿔 넣기와 같은 되돌리기).
//   대상 = 그림이 쪽의 절반 이상을 덮고 해상도가 300dpi 미만인 쪽(글자가 벡터인 쪽은 그림으로 바꾸면 오히려 나빠진다).
//   ⚠ 쪽이 그림이 되므로 글자 선택·검색은 사라진다(스캔본은 원래 그림). 쪽 편집본(내부 편집·스캔 정리·K100)이 있는 쪽은 뺀다
//     — 편집본이 옛 쪽을 들고 있어 바꿔도 화면에 안 나온다. 업스케일을 먼저 하고 정리·K100을 하면 된다.
const IE_PAGE_MAX = 30;   // 한 번에 여는 쪽 수(쪽 그림을 메모리에 들고 있다) — 바꾼 쪽은 300dpi가 돼 다음에 다시 열면 나머지가 나온다
async function openPdfPageUpscale() {
  if (!originalPdfBytes || !globalPdfDoc) { showError('먼저 PDF를 여세요.'); return; }
  const rs = pageResults.filter(r => r && !r.isBlank && r.originalIdx != null);
  const selRs = rs.filter(r => selectedPages.has(r.pageNum));
  const useRs = selRs.length ? selRs : rs;
  const numOf = new Map(); useRs.forEach(r => { if (!numOf.has(r.originalIdx)) numOf.set(r.originalIdx, r.pageNum); });
  const idxs = [...numOf.keys()].sort((a, b) => a - b);
  showLoading('📄 저해상도 쪽을 찾는 중…');
  let src, res;
  try {
    src = await getSourceDoc();
    if (src.context.trailerInfo.Encrypt) throw new Error('암호가 걸린 PDF는 쪽을 바꿔 넣을 수 없습니다.');
    res = iePdfFind(src, idxs, p => updateProgress(Math.round(p * 20)), { all: true });
  } catch (e) { hideLoading(); showError('쪽 살펴보기 실패: ' + ((e && e.message) || e)); return; }
  // 쪽마다 그림이 덮는 넓이·해상도(쪽의 5% 이상 차지하는 그림 중 가장 높은 해상도로 그린다 — 디테일을 잃지 않게)
  const st = new Map();
  for (const f of res.found.values()) for (const p of f.places) {
    const s = st.get(p.pageIdx) || { area: 0, dpi: 0, big: 0 };
    s.area += p.wPt * p.hPt; s.list = s.list || []; s.list.push(p);
    st.set(p.pageIdx, s);
  }
  const cand = [], skip = { '그림이 적은 쪽(글자·도형 위주)': 0, '이미 300dpi 이상': 0, '편집한 쪽(내부 편집·스캔 정리·K100)': 0 };
  for (const pi of idxs) {
    let box; try { const pg = src.getPage(pi), cb = pg.getCropBox(); box = cb; } catch (e) { continue; }
    const pageArea = Math.max(1, box.width * box.height), s = st.get(pi);
    if (!s || s.area < pageArea * 0.5) { skip['그림이 적은 쪽(글자·도형 위주)']++; continue; }
    let dpi = 0; for (const p of s.list) if (p.wPt * p.hPt >= pageArea * 0.05) dpi = Math.max(dpi, p.dpi);
    if (!(dpi > 0)) dpi = Math.max(...s.list.map(p => p.dpi));
    if (dpi >= IE_PDF_DPI - 5) { skip['이미 300dpi 이상']++; continue; }
    if (typeof contentEdits !== 'undefined' && contentEdits.has(pi)) { skip['편집한 쪽(내부 편집·스캔 정리·K100)']++; continue; }
    cand.push({ pi, dpi });
  }
  const skipTxt = Object.entries(skip).filter(([, v]) => v).map(([k, v]) => `${k} ${v}쪽`).join(' · ');
  const scope = selRs.length ? `고른 ${idxs.length}쪽` : `전체 ${idxs.length}쪽`;
  if (!cand.length) {
    hideLoading();
    showSuccess(`📄 ${scope}에서 업스케일할 저해상도 쪽이 없습니다.` + (skipTxt ? `\n(${skipTxt})` : '')
      + `\n쪽 안의 작은 사진만 흐리면 🖼 → '🖼 PDF 안 저해상도 그림'을 쓰세요.`);
    return;
  }
  const more = Math.max(0, cand.length - IE_PAGE_MAX);
  const go = cand.slice(0, IE_PAGE_MAX);
  const items = [];
  try {
    for (let k = 0; k < go.length; k++) {
      const { pi, dpi } = go[k];
      if (typeof loadingMsg !== 'undefined') loadingMsg.textContent = `📄 쪽을 그리는 중… (${k + 1}/${go.length})`;
      const page = await globalPdfDoc.getPage(pi + 1);
      const rdpi = Math.max(50, Math.min(300, Math.round(dpi)));
      const vp = page.getViewport({ scale: rdpi / 72, rotation: 0 });   // 돌리지 않은 쪽 그대로(/Rotate는 쪽에 남는다)
      const w = Math.max(1, Math.round(vp.width)), h = Math.max(1, Math.round(vp.height));
      const c = ieCanvas(w, h), x = c.getContext('2d');
      x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
      const AM = (pdfjsLib.AnnotationMode && pdfjsLib.AnnotationMode.DISABLE != null) ? pdfjsLib.AnnotationMode.DISABLE : 0;   // 주석은 쪽에 그대로 남으니 굽지 않는다
      const params = { canvasContext: x, viewport: vp, annotationMode: AM, background: '#ffffff' };
      if (typeof renderPageNoSeams === 'function') await renderPageNoSeams(page, params); else await page.render(params).promise;
      page.cleanup();
      const sm = iePixels(c, Math.max(1, Math.round(w * Math.min(1, 400 / Math.max(w, h)))), Math.max(1, Math.round(h * Math.min(1, 400 / Math.max(w, h)))));
      const blob = await ieBlob(c, 'image/jpeg', 0.9);
      const bmp = await createImageBitmap(c); c.width = c.height = 0;
      const view = page.view;   // pdf.js가 그린 상자(CropBox ∩ MediaBox) — 키운 그림을 이 상자에 앉힌다
      items.push({
        it: null, name: `${numOf.get(pi)}쪽 · 쪽 전체`, path: 'page:' + pi, dir: '',
        bmp, bmpA: null, w, h, url: URL.createObjectURL(blob), dpiKnown: true, wMm: (view[2] - view[0]) * 25.4 / 72,
        gray: ImgEnhance.isNeutralRgba(sm.data, 6), alpha: false, up: null, vec: null, err: null,
        pageUp: { pageIdx: pi, view: view.slice(), srcDpi: dpi },
      });
      updateProgress(20 + Math.round((k + 1) / go.length * 80));
    }
  } catch (e) {
    hideLoading(); items.forEach(ieFreeItem);
    showError('쪽 그리기 실패: ' + ((e && e.message) || e)); return;
  }
  hideLoading();
  const note = `${scope} 중 저해상도 쪽 ${cand.length}쪽` + (more ? ` — 한 번에 ${IE_PAGE_MAX}쪽까지 열었습니다(바꿔 넣은 뒤 다시 열면 나머지 ${more}쪽)` : '')
    + (skipTxt ? ` · 뺀 쪽: ${skipTxt}` : '');
  await openImageEnhance(items, { onApply: picks => iePageApply(picks), pageMode: true, note });
}
// 키운 쪽 그림 → 그림 객체(흑백이면 1성분 JPEG = DeviceGray · 함정 15)
async function iePageImage(ctx, S) {
  const r = S.up, w = r.w, h = r.h;
  let bytes, cs;
  if (S.gray) {
    const px = iePixels(r.bmp).data, g = new Uint8Array(w * h);
    for (let i = 0, j = 0; i < g.length; i++, j += 4) g[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
    bytes = encodeGrayJpeg(g, w, h, 92); cs = 'DeviceGray';
  } else {
    const c = ieCanvas(w, h), x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); x.drawImage(r.bmp, 0, 0);
    bytes = new Uint8Array(await (await ieBlob(c, 'image/jpeg', 0.92)).arrayBuffer()); c.width = c.height = 0; cs = 'DeviceRGB';
  }
  const d = ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: cs, BitsPerComponent: 8, Filter: 'DCTDecode' });
  return PDFLib.PDFRawStream.of(d, bytes);
}
// 쪽이 쓰는 그림의 용량·화소(폼 안까지 세 겹) — 바꾼 뒤 '용량 전→후' 안내용
function iePageImgStat(ctx, node) {
  const seen = new Set(); let bytes = 0, px = 0;
  const walk = (res, depth) => {
    if (!res || depth > 3) return;
    let xo = null; try { xo = res.lookupMaybe(ieN('XObject'), PDFLib.PDFDict); } catch (e) {}
    if (!xo) return;
    for (const [, v] of xo.entries()) {
      const key = String(v); if (seen.has(key)) continue; seen.add(key);
      const st = ctx.lookup(v); if (!st || !st.dict) continue;
      const sub = String(st.dict.get(ieN('Subtype')));
      if (sub === '/Image') { bytes += (st.contents && st.contents.length) || 0; px += (ieNum(st.dict.lookup(ieN('Width'))) * ieNum(st.dict.lookup(ieN('Height')))) || 0; }
      else if (sub === '/Form') { let r = null; try { r = st.dict.lookupMaybe(ieN('Resources'), PDFLib.PDFDict); } catch (e) {} walk(r, depth + 1); }
    }
  };
  try { walk(node.Resources(), 0); } catch (e) {}
  return { bytes, px };
}
async function iePageApply(picks) {
  showLoading(`📄 ${picks.length}쪽을 업스케일한 그림으로 바꾸는 중…`);
  try {
    const src = await getSourceDoc(), ctx = src.context;
    const base = originalPdfBytes, prevLen = base.length;
    let next = ieOrigSize(base, src);
    const objs = [], touched = [], checks = [], stat = { b0: 0, p0: 0, b1: 0, p1: 0 };
    for (let i = 0; i < picks.length; i++) {
      const S = picks[i], pi = S.pageUp.pageIdx;
      if (typeof contentEdits !== 'undefined' && contentEdits.has(pi)) throw new Error(`${S.name} — 그사이 편집된 쪽입니다. 창을 다시 열어 주세요`);
      const page = src.getPage(pi), node = page.node;
      const was = iePageImgStat(ctx, node); stat.b0 += was.bytes; stat.p0 += was.px;
      const img = await iePageImage(ctx, S);
      stat.b1 += img.contents.length; stat.p1 += S.up.w * S.up.h;
      const imgRef = PDFLib.PDFRef.of(next++), cRef = PDFLib.PDFRef.of(next++);
      const [x0, y0, x1, y1] = S.pageUp.view;
      const ops = `q ${(x1 - x0).toFixed(4)} 0 0 ${(y1 - y0).toFixed(4)} ${x0.toFixed(4)} ${y0.toFixed(4)} cm /PgUp0 Do Q`;
      const content = ctx.flateStream(ops);
      const nd = node.clone(ctx);
      nd.set(ieN('Contents'), cRef);
      nd.set(ieN('Resources'), ctx.obj({ XObject: { PgUp0: imgRef } }));
      nd.delete(ieN('Group'));   // 투명도 그룹은 이제 필요 없다(그림 한 장)
      objs.push({ ref: imgRef, obj: img }, { ref: cRef, obj: content }, { ref: page.ref, obj: nd });
      checks.push({ pi, cRef });
      touched.push(pi);
      updateProgress(Math.round((i + 1) / picks.length * 50));
      await uiYield();
    }
    const newBytes = ieAppendUpdate(base, src, objs);
    // 확인 — 다시 읽어 쪽이 새 내용을 가리키는지
    const chk = await PDFLib.PDFDocument.load(newBytes.slice(0), { ignoreEncryption: true, updateMetadata: false });
    for (const { pi, cRef } of checks) {
      const c = chk.getPage(pi).node.get(ieN('Contents'));
      if (!(c instanceof PDFLib.PDFRef) || c.objectNumber !== cRef.objectNumber) throw new Error(`${pi + 1}쪽을 다시 읽지 못했습니다`);
    }
    updateProgress(60);
    if (typeof loadingMsg !== 'undefined') loadingMsg.textContent = '📄 썸네일·결과 다시 그리는 중…';
    await ieCommitOriginal(newBytes, touched);
    const tab = tabs.get(activeTabId);
    if (tab) (tab.ieUndo || (tab.ieUndo = [])).push({ len: prevLen, recs: new Map(), n: picks.length, touched, kind: 'page' });
    if (tab) tab.ieUpscaled = true;   // 저장 이름 '_이미지-Up'
    hideLoading();
    const shown = iePagesLabel(touched.map(pageIdx => ({ pageIdx })));
    const dpis = picks.map(S => Math.round(S.up.w / ((S.pageUp.view[2] - S.pageUp.view[0]) / 72)));
    showSuccess(`📄 쪽 ${picks.length}개를 업스케일한 그림으로 바꿨습니다 — ${shown} · ${Math.min(...dpis)}${Math.max(...dpis) !== Math.min(...dpis) ? '~' + Math.max(...dpis) : ''}dpi`
      + `\n그림 화소 ${(stat.p0 / 1e6).toFixed(1)}MP → ${(stat.p1 / 1e6).toFixed(1)}MP(${stat.p0 ? (stat.p1 / stat.p0).toFixed(1) : '-'}배) · 그림 용량 ${(stat.b0 / 1048576).toFixed(1)}MB → ${(stat.b1 / 1048576).toFixed(1)}MB`
      + (stat.b1 < stat.b0 ? ` — 화소는 늘었지만 ${picks.every(S => S.gray) ? '흑백 쪽을 먹 1도 JPEG로' : 'JPEG로'} 담아 용량은 줄 수 있습니다(원래 그림이 무손실·컬러였던 경우)` : '')
      + `\n썸네일·결과에 반영됐습니다 → 🔍 크게 보기로 확인하고 '✔ 적용'·'⇩ 다운로드'로 저장하세요. 원본 PDF 파일은 그대로이고, 다운로드 이름은 '_이미지-Up'이 붙은 사본입니다.`
      + `\n되돌리려면 🖼 이미지 업스케일·벡터화 → '↺ 되돌리기'.`);
    return true;
  } catch (e) {
    hideLoading();
    showError('쪽 바꿔 넣기 실패 — 아무것도 바꾸지 않았습니다: ' + ((e && e.message) || e));
    return false;
  }
}

// 쪽 편집본(이미 구운 쪽) 안의 같은 그림도 바꾼다 — 내용 지문(fp)으로 찾아 그 자리(ctx.assign)에. 바뀌었으면 새 바이트
async function iePatchRecordBytes(bytes, repByFp) {
  if (!bytes) return null;
  const doc = await PDFLib.PDFDocument.load(bytes.slice ? bytes.slice(0) : bytes, { ignoreEncryption: true, updateMetadata: false });
  let n = 0;
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFLib.PDFRawStream) || String(obj.dict.get(ieN('Subtype'))) !== '/Image') continue;
    const rep = repByFp.get(ieFnv(obj.contents));
    if (!rep) continue;
    doc.context.assign(ref, ieRepObj(doc.context, obj.dict, rep)); n++;
  }
  return n ? new Uint8Array(await savePdfDoc(doc)) : null;
}
// 원본 바이트를 바꾼 뒤 화면·캐시 — 목차 쪽 넣기와 같은 순서
async function ieCommitOriginal(newBytes, touchedIdx) {
  const newPdf = await openPdfDoc({ data: newBytes.slice(0) }).promise;   // 열리지 않으면 여기서 예외 → 아무것도 바꾸지 않는다
  originalPdfBytes = newBytes;
  const tab = tabs.get(activeTabId);
  if (tab) { tab.originalPdfBytes = newBytes; tab.fileSize = newBytes.byteLength; }
  try { if (globalPdfDoc) globalPdfDoc.destroy(); } catch (e) {}
  globalPdfDoc = newPdf;
  if (tab) tab.pdfDoc = newPdf;
  clearProcessCaches();
  await regenEditedThumbs([...new Set(touchedIdx)]);
  setDirty(true);
  refreshResults();
  updateDownloadBtn();
  if (previewVisible() || shouldPreview()) scheduleLivePreview(); else invalidateProcessed();
}
async function iePdfApply(picks) {
  showLoading(`📄 그림 ${picks.length}개를 PDF에 바꿔 넣는 중…`);
  try {
    const src = await getSourceDoc();
    const objs = [], repByFp = new Map(), touched = new Set();
    let nUp = 0, nVec = 0;
    for (let i = 0; i < picks.length; i++) {
      const S = picks[i], f = S.pdf;
      const rep = await iePdfRep(S);
      for (const ref of (f.refs || [f.ref])) {   // 같은 내용의 그림 객체 모두
        const cur = src.context.lookup(ref);
        if (!cur || !cur.dict || ieFnv(cur.contents) !== ieFnv(f.st.contents)) throw new Error('원본이 그사이 바뀌었습니다 — 창을 다시 열어 주세요');
        objs.push({ ref, obj: ieRepObj(src.context, cur.dict, rep) });
      }
      repByFp.set(ieFnv(f.st.contents), rep);
      f.places.forEach(p => touched.add(p.pageIdx));
      if (rep.kind === 'vec') nVec++; else nUp++;
      updateProgress(Math.round((i + 1) / picks.length * 50));
      await uiYield();
    }
    const base = originalPdfBytes, prevLen = base.length;
    const newBytes = ieAppendUpdate(base, src, objs);
    // 확인 — pdf-lib로 다시 읽어 바꾼 객체가 새 것인지
    const chk = await PDFLib.PDFDocument.load(newBytes.slice(0), { ignoreEncryption: true, updateMetadata: false });
    for (const { ref, obj } of objs) {
      const o = chk.context.lookup(ref);
      if (!o || !o.contents || o.contents.length !== obj.contents.length) throw new Error('바꿔 넣은 그림을 다시 읽지 못했습니다 (객체 ' + ref + ')');
    }
    updateProgress(60);
    // 이미 구운 쪽 편집본도
    const recUndo = new Map();
    for (const [idx, rec] of [...contentEdits.entries()]) {
      if (!rec || !rec.bytes) continue;
      const nb = await iePatchRecordBytes(rec.bytes, repByFp);
      let np;
      if (rec.scanPrev && rec.scanPrev.bytes) { const pb = await iePatchRecordBytes(rec.scanPrev.bytes, repByFp); if (pb) np = Object.assign({}, rec.scanPrev, { bytes: pb }); }
      if (nb || np) {
        recUndo.set(idx, rec);
        contentEdits.set(idx, Object.assign({}, rec, nb ? { bytes: nb } : {}, np ? { scanPrev: np } : {}, { rev: (rec.rev || 0) + 1 }));
        touched.add(idx);
      }
    }
    updateProgress(75);
    if (typeof loadingMsg !== 'undefined') loadingMsg.textContent = '📄 썸네일·결과 다시 그리는 중…';
    try { await ieCommitOriginal(newBytes, [...touched]); }
    catch (e) { recUndo.forEach((rec, idx) => contentEdits.set(idx, rec)); throw e; }
    const tab = tabs.get(activeTabId);
    if (tab) (tab.ieUndo || (tab.ieUndo = [])).push({ len: prevLen, recs: recUndo, n: picks.length, touched: [...touched] });
    if (tab) tab.ieUpscaled = true;   // 저장 이름 '_이미지-Up'
    hideLoading();
    const shown = iePagesLabel([...touched].map(pageIdx => ({ pageIdx })));
    showSuccess(`📄 그림 ${picks.length}개를 바꿔 넣었습니다${nUp && nVec ? ` (업스케일 ${nUp} · 벡터 ${nVec})` : nVec ? ' (벡터)' : ' (업스케일)'} — ${shown}\n썸네일·결과에 반영됐습니다 → '✔ 적용'·'⇩ 다운로드'로 저장하세요. 원본 PDF 파일 자체는 바뀌지 않습니다(💼 작업 저장에는 들어감).\n되돌리려면 🖼 이미지 업스케일·벡터화 → '↺ PDF 그림 바꿔 넣기 되돌리기'.`);
    return true;
  } catch (e) {
    hideLoading();
    showError('PDF에 바꿔 넣기 실패 — 아무것도 바꾸지 않았습니다: ' + ((e && e.message) || e));
    return false;
  }
}
function iePdfUndoKind() {
  try { const t = tabs.get(activeTabId); const u = t && t.ieUndo; return u && u.length ? u[u.length - 1].kind || 'img' : ''; } catch (e) { return ''; }
}
function iePdfUndoCount() {
  try { const t = tabs.get(activeTabId); const u = t && t.ieUndo; return u && u.length && originalPdfBytes ? u[u.length - 1].n : 0; } catch (e) { return 0; }
}
async function iePdfUndo() {
  const tab = tabs.get(activeTabId), u = tab && tab.ieUndo && tab.ieUndo[tab.ieUndo.length - 1];
  if (!u) return;
  if (!originalPdfBytes || originalPdfBytes.length < u.len) { tab.ieUndo = []; showError('되돌릴 수 없습니다 — 그사이 문서가 바뀌었습니다.'); return; }
  showLoading('↺ 그림 바꿔 넣기를 되돌리는 중…');
  try {
    const touched = new Set(u.touched || []);
    const now = new Map();
    u.recs.forEach((rec, idx) => { now.set(idx, contentEdits.get(idx)); contentEdits.set(idx, Object.assign({}, rec, { rev: ((contentEdits.get(idx) || {}).rev || 0) + 1 })); touched.add(idx); });
    try { await ieCommitOriginal(originalPdfBytes.slice(0, u.len), [...touched]); }
    catch (e) { now.forEach((rec, idx) => { if (rec) contentEdits.set(idx, rec); }); throw e; }
    tab.ieUndo.pop();
    if (!tab.ieUndo.length && !tab.ieUpFromFile) tab.ieUpscaled = false;   // 모두 되돌리면 이름도 원래대로(작업 파일에서 이어받은 표시는 유지)
    hideLoading();
    showSuccess(`↺ ${u.kind === 'typo' ? `오타 고치기 ${u.n}곳` : u.kind === 'page' ? `쪽 업스케일 ${u.n}쪽` : `그림 ${u.n}개`}을 원래대로 되돌렸습니다.`);
  } catch (e) { hideLoading(); showError('되돌리기 실패: ' + ((e && e.message) || e)); }
}

// ══ ✏ 오타 고치기 (2026-10-30 사용자 요청) ══
//   그림이 된 쪽(스캔·업스케일)의 틀린 글자를 고친다: 틀린 낱말을 사각형으로 끌면 그 자리의 종이 색(둘레 띠의 밝은 쪽 중앙값)·
//   글자 색(진한 점)·글자 높이를 재서, 바른 글자를 같은 해상도의 그림 조각(종이 색 바탕 + 글자)으로 덮는다.
//   저장 = 원본 바이트 끝에 증분 저장(쪽 사전 사본: Contents = [q, 원래 내용…, Q + 조각들], Resources = 사본 + 조각 그림) — 되돌리기는 업스케일과 같은 tab.ieUndo(kind 'typo').
//   좌표: 조각은 '보이는 쪽'(pdf.js 뷰포트, /Rotate·CropBox 반영) pt로 들고, 저장할 때 뷰포트 변환의 역으로 쪽 좌표에 앉힌다.
//   쪽 편집본(contentEdits)이 있는 쪽은 뺀다 — 편집본이 옛 쪽을 들고 있다(업스케일과 같은 규칙).
const TY_FONTS = [
  { v: 'Batang, 바탕, serif', label: '바탕 (명조)' }, { v: '"Noto Serif KR", "Nanum Myeongjo", 나눔명조, Batang, serif', label: '나눔명조·본명조' },
  { v: 'Dotum, 돋움, sans-serif', label: '돋움' }, { v: 'Gulim, 굴림, sans-serif', label: '굴림' },
  { v: '"Malgun Gothic", "맑은 고딕", sans-serif', label: '맑은 고딕' }, { v: '"Nanum Gothic", 나눔고딕, sans-serif', label: '나눔고딕' },
  { v: 'Gungsuh, 궁서, serif', label: '궁서' }, { v: '"Times New Roman", serif', label: 'Times (영문)' }, { v: 'Arial, sans-serif', label: 'Arial (영문)' },
];
const tyMulRV = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3], A[4] * B[0] + A[5] * B[2] + B[4], A[4] * B[1] + A[5] * B[3] + B[5]];   // 행 벡터: A 다음 B
const tyInv = m => { const det = m[0] * m[3] - m[1] * m[2]; return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det]; };
const tyLum = (r, g, b) => (r * 77 + g * 150 + b * 29) >> 8;
const tyHex = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const tyRgb = h => [1, 3, 5].map(i => parseInt(String(h).slice(i, i + 2), 16) || 0);
const tyEsc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// 사각형(그림 px) 둘레·안쪽을 재서 바탕색·글자색·글자 상자 — img: ImageData(보기 그림), r: {x,y,w,h} px
function tyMeasure(img, r) {
  const W = img.width, H = img.height, d = img.data;
  const at = (x, y) => { const o = (y * W + x) * 4; return [d[o], d[o + 1], d[o + 2]]; };
  const x0 = Math.max(0, Math.round(r.x)), y0 = Math.max(0, Math.round(r.y)), x1 = Math.min(W - 1, Math.round(r.x + r.w)), y1 = Math.min(H - 1, Math.round(r.y + r.h));
  // 바탕: 사각형 바깥 4px 띠 + 안쪽(듬성듬성) — 밝은 쪽 절반의 중앙값(글자 점이 섞여도)
  const ring = [];
  for (let y = Math.max(0, y0 - 4); y <= Math.min(H - 1, y1 + 4); y++) for (let x = Math.max(0, x0 - 4); x <= Math.min(W - 1, x1 + 4); x++) {
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - x0) % 3) continue;
    ring.push(at(x, y));
  }
  ring.sort((a, b) => tyLum(...a) - tyLum(...b));
  const bright = ring.slice(Math.floor(ring.length * 0.5));
  const med = k => { const v = bright.map(c => c[k]).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : 255; };
  const bg = [med(0), med(1), med(2)], bgL = tyLum(...bg);
  // 글자: 바탕보다 충분히 어두운 점
  const thr = bgL - Math.max(35, bgL * 0.25);
  let n = 0, ix0 = 1e9, iy0 = 1e9, ix1 = -1, iy1 = -1; const ink = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const c = at(x, y); if (tyLum(...c) >= thr) continue;
    n++; ink.push(c); if (x < ix0) ix0 = x; if (x > ix1) ix1 = x; if (y < iy0) iy0 = y; if (y > iy1) iy1 = y;
  }
  let fg = [25, 25, 25], box = null, dense = 0;
  if (n > 6) {
    ink.sort((a, b) => tyLum(...a) - tyLum(...b));
    const dark = ink.slice(0, Math.max(1, Math.floor(ink.length * 0.3)));
    fg = [0, 1, 2].map(k => { const v = dark.map(c => c[k]).sort((a, b) => a - b); return v[v.length >> 1]; });
    box = { x: ix0, y: iy0, w: ix1 - ix0 + 1, h: iy1 - iy0 + 1 };
    dense = n / Math.max(1, box.w * box.h);
  }
  return { bg, fg, box, dense };
}

// 조각 그림 — dpi로(보기·저장 공용). 바탕 칠 + 글자(넘치면 가로로 줄임). p: 보이는 쪽 pt 단위
function tyRenderPatch(p, dpi, gray) {
  const k = dpi / 72, w = Math.max(1, Math.round(p.w * k)), h = Math.max(1, Math.round(p.h * k));
  const c = ieCanvas(w, h), x = c.getContext('2d');
  const bg = gray ? Array(3).fill(tyLum(...p.bg)) : p.bg, fg = gray ? Array(3).fill(tyLum(...p.fg)) : p.fg;
  x.fillStyle = tyHex(bg); x.fillRect(0, 0, w, h);
  if (p.text) {
    x.font = `${p.bold ? 700 : 400} ${p.size * k}px ${p.font}`;
    x.textBaseline = 'alphabetic';
    const m = x.measureText(p.text);
    const asc = m.actualBoundingBoxAscent, des = m.actualBoundingBoxDescent, lft = m.actualBoundingBoxLeft, inkW = lft + m.actualBoundingBoxRight;
    const availW = (p.inkW || Math.max(1, p.w - 1.2)) * k;
    const sx = p.fitW && inkW > availW ? Math.max(0.55, availW / inkW) : 1;
    const cx = ((p.inkX != null ? p.inkX : 0.6) + p.dx) * k, cy = ((p.inkCy != null ? p.inkCy : p.h / 2) + p.dy) * k;
    x.save(); x.translate(cx, 0); x.scale(sx, 1);
    if (p.soft) x.filter = `blur(${Math.max(0.3, k * 0.12).toFixed(2)}px)`;
    x.fillStyle = tyHex(fg);
    x.fillText(p.text, lft, cy - (des - asc) / 2);
    x.restore();
  }
  return c;
}

async function openTypoFix(displayIdx) {
  if (!originalPdfBytes || !globalPdfDoc) { showError('먼저 PDF를 여세요.'); return; }
  const rr = pageResults[displayIdx];
  if (!rr || rr.isBlank || rr.originalIdx == null) { showError('오타를 고칠 쪽을 우클릭해 주세요 (빈 쪽은 안 됩니다).'); return; }
  const oi = rr.originalIdx;
  if (typeof contentEdits !== 'undefined' && contentEdits.has(oi)) {
    showError('이 쪽은 이미 편집(내부 편집·스캔 정리·K100)한 쪽이라 오타 고치기를 쓸 수 없습니다 — 🖊 내부 편집기에서 사각형(R)·텍스트(T)로 고치세요.\n(오타 고치기를 먼저 하고 나서 정리·K100을 하면 됩니다)');
    return;
  }
  showLoading('✏ 쪽을 그리는 중…');
  let page, VDPI, gray, cv, img, pdpi = 300;
  try {
    // 조각 해상도 = 쪽 그림의 해상도(업스케일한 쪽이면 300) — 그림이 없으면 300
    try {
      const src = await getSourceDoc(); const f = iePdfFind(src, [oi], null, { all: true });
      let best = 0; for (const g of f.found.values()) for (const p of g.places) best = Math.max(best, p.dpi);
      if (best > 0) pdpi = Math.max(150, Math.min(600, Math.round(best)));
    } catch (e) {}
    page = await globalPdfDoc.getPage(oi + 1);
    VDPI = Math.min(220, pdpi);
    const vp = page.getViewport({ scale: VDPI / 72 });
    cv = ieCanvas(Math.round(vp.width), Math.round(vp.height));
    const x = cv.getContext('2d', { willReadFrequently: true }); x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height);
    const params = { canvasContext: x, viewport: vp };
    if (typeof renderPageNoSeams === 'function') await renderPageNoSeams(page, params); else await page.render(params).promise;
    img = x.getImageData(0, 0, cv.width, cv.height);
    gray = !rr.isColor;
  } catch (e) { hideLoading(); showError('쪽 그리기 실패: ' + ((e && e.message) || e)); return; }
  hideLoading();
  const K = VDPI / 72;                                   // 보기 그림 px / pt
  const T1 = page.getViewport({ scale: 1 }).transform;   // 쪽 좌표 → 보이는 쪽 pt(왼쪽 위 원점)
  const fontPref = ieLs('tyFont', TY_FONTS[0].v);
  const soft0 = ieLs('tySoft', '1') !== '0';
  const patches = []; let sel = -1;

  const ov = document.createElement('div');
  ov.className = 'merge-overlay';
  ov.innerHTML = '<div class="merge-modal rbv-modal rbv-full ty-modal">'
    + `<div class="rbv-titlebar"><h3 class="merge-title"><span class="ic">✏</span> 오타 고치기 — ${rr.pageNum}쪽</h3></div>`
    + '<p class="merge-sub">틀린 글자를 <b>끌어서 사각형으로</b> 고르세요 → 오른쪽에 바른 글자를 입력합니다. 종이 색·글자 색·크기는 자동으로 맞추고, 바꿔서 다듬을 수 있습니다.</p>'
    + '<div class="rbv-body"><div class="ty-viewwrap" id="tyWrap"><div class="ty-stage" id="tyStage"></div></div>'
    + '<div class="ty-side"><div class="ty-list" id="tyList"></div><div class="ty-form" id="tyForm"></div></div></div>'
    + '<p class="split-dim rb-note">휠 = 확대·축소 · 가운데 단추 또는 Space+끌기 = 이동 · 조각 클릭 = 고르기 · Delete = 고른 조각 지우기 · 화살표 = 글자 위치 0.1pt(Shift 1pt) · 새 글자는 쪽과 같은 해상도(' + pdpi + 'dpi) 그림으로 들어갑니다' + (gray ? ' · 흑백 쪽이라 먹 1도' : '') + '</p>'
    + '<div class="merge-actions"><span class="split-dim" id="tyInfo"></span><button class="merge-cancel" id="tyCancel">취소</button><button class="merge-confirm" id="tySave" title="고친 글자를 쪽에 넣습니다 — 원본 파일은 그대로 · 되돌리기 가능">✔ 저장</button></div></div>';
  document.body.appendChild(ov);
  const $ = id => ov.querySelector('#' + id);
  if (typeof decolorEmojiIn === 'function') { try { decolorEmojiIn(ov); } catch (e) {} }
  const stage = $('tyStage'), wrap = $('tyWrap');
  cv.className = 'ty-base'; stage.appendChild(cv);
  const lay = ieCanvas(cv.width, cv.height); lay.className = 'ty-lay'; stage.appendChild(lay);
  const lx = lay.getContext('2d');
  let zoom = 1, fitZ = 1, drag = null, space = false;
  const applyZoom = () => { stage.style.width = (cv.width * zoom) + 'px'; stage.style.height = (cv.height * zoom) + 'px'; };
  const fit = () => { fitZ = Math.max(0.05, Math.min((wrap.clientWidth - 20) / cv.width, (wrap.clientHeight - 20) / cv.height)); zoom = fitZ; applyZoom(); };
  requestAnimationFrame(fit);

  function drawLay() {
    lx.clearRect(0, 0, lay.width, lay.height);
    const lw = Math.max(1, 1.5 / zoom);
    patches.forEach((p, i) => {
      const c = tyRenderPatch(p, VDPI, gray);
      lx.drawImage(c, p.x * K, p.y * K, c.width, c.height);
      c.width = c.height = 0;
      lx.lineWidth = lw; lx.setLineDash(i === sel ? [] : [4 * lw, 3 * lw]);
      lx.strokeStyle = i === sel ? '#e0a800' : 'rgba(224,168,0,.7)';
      lx.strokeRect(p.x * K - lw, p.y * K - lw, p.w * K + 2 * lw, p.h * K + 2 * lw);
    });
    if (drag && drag.r) { lx.setLineDash([]); lx.strokeStyle = '#e0a800'; lx.lineWidth = lw; lx.strokeRect(drag.r.x, drag.r.y, drag.r.w, drag.r.h); }
    lx.setLineDash([]);
  }
  function addPatch(rpx) {
    const m = tyMeasure(img, rpx);
    const p = { x: rpx.x / K, y: rpx.y / K, w: rpx.w / K, h: rpx.h / K, bg: m.bg, fg: m.fg, autoBg: m.bg, autoFg: m.fg, text: '', font: fontPref, bold: false, dx: 0, dy: 0, fitW: true, soft: soft0, size: 10 };
    if (m.box) {
      p.size = Math.max(4, Math.round(m.box.h / K / 0.78 * 2) / 2);   // 한글 글자 높이 ≈ 글자 크기의 0.78
      p.inkX = (m.box.x - rpx.x) / K; p.inkW = m.box.w / K; p.inkCy = (m.box.y + m.box.h / 2 - rpx.y) / K;
      p.bold = m.dense > 0.42;
    }
    p.autoSize = p.size; p.autoBold = p.bold;
    patches.push(p); sel = patches.length - 1;
    renderList(); renderForm(true); drawLay();
  }
  function renderList() {
    $('tyList').innerHTML = patches.length ? patches.map((p, i) => `<div class="ty-row${i === sel ? ' cur' : ''}" data-i="${i}"><b>${i + 1}</b> ${p.text ? tyEsc(p.text) : '<span class="split-dim">(글자 입력 전)</span>'}</div>`).join('')
      : '<div class="split-dim ty-empty">쪽에서 틀린 글자를 끌어 고르세요.</div>';
    $('tySave').disabled = !patches.some(p => p.text);
    $('tyInfo').textContent = patches.length ? `고친 곳 ${patches.filter(p => p.text).length} / ${patches.length}` : '';
  }
  function renderForm(focus) {
    const p = patches[sel], F = $('tyForm');
    if (!p) { F.innerHTML = ''; return; }
    F.innerHTML = `<label class="ty-f">바른 글자<input class="pt-input" id="tyText" value="${tyEsc(p.text)}" placeholder="여기에 입력"></label>`
      + `<label class="ty-f">글꼴<select class="pt-input" id="tyFont">${TY_FONTS.map((f, i) => `<option value="${i}"${f.v === p.font ? ' selected' : ''}>${tyEsc(f.label)}</option>`).join('')}</select></label>`
      + `<div class="ty-f2"><label class="ty-f">크기 <input type="number" class="pt-input ty-num" id="tySize" min="3" max="200" step="0.5" value="${p.size}"> pt</label><label class="sc-opt"><input type="checkbox" id="tyBold"${p.bold ? ' checked' : ''}> 굵게</label></div>`
      + `<div class="ty-f2"><label class="ty-f">글자색 <input type="color" id="tyFg" value="${tyHex(p.fg)}"></label><label class="ty-f">바탕색 <input type="color" id="tyBg" value="${tyHex(p.bg)}"></label><button class="merge-cancel ty-sm" id="tyAuto" title="색·크기·위치를 자동으로 잰 값으로">↺ 자동</button></div>`
      + `<div class="ty-f2"><label class="sc-opt" title="글자가 칸보다 길면 가로로 줄여 맞춥니다"><input type="checkbox" id="tyFitW"${p.fitW ? ' checked' : ''}> 폭 맞춤</label><label class="sc-opt" title="새 글자 가장자리를 아주 살짝 흐리게 해 스캔 글자와 어울리게"><input type="checkbox" id="tySoft"${p.soft ? ' checked' : ''}> 스캔 느낌</label></div>`
      + `<div class="ty-f2 ty-nudge"><span class="split-dim">위치</span><button class="merge-cancel ty-sm" data-n="-1,0">←</button><button class="merge-cancel ty-sm" data-n="1,0">→</button><button class="merge-cancel ty-sm" data-n="0,-1">↑</button><button class="merge-cancel ty-sm" data-n="0,1">↓</button><span class="split-dim" id="tyD">${p.dx.toFixed(1)}, ${p.dy.toFixed(1)}pt</span></div>`
      + `<button class="merge-cancel ty-del" id="tyDel">🗑 이 조각 지우기</button>`;
    if (typeof decolorEmojiIn === 'function') { try { decolorEmojiIn(F); } catch (e) {} }
    const up = () => { renderList(); drawLay(); };
    $('tyText').oninput = e => { p.text = e.target.value; up(); };
    $('tyFont').onchange = e => { p.font = TY_FONTS[+e.target.value].v; ieLsSet('tyFont', p.font); up(); };
    $('tySize').oninput = e => { const v = parseFloat(e.target.value); if (v > 0) { p.size = v; up(); } };
    $('tyBold').onchange = e => { p.bold = e.target.checked; up(); };
    $('tyFg').oninput = e => { p.fg = tyRgb(e.target.value); up(); };
    $('tyBg').oninput = e => { p.bg = tyRgb(e.target.value); up(); };
    $('tyFitW').onchange = e => { p.fitW = e.target.checked; up(); };
    $('tySoft').onchange = e => { p.soft = e.target.checked; ieLsSet('tySoft', p.soft ? 1 : 0); up(); };
    $('tyAuto').onclick = () => { p.fg = p.autoFg; p.bg = p.autoBg; p.size = p.autoSize; p.bold = p.autoBold; p.dx = p.dy = 0; renderForm(); up(); };
    F.querySelectorAll('[data-n]').forEach(b => b.onclick = () => nudge(...b.dataset.n.split(',').map(Number), 1));
    $('tyDel').onclick = delSel;
    if (focus) setTimeout(() => { const t = $('tyText'); if (t) t.focus(); }, 30);
  }
  function nudge(ax, ay, step) { const p = patches[sel]; if (!p) return; p.dx += ax * step; p.dy += ay * step; const d = $('tyD'); if (d) d.textContent = `${p.dx.toFixed(1)}, ${p.dy.toFixed(1)}pt`; drawLay(); }
  function delSel() { if (sel < 0) return; patches.splice(sel, 1); sel = Math.min(sel, patches.length - 1); renderList(); renderForm(); drawLay(); }
  $('tyList').addEventListener('click', e => { const r = e.target.closest('.ty-row'); if (!r) return; sel = +r.dataset.i; renderList(); renderForm(true); drawLay(); });

  // 끌기: 왼쪽 = 사각형(조각 안을 짧게 누르면 그 조각 고르기) · 가운데 단추/Space+왼쪽 = 이동
  const toPx = e => { const b = lay.getBoundingClientRect(); return { x: (e.clientX - b.left) / b.width * lay.width, y: (e.clientY - b.top) / b.height * lay.height }; };
  wrap.addEventListener('mousedown', e => {
    if (e.button === 1 || (e.button === 0 && space)) {
      e.preventDefault(); const sx = wrap.scrollLeft, sy = wrap.scrollTop, x0 = e.clientX, y0 = e.clientY;
      const mv = ev => { wrap.scrollLeft = sx - (ev.clientX - x0); wrap.scrollTop = sy - (ev.clientY - y0); };
      const upf = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', upf); };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', upf); return;
    }
    if (e.button !== 0 || !e.target.closest('.ty-stage')) return;
    e.preventDefault();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    const p0 = toPx(e);
    const hit = patches.findIndex(p => p0.x >= p.x * K && p0.x <= (p.x + p.w) * K && p0.y >= p.y * K && p0.y <= (p.y + p.h) * K);
    drag = { p0, r: null, hit };
    const mv = ev => { const p1 = toPx(ev); drag.r = { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), w: Math.abs(p1.x - p0.x), h: Math.abs(p1.y - p0.y) }; drawLay(); };
    const upf = () => {
      window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', upf);
      const d = drag; drag = null;
      if (d.r && d.r.w > 4 && d.r.h > 4) addPatch(d.r);
      else if (d.hit >= 0) { sel = d.hit; renderList(); renderForm(true); drawLay(); }
      else drawLay();
    };
    window.addEventListener('mousemove', mv); window.addEventListener('mouseup', upf);
  });
  wrap.addEventListener('wheel', e => {
    e.preventDefault();
    const b = stage.getBoundingClientRect(), ux = (e.clientX - b.left) / zoom, uy = (e.clientY - b.top) / zoom;
    zoom = Math.max(fitZ * 0.5, Math.min(8, zoom * Math.pow(1.0015, -e.deltaY)));
    applyZoom();
    const b2 = stage.getBoundingClientRect();
    wrap.scrollLeft += (b2.left + ux * zoom) - e.clientX;
    wrap.scrollTop += (b2.top + uy * zoom) - e.clientY;
    drawLay();
  }, { passive: false });

  const close = () => { document.removeEventListener('keydown', onKey, true); document.removeEventListener('keyup', onKeyUp, true); window.removeEventListener('resize', fit); ov.remove(); cv.width = cv.height = 0; lay.width = lay.height = 0; };
  const askClose = () => { if (!patches.some(p => p.text) || confirm('고친 내용을 버리고 닫을까요?')) close(); };
  const typing = e => e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'checkbox';
  const onKey = e => {
    if (document.querySelector('.pt-box')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); askClose(); return; }
    if (typing(e)) { if (e.key === 'Enter' && e.target.id === 'tyText') { e.preventDefault(); e.target.blur(); } e.stopPropagation(); return; }
    if (e.code === 'Space') { e.preventDefault(); e.stopPropagation(); space = true; wrap.classList.add('ty-pan'); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); delSel(); return; }
    const ar = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (ar) { e.preventDefault(); e.stopPropagation(); nudge(ar[0], ar[1], e.shiftKey ? 1 : 0.1); return; }
    e.stopPropagation();   // 창이 떠 있는 동안 앱 단축키(쪽 지우기·회전 등)가 뒤에서 돌지 않게
  };
  const onKeyUp = e => { if (e.code === 'Space') { space = false; wrap.classList.remove('ty-pan'); } };
  document.addEventListener('keydown', onKey, true); document.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('resize', fit);
  $('tyCancel').onclick = askClose;
  $('tySave').onclick = async () => {
    const use = patches.filter(p => p.text);
    if (!use.length) return;
    const ok = await tyApply(oi, use, T1, pdpi, gray, rr.pageNum);
    if (ok) close();
  };
  ov.__tyTest = { addPatch, patches, K, get sel() { return sel; }, renderForm, drawLay, img };   // 검사용
  renderList(); drawLay();
}

async function tyApply(oi, patches, T1, dpi, gray, pageNum) {
  showLoading(`✏ ${patches.length}곳을 쪽에 넣는 중…`);
  try {
    if (typeof contentEdits !== 'undefined' && contentEdits.has(oi)) throw new Error('그사이 편집된 쪽입니다 — 창을 다시 열어 주세요');
    const src = await getSourceDoc(), ctx = src.context;
    const base = originalPdfBytes, prevLen = base.length;
    let next = ieOrigSize(base, src);
    const page = src.getPage(oi), node = page.node;
    const inv = tyInv(T1);
    const objs = [];
    let ops = 'Q\n';
    const res0 = node.Resources();
    const res2 = res0 ? res0.clone(ctx) : ctx.obj({});
    const xo0 = res2.lookupMaybe(ieN('XObject'), PDFLib.PDFDict);
    const xo2 = xo0 ? xo0.clone(ctx) : ctx.obj({});
    let k = 0;
    for (const p of patches) {
      const c = tyRenderPatch(p, dpi, gray), w = c.width, h = c.height;
      const px = c.getContext('2d').getImageData(0, 0, w, h).data; c.width = c.height = 0;
      const raw = new Uint8Array(w * h * (gray ? 1 : 3));
      for (let i = 0, j = 0; j < px.length; j += 4) { if (gray) raw[i++] = tyLum(px[j], px[j + 1], px[j + 2]); else { raw[i++] = px[j]; raw[i++] = px[j + 1]; raw[i++] = px[j + 2]; } }
      const ref = PDFLib.PDFRef.of(next++);
      objs.push({ ref, obj: PDFLib.PDFRawStream.of(ctx.obj({ Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: gray ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' }), pako.deflate(raw)) });
      let nm; do { nm = 'TyP' + (k++); } while (xo2.get(ieN(nm)));
      xo2.set(ieN(nm), ref);
      const M = tyMulRV([p.w, 0, 0, -p.h, p.x, p.y + p.h], inv);   // 그림 단위 정사각형 → 보이는 쪽 pt → 쪽 좌표
      ops += `q ${M.map(v => (+v.toFixed(5))).join(' ')} cm /${nm} Do Q\n`;
    }
    res2.set(ieN('XObject'), xo2);
    const qRef = PDFLib.PDFRef.of(next++), pRef = PDFLib.PDFRef.of(next++);
    objs.push({ ref: qRef, obj: ctx.flateStream('q\n') }, { ref: pRef, obj: ctx.flateStream(ops) });
    const c0 = node.get(ieN('Contents'));
    const old = !c0 ? [] : c0 instanceof PDFLib.PDFArray ? c0.asArray() : [c0];
    if (old.some(v => !(v instanceof PDFLib.PDFRef))) throw new Error('이 쪽의 내용 구조는 고칠 수 없습니다');
    const nd = node.clone(ctx);
    nd.set(ieN('Contents'), ctx.obj([qRef, ...old, pRef]));
    nd.set(ieN('Resources'), res2);
    objs.push({ ref: page.ref, obj: nd });
    const newBytes = ieAppendUpdate(base, src, objs);
    const chk = await PDFLib.PDFDocument.load(newBytes.slice(0), { ignoreEncryption: true, updateMetadata: false });
    const cc = chk.getPage(oi).node.get(ieN('Contents'));
    if (!(cc instanceof PDFLib.PDFArray) || cc.size() !== old.length + 2) throw new Error('고친 쪽을 다시 읽지 못했습니다');
    await ieCommitOriginal(newBytes, [oi]);
    const tab = tabs.get(activeTabId);
    if (tab) (tab.ieUndo || (tab.ieUndo = [])).push({ len: prevLen, recs: new Map(), n: patches.length, touched: [oi], kind: 'typo' });
    hideLoading();
    showSuccess(`✏ ${pageNum}쪽 오타 ${patches.length}곳을 고쳤습니다 (${dpi}dpi 그림 조각).\n🔍 크게 보기로 확인하고 '✔ 적용'·'⇩ 다운로드'로 저장하세요. 원본 PDF 파일은 그대로입니다.\n되돌리려면 🖼 업스케일 → '↺ 마지막 바꿔 넣기 되돌리기'.`);
    return true;
  } catch (e) {
    hideLoading();
    showError('오타 고치기 저장 실패 — 아무것도 바꾸지 않았습니다: ' + ((e && e.message) || e));
    return false;
  }
}
function ctxTypoFix() { const idx = ctxTargetIdx; hideCtxMenu(); openTypoFix(idx); }
