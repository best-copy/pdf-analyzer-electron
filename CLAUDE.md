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
src/seam-repair.js 사진 띠 이음매 흰 줄 보정 — pdf.js 렌더 공용(renderPageNoSeams). index·editor·E-book 독립 도구가 같은 파일
src/worker-gray.js 흑백변환 워커 — 콘텐츠 스트림 연산자 치환·이미지 그레이화 (CMYK JPEG 정밀 디코드)
src/worker-assemble.js 병합·조립 워커
src/libs/          vendored: pdf.js, pdf-lib, fontkit, pako, jpeg-decoder.js(jpeg-js 0.4.4),
                   gray-jpeg.js(자체 1성분 JPEG 인코더 — 흑백 사진 재인코딩),
                   gray-blend.js(저장 직전 투명도 흑백 합성 그룹 — 앱·조립 워커·편집기·임포징 도구 공용)
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
- 캐시: `_bwCache`(originalIdx→변환 문서의 쪽, **상한 없음** — 함정 9), 분석 후 `prewarmInkNorm`, 적용 후 `prewarmOptimizedOutput`이 유휴 시간에 미리 계산.
- **Dot Gain**(◐ 없음·10·15·20%): 앱 전체 설정, **기억하지 않음 — 켤 때마다 없음(0)**(사용자 지시 2026-09-17 · 옛 저장값 `dotGainLevel`은 켤 때 지움). 곡선은 `dotGainCurve` 하나 — **worker-gray.js와 app-process.js 두 벌이 같은 식**이어야 한다(`gray-colorspace.test.js`가 대조). 값은 `baseSignature`에 들어가 캐시가 갈린다.

### 3.3 임포징 (app-process.js, 모드 4종)
- 공용: `embedAllPages(out, src, onProgress, extraRot)` — **pdf-lib `embedPage`는 `/Rotate`를 무시하므로 변환행렬로 굽는다** (90°: `[0,-1,1,0,0,w]`, 180°: `[-1,0,0,-1,w,h]`, 270°: `[0,1,-1,0,h,0]`).
- 순서 계산은 **순수 함수로 분리**(`bookletSheetOrder`, `cutStackOrder`, `dup2upOrder`) — 노드에서 단독 검증 가능해야 한다.
- 공통 옵션: 용지(표준+사용자정의 `localStorage customPapers`), 여백, 거터, 블리드(트림 대비 확대), 재단선(`drawCropMarks`).
- 생성 직후 `renderProcessedPreview(res.bytes)`로 결과를 화면에 표시하고 저장 다이얼로그를 띄운다.
- 모드: 중철(북클릿), 정합(Cut&Stack 2/4분할·단면/양면·뒷면 열 미러), 반복(Step&Repeat), 복제 2부(`1 1* 2* 2` — Quite Imposing 방식, 오른쪽 벌 180°).

### 3.4 분리 저장 (✂)
- 완성본을 **N쪽 단위**(10·20·대수 16 등) 또는 **쪽 범위**(`21-39`, `1-20, 41-60`)로 나눠 한 폴더에 저장한다.
- 최종 바이트는 다운로드와 **같은 `buildFinalSaveBytes`**(최적화 → 목차 북마크 → 폰트 안전화 → 컬러 검수)를 쓴다 — 두 경로가 갈라지면 한쪽에만 단계가 빠진다.
- 버튼 좌클릭 = 적용본, **우클릭 = 원본 그대로**(⇩ 다운로드와 같은 규칙). 적용 전이라고 버튼을 `disabled`로 두지 말 것 — disabled 버튼은 `contextmenu`도 먹지 않아 우클릭이 죽는다(흐리게만).
- 구간 계산은 순수 함수 `splitRangesEveryN`·`parseSplitRanges`·`splitPartFileName`(`split-save.test.js`). 저장은 `dialog:pickSplitFolder`(폴더 1회 선택)+preload `saveFilesToFolder`(같은 이름이면 `-1`). 나눈 파일에는 목차 북마크가 없다. `split-save.e2e.js`.

