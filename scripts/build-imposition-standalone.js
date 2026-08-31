// 임포징 기능만 담은 독립 실행 HTML 생성기 (배포용)
// src/app-process.js의 실제 임포징 빌더 함수를 추출해 pdf-lib와 함께 단일 HTML로 묶는다.
// 사용: node scripts/build-imposition-standalone.js  → dist/임포징도구.html
// (빌더가 바뀌면 다시 실행해 재생성 — 코드 드리프트 방지)
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const appSrc = fs.readFileSync(path.join(ROOT, 'src/app-process.js'), 'utf8');
const pdflib = fs.readFileSync(path.join(ROOT, 'src/libs/pdf-lib.min.js'), 'utf8');
// 원본 미리보기(썸네일·본문)를 그리려면 pdf.js가 필요하다 — 워커는 스크립트 블록에 담아
// blob URL로 띄운다(파일이 하나뿐이라 외부 파일을 못 읽으므로).
const pdfjs = fs.readFileSync(path.join(ROOT, 'src/libs/pdf.min.js'), 'utf8');
const pdfWorker = fs.readFileSync(path.join(ROOT, 'src/libs/pdf.worker.min.js'), 'utf8');
if (pdfWorker.includes('</scr' + 'ipt>')) throw new Error('워커 소스에 </script>가 있어 인라인 불가');

// ── app-process.js에서 함수/상수 추출 (이름 → 소스 텍스트) ──
function exFn(name) {
  let s = appSrc.indexOf('async function ' + name);
  if (s < 0) s = appSrc.indexOf('function ' + name);
  if (s < 0) throw new Error('함수 없음: ' + name);
  const e = appSrc.indexOf('\n    }', s) + 6;
  return appSrc.slice(s, e).replace(/^\s{4}/gm, '');   // 4칸 들여쓰기 제거
}
function exConst(name) {
  const s = appSrc.indexOf('const ' + name);
  if (s < 0) throw new Error('상수 없음: ' + name);
  return appSrc.slice(s, appSrc.indexOf('\n', s)).trim();
}

const BUILDERS = [
  // 빌더가 부르는 헬퍼까지 전부 — 하나라도 빠지면 브라우저에서 '함수 없음'으로 죽는다
  'uiYield', 'ensurePageContents', 'pageTrimInset',
  'embedAllPages', 'placeInSlot', 'drawPlaced', 'impMargins', 'impGaps', 'drawFrame',
  'prepSlug', 'drawSlug', 'drawStackNum', 'trimSizeMm',
  'drawCropMarks', 'drawTrimMarks', 'drawCutDims',
  'bookletSheetOrder', 'cutStackOrder', 'dup2upOrder',
  'buildBookletBytes', 'buildNupBytes', 'buildStepRepeatBytes', 'buildDup2upBytes',
].map(exFn).join('\n\n');

const IMP_PAPERS = exConst('IMP_PAPERS');
const SEED = exConst('IMP_PROFILE_SEED');   // 71종 프로파일 시드

// 추출한 함수들이 참조하는 앱 전역 몇 개 — 여기서만 쓰는 최소 선언
const GLOBALS = `
let _yieldAt = 0;              // uiYield의 마지막 양보 시각
`;

const core = `
${GLOBALS}
${IMP_PAPERS}
${SEED}
${BUILDERS}
`;

