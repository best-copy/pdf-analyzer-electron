// 검사용 창은 언제나 **가장 왼쪽 모니터**에 띄운다.
// 주 모니터는 사용자가 실제 인쇄 작업을 하는 공간이라, 하네스 창이 그 위에 뜨면
// 작업을 가리고 포커스를 빼앗는다. 모니터 배치는 바뀌므로 좌표를 박지 말고
// bounds.x가 가장 작은 화면을 그때그때 고른다.
//   const { leftWin } = require('./_leftwin');
//   new BrowserWindow({ show: true, width: 1200, height: 860, ...leftWin(1200, 860) })
// ⚠ 크기 **뒤에** 펼쳐 넣는다 — 왼쪽 모니터가 창보다 좁으면(이 PC는 1280px) 크기를 줄여야
//    주 모니터로 넘치지 않는데, 앞에 두면 뒤의 width/height가 그 값을 덮어쓴다.
// ⚠ app.whenReady() 뒤에 호출할 것 (screen 모듈은 그 전에 못 쓴다).
const { screen } = require('electron');

function leftWin(w, h) {
  let L;
  try {
    const all = screen.getAllDisplays();
    L = all.reduce((m, d) => (d.bounds.x < m.bounds.x ? d : m), all[0]);
  } catch (e) { return {}; }        // 화면 정보를 못 얻으면 그냥 기본 위치
  if (!L) return {};
  const A = L.workArea || L.bounds;   // 작업 표시줄을 뺀 영역
  const out = { x: A.x + 20, y: A.y + 20 };
  if (w) out.width = Math.min(w, A.width - 40);
  if (h) out.height = Math.min(h, A.height - 40);
  return out;
}
module.exports = { leftWin };