### 3.5 견적서
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
10. **pdf.js로 쪽을 그림으로 굽는 곳은 `renderPageNoSeams`를 쓸 것** — 한글·오피스 변환 PDF는 사진을 가로 띠로 잘라 넣어, pdf.js 렌더에 띠 경계마다 1px 흰 줄이 구워진다. 그림 위치는 렌더 중 drawImage 가로채기로 얻는다(`getOperatorList`를 따로 부르면 페이지를 두 번 해석해 렌더 +93%).
9. **탭 전환·파일 교체·내부편집 중 캐시 오염**: 탭 id 비교만으로는 부족하다(파일 교체는 탭 id를 유지). 모든 비동기 빌드는 시작할 때 `_cacheGen`을 기억하고 **캐시에 쓰기 전·결과를 붙이기 전** 비교해 다르면 `staleCacheError()`를 던진다(`clearProcessCaches`가 세대를 올린다). 진행 중 빌드 합류(`_optInflight`)도 서명+세대로. `_bwCache`에 상한(FIFO)을 두지 말 것 — 800쪽 넘으면 방금 넣은 쪽이 지워져 적용본이 빈 A4가 됐다. `scripts/test/cache-generation.e2e.js`.
11. **흑백 색 연산자는 성분 수로 색을 짐작하지 말 것** — `/DeviceGray cs 0 sc`(검정)를 별색으로 보고 흰색으로 뒤집었다. 색공간 정의를 `buildCsDesc`(app-process)로 설명자로 만들어 워커 `csToGray`가 계산한다(별색·DeviceN 함수 Type 0/2/3/4, Indexed 번호표, Lab). **ICCBased N=3이 RGB라는 보장이 없다** — 팬톤 대체 색공간은 Lab ICC라 헤더 서명(16~19바이트)으로 가린다. 모르면 성분 수 추정으로라도 회색화(컬러 과금 방지). 회귀: `gray-colorspace.test.js`, 실파일은 옛/새 코드를 gs로 원본 밝기와 대조(흰색 반전 픽셀 수).
12. **콘텐츠 스트림을 못 풀었으면(LZW·필터 배열·inflate 실패) 그 쪽의 색공간 리소스를 지우지 말 것** — 남은 `/CS0 cs`가 없는 리소스를 불러 Acrobat 페이지 오류. `streamSkipped` 참조.
14. **작업 파일(.pdfw)은 한 버퍼로 합치지 말 것** — 원본·적용본을 합치면 2GB 버퍼 한계를 넘어 저장이 실패했다. 저장은 `packWorkFileParts` 조각을 preload `writeBig`이 이어 쓰고, 열기는 `readWorkFileFromPath`가 `readFileRange`로 조각별로 읽는다(형식은 그대로). 압축 저장은 PDF가 이미 압축돼 실측 86.6%(대부분 95~99%)라 채택하지 않았다. `workfile-2gb.e2e.js`.
15. **흑백 사진을 캔버스 JPEG로 되돌리지 말 것** — Chromium 캔버스는 1성분 JPEG를 못 만들어 회색을 R=G=B **RGB JPEG**로 담았고, 프린터·gs inkcov가 CMY를 잡아 컬러로 셀 수 있었다. `jpeg2gray`는 `libs/gray-jpeg.js`(허프만 최적화, q82)로 **DeviceGray JPEG**를 만든다 — 실측 158장에서 용량 94%·PSNR 동일, 실파일 28개 회귀에서 사진 CMY 9개 파일 → 0. Flate 무손실은 177~213%라 폴백 전용. DHT 길이 1바이트만 틀려도 jpeg-js는 받고 Chromium은 거부하니 `gray-jpeg.test.js`와 pdf.js 렌더로 함께 확인.
16. **흑백으로 다 바꿔도 투명도 쪽은 프린터가 컬러로 셀 수 있다** — 페이지에 투명도 그룹(/Group)이 없으면 gs·RIP이 기본 출력 색공간에서 합성해, **격리 투명도 그룹 폼(/Group /I true)**이 있는 쪽은 회색이 C=M=Y+K로 나온다(단순 ca·SMask는 재현 안 됨). 흑백변환 쪽만 고치면 안 된다 — 임포징·모아찍기의 `embedPage` 판에는 그룹이 없어 되살아나고 폼에 그룹을 달아도 무효(실측). 그래서 **모든 저장이 지나는 `savePdfDoc`**(app-core·worker-assemble·editor·임포징 독립 도구 네 벌 — 한 줄 그대로 유지)이 `libs/gray-blend.js` `addGrayBlendGroups`로 "그룹 없음 + 투명도 사용 + 그리는 색이 전부 무채색"인 쪽에만 DeviceGray 그룹을 단다. 컬러가 한 점이라도 있으면 달지 않는다(색이 회색으로 합성됨). 실파일 28개 CMY 11개 → 0. `gray-blend.test.js`, `gray-blend-imposition.e2e.js`(중철·다운로드까지 gs inkcov).
17. **부속 스트림(색상표·ICC·함수 표본)을 Flate만 풀지 말 것** — ASCII85 색상표 Indexed 이미지가 통째로 건너뛰어져 컬러로 남았다. `pdfStreamDecoded`(Flate는 잘린 스트림 복구, 그 밖은 pdf-lib 디코더, 예측자 있으면 null). 인라인 이미지 사전 안 색상표(`/CS [/I /RGB n <…>]`)는 워커 `inlineIndexedToGray`가 색상표만 회색으로.
18. **흑백으로 바꿀 쪽과 그대로 둘 쪽을 한 번의 `copyPages`로 같은 문서에 넣고 제자리 변환하지 말 것** — 두 쪽이 같은 이미지·폼 객체를 공유하면(반복 게재한 사진 등) 흑백 쪽을 변환할 때 컬러 쪽도 회색이 된다. 실파일 `칼7흑213.pdf`: 화면(적용본)은 컬러 7쪽인데 저장본은 3쪽만 컬러 → 프린터도 3쪽만 컬러. 적용 경로(`ensureBwConverted`)는 흑백 쪽만 따로 복사해 멀쩡했고 다운로드 경로(`buildBaseOptimized`)만 전 쪽을 한 번에 복사했다. 두 묶음으로 나눠 복사한다(묶음 안 공유는 유지). 대가: 두 묶음이 함께 쓰던 글꼴이 두 벌(실측 +133KB, 약 3%). `scripts/test/bw-shared-image.e2e.js`(합성 + 실파일 인자).
19. **`pako.inflate`의 실패는 예외가 아니라 `undefined`일 수 있다** — zlib 체크섬(adler32)이 틀리거나 빠진 콘텐츠 스트림(실파일 28개·5,393개 스트림 중 11개)에서 워커 `stream-grayify`가 TypeError로 죽어 **그 쪽 전체가 컬러로 저장**됐다. Acrobat·pdf-lib은 그대로 열어 화면은 멀쩡하다. 결과는 `ArrayBuffer.isView`로 확인하고(vm 테스트에선 `instanceof Uint8Array`가 realm이 달라 거짓), 실패하면 zlib 머리 2바이트를 떼고 raw deflate(`inflateRawTolerant`·`inflateLenient`)로 푼다 — 복구 10개 모두 pdf-lib과 바이트 일치. `inflate-tolerant.test.js`.
20. **저장본 컬러 검수(`checkColorIntent`)를 끄거나 분석값(isColor)만으로 바꾸지 말 것** — 다운로드 base(`buildBaseOptimized`)가 저장 직전 쪽마다 `pageIsNeutral`(렌더 없이 내용만)로 ① 흑백 대상인데 색이 남은 쪽 ② **원본에 색이 있었는데** 저장본이 무채색이 된 쪽을 찾아 저장 전 확인창을 띄운다. 분석값만 믿으면 K 100% 검정을 pdf.js가 따뜻한 RGB로 그려 헛경보가 난다(실파일 59쪽). 먹 한 가지(`/Separation /Black`, `/DeviceN [/Black]`)는 무채색. 실파일 28개 × 두 경우 헛경보 0, 진짜로 남은 색 5쪽을 찾아냄(→ 19번). pdf.js 렌더 비교는 224쪽에 76~213초라 기각.
21. **같은 쪽을 `embedPage`로 두 번 임베드하지 말 것 — 겉 폼으로 재사용** — pdf-lib `embedPage`는 호출마다 그 쪽의 사진·폰트를 통째로 새로 복사한다. 복제 2-up(`buildDup2upBytes`)이 정방향·180° 두 벌을 임베드해 결과가 원고의 2배(도록 150쪽 적용본 952MB → 1,956MB)가 됐고, 렌더러 버퍼 한계(단일 ArrayBuffer <2GiB·렌더러 합계 ≈14GB, Electron 31 실측)에 걸려 "Array buffer allocation failed"로 적용이 실패했다. 180° 벌은 `rotate180Embeds`가 정방향 폼을 `/P0 Do`로 부르는 겉 폼으로 만든다(트림 인셋 l↔r·b↔t 교환, 결과 978MB·옛/새 gs 렌더 픽셀 동일). 임포징 독립 도구 BUILDERS에도 같이. `dup-2up-memory.e2e.js`·`dup-2up-flow.e2e.js`·`dup-2up-realapp.e2e.js`.
13. **COM 변환(한글·Office·Adobe)은 사용자가 켜 둔 앱에 붙을 수 있다** — 스크립트가 새로 띄운 프로세스만 `COMPID:n`으로 알리고, 그때만 Quit·시간 초과 시 taskkill. 켜져 있던 앱이면 우리가 연 문서만 닫는다. Office는 `AutomationSecurity=3`(매크로 차단). **한글 보안창 워처**도 같은 이유로 좁힌다: '접근하려는 시도' 창만(확인·예·계속은 절대 안 누름), 켜져 있던 한글이면 창에 **변환 중 파일 이름**이 보일 때만 '접근 허용'(모두 허용 아님), 진짜 마우스 클릭은 그 좌표 맨 위가 그 버튼일 때만(가려지면 앞으로 올리기만). 예전 워처는 사용자 한글의 저장 확인 [확인]·다른 파일 보안 창까지 눌렀다(가짜 대화상자로 재현). `scripts/test/hwp-dialog-watch.test.ps1`(왼쪽 모니터에 가짜 창을 띄워 실제 클릭 — smoke에는 안 넣음).

