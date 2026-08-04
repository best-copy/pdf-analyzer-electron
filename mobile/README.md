# PDF 분석기 — 안드로이드판 (mobile/)

인쇄소 PDF 도구의 안드로이드 이식. **분석·흑백변환·잉크정규화·임포징·병합·견적은 폰 단독**으로 동작하고,
**HWP/Office/Adobe 변환·프린터 잉크판정·견적서 PDF 인쇄는 사무실 PC**(메인 앱의 📱 모바일 연동 서버)에 위임한다.

## 구조

```
mobile/
  capacitor.config.json   앱 ID kr.co.ilchung.pdfanalyzer, webDir=www
  mobile-src/
    mobile-bridge.js      window.electronAPI 어댑터 — 가상경로(mob://) 메모리 맵 + PC 서버 HTTP 위임
    mobile-boot.js        부트로더 — pdf.js 워커 프리로드 후 core→process→ui 순차 로드, 모바일 UI 보정
  scripts/build-www.js    데스크톱 src/ → www/ 변환 (원본 무수정 — 빌드 시점 변환만)
  www/                    빌드 산출물 (git 제외 대상)
  android/                Capacitor 네이티브 프로젝트 + WolPlugin.java (Wake-on-LAN)
```

## 빌드 (이 PC: JDK=D:\Tools\jdk-17.0.20+8, SDK=D:\Tools\Android)

```
cd mobile
npm install
npm run sync          # build-www + cap sync android
cd android
$env:JAVA_HOME='D:\Tools\jdk-17.0.20+8'; $env:ANDROID_HOME='D:\Tools\Android'
$env:JAVA_TOOL_OPTIONS='-Djdk.net.unixdomain.tmpdir=D:\Tools\tmp'   # ★ 필수 — 아래 함정 참조
.\gradlew assembleDebug   # → app\build\outputs\apk\debug\app-debug.apk
```

**★ 이 PC 전용 함정 (다른 PC에선 불필요할 수 있음)**: TEMP가 8.3 축약 경로(`C:\Users\ADMINI~1\...`)라
afunix.sys가 자동 생성 AF_UNIX 소켓 경로의 connect를 WSAEINVAL로 거부 → JDK17 `Selector.open()` 전멸 →
gradle "Unable to establish loopback connection". 해결 = 소켓 임시폴더를 일반 ASCII 경로로:
`JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=D:\Tools\tmp` (gradle.properties의 jvmargs만으론 부족 —
gradle이 -D를 데몬 기동 후에 적용하므로 반드시 환경변수로. Android Studio GUI 빌드 시에도 필요).

## 핵심 설계 (다른 AI/개발자가 이어받을 때)

1. **데스크톱 소스는 수정하지 않는다.** build-www.js가 빌드 시점에만 변환(스크립트 블록 교체·viewport 추가).
   데스크톱에 넣은 모바일 분기는 `window.__MOBILE__` 가드 하나뿐(app-core.js 병렬분석 상한).
2. **가상 경로**: 데스크톱 API는 경로 기반(openFile→path→readFile). 모바일은 File 객체를
   `mob://` 키로 메모리 맵에 담아 같은 모양 유지. readFile은 동기 반환이 필수(.ai 판별이 동기 호출).
   맵 총량 512MB 초과 시 오래된 것부터 자동 해제.
3. **PC 위임**: convert*/inkCoverage/printToPDF는 remote-server.js HTTP API로. 연결 정보는
   localStorage 'mobServer' {host, token, mac}. 미연결 시 한국어 안내 에러.
4. **WoL**: WolPlugin.java(커스텀, UDP 매직패킷 브로드캐스트 포트9 ×3회). MAC은 '연결 확인' 시
   /info에서 받아 저장. PC는 BIOS·랜카드 Wake on Magic Packet 활성 필요.
5. **딥링크**: PC 테스트 페이지의 '앱에 이 PC 등록' → `pdfeditor://connect?host=..&t=..&mac=..`
   → bridge의 appUrlOpen 리스너가 저장.
6. **제외 기능(3단계 과제)**: 내부 콘텐츠 편집기(editor.html, 별도 창 구조라 재설계 필요),
   시스템 폰트 임베드(listFonts→[]), 드래그&드롭.

## 함정

- app-core.js가 로드 시점에 `getWorkerContent()`를 **동기** 호출 → 부트로더가 워커 텍스트를
  먼저 fetch한 뒤 앱 스크립트를 로드해야 한다. 스크립트 로드 순서(core→process→ui)는 전역 공유라 필수.
- WebView가 백그라운드로 가면 rAF가 멈춰 pdf.js 렌더가 일시정지(포그라운드 복귀 시 재개) — 버그 아님.
- LAN이 http라 `androidScheme: http` + `usesCleartextTraffic` 필요 (https면 mixed content 차단).
- Filesystem 저장은 DOCUMENTS + 공유시트. Downloads 직접 쓰기는 플러그인 미지원.
