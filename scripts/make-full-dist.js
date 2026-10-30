// 🔓 정식판(체험 키 없이 쓰는 판) 배포본 만들기 — 관리자 PC 전용(개인키로 서명)
//   사용: node scripts/make-full-dist.js --version 3.9.2 [--notes "바뀐 점…"] [--no-zip]
//   · 기준은 포터블 폴더 dist/win-unpacked (먼저 변경 파일을 동기화해 둘 것)
//   · 만드는 것 (dist/ 아래)
//       1) win-unpacked_<버전>_정식판_<날짜>.zip  — 새 PC에 처음 깔 때 (안쪽 폴더 이름은 예전처럼 win-unpacked/)
//       2) PDF분석기-정식판-업데이트-<버전>.pdfupd — 체험판으로 깔린 PC를 정식판으로 바꿀 때
//          (앱 창 메뉴 Alt → Help → '🔄 업데이트 적용' — 업데이트 적용은 체험 기간이 끝난 PC에서도 된다)
//   · 정식판 표시는 resources/app/full-license.dat(관리자 키 서명, license.js readFull) 한 파일이다.
//     dist/win-unpacked(관리자 PC 포터블)에는 넣지 않는다 — 따로 복사한 폴더(dist/_full-staging)에서만.
//   · 버전은 저장소 package.json과 dist/win-unpacked의 package.json도 함께 올린다(make-update.js와 같은 규칙).
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const license = require(path.join(ROOT, 'license.js'));
const updater = require(path.join(ROOT, 'updater.js'));

const args = process.argv.slice(2);
const arg = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(DIST, 'win-unpacked');
const STAGE_ROOT = path.join(DIST, '_full-staging');
const STAGE = path.join(STAGE_ROOT, 'win-unpacked');
const mb = n => (n / 1048576).toFixed(1) + 'MB';

const admin = license.adminData();
if (!admin || !license.isAdminPC()) { console.error('✘ 이 PC에는 관리자 개인키가 없습니다 — 정식판은 관리자 PC에서만 만들 수 있습니다.'); process.exit(1); }

const appPkgPath = path.join(SRC, 'resources', 'app', 'package.json');
const appPkg = JSON.parse(fs.readFileSync(appPkgPath, 'utf8'));
const version = arg('--version') || appPkg.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) { console.error('✘ 버전은 3.9.2 같은 형식이어야 합니다: ' + version); process.exit(1); }
if (updater.compareVersions(version, appPkg.version) < 0) { console.error(`✘ 새 버전(${version})이 지금 포터블 버전(${appPkg.version})보다 낮습니다.`); process.exit(1); }
const notes = arg('--notes') || '🔓 정식판 — 체험 키 없이 모든 기능(저장·출력)을 씁니다.';