const ui = String.raw`
const $ = id => document.getElementById(id);
const MM = 72 / 25.4;
let srcBytes = null, srcName = '문서', lastBytes = null, lastUrl = null;
let lastCover = null, lastInner = null;   // 중철 표지 분리 결과
let _genCache = { sig: null, res: null };  // 같은 설정 재생성 방지(반복 클릭에서 즉시)

// ── pdf.js 워커 (인라인 소스 → blob) ──
try {
  const wsrc = document.getElementById('pdfWorkerSrc').textContent;
  pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([wsrc], { type: 'application/javascript' }));
} catch (e) { console.error('pdf.js 워커 준비 실패:', e); }

// ── 파일 읽기 (선택 · 드래그&드롭 공용) ──
let srcDoc = null;      // pdf.js 문서 (원본 미리보기용)
let curPage = 1;
async function loadFile(f) {
  if (!f) return;
  if (!/\.pdf$/i.test(f.name)) { setStatus('PDF 파일만 열 수 있습니다.', true); return; }
  srcName = f.name.replace(/\.pdf$/i, '');
  srcBytes = new Uint8Array(await f.arrayBuffer());
  $('fname').textContent = f.name;
  lastBytes = null; $('dlBtn').disabled = true; _genCache = { sig: null, res: null };
  setStatus('PDF 로드됨 — 방식을 고르고 [임포징 생성]을 누르세요.');
  await showSource();
}
$('file').addEventListener('change', e => loadFile(e.target.files[0]));

// 창 어디에 떨어뜨려도 열린다
const dropZone = document.body;
['dragenter', 'dragover'].forEach(t => dropZone.addEventListener(t, e => {
  e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; dropZone.classList.add('drop-on');
}));
['dragleave', 'drop'].forEach(t => dropZone.addEventListener(t, e => {
  if (t === 'dragleave' && e.relatedTarget) return;
  dropZone.classList.remove('drop-on');
}));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) loadFile(f);
});

// ── 원본 미리보기 (썸네일 레일 + 본문) ──
async function showSource() {
  const rail = $('rail');
  rail.innerHTML = ''; setView('src');
  try {
    if (srcDoc) { try { await srcDoc.destroy(); } catch (e) {} srcDoc = null; }
    srcDoc = await pdfjsLib.getDocument({ data: srcBytes.slice(0) }).promise;
    const n = srcDoc.numPages;
    const p1 = await srcDoc.getPage(1);
    const v1 = p1.getViewport({ scale: 1 });
    $('pvInfo').textContent = srcName + '.pdf · ' + n + '쪽 · ' +
      Math.round(v1.width / MM) + '×' + Math.round(v1.height / MM) + 'mm';
    curPage = 1;
    await drawPage(1);
    for (let i = 1; i <= n; i++) {
      const c = document.createElement('canvas');
      c.className = 'th' + (i === 1 ? ' cur' : ''); c.dataset.p = i;
      c.onclick = () => drawPage(i);
      const num = document.createElement('div'); num.className = 'thnum'; num.textContent = i;
      rail.appendChild(c); rail.appendChild(num);
    }
    // 썸네일은 본문이 뜬 뒤 천천히 채운다(첫 화면이 빨리 나오게)
    for (let i = 1; i <= n; i++) {
      const c = rail.querySelector('canvas[data-p="' + i + '"]');
      if (!c) continue;
      const pg = await srcDoc.getPage(i);
      const vp = pg.getViewport({ scale: 112 / pg.getViewport({ scale: 1 }).width });
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      pg.cleanup();
      await new Promise(r => setTimeout(r));
    }
  } catch (e) {
    console.error(e); setStatus('원본 미리보기 실패: ' + (e && e.message ? e.message : e), true);
  }
}
async function drawPage(i) {
  if (!srcDoc) return;
  curPage = i;
  document.querySelectorAll('#rail canvas').forEach(c => c.classList.toggle('cur', +c.dataset.p === i));
  const pg = await srcDoc.getPage(i);
  const stage = $('stageSrc');
  const maxW = Math.max(200, stage.clientWidth - 28), maxH = Math.max(200, stage.clientHeight - 28);
  const v1 = pg.getViewport({ scale: 1 });
  const scale = Math.min(maxW / v1.width, maxH / v1.height, 2);
  const vp = pg.getViewport({ scale });
  const cv = $('pageCv');
  cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
  await pg.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  pg.cleanup();
}
function setView(which) {
  const src = which === 'src';
  $('stageSrc').style.display = src ? '' : 'none';
  $('stageOut').style.display = src ? 'none' : '';
  $('rail').style.display = src ? '' : 'none';
  $('tabSrc').classList.toggle('active', src);
  $('tabOut').classList.toggle('active', !src);
}
function showView(which) {
  if (which === 'out' && !lastBytes) { setStatus('먼저 [임포징 생성]을 누르세요.', true); return; }
  setView(which);
}

// ── 모드 전환 ──
let mode = '';
function setMode(m) {
  mode = m;
  document.querySelectorAll('#modes button').forEach(b => b.classList.toggle('active', b.dataset.m === m));
  const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };
  const bk = m === 'booklet', nu = m === 'nup', cs = m === 'cutstack', rp = m === 'repeat', dp = m === 'dup';
  show('rowBind', bk); show('rowCreep', bk); show('rowCover', bk); show('rowStackNum', cs);
  show('rowGrid', nu || cs);
  show('rowSides', nu || cs || dp);
  show('rowRep', rp);
  $('hint').textContent = ({
    booklet: '중철(북클릿): 앞/뒤 교대로 재배열 → 가로 용지·양면·짧은 쪽 넘김 → 반 접어 중철.',
    nup: '모아찍기(N-up): 연속 페이지를 열×행 그리드로 앉힙니다.',
    cutstack: '정합(Cut&Stack): 재단 후 묶음을 순서대로 겹치면 완성. 열×행 지정.',
    repeat: '반복(Step&Repeat): 같은 원고를 한 시트에 여러 벌. 칸수를 비우면 실제 크기 자동 최대.',
    dup: '복제 2부: 같은 페이지 2벌(오른쪽 180°). 양면=앞뒤 2쪽씩, 단면=페이지당 1시트.',
  })[m] || '위에서 임포징 방식을 고르세요.';
}

// ── 용지 → 시트 pt ──
function paperPt(orient) {
  const v = $('paper').value;
  if (v === 'auto') return null;
  let w, h;
  if (v === '__custom__') { w = parseFloat($('cw').value); h = parseFloat($('ch').value); if (!(w > 0 && h > 0)) return null; w *= MM; h *= MM; }
  else { const b = IMP_PAPERS[v] || IMP_PAPERS.A4; w = b[0]; h = b[1]; }
  if (orient === 'landscape' && h > w) [w, h] = [h, w];
  if (orient === 'portrait' && w > h) [w, h] = [h, w];
  return [w, h];
}

// ── 폼 → 빌더 옵션 ──
function buildOpts() {
  const scale = document.querySelector('#scaleGrp button.active')?.dataset.s || 'fit';
  const sides = +(document.querySelector('#sidesGrp button.active')?.dataset.sd || 2);
  // 슬러그: 브라우저에선 한글 폰트 파일 접근이 없어 ASCII만 인쇄됨(파일명 한글은 생략됨)
  const d = new Date(), p2 = v => String(v).padStart(2, '0');
  const common = {
    margin: parseFloat($('margin').value) || 0,
    gutter: parseFloat($('gutter').value) || 0,
    bleed: parseFloat($('bleed').value) || 0,
    srcBleed: parseFloat($('srcBleed').value) || 0,   // 원고에 이미 포함된 재단여백(TrimBox 없을 때)
    crop: $('crop').checked, frame: $('frame').checked,
    cropDims: $('cropDims').checked,
    cropStyle: {
      shape: $('cropShape').value || 'corner',
      gap: parseFloat($('cropGap').value) || 1,
      len: parseFloat($('cropLen').value) || 3,
      th: parseFloat($('cropTh').value) || 0.4,
      center: $('cropCenter').checked,
    },
    slug: $('slug').checked ? { text: srcName + ' · ' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()), fontBytes: null } : null,
    stackNum: $('stackNum').checked,
    place: {
      scale,
      fixedScale: scale === 'fixed' ? (parseFloat($('fixed').value) || 100) / 100 : undefined,
      align: $('align').value || 'cc',
      offX: parseFloat($('offX').value) || 0, offY: parseFloat($('offY').value) || 0,
    },
  };
  const across = parseInt($('across').value) || 1, down = parseInt($('down').value) || 1;
  // 표준 용지만 그리드 모양에 맞는 방향 자동 — 사용자 지정 크기는 입력 그대로
  const nupOrient = $('paper').value === '__custom__' ? null : (across > down ? 'landscape' : 'portrait');
  if (mode === 'nup') return Object.assign(common, { mode, sheet: paperPt(nupOrient), across, down, sides, order: 'sequential' });
  if (mode === 'cutstack') return Object.assign(common, { mode, sheet: paperPt(down > 1 ? 'portrait' : 'landscape'), across, down, sides, order: 'cutstack' });
  if (mode === 'repeat') return Object.assign(common, { mode, sheet: paperPt(null), cols: parseInt($('repCols').value) || 0, rows: parseInt($('repRows').value) || 0 });
  if (mode === 'dup') return Object.assign(common, { mode, sheet: paperPt('landscape'), sides });
  return Object.assign(common, { mode: 'booklet', sheet: paperPt('landscape'), creep: parseFloat($('creep').value) || 0, binding: document.querySelector('#bindGrp button.active')?.dataset.b || 'left' });
}

// ── 생성 ──
async function generate() {
  if (!srcBytes) { setStatus('먼저 PDF 파일을 선택하세요.', true); return; }
  if (!mode) { setStatus('임포징 방식을 먼저 고르세요.', true); return; }
  const opts = buildOpts();
  // 같은 원고·같은 설정이면 다시 굽지 않는다(반복 클릭·탭 전환에서 즉시)
  const sig = srcName + '|' + srcBytes.length + '|' + JSON.stringify(opts);
  const t0 = performance.now();
  setStatus('임포징 생성 중…');
  barShow(true); $('genBtn').disabled = true;
  try {
    let res;
    if (_genCache.sig === sig && _genCache.res) { res = _genCache.res; }
    else {
      const build = (opts.mode === 'nup' || opts.mode === 'cutstack') ? buildNupBytes
        : opts.mode === 'repeat' ? buildStepRepeatBytes
        : opts.mode === 'dup' ? buildDup2upBytes : buildBookletBytes;
      res = await build(srcBytes.slice(0), opts, pc => {
        setStatus('임포징 생성 중… ' + Math.round(pc) + '%');
        barSet(pc * 0.95);              // 95%까지가 시트 조립, 나머지는 저장·미리보기
      });
      _genCache = { sig, res };
    }
    const took = Math.round(performance.now() - t0);
    lastBytes = res.bytes; lastCover = lastInner = null;
    // 중철 표지 분리: 맨 바깥 시트(표지 4면) / 내지 시트를 별도 PDF로
    if (mode === 'booklet' && $('coverSplit') && $('coverSplit').checked) {
      if ((res.sheets || 0) < 2) { setStatus('표지 분리는 시트 2장 이상(본문 5쪽 이상)일 때 가능합니다.', true); }
      else {
        const srcDoc = await PDFLib.PDFDocument.load(res.bytes.slice(0));
        const mk = async idxs => { const d = await PDFLib.PDFDocument.create(); (await d.copyPages(srcDoc, idxs)).forEach(p => d.addPage(p)); return d.save({ useObjectStreams: false, updateFieldAppearances: false }); };
        lastCover = await mk([0, 1]);
        lastInner = await mk(Array.from({ length: srcDoc.getPageCount() - 2 }, (_, i) => i + 2));
      }
    }
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(new Blob([res.bytes], { type: 'application/pdf' }));
    $('preview').src = lastUrl;
    setView('out');
    $('dlBtn').disabled = false;
    barDone();
    $('pvInfo').textContent = '시트 ' + (res.sheets || '?') + '장'
      + (res.trimMm ? ' · 재단 후 ' + res.trimMm[0] + '×' + res.trimMm[1] + 'mm' : '') + ' · ' + took + 'ms';
    setStatus(lastCover
      ? '생성 완료 — 표지/내지 분리됨. [⇩ 다운로드]를 누르면 표지·내지 2개 파일이 저장됩니다. (표지 1시트 + 내지 ' + (res.sheets - 1) + '시트)'
      : '생성 완료 (' + took + 'ms) — 미리보기 확인 후 [⇩ 다운로드]로 저장하세요. (시트 ' + (res.sheets || '?') + '장'
        + (res.trimMm ? ' · 재단 후 ' + res.trimMm[0] + '×' + res.trimMm[1] + 'mm' : '') + ')');
  } catch (e) {
    console.error(e); setStatus('생성 실패: ' + (e && e.message ? e.message : String(e)), true);
    barShow(false);
  } finally {
    $('genBtn').disabled = false;
  }
}
function saveAs(bytes, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function download() {
  if (!lastBytes) return;
  if (lastCover && lastInner) {   // 중철 표지 분리 — 표지·내지 2개 파일
    saveAs(lastCover, srcName + '_중철_표지.pdf');
    setTimeout(() => saveAs(lastInner, srcName + '_중철_내지.pdf'), 400);
    setStatus('표지·내지 2개 파일 저장 — 표지는 두꺼운 용지 1장 양면, 내지는 본문 용지 양면(짧은 쪽 넘김) → 내지를 접어 표지로 감싸 중철.');
    return;
  }
  const modeName = ({ booklet: '중철', nup: '모아찍기', cutstack: '정합', repeat: '반복', dup: '2up' })[mode] || '임포징';
  saveAs(lastBytes, srcName + '_' + modeName + '.pdf');
}
function setStatus(t, err) { const s = $('status'); s.textContent = t; s.style.color = err ? '#ff6b6b' : '#8e8e93'; }
// ── 진행 바 — 시트 조립(0~95%) → 저장·미리보기(100%) ──
function barShow(on) {
  const b = $('genBar');
  b.style.display = on ? '' : 'none';
  if (on) { b.classList.remove('done'); $('genBarFill').style.width = '0%'; }
}
function barSet(pct) { $('genBarFill').style.width = Math.max(0, Math.min(100, pct)) + '%'; }
function barDone() { $('genBar').classList.add('done'); barSet(100); setTimeout(() => barShow(false), 900); }

// ── 프로파일 (시드 + localStorage, 폼에 펼쳐 로드) ──
// QI 원본 대조로 매핑 정정된 이름들 — 옛 localStorage에 남은 잘못된 매핑(중철↔정합)을 1회 교체
const QI_FIX_NAMES = ['A4_단면_1up','8K_양면_1up','270-390_양면_1up_컷앤스택_중앙정렬','양면_1up_컷앤스택_100%','270-390_양면_1up_컷앤스택','A4_확대100.5_블리드0.4_재단선_컷앤스택_311-438','A4_확대100.5_블리드0.4_재단선_중철_311-438','218-312_양면_1up_센터_컷앤스택_100%','A4_단면_1up_312-438','8K_양면_1up_Cut&Stack','A5_양면_1up_Cut&Stack','8K_단면_1up','A4_단면_1up_315-465','8K_양면_1up_Cut&Stack_A5원고 2판'];
function migrateProfiles(list) {
  try {
    if (localStorage.getItem('impProfilesFixQI1')) return list;
    const byName = new Map(IMP_PROFILE_SEED.map(p => [p.n, p]));
    QI_FIX_NAMES.forEach(n => { const at = list.findIndex(x => x && x.n === n); if (at >= 0 && byName.has(n)) list[at] = Object.assign({}, byName.get(n)); });
    localStorage.setItem('impProfiles', JSON.stringify(list));
    localStorage.setItem('impProfilesFixQI1', '1');
  } catch (e) {}
  return list;
}
function loadProfiles() { try { const a = JSON.parse(localStorage.getItem('impProfiles')); if (Array.isArray(a)) return migrateProfiles(a); } catch (e) {} const s = IMP_PROFILE_SEED.map(p => Object.assign({}, p)); try { localStorage.setItem('impProfiles', JSON.stringify(s)); localStorage.setItem('impProfilesFixQI1', '1'); } catch (e) {} return s; }
function saveProfiles(l) { try { localStorage.setItem('impProfiles', JSON.stringify(l)); } catch (e) {} }
function fillProfiles() {
  const sel = $('profile'); const list = loadProfiles();
  sel.innerHTML = '<option value="">— 프로파일 선택 —</option>' + list.map((p, i) => '<option value="' + i + '">' + esc(p.n) + '</option>').join('');
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
function applyProfile() {
  const idx = $('profile').value; if (idx === '') return;
  const p = loadProfiles()[+idx]; if (!p) return;
  setMode(p.m);
  document.querySelectorAll('#scaleGrp button').forEach(b => b.classList.toggle('active', b.dataset.s === (p.sc || 'fit')));
  document.querySelectorAll('#sidesGrp button').forEach(b => b.classList.toggle('active', +b.dataset.sd === (p.sd || 2)));
  document.querySelectorAll('#bindGrp button').forEach(b => b.classList.toggle('active', b.dataset.b === (p.bd || 'left')));
  if (p.sw && p.sh) { $('paper').value = '__custom__'; $('cw').value = p.sw; $('ch').value = p.sh; $('rowCustom').style.display = ''; }
  else { $('paper').value = 'auto'; $('rowCustom').style.display = 'none'; }
  $('across').value = p.ax || 1; $('down').value = p.dn || 1;
  $('align').value = p.al || 'cc'; $('offX').value = p.ox || 0; $('offY').value = p.oy || 0;
  $('fixed').value = p.fx != null ? (p.fx * 100).toFixed(1) : 100;
  $('margin').value = p.mg != null ? p.mg : (p.ml || 0);
  $('gutter').value = p.hg || 0; $('bleed').value = p.bl || 0;
  $('crop').checked = !!p.cr; $('frame').checked = !!p.fr;
  setStatus("프로파일 '" + p.n + "' 불러옴 — [임포징 생성]을 누르세요.");
}
function saveProfileAs() {
  const name = ($('profName').value || '').trim(); if (!name) { setStatus('저장할 프로파일 이름을 입력하세요.', true); return; }
  const o = buildOpts(); const s = { n: name, m: mode, sc: o.place.scale, al: o.place.align };
  if (o.sheet) { s.sw = +(o.sheet[0] / MM).toFixed(1); s.sh = +(o.sheet[1] / MM).toFixed(1); }   // pt → mm
  const mg = parseFloat($('margin').value) || 0; if (mg) s.mg = mg;
  const hg = parseFloat($('gutter').value) || 0; if (hg) { s.hg = hg; s.vg = hg; }
  const bl = parseFloat($('bleed').value) || 0; if (bl) s.bl = bl;
  if ($('crop').checked) s.cr = 1; if ($('frame').checked) s.fr = 1;
  if (o.place.scale === 'fixed') s.fx = o.place.fixedScale;
  if (mode === 'nup' || mode === 'cutstack') { s.ax = parseInt($('across').value) || 1; s.dn = parseInt($('down').value) || 1; }
  if (mode === 'nup' || mode === 'cutstack' || mode === 'dup') s.sd = +(document.querySelector('#sidesGrp button.active')?.dataset.sd || 2);
  if (o.place.offX) s.ox = o.place.offX;
  if (o.place.offY) s.oy = o.place.offY;
  if (mode === 'booklet' && o.binding === 'right') s.bd = 'right';
  const list = loadProfiles(); const at = list.findIndex(x => x.n === name);
  if (at >= 0) { if (!confirm("'" + name + "' 덮어쓸까요?")) return; list[at] = s; } else list.push(s);
  saveProfiles(list); fillProfiles(); setStatus("프로파일 '" + name + "' 저장됨.");
}
function delProfile() {
  const idx = $('profile').value; if (idx === '') { setStatus('삭제할 프로파일을 고르세요.', true); return; }
  const list = loadProfiles(); const n = list[+idx] && list[+idx].n;
  if (!n || !confirm("'" + n + "' 삭제할까요?")) return;
  list.splice(+idx, 1); saveProfiles(list); fillProfiles(); renderProfList(); setStatus("삭제됨: " + n);
}
// ── 여러 개 골라 한 번에 삭제 (목록 + 체크박스) ──
function toggleProfList() {
  const box = $('profList');
  const show = box.style.display === 'none' || !box.style.display;
  box.style.display = show ? '' : 'none';
  $('profListActions').style.display = show ? '' : 'none';
  $('profListBtn').classList.toggle('active', show);
  if (show) renderProfList();
}
function renderProfList() {
  const box = $('profList'); if (!box || box.style.display === 'none') return;
  const list = loadProfiles();
  box.innerHTML = list.map((pf, i) =>
    '<label class="prof-item"><input type="checkbox" data-i="' + i + '" onchange="syncProfDelBtn()">' +
    '<span title="' + esc(pf.n) + '">' + esc(pf.n) + '</span></label>').join('')
    || '<div class="hint" style="margin:0;">프로파일이 없습니다.</div>';
  syncProfDelBtn();
}
function profChecked() {
  return [...document.querySelectorAll('#profList input:checked')].map(c => +c.dataset.i);
}
function syncProfDelBtn() {
  const n = profChecked().length;
  const b = $('profDelBtn');
  if (b) { b.disabled = n === 0; b.textContent = n ? '🗑 선택 ' + n + '개 삭제' : '🗑 선택 삭제'; }
}
function profCheckAll(on) {
  document.querySelectorAll('#profList input').forEach(c => { c.checked = !!on; });
  syncProfDelBtn();
}
function delProfChecked() {
  const idxs = profChecked();
  if (!idxs.length) { setStatus('삭제할 프로파일을 체크하세요.', true); return; }
  const list = loadProfiles();
  const names = idxs.map(i => list[i] && list[i].n).filter(Boolean);
  if (!confirm(names.length + '개 프로파일을 삭제할까요?' + String.fromCharCode(10, 10) + names.slice(0, 12).join(String.fromCharCode(10)) + (names.length > 12 ? String.fromCharCode(10) + '…' : ''))) return;
  const keep = list.filter((_, i) => idxs.indexOf(i) < 0);
  saveProfiles(keep); fillProfiles(); renderProfList();
  setStatus(names.length + '개 프로파일을 삭제했습니다.');
}
// ── 동기화: 본 앱과 JSON으로 프로파일 공유 ──
function exportProfiles() {
  const list = loadProfiles(); if (!list.length) { setStatus('내보낼 프로파일이 없습니다.', true); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' }));
  a.download = 'imposition-profiles.json'; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  setStatus('프로파일 ' + list.length + '개 내보냄 (imposition-profiles.json).');
}
function importProfilesClick() { $('impFile').click(); }
function importProfilesFile(input) {
  const f = input.files && input.files[0]; if (!f) return;
  const rd = new FileReader();
  rd.onload = () => {
    try {
      const arr = JSON.parse(rd.result); if (!Array.isArray(arr)) throw new Error('프로파일 JSON(배열)이 아닙니다.');
      const valid = arr.filter(p => p && typeof p.n === 'string' && typeof p.m === 'string'); if (!valid.length) throw new Error('유효한 프로파일 없음');
      const list = loadProfiles(); let a = 0, u = 0;
      valid.forEach(p => { const at = list.findIndex(x => x.n === p.n); if (at >= 0) { list[at] = p; u++; } else { list.push(p); a++; } });
      saveProfiles(list); fillProfiles(); setStatus('가져오기 완료 — 추가 ' + a + ' · 갱신 ' + u + ' (총 ' + list.length + ').');
    } catch (e) { setStatus('가져오기 실패: ' + (e.message || e), true); }
  };
  rd.readAsText(f); input.value = '';
}

// 용지 드롭다운 변경 시 사용자지정 행 토글
$('paper').addEventListener('change', () => { $('rowCustom').style.display = $('paper').value === '__custom__' ? '' : 'none'; });
// 프로파일 선택 즉시 자동 적용 (빈 선택은 무시)
$('profile').addEventListener('change', () => { if ($('profile').value !== '') applyProfile(); });

// 초기화
document.querySelectorAll('#scaleGrp button')[0].classList.add('active');
document.querySelectorAll('#sidesGrp button')[0].classList.add('active');
document.querySelectorAll('#bindGrp button')[0].classList.add('active');
fillProfiles();
setMode('');
`;

