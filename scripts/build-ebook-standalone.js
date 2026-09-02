// E-book 시안 생성기만 담은 독립 실행 HTML (배포용)
// src/app-process.js의 <EBOOK-CORE> 구간과 실제 렌더 함수를 그대로 떼어내 pdf.js와 함께 묶는다.
// 사용: node scripts/build-ebook-standalone.js  → dist/E북시안도구.html
// (코어가 바뀌면 다시 실행해 재생성 — 코드 드리프트 방지)
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

const appSrc = fs.readFileSync(path.join(ROOT, 'src/app-process.js'), 'utf8');

function slice(a, b) {
  const s = appSrc.indexOf(a), e = appSrc.indexOf(b, s);
  if (s < 0 || e < 0) throw new Error('마커를 찾을 수 없습니다: ' + a);
  return appSrc.slice(s, e);
}
function exFn(name) {
  let s = appSrc.indexOf('async function ' + name);
  if (s < 0) s = appSrc.indexOf('function ' + name);
  if (s < 0) throw new Error('함수 없음: ' + name);
  const e = appSrc.indexOf('\n    }', s) + 6;
  return appSrc.slice(s, e).replace(/^\s{4}/gm, '');
}

const core = slice('// <EBOOK-CORE>', '// </EBOOK-CORE>').replace(/^\s{4}/gm, '');
// 렌더는 앱과 완전히 같은 함수를 쓴다(화질·여백 처리가 갈라지지 않게)
const render = 'let _yieldAt = 0;\n' + exFn('uiYield') + '\n' + exFn('ebookRenderPages');

const pdfjs = fs.readFileSync(path.join(ROOT, 'src/libs/pdf.min.js'), 'utf8');
const worker = fs.readFileSync(path.join(ROOT, 'src/libs/pdf.worker.min.js'), 'utf8');

const UI = `
<div class="wrap">
  <h1>📖 E-book 시안 만들기</h1>
  <p class="sub">인쇄용 PDF를 넣으면 고객이 브라우저에서 책처럼 넘겨보는 <b>HTML 파일 하나</b>를 만듭니다.
     인터넷·설치 필요 없이 이 파일 안에서 전부 처리되며, PDF는 어디로도 전송되지 않습니다.</p>

  <div class="drop" id="drop">
    <div class="big">여기에 PDF를 끌어다 놓으세요</div>
    <div class="small">또는 <label class="link">파일 선택<input type="file" id="file" accept="application/pdf" hidden></label></div>
    <div class="small" id="fname"></div>
  </div>

  <div class="opts">
    <label>제목 <input type="text" id="title" placeholder="예: 한빛인쇄 카탈로그 출력 시안"></label>
    <label>화질
      <select id="dpi">
        <option value="100">가벼움 (100dpi)</option>
        <option value="150">표준 (150dpi)</option>
        <option value="200" selected>고화질 (200dpi)</option>
      </select>
    </label>
    <label>보는 기기
      <select id="target">
        <option value="web" selected>💻 일반 웹용 (PC·노트북)</option>
        <option value="mobile">📱 모바일용 (가로=두 쪽, 세로=한 쪽씩)</option>
      </select>
    </label>
    <label>보기 형식
      <select id="view">
        <option value="spread" selected>📖 양면(펼침) — 제본된 책 모양</option>
        <option value="single">📄 단면(한 면 인쇄) — 왼쪽 백지 + 오른쪽 인쇄면</option>
      </select>
    </label>
    <label>제본 형태
      <select id="bstyle">
        <option value="book" selected>📕 책자 제본 (무선·중철) — 책등에 골</option>
        <option value="twinring">🌀 트윈링 (더블와이어) — 고리·타공</option>
      </select>
    </label>
    <label>제본
      <select id="bind">
        <option value="left" selected>좌철 (가로쓰기)</option>
        <option value="right">우철 (세로쓰기)</option>
      </select>
    </label>
    <label class="chk"><input type="checkbox" id="wm"> 워터마크 '시안' 넣기</label>
    <label class="chk"><input type="checkbox" id="cover" checked> 표지를 단독 페이지로</label>
    <label>재단선 안내 <input type="number" id="bleed" value="0" min="0" max="20" step="0.5" title="블리드(도련) mm — 0이면 표시하지 않습니다"> mm</label>
  </div>

  <button class="go" id="go" disabled>시안 만들기</button>
  <div class="msg" id="msg"></div>
  <div class="bar" id="bar"><i></i></div>
</div>
`;

