// 🔄 업데이트 파일 만들기 (관리자 PC 전용 — 개인키로 서명)
//   사용: node scripts/make-update.js --version 3.9.0 --notes "바뀐 점…" [--modules] [--out 폴더]
//   · 기준은 포터블 폴더 dist/win-unpacked (먼저 변경 파일을 그곳에 동기화해 둘 것 — CLAUDE.md 절대 규칙 2)
//   · --version을 주면 저장소 package.json과 포터블 resources/app/package.json의 버전도 함께 올린다
//   · --modules: node_modules까지 담는다(의존성 버전을 바꿨을 때만 — 평소엔 필요 없음)
//   · 결과: dist/PDF분석기-업데이트-<버전>.pdfupd → 받는 PC는 앱 ⚙ → '🔄 업데이트 적용'
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const license = require(path.join(ROOT, 'license.js'));
const updater = require(path.join(ROOT, 'updater.js'));

const args = process.argv.slice(2);
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const installDir = path.resolve(arg('--install') || path.join(ROOT, 'dist', 'win-unpacked'));
const outDir = path.resolve(arg('--out') || path.join(ROOT, 'dist'));
const includeModules = args.includes('--modules');
const notes = arg('--notes') || '';

const admin = license.adminData();
if (!admin || !license.isAdminPC()) { console.error('✘ 이 PC에는 관리자 개인키가 없습니다 — 업데이트 파일은 관리자 PC에서만 만들 수 있습니다.'); process.exit(1); }

const appPkgPath = path.join(installDir, 'resources', 'app', 'package.json');
const appPkg = JSON.parse(fs.readFileSync(appPkgPath, 'utf8'));
let version = arg('--version') || appPkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) { console.error('✘ 버전은 3.9.0 같은 형식이어야 합니다: ' + version); process.exit(1); }
if (updater.compareVersions(version, appPkg.version) < 0) { console.error(`✘ 새 버전(${version})이 지금 포터블 버전(${appPkg.version})보다 낮습니다.`); process.exit(1); }

const { bytes, manifest } = updater.buildUpdate({ installDir, version, notes, includeModules, privPem: admin.priv });
// 만든 파일을 바로 다시 읽어 서명·해시를 확인한다
updater.readUpdate(bytes);
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `PDF분석기-업데이트-${version}.pdfupd`);
fs.writeFileSync(out, bytes);

// 버전 맞추기 — 포터블 폴더와 저장소 package.json
if (appPkg.version !== version) { appPkg.version = version; fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2) + '\n', 'utf8'); }
const repoPkgPath = path.join(ROOT, 'package.json');
if (path.resolve(installDir) === path.resolve(path.join(ROOT, 'dist', 'win-unpacked'))) {
  const raw = fs.readFileSync(repoPkgPath, 'utf8');
  const fixed = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
  if (fixed !== raw) fs.writeFileSync(repoPkgPath, fixed, 'utf8');
}
const mb = n => (n / 1048576).toFixed(1) + 'MB';
console.log(`✔ 업데이트 파일: ${out}`);
console.log(`  버전 ${version} · 파일 ${manifest.files.length}개 · 압축 ${mb(bytes.length)} (원본 ${mb(manifest.files.reduce((a, f) => a + f.size, 0))})${includeModules ? ' · node_modules 포함' : ''}`);
console.log(`  받는 PC: 앱 첫 화면 '🔄 업데이트' 또는 왼쪽 패널 ⚙ → '🔄 업데이트 적용' → 이 파일 선택 → 자동으로 다시 시작`);