const html = `<!doctype html>
<html lang="ko"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>임포징 도구 (독립 실행)</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "Segoe UI", "Malgun Gothic", sans-serif; background: #1d1d1f; color: #f5f5f7; }
  header { background: #161617; padding: 12px 18px; border-bottom: 1px solid rgba(255,255,255,.1); display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 16px; margin: 0; color: #ffd60a; }
  header .sub { font-size: 12px; color: #8e8e93; }
  .wrap { display: flex; height: calc(100vh - 49px); }
  .panel { width: 380px; flex: 0 0 380px; overflow-y: auto; padding: 14px; border-right: 1px solid rgba(255,255,255,.1); }
  .preview { flex: 1; background: #2a2a2c; display: flex; flex-direction: column; min-width: 0; }
  .pv-bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: #202022; border-bottom: 1px solid rgba(255,255,255,.08); }
  .pv-bar .tab { background: #2c2c2e; border: 1px solid rgba(255,255,255,.14); color: #f5f5f7; border-radius: 7px; padding: 5px 12px; font-size: 12px; cursor: pointer; font-family: inherit; }
  .pv-bar .tab.active { background: #ffd60a; color: #1d1d1f; font-weight: 700; }
  .pv-bar .pv-info { font-size: 12px; color: #8e8e93; margin-left: auto; }
  .pv-body { flex: 1; display: flex; min-height: 0; }
  .rail { width: 132px; flex: 0 0 132px; overflow-y: auto; padding: 8px; background: #202022; border-right: 1px solid rgba(255,255,255,.08); }
  .rail .th { width: 100%; margin-bottom: 8px; border: 2px solid transparent; border-radius: 4px; background: #fff; cursor: pointer; display: block; }
  .rail .th.cur { border-color: #ffd60a; }
  .rail .thnum { text-align: center; font-size: 10.5px; color: #8e8e93; margin: -6px 0 6px; }
  .stage { flex: 1; overflow: auto; padding: 14px; min-width: 0; }
  .stage canvas { display: block; margin: 0 auto; background: #fff; box-shadow: 0 6px 20px rgba(0,0,0,.45); max-width: 100%; }
  #stageOut { padding: 0; overflow: hidden; }
  #stageOut iframe { display: block; width: 100%; height: 100%; border: none; background: #fff; }
  .drop-on { outline: 3px dashed #ffd60a; outline-offset: -8px; }
  .prof-list { max-height: 190px; overflow-y: auto; background: #1c1c1e; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 6px; margin-top: 6px; }
  .prof-item { display: flex; align-items: center; gap: 6px; padding: 3px 4px; font-size: 12px; color: #d1d1d6; border-radius: 5px; }
  .prof-item:hover { background: #2c2c2e; }
  .prof-item input { accent-color: #ffd60a; width: 13px; height: 13px; flex: 0 0 auto; }
  .prof-item span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sec { background: #242426; border-radius: 10px; padding: 12px; margin-bottom: 12px; }
  .sec-title { font-size: 12px; font-weight: 700; color: #ffd60a; text-transform: uppercase; letter-spacing: .4px; margin-bottom: 10px; }
  .row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  label.lbl { min-width: 56px; font-size: 12px; color: #aeaeb2; white-space: nowrap; }
  .row .hint { white-space: nowrap; }
  select, input[type=number], input[type=text] { background: #2c2c2e; color: #f5f5f7; border: 1px solid rgba(255,255,255,.14); border-radius: 7px; padding: 7px 9px; font-size: 12.5px; font-family: inherit; flex: 1; min-width: 0; }
  .grp { display: flex; gap: 4px; flex-wrap: wrap; }
  .grp button, .chip { background: #2c2c2e; border: 1px solid rgba(255,255,255,.14); color: #f5f5f7; border-radius: 7px; padding: 6px 10px; font-size: 12px; cursor: pointer; font-family: inherit; }
  .grp button.active { background: #ffd60a; color: #1d1d1f; font-weight: 700; }
  .chip:hover, .grp button:hover { background: #48484a; }
  .hint { font-size: 11.5px; color: #8e8e93; line-height: 1.5; margin-top: 4px; }
  .gen { width: 100%; background: #ffd60a; color: #1d1d1f; font-weight: 700; border: none; border-radius: 9px; padding: 11px; font-size: 14px; cursor: pointer; margin-top: 4px; }
  .gen:hover { background: #ffdf3a; }
  .dl { width: 100%; background: #2c2c2e; color: #f5f5f7; border: 1px solid rgba(255,255,255,.18); border-radius: 9px; padding: 10px; font-size: 13px; cursor: pointer; margin-top: 8px; }
  .dl:disabled { opacity: .4; cursor: not-allowed; }
  .file { display: block; width: 100%; text-align: center; background: #2c2c2e; border: 1px dashed rgba(255,255,255,.28); border-radius: 9px; padding: 14px; cursor: pointer; color: #d1d1d6; }
  .file input { display: none; }
  #status { font-size: 12px; color: #8e8e93; margin-top: 8px; min-height: 16px; }
  .genbar { height: 8px; background: #2c2c2e; border: 1px solid rgba(255,255,255,.14); border-radius: 6px; overflow: hidden; margin-top: 8px; }
  .genbar > div { height: 100%; width: 0%; background: #ffd60a; transition: width .12s linear; }
  .genbar.done > div { background: #34c759; }
  .ck { display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 12.5px; color: #d1d1d6; }
  .ck input { accent-color: #ffd60a; width: 14px; height: 14px; }
</style></head><body>
<header>
  <h1>📖 임포징 도구</h1>
  <span class="sub">PDF 제본 조판 — 브라우저에서 바로 실행 (설치 불필요)</span>
</header>
<div class="wrap">
  <aside class="panel">
    <div class="sec">
      <label class="file">
        <input type="file" id="file" accept="application/pdf,.pdf">
        📂 PDF 파일 선택 — <span id="fname">선택 안 됨</span>
      </label>
    </div>

    <div class="sec">
      <div class="sec-title">프로파일</div>
      <div class="row">
        <select id="profile"></select>
        <button class="chip" onclick="applyProfile()">📂 불러오기</button>
      </div>
      <div class="row">
        <input type="text" id="profName" placeholder="새 프로파일 이름">
        <button class="chip" onclick="saveProfileAs()">💾 저장</button>
        <button class="chip" onclick="delProfile()" title="위에서 고른 프로파일 1개 삭제">🗑</button>
        <button class="chip" id="profListBtn" onclick="toggleProfList()" title="여러 개 골라 한 번에 삭제">📋 목록</button>
      </div>
      <div id="profList" class="prof-list" style="display:none;"></div>
      <div class="row" id="profListActions" style="display:none;">
        <button class="chip" onclick="profCheckAll(true)">전체 선택</button>
        <button class="chip" onclick="profCheckAll(false)">해제</button>
        <button class="chip" id="profDelBtn" onclick="delProfChecked()" disabled>🗑 선택 삭제</button>
      </div>
      <div class="row">
        <button class="chip" style="flex:1;" onclick="exportProfiles()" title="프로파일 전체를 JSON으로 저장 (본 앱과 동기화)">⬆ 내보내기</button>
        <button class="chip" style="flex:1;" onclick="importProfilesClick()" title="본 앱에서 내보낸 JSON을 가져와 병합">⬇ 가져오기</button>
        <input type="file" id="impFile" accept="application/json,.json" style="display:none;" onchange="importProfilesFile(this)">
      </div>
    </div>

    <div class="sec">
      <div class="sec-title">임포징 방식</div>
      <div class="grp" id="modes">
        <button data-m="booklet" onclick="setMode('booklet')">중철</button>
        <button data-m="nup" onclick="setMode('nup')">모아찍기</button>
        <button data-m="cutstack" onclick="setMode('cutstack')">정합</button>
        <button data-m="repeat" onclick="setMode('repeat')">반복</button>
        <button data-m="dup" onclick="setMode('dup')">복제2부</button>
      </div>
      <div class="hint" id="hint"></div>
    </div>

    <div class="sec">
      <div class="sec-title">용지 · 배치</div>
      <div class="row">
        <label class="lbl">용지</label>
        <select id="paper">
          <option value="auto">자동 (원본 기준)</option>
          <option value="__custom__">사용자 지정 (W×H)</option>
          <option value="A4">A4</option><option value="A3">A3</option>
          <option value="B4">B4</option><option value="B5">B5</option>
        </select>
      </div>
      <div class="row" id="rowCustom" style="display:none;">
        <label class="lbl">직접크기</label>
        <input type="number" id="cw" placeholder="폭" style="flex:0 0 66px;">
        <span>×</span>
        <input type="number" id="ch" placeholder="높이" style="flex:0 0 66px;">
        <span class="hint" style="margin:0;">mm</span>
      </div>
      <div class="row" id="rowGrid" style="display:none;">
        <label class="lbl">그리드</label>
        <input type="number" id="across" min="1" value="2" style="flex:0 0 60px;"> 열 ×
        <input type="number" id="down" min="1" value="1" style="flex:0 0 60px;"> 행
      </div>
      <div class="row" id="rowSides" style="display:none;">
        <label class="lbl">인쇄</label>
        <div class="grp" id="sidesGrp">
          <button data-sd="2">양면</button><button data-sd="1">단면</button>
        </div>
      </div>
      <div class="row" id="rowBind" style="display:none;">
        <label class="lbl">제본</label>
        <div class="grp" id="bindGrp">
          <button data-b="left">좌철</button><button data-b="right">우철</button>
        </div>
      </div>
      <div class="row" id="rowCover" style="display:none;">
        <label class="ck" title="표지 4면이 실리는 맨 바깥 시트를 별도 PDF로 분리 — 두꺼운 표지 용지에 따로 인쇄"><input type="checkbox" id="coverSplit"> 📕 표지 분리 (표지/내지 별도 저장)</label>
      </div>
      <div class="row" id="rowRep" style="display:none;">
        <label class="lbl">배치</label>
        <input type="number" id="repCols" min="1" placeholder="가로" style="flex:0 0 60px;"> ×
        <input type="number" id="repRows" min="1" placeholder="세로" style="flex:0 0 60px;">
        <span class="hint" style="margin:0;">비우면 자동</span>
      </div>
      <div class="row">
        <label class="lbl">배치크기</label>
        <div class="grp" id="scaleGrp">
          <button data-s="fit">칸 맞춤</button><button data-s="orig">100%</button><button data-s="fixed">지정%</button>
        </div>
        <input type="number" id="fixed" value="100" style="flex:0 0 60px;">
      </div>
      <div class="row">
        <label class="lbl">정렬</label>
        <select id="align">
          <option value="tl">좌상</option><option value="tc">상단중앙</option><option value="tr">우상</option>
          <option value="cl">좌중앙</option><option value="cc" selected>정중앙</option><option value="cr">우중앙</option>
          <option value="bl">좌하</option><option value="bc">하단중앙</option><option value="br">우하</option>
        </select>
        <span class="hint" style="margin:0;">이동 X</span>
        <input type="number" id="offX" value="0" style="flex:0 0 54px;">
        <input type="number" id="offY" value="0" style="flex:0 0 54px;" title="Y (mm)">
      </div>
    </div>

    <div class="sec">
      <div class="sec-title">여백 · 재단</div>
      <div class="row">
        <label class="lbl">여백</label>
        <input type="number" id="margin" value="0" style="flex:0 0 66px;"> mm
        <label class="lbl" style="min-width:auto;">거터</label>
        <input type="number" id="gutter" value="0" style="flex:0 0 66px;"> mm
      </div>
      <div class="row" id="rowCreep" style="display:none;">
        <label class="lbl">밀림보정</label>
        <input type="number" id="creep" value="0" step="0.05" style="flex:0 0 66px;"> mm/장
      </div>
      <div class="row">
        <label class="lbl" title="원고에 재단여백이 없을 때, 페이지를 재단선 밖으로 키워 칸을 채웁니다">블리드 채움</label>
        <input type="number" id="bleed" value="0" style="flex:0 0 66px;"> mm
      </div>
      <div class="row">
        <label class="lbl" title="원고가 이미 사방으로 재단여백을 품고 있을 때 그 폭 — 그만큼 안쪽이 실제 재단선입니다(예: 297×420을 303×426으로 만든 파일 → 3). PDF에 TrimBox가 있으면 자동 인식되므로 0으로 두세요">원고 블리드</label>
        <input type="number" id="srcBleed" value="0" step="0.5" style="flex:0 0 66px;"> mm
        <span class="hint" style="margin:0;">원고에 이미 포함된 재단여백</span>
      </div>
      <div class="row" id="rowCropStyle">
        <label class="lbl" title="재단 위치 표기 모양 — 어느 모양이든 자르는 위치는 같습니다">재단선</label>
        <select id="cropShape" style="flex:1 1 140px;">
          <option value="corner">┐ 모서리(기본)</option>
          <option value="notouch">┐ 모서리(겹침 없음)</option>
        </select>
      </div>
      <div class="row">
        <label class="lbl">마크 치수</label>
        <span class="hint" style="margin:0;">간격</span>
        <input type="number" id="cropGap" value="1" step="0.5" style="flex:0 0 52px;">
        <span class="hint" style="margin:0;">길이</span>
        <input type="number" id="cropLen" value="3" step="0.5" style="flex:0 0 52px;">
        <span class="hint" style="margin:0;">굵기</span>
        <input type="number" id="cropTh" value="0.4" step="0.1" style="flex:0 0 52px;">
      </div>
      <div class="row" style="gap:14px; flex-wrap:wrap;">
        <label class="ck"><input type="checkbox" id="crop"> ✂ 재단선</label>
        <label class="ck" title="각 변 중앙 바깥에도 마크 추가 — 접지·정합 확인용"><input type="checkbox" id="cropCenter"> 중앙마크</label>
        <label class="ck" title="시험 기능 — 자를 때마다의 거리(재단기 입력값)를 재단선 옆에 인쇄"><input type="checkbox" id="cropDims"> 📏 재단 치수(시험)</label>
        <label class="ck"><input type="checkbox" id="frame"> ▢ 프레임</label>
        <label class="ck" title="시트 하단에 파일명·날짜·시트번호 인쇄 (브라우저 도구는 영문·숫자만)"><input type="checkbox" id="slug"> 🏷 슬러그</label>
        <span id="rowStackNum" style="display:none;"><label class="ck" title="정합 전용 — 각 묶음 트림 왼쪽 바깥에 겹치기 순서 번호. 재단 시 잘려나감"><input type="checkbox" id="stackNum"> ① 묶음번호</label></span>
      </div>
    </div>

    <button class="gen" id="genBtn" onclick="generate()">📖 임포징 생성</button>
    <div class="genbar" id="genBar" style="display:none;"><div id="genBarFill"></div></div>
    <button class="dl" id="dlBtn" onclick="download()" disabled>⇩ 다운로드 (PDF 저장)</button>
    <div id="status"></div>
  </aside>
  <main class="preview" id="pvMain">
    <div class="pv-bar">
      <button class="tab active" id="tabSrc" onclick="showView('src')">📄 원본</button>
      <button class="tab" id="tabOut" onclick="showView('out')">📖 임포징 결과</button>
      <span class="pv-info" id="pvInfo">PDF를 끌어다 놓거나 왼쪽에서 선택하세요</span>
    </div>
    <div class="pv-body">
      <div class="rail" id="rail"></div>
      <div class="stage" id="stageSrc"><canvas id="pageCv"></canvas></div>
      <div class="stage" id="stageOut" style="display:none; padding:0;"><iframe id="preview" title="임포징 결과"></iframe></div>
    </div>
  </main>
</div>
<script>${pdflib}</script>
<script>${pdfjs}</script>
<script id="pdfWorkerSrc" type="javascript/worker">${pdfWorker}</script>
<script>
const PDFLib = window.PDFLib;
${core}
</script>
<script>${ui}</script>
</body></html>
`;

const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, '임포징도구.html');
fs.writeFileSync(outPath, html);
console.log('생성 완료:', outPath, '(' + (html.length / 1024).toFixed(0) + ' KB)');