const APP_JS = `
${core}
${render}

var _bytes = null, _name = '';
var $ = function (id) { return document.getElementById(id); };
function msg(t, err) { $('msg').textContent = t; $('msg').className = 'msg' + (err ? ' err' : ''); }
function prog(p) { $('bar').style.display = p == null ? 'none' : 'block'; if (p != null) $('bar').firstChild.style.width = p + '%'; }

function take(file) {
  if (!file) return;
  if (!/\\.pdf$/i.test(file.name)) { msg('PDF 파일만 넣을 수 있습니다.', true); return; }
  var fr = new FileReader();
  fr.onload = function () {
    _bytes = new Uint8Array(fr.result);
    _name = file.name.replace(/\\.pdf$/i, '');
    $('fname').textContent = '📄 ' + file.name + ' (' + (file.size / 1048576).toFixed(1) + 'MB)';
    if (!$('title').value) $('title').value = _name + ' 출력 시안';
    $('go').disabled = false;
    msg('');
  };
  fr.readAsArrayBuffer(file);
}
$('file').onchange = function () { take(this.files[0]); };
var drop = $('drop');
['dragenter', 'dragover'].forEach(function (ev) {
  drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('on'); });
});
['dragleave', 'drop'].forEach(function (ev) {
  drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('on'); });
});
drop.addEventListener('drop', function (e) { take(e.dataTransfer.files[0]); });

$('go').onclick = async function () {
  if (!_bytes) return;
  $('go').disabled = true;
  msg('페이지를 그리는 중…');
  prog(2);
  try {
    var dpi = +$('dpi').value;
    var book = await ebookRenderPages(_bytes, dpi, function (p) { prog(Math.max(2, p)); });
    var bleed = +$('bleed').value || 0;
    var html = buildEbookProofHtml({
      title: $('title').value || (_name + ' 출력 시안'),
      meta: {
        mm: book.mm, bind: $('bind').value, target: $('target').value, view: $('view').value,
        bindStyle: $('bstyle').value,
        spec: book.mm[0] + '×' + book.mm[1] + 'mm · ' + book.pages.length + '쪽',
        date: new Date().toLocaleDateString('ko-KR'), by: '',
      },
      book: book.pages, sheets: [],
      opts: {
        watermark: $('wm').checked, wmText: '시안',
        trimPct: (bleed > 0 && book.mm[0]) ? (bleed / book.mm[0]) : 0,
        coverSingle: $('cover').checked,
      },
    });
    var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = _name + '_시안.html';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    prog(null);
    msg('✅ 시안 생성 완료 — ' + book.pages.length + '쪽 · ' + (blob.size / 1048576).toFixed(1) + 'MB. 내려받은 HTML 파일을 그대로 메일·카톡에 첨부하면 됩니다.');
  } catch (e) {
    prog(null);
    msg('실패: ' + (e && e.message ? e.message : e), true);
  }
  $('go').disabled = false;
};
`;

const html = `<!DOCTYPE html>
<html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>E-book 시안 만들기</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#f5f5f7;color:#1d1d1f;font-family:-apple-system,BlinkMacSystemFont,"Malgun Gothic","맑은 고딕",sans-serif;padding:28px}
.wrap{max-width:680px;margin:0 auto;background:#fff;border:1px solid #e8e8ed;border-radius:16px;padding:26px}
h1{font-size:1.25em;margin-bottom:8px}
.sub{font-size:0.85em;color:#48484a;line-height:1.7;margin-bottom:18px}
.drop{border:2px dashed #d2d2d7;border-radius:14px;padding:34px 20px;text-align:center;transition:.15s;background:#fbfbfd}
.drop.on{border-color:#ffd60a;background:#fffdf0}
.drop .big{font-size:1.02em;font-weight:700}
.drop .small{font-size:0.82em;color:#48484a;margin-top:8px}
.link{color:#1d1d1f;font-weight:700;text-decoration:underline;cursor:pointer}
.opts{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:18px 0}
.opts label{font-size:0.82em;color:#48484a;font-weight:600;display:flex;flex-direction:column;gap:5px}
.opts label.chk{flex-direction:row;align-items:center;gap:7px}
input[type=text],input[type=number],select{padding:9px 11px;border:1px solid #d2d2d7;border-radius:8px;font-family:inherit;font-size:0.95em;color:#1d1d1f;background:#fff}
input[type=number]{width:90px}
.go{width:100%;border:none;border-radius:10px;padding:14px;font-size:1em;font-weight:700;background:#1d1d1f;color:#ffd60a;cursor:pointer}
.go:disabled{opacity:.4;cursor:default}
.msg{margin-top:14px;font-size:0.86em;line-height:1.6;white-space:pre-line;color:#1d1d1f}
.msg.err{color:#8a1c1c}
.bar{display:none;height:6px;background:#e8e8ed;border-radius:99px;margin-top:12px;overflow:hidden}
.bar i{display:block;height:100%;width:0;background:#ffd60a;transition:width .2s}
</style></head><body>
${UI}
<script>${pdfjs}<\/script>
<script>
pdfjsLib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(
  new Blob([${JSON.stringify(worker)}], { type: 'text/javascript' }));
<\/script>
<script>${APP_JS}<\/script>
</body></html>`;

// 인라인 스크립트 안에 닫는 태그가 섞이면 브라우저가 거기서 스크립트를 끊는다(주석 안이라도!).
// 조용히 반쪽짜리 도구가 나가지 않도록 여기서 잡는다.
const marker = '</scr' + 'ipt>';
const opens = (html.match(/<script/gi) || []).length;
const closes = html.split(marker).length - 1;
if (opens !== closes) {
  throw new Error(`인라인 스크립트 태그 짝이 맞지 않습니다 (여는 ${opens} / 닫는 ${closes})`
    + ' — 코어 주석이나 문자열에 닫는 스크립트 태그가 들어 있는지 확인하세요.');
}

const outDir = path.join(ROOT, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'E북시안도구.html');
fs.writeFileSync(out, html, 'utf8');
console.log(`✔ ${path.relative(ROOT, out)} (${(Buffer.byteLength(html) / 1048576).toFixed(2)}MB)`);
