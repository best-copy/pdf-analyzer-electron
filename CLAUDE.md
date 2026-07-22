# PDF Editor (pdf-analyzer-electron) — 프로젝트 지침

> 이 문서는 **어떤 AI 모델이 작업하더라도** 동일 품질의 결과를 내도록 만든 프로젝트 지침이다.
> 작업 전 반드시 전체를 읽고, 특히 [절대 규칙](#0-절대-규칙)과 [함정 목록](#5-알려진-함정--반드시-피할-것)을 숙지할 것.

## 0. 절대 규칙

1. **검증 없이 완료 보고 금지.** 코드 변경 후 최소 `npm run smoke`(전 JS 구문검사 + 12초 부팅 오류 검출) 통과. PDF 파이프라인 변경 시 [7. 검증 방법론](#7-검증-방법론)의 절차 필수.
2. **배포는 포터블 앱 동기화만.** 변경 파일을 `dist/win-unpacked/resources/app/` 아래 같은 경로로 복사한다. exe 재빌드·zip 재생성은 사용자가 요청할 때만.
3. **스크립트 로드 순서 변경 금지.** `index.html`의 `<script>`는 `app-core.js → app-process.js → app-ui.js` 순서. 클래식 스크립트라 최상위 선언이 파일 간 전역 공유되며, 뒤 파일이 앞 파일을 참조한다.
4. **UI 문자열은 한국어 + 인쇄 실무 용어.** (중철, 정합, 거터, 블리드, 재단선, 밀림보정, 짧은 쪽 넘김…) 성공 메시지에는 항상 "다음 행동" 안내를 포함한다.
5. **테마는 Black & Yellow.** 검정 `#1d1d1f` / 노랑 `#ffd60a` / 회색 보조 `#48484a`. 새 UI 요소도 이 팔레트. 컬러 이모지는 `filter: grayscale(1)` 또는 `.ic` 클래스로 무채색화.
6. **대용량 데이터를 IPC로 직렬화 금지.** 50MB+ PDF 바이트는 임시파일(`writeTempFile`, tmpdir의 `pdfedit_*` 접두사)로 경로만 주고받는다. 임시파일 정리 규칙은 main.js `sweepTempConversions` 참조.

## 1. 프로젝트 개요

- **무엇**: 인쇄소 실무용 Electron PDF 도구. 문서 수집(PDF·HWP·Office·Adobe 자동 변환) → 컬러/흑백 분석 → 페이지 편집 → 흑백변환·잉크 정규화 → 임포징 → 견적서.
- **사용자**: 인쇄소 운영자 1인. 프린터 과금(컬러 장수)과 재단·제본 실무가 핵심 관심사.
- **스택**: Electron 31, pdf-lib 1.17.1(수정), pdf.js(vendored), pako, jpeg-js(vendored·주의사항 있음), Web Worker 풀. 빌드: electron-builder portable.

## 2. 파일 구조와 역할

```
main.js            Electron 메인 — 창·IPC(파일 다이얼로그, HWP/Office/Adobe 변환 큐,
                   printToPDF, fonts:list, ink:coverage(gs inkcov), temp 정리)
preload.js         contextBridge — fs 직접 읽기/쓰기(saveFile·readFile·writeTempFile), IPC 래퍼
src/index.html     마크업만 (~600줄). 스크립트/스타일은 외부 파일
src/style.css      전체 스타일 (테마 팔레트 포함)
src/app-core.js    분석(멀티 pdf.js 문서 병렬)·탭·흑백 파이프라인(isBwTarget, _bwCache, 프리웜)
src/app-process.js 변환기(convertPageToGrayscaleVector)·다운로드 최적화·병합·견적·임포징 4종
src/app-ui.js      좌측 사이드바·우측 편집 사이드바·미리보기(renderProcessedPreview)·부트스트랩
src/editor.html    페이지 내부 콘텐츠 편집기 (별도 BrowserWindow, 임시파일로 PDF 수수)
src/worker-gray.js 흑백변환 워커 — 콘텐츠 스트림 연산자 치환·이미지 그레이화 (CMYK JPEG 정밀 디코드)
src/worker-assemble.js 병합·조립 워커
src/libs/          vendored: pdf.js, pdf-lib, fontkit, pako, jpeg-decoder.js(jpeg-js 0.4.4)
src/convert_*.ps1  한글/Office/Adobe COM 변환 스크립트 (convert_hwp.ps1은 UTF-8 BOM 필수)
scripts/smoke.js   npm run smoke
```

**전역 공유 규칙**: 세 app-*.js는 모듈이 아니다. 최상위 `let/const/function`이 공유 전역이다.
새 **최상위 즉시 실행문**(IIFE·직접 호출)은 참조 대상이 같은 파일 앞쪽 또는 이전 파일에 있어야 한다(함수 호이스팅은 파일 경계를 넘지 않음). 이벤트 핸들러 내부 참조는 어느 파일이든 무방.

## 3. 핵심 파이프라인

### 3.1 분석 (app-core.js)
- pdf.js는 **문서당 워커 1개** → 같은 바이트로 보조 문서 2~3개를 추가 로드해 실병렬(8p 이상·96MB 미만).
- 페이지별: 저해상 렌더 → 15k 픽셀 샘플 RGB 중성 판정(`r≈g≈b`) → 썸네일 toBlob(파이프라인 비블로킹, promise 수집 후 일괄 대기) → `page.cleanup()`.
- **분석은 RGB 기준**이므로 리치블랙(CMYK 회색)은 흑백으로 판정됨 — 프린터 과금과의 차이는 '잉크 정규화'와 '🧾 프린터 판정'(gs inkcov)이 담당.

### 3.2 흑백변환·잉크 정규화
- **대상 판정은 `isBwTarget(r)`(app-core.js) 단일 함수** — 적용(buildBaseProcessed)과 다운로드(buildBaseOptimized) 두 파이프라인이 공유한다. 한쪽에만 조건을 추가하면 과거처럼 "다운로드본에서 정규화 누락" 버그가 재발한다.
- 잉크 정규화(`processingOptions.inkNorm`, 기본 ON): 흑백 판정 페이지도 DeviceGray로 강제 — 프린터가 흑백으로 과금하게 함.
- Dot Gain은 `_dotGainCtx`(WeakMap, pdfDoc별) — 회색 판정 페이지는 항상 0 강제.
- 캐시: `_bwCache`(originalIdx→단일페이지 doc, 상한 800 FIFO), 분석 후 `prewarmInkNorm`, 적용 후 `prewarmOptimizedOutput`이 유휴 시간에 미리 계산.

### 3.3 임포징 (app-process.js, 모드 4종)
- 공용: `embedAllPages(out, src, onProgress, extraRot)` — **pdf-lib `embedPage`는 `/Rotate`를 무시하므로 변환행렬로 굽는다** (90°: `[0,-1,1,0,0,w]`, 180°: `[-1,0,0,-1,w,h]`, 270°: `[0,1,-1,0,h,0]`).
- 순서 계산은 **순수 함수로 분리**(`bookletSheetOrder`, `cutStackOrder`, `dup2upOrder`) — 노드에서 단독 검증 가능해야 한다.
- 공통 옵션: 용지(표준+사용자정의 `localStorage customPapers`), 여백, 거터, 블리드(트림 대비 확대), 재단선(`drawCropMarks`).
- 생성 직후 `renderProcessedPreview(res.bytes)`로 결과를 화면에 표시하고 저장 다이얼로그를 띄운다.
- 모드: 중철(북클릿), 정합(Cut&Stack 2/4분할·단면/양면·뒷면 열 미러), 반복(Step&Repeat), 복제 2부(`1 1* 2* 2` — Quite Imposing 방식, 오른쪽 벌 180°).

### 3.4 견적서
컬러/흑백 장수 × 단가(localStorage 기본 단가) → 견적 테이블·인쇄·PDF 저장. 파일명에 금액 표기 옵션.

## 4. IPC·프로세스 경계

| 채널 | 방향 | 용도 |
|---|---|---|
| `dialog:openFile` / `dialog:saveFilePath` | R→M | 경로만. 내용은 preload fs 직접 |
| `hwp/office/adobe:convertToPdf` | R→M | COM 변환(각각 직렬 큐), 임시 PDF 경로 반환 |
| `ink:coverage` | R→M | gs inkcov (gs는 PATH 또는 `C:\Program Files\gs\gs*` 자동 탐색) |
| `editor:open/pull/save/close` | 양방향 | 내부 편집기 창 — 페이로드는 경로+작은 JSON만 |
| `print:toPDF` | R→M | 견적서 HTML → PDF |

## 5. 알려진 함정 — 반드시 피할 것

1. **pdf-lib `embedPage`는 `/Rotate` 무시** → 임포징·조판에서 회전 페이지는 반드시 변환행렬로 굽기 (3.3 참조).
2. **CMYK(4comp) JPEG**: Chromium 네이티브 디코드는 네거티브를 만들고, **jpeg-js 0.4.4 내장 CMYK→RGB도 틀리다**(GS 대비 오차 118/255). worker-gray.js는 `JpegImage.getData` raw를 받아 **캘리브레이션된 공식**(`gray = lum(보색채널) × data[3]/255`, 오차 8/255)을 쓴다. 이 경로를 "정리"한답시고 jpeg-js decode()의 RGB 출력으로 바꾸지 말 것.
3. **흑백변환 정규식**: 색상 연산자 치환에 좌측경계 `_LB='(?<![\w/.#-])'` 필수 — 없으면 패턴명 `/P8`의 숫자를 틴트로 오매칭해 `/P-7.0000 g` 같은 깨진 토큰이 생기고 Acrobat이 "페이지 오류"를 낸다. `/Pattern cs`는 제거 금지.
4. **색공간을 DeviceGray로 바꿀 때 부속 배열 동기화**: ExtGState SMask의 `/BC`, 이미지 SMask의 `/Matte`는 성분 수를 새 색공간에 맞출 것(부모 이미지 색공간 기준).
5. **TTC 폰트는 pdf-lib 임베드 불가** — 폰트 목록에서 제외돼 있음.
6. **HWP 변환**: convert_hwp.ps1은 UTF-8 BOM 필수, 한글은 단일 인스턴스라 큐 직렬화. 가로형(WIDELY) 문서 용지 폴백 이슈는 미해결(사후보정 금지 — 실패했던 접근).
7. **PGM/PPM 파싱 시 `#` 주석 줄 스킵** — 안 하면 전체 오판정.
8. **Grep 도구가 한글+특수문자를 깨져 보이게 렌더링할 수 있음** — 파일 손상으로 오판하지 말고 `cat -A`나 Read로 재확인 후 수정할 것.
9. **탭 전환 시 캐시 오염**: 백그라운드 프리웜은 시작 시점 탭 id를 기억하고, 끝났을 때 탭이 바뀌었으면 `clearProcessCaches()`로 전부 폐기한다. 새 백그라운드 작업도 같은 패턴을 따를 것.

## 6. UI 규약

- 버튼/섹션 제목: `이모지 + 한글` (예: `📖 임포징 PDF 생성`). 이모지가 컬러면 무채색 필터 적용.
- 진행 표시: 하단 중앙 고정 토스트(`showLoading` + `updateProgress`) — 완료 시 사라짐. 상단 인라인 진행바는 사용 안 함.
- 성공 메시지(`showSuccess`): 여러 줄 허용(`white-space:pre-line`). **결과 요약 + 인쇄/후속 지침**(예: "가로 용지 · 양면 · 짧은 쪽 넘김 → 재단 → …")을 포함.
- 파괴적/외부 동작 전 confirm. 옵션 기본값은 실무에서 가장 자주 쓰는 값(예: 잉크 정규화 ON, 정합 양면).
- 새 옵션은 편집 사이드바의 해당 섹션에 `es-row`/`es-chip` 패턴으로 추가하고, 모드별 표시 토글은 `setImpMode` 스타일을 따른다.

## 7. 검증 방법론

**"동작한다"의 기준은 눈과 수치다. 코드가 그럴듯한 것은 증거가 아니다.**

1. **스모크**: `npm run smoke` — 모든 커밋 전.
2. **파이프라인 로직**: 순수 함수(순서 계산 등)는 스크래치 폴더에 노드 테스트를 만들어 **앱 파일에서 함수를 추출(eval)해 실제 코드로** 검증한다. 테스트용 복사본을 따로 만들지 말 것(드리프트).
3. **PDF 출력 시각 검증**: Ghostscript로 렌더해 이미지를 직접 확인한다.
   `"C:\Program Files\gs\gs10.07.1\bin\gswin64c.exe" -q -dNOPAUSE -dBATCH -sDEVICE=png16m -r72 -o out_%d.png in.pdf`
   방향/배치 검증에는 번호+색띠를 넣은 합성 PDF(pdf-lib로 생성)를 쓴다.
4. **계조·색 문제는 정답 기준 캘리브레이션**: 추측으로 공식을 고르지 말고, (a) 문제 이미지를 담은 최소 PDF를 수제작 → (b) gs pgmraw 1:1 렌더 = 정답 → (c) 후보 공식들을 픽셀 대조해 평균 오차로 확정한다. (CMYK JPEG 수정이 이 방법으로 해결됨)
5. **워커 검증**: 오프스크린 Electron 스크립트로 실제 워커를 구동해 입출력을 확인한다 (worker는 DOM 없는 노드에서 못 돌림).
6. **회귀**: 3comp JPEG 등 기존 경로가 깨지지 않았는지 함께 확인.

## 8. 작업 완료 체크리스트

```
□ npm run smoke 통과
□ 파이프라인 변경 시: 노드 추출 테스트 + gs 렌더 시각 확인
□ 변경 파일 dist/win-unpacked/resources/app/ 동기화
□ 성공 메시지에 후속 행동 안내 포함 (신규 기능 시)
□ 테마(black&yellow)·한국어·이모지 무채색 준수
□ 메모리/작업내역에 비자명한 발견 기록 (함정·공식·검증법)
```

## 9. 참고 문서

- `docs/PROMPT_TEMPLATES.md` — 작업 유형별 프롬프트 템플릿
- `docs/STYLE_PROFILE.md` — 사용자 스타일 프로파일 (결과물 톤 재현용)
- `작업내역*.md` — 날짜별 작업 기록