## 6. UI 규약

- 버튼/섹션 제목: `이모지 + 한글` (예: `📖 임포징 PDF 생성`). 이모지가 컬러면 무채색 필터 적용.
- 진행 표시: 하단 중앙 고정 토스트(`showLoading` + `updateProgress`) — 완료 시 사라짐. 상단 인라인 진행바는 사용 안 함.
- 성공 메시지(`showSuccess`): 여러 줄 허용(`white-space:pre-line`). **결과 요약 + 인쇄/후속 지침**(예: "가로 용지 · 양면 · 짧은 쪽 넘김 → 재단 → …")을 포함.
- 파괴적/외부 동작 전 confirm. 옵션 기본값은 실무에서 가장 자주 쓰는 값(예: 잉크 정규화 ON, 정합 양면).
- 새 옵션은 편집 사이드바의 해당 섹션에 `es-row`/`es-chip` 패턴으로 추가하고, 모드별 표시 토글은 `setImpMode` 스타일을 따른다.

## 7. 검증 방법론

**"동작한다"의 기준은 눈과 수치다. 코드가 그럴듯한 것은 증거가 아니다.**

1. **스모크**: `npm run smoke` — 모든 커밋 전. 검사 모드(`TEST_WINDOW=left`)는 사용자 폴더를 따로 써서(사용자가 켜 둔 앱과 단일 인스턴스 잠금이 겹치지 않게) 부팅하고, 앱이 찍는 `[SMOKE] BOOT_OK`가 없으면 실패다 — 예전엔 앱이 곧바로 꺼져도 로그가 비어 '통과'였다. 검사 모드는 임시파일 정리·원격 서버·인쇄 감시를 돌리지 않는다.
2. **파이프라인 로직**: 순수 함수(순서 계산 등)는 스크래치 폴더에 노드 테스트를 만들어 **앱 파일에서 함수를 추출(eval)해 실제 코드로** 검증한다. 테스트용 복사본을 따로 만들지 말 것(드리프트).
3. **PDF 출력 시각 검증**: Ghostscript로 렌더해 이미지를 직접 확인한다.
   `"C:\Program Files\gs\gs10.07.1\bin\gswin64c.exe" -q -dNOPAUSE -dBATCH -sDEVICE=png16m -r72 -o out_%d.png in.pdf`
   방향/배치 검증에는 번호+색띠를 넣은 합성 PDF(pdf-lib로 생성)를 쓴다.
