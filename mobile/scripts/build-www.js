// ── www 빌드: 데스크톱 src/ → 모바일 www/ 변환 ──────────────────────────────
// 데스크톱 소스를 수정하지 않고 빌드 시점에만 변환한다(드리프트 방지 — 원본 단일 유지).
// 변환 내용:
//  1) index.html: 스크립트 블록을 모바일 부트로더로 교체(워커 프리로드 후 순차 로드),
//     viewport 메타 추가, qrcode.js 제거(모바일 불필요)
//  2) 앱 JS·style.css·워커·libs 복사 (editor.html·convert_*.ps1 등 PC 전용 제외)
//  3) mobile-src/의 브리지·부트로더 복사
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');       // 저장소 루트
const SRC  = path.join(ROOT, 'src');
const MOB  = path.join(__dirname, '..');
const WWW  = path.join(MOB, 'www');

function copy(rel, destRel) {
  const from = path.join(SRC, rel);
  const to = path.join(WWW, destRel || rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

// 초기화
fs.rmSync(WWW, { recursive: true, force: true });
fs.mkdirSync(WWW, { recursive: true });

// 1) index.html 변환
let html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');

// viewport (데스크톱 html에는 없음) — 모바일 스케일 필수
html = html.replace(/<meta charset="utf-8"\s*\/?>/i,
  '<meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');

// 스크립트 블록 교체: qrcode/core/process/ui → bridge + boot (boot이 순서 로드)
const scriptBlockRe = /<script src="\.\/libs\/qrcode\.js"><\/script>[^]*?<script src="\.\/app-ui\.js"><\/script>/;
if (!scriptBlockRe.test(html)) { console.error('✖ index.html 스크립트 블록을 찾지 못했습니다 — 데스크톱 index.html 구조가 바뀌었는지 확인'); process.exit(1); }
html = html.replace(scriptBlockRe,
  '<script src="./mobile-bridge.js"></script><!-- electronAPI 모바일 어댑터 (앱 스크립트보다 먼저) -->\n' +
  '  <script src="./mobile-boot.js"></script><!-- 워커 프리로드 후 core→process→ui 순차 로드 -->');

fs.writeFileSync(path.join(WWW, 'index.html'), html, 'utf8');

// 2) 앱 파일 복사 (PC 전용 제외: editor.html, convert_*.ps1, icon.ico)
copy('style.css');
copy('app-core.js');
copy('app-process.js');
copy('app-ui.js');
copy('worker-gray.js');
copy('worker-assemble.js');
for (const f of fs.readdirSync(path.join(SRC, 'libs'))) {
  if (f === 'qrcode.js') continue;               // QR 표시는 PC 전용
  copy(path.join('libs', f));
}

// 3) 모바일 전용 소스
for (const f of fs.readdirSync(path.join(MOB, 'mobile-src'))) {
  fs.copyFileSync(path.join(MOB, 'mobile-src', f), path.join(WWW, f));
}

const count = (function walk(d) { return fs.readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? walk(path.join(d, e.name)) : 1), 0); })(WWW);
console.log(`✅ www 빌드 완료 — ${count}개 파일 (${WWW})`);
console.log('   다음: npx cap sync android → android/ 를 Android Studio로 열거나 gradlew assembleDebug');