// 1) 버전 맞추기 — 관리자 포터블·저장소
if (appPkg.version !== version) { appPkg.version = version; fs.writeFileSync(appPkgPath, JSON.stringify(appPkg, null, 2) + '\n', 'utf8'); }
const repoPkgPath = path.join(ROOT, 'package.json');
const raw = fs.readFileSync(repoPkgPath, 'utf8');
const fixed = raw.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`);
if (fixed !== raw) fs.writeFileSync(repoPkgPath, fixed, 'utf8');

// 2) 따로 복사한 폴더에 정식판 표시 넣기 (사용자 자료가 섞이지 않게 실행 폴더만)
console.log('📁 포터블 폴더 복사 중…');
fs.rmSync(STAGE_ROOT, { recursive: true, force: true });
fs.cpSync(SRC, STAGE, { recursive: true });
const tok = license.makeFullToken(admin.priv, `정식판 ${version}`);
const fullFile = path.join(STAGE, 'resources', 'app', 'full-license.dat');
fs.writeFileSync(fullFile, tok + '\n', 'utf8');
// 만든 표시를 공개키로 다시 확인
const p = license.verifyToken(tok);
if (!p || p.format !== license.FULL_FORMAT) { console.error('✘ 정식판 표시 서명 확인 실패'); process.exit(1); }

// 3) 업데이트 파일 — 체험판 PC를 정식판으로
const { bytes, manifest } = updater.buildUpdate({ installDir: STAGE, version, notes, includeModules: false, privPem: admin.priv });
const back = updater.readUpdate(bytes);
const m = back.manifest || back;
if (!(m.files || []).some(f => f.p === 'resources/app/full-license.dat')) { console.error('✘ 업데이트 파일에 정식판 표시가 빠졌습니다'); process.exit(1); }
const updOut = path.join(DIST, `PDF분석기-정식판-업데이트-${version}.pdfupd`);
fs.writeFileSync(updOut, bytes);
console.log(`✔ 업데이트 파일: ${updOut}\n  파일 ${manifest.files.length}개 · ${mb(bytes.length)}`);

// zip 만들기 — PowerShell 5.1의 ZipFile.CreateFromDirectory는 경로를 '\'로 적는다(표준은 '/') — 항목을 하나씩 '/' 경로로 넣는다
//   src 폴더 자체가 zip 안의 맨 위 폴더가 된다
function makeZip(src, out) {
  fs.rmSync(out, { force: true });
  const ps = `Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem;
    $base = Split-Path -Parent $env:ZSRC; $zip = [IO.Compression.ZipFile]::Open($env:ZOUT, 'Create');
    try { Get-ChildItem -LiteralPath $env:ZSRC -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($base.Length + 1).Replace('\\', '/');
      [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $_.FullName, $rel, [IO.Compression.CompressionLevel]::Optimal) } }
    finally { $zip.Dispose() }`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { env: Object.assign({}, process.env, { ZSRC: src, ZOUT: out }), stdio: 'inherit' });
}
const d0 = new Date();
const ymd = `${d0.getFullYear()}${String(d0.getMonth() + 1).padStart(2, '0')}${String(d0.getDate()).padStart(2, '0')}`;

// 4) zip — 새 PC용 (안쪽 폴더 win-unpacked/)
if (!args.includes('--no-zip')) {
  const zipOut = path.join(DIST, `win-unpacked_${version}_정식판_${ymd}.zip`);
  console.log('🗜 새 PC용 zip 만드는 중… (1~2분)');
  makeZip(STAGE, zipOut);
  console.log(`✔ 정식판 zip: ${zipOut}\n  ${mb(fs.statSync(zipOut).size)}`);
}

// 5) 덮어쓰기 zip — 업데이트 기능이 없는 옛 버전(3.8 이하)용 (2026-10-30 사용자 요청)
//    Electron이 같으므로(31) resources/app만 바꾸면 된다. zip 안: 업데이트.bat + update-from-old.ps1 + app/(새 resources/app 전체) + root/(실행 폴더 스크립트)
//    받는 PC: 압축을 풀고 '업데이트.bat' 더블클릭 → 설치 폴더 자동으로 찾기(보내기 바로 가기·실행 중인 앱·폴더 고르기) → 원래 app은 app.bak-…로 남기고 교체
if (!args.includes('--no-zip')) {
  const owRoot = path.join(STAGE_ROOT, 'ow'), ow = path.join(owRoot, `PDF분석기-업데이트-${version}`);
  fs.rmSync(owRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(ow, 'root'), { recursive: true });
  fs.cpSync(path.join(STAGE, 'resources', 'app'), path.join(ow, 'app'), { recursive: true });
  for (const f of fs.readdirSync(STAGE)) {
    if (/\.(ps1|bat|txt|pdf)$/i.test(f) && !/^LICENSE/i.test(f) && fs.statSync(path.join(STAGE, f)).isFile()) fs.copyFileSync(path.join(STAGE, f), path.join(ow, 'root', f));
  }
  fs.copyFileSync(path.join(ROOT, 'scripts', 'old-update', 'update-from-old.ps1'), path.join(ow, 'update-from-old.ps1'));
  fs.copyFileSync(path.join(ROOT, 'scripts', 'old-update', 'update.bat'), path.join(ow, '업데이트.bat'));
  fs.writeFileSync(path.join(ow, '읽어보기.txt'), [
    `PDF 분석기 ${version} 정식판 — 옛 버전(3.8 이하)에서 올리기`, '',
    '1. 이 zip을 아무 곳에나 모두 풉니다(바탕화면 등).',
    "2. 풀린 폴더의 '업데이트.bat'를 더블클릭합니다.",
    '   - 설치된 PDF 분석기 폴더를 자동으로 찾습니다(못 찾으면 폴더를 고르는 창이 뜹니다).',
    '   - 앱이 켜져 있으면 닫으라고 안내합니다.',
    "   - 원래 프로그램은 resources\\app.bak-옛버전-날짜 폴더로 남겨 둡니다(문제가 있으면 이름을 app으로 되돌리면 원래대로).",
    '3. 끝나면 앱을 켭니다 — 체험 키 없이, 사용 기한 없이 저장·출력됩니다.', '',
    '설정·프리셋·작업 기록은 그대로 남습니다.',
    "다음부터는 앱의 창 메뉴(Alt) Help → '업데이트 적용'으로 .pdfupd 파일을 적용하면 됩니다.", '',
  ].join('\r\n'), 'utf8');
  const owOut = path.join(DIST, `PDF분석기-정식판-3.8용-덮어쓰기-${version}.zip`);
  console.log('🗜 3.8용 덮어쓰기 zip 만드는 중…');
  makeZip(ow, owOut);
  console.log(`✔ 3.8용 덮어쓰기 zip: ${owOut}\n  ${mb(fs.statSync(owOut).size)}`);
}
fs.rmSync(STAGE_ROOT, { recursive: true, force: true });   // 복사본(약 450MB) 정리 — 결과는 zip·업데이트 파일에 있다
console.log(`\n받는 PC
  · 새로 깔 때: zip을 풀어 '설치.bat' 또는 'PDF 분석기.exe' — 체험 키 창이 뜨지 않습니다
  · 체험판으로 깔린 PC: 앱에서 Alt → Help → '🔄 업데이트 적용'(또는 왼쪽 패널 ⚙) → 정식판 업데이트 파일 선택 → 자동 재시작
  · 3.8 이하(업데이트 기능 없음): '3.8용 덮어쓰기' zip을 풀고 '업데이트.bat' 더블클릭 — 설정은 그대로 남습니다`);