4. **계조·색 문제는 정답 기준 캘리브레이션**: 추측으로 공식을 고르지 말고, (a) 문제 이미지를 담은 최소 PDF를 수제작 → (b) gs pgmraw 1:1 렌더 = 정답 → (c) 후보 공식들을 픽셀 대조해 평균 오차로 확정한다. (CMYK JPEG 수정이 이 방법으로 해결됨)
5. **워커 검증**: 오프스크린 Electron 스크립트로 실제 워커를 구동해 입출력을 확인한다 (worker는 DOM 없는 노드에서 못 돌림).
6. **회귀**: 3comp JPEG 등 기존 경로가 깨지지 않았는지 함께 확인.
7. **검사 창은 가장 왼쪽 모니터**: 주 모니터는 사용자 작업 공간이다. 창을 띄우는 하네스는 `{ show:true, width, height, ...leftWin(width, height) }`(scripts/test/_leftwin.js — 크기 **뒤에** 둬야 좁은 화면에 맞춰 줄인다), 앱 본체를 띄울 때는 환경변수 `TEST_WINDOW=left`(모든 프로젝트 공통 이름 · 옛 이름 `PDFEDIT_TEST_WINDOW`도 받는다 · smoke가 넘긴다). 애니메이션을 재지 않으면 `show:false`(숨긴 창은 rAF가 1fps로 조여진다).

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
