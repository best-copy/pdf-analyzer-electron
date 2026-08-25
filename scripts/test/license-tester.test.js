// 테스터 PC 관점 검증 — USERPROFILE을 임시폴더로 바꿔 '관리자 아님' 상태를 만든다.
// 토큰은 부모(진짜 관리자 PC)가 서명해 넘긴다.
const {execFileSync}=require('child_process');
const fs=require('fs'),os=require('os'),path=require('path');
const R = require('path').join(__dirname, '..', '..').split(path.sep).join('/') + '/';   // 저장소 루트
const lic=require(R+'license.js');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'lict_'));
lic.init({userDataDir:tmp,appVersion:'t'});
const adm=lic.adminData(), HW=lic.hwid(), D=86400000, now=Date.now();
const mk=(o)=>lic.signToken(Object.assign({v:1,key:'PDFE-TEST-TEST-TEST',hwid:HW,iat:now,exp:now+5*D,next:now+7*D},o),adm.priv);

const cases=[
  ['키 없음 → none/차단',            null,                                   'none',     false],
  ['정상 토큰 → licensed/허용',      mk({}),                                 'licensed', true ],
  ['만료 → expired/차단',            mk({exp:now-D}),                        'expired',  false],
  ['다른 PC 토큰 → 차단',            mk({hwid:'f'.repeat(24)}),              'expired',  false],
  ['재확인 기한+유예 초과 → 차단',   mk({next:now-4*D}),                     'expired',  false],
  ['유예 안(재확인 지남) → 허용',    mk({next:now-D}),                       'licensed', true ],
  ['서명 위조 → 차단',               mk({}).split('.')[0]+'.AAAA',           'expired',  false],
];
let pass=0,fail=0;
const fakeHome=fs.mkdtempSync(path.join(os.tmpdir(),'lichome_'));
for(const [name,tok,wantMode,wantSave] of cases){
  const ud=fs.mkdtempSync(path.join(os.tmpdir(),'licud_'));
  if(tok) fs.writeFileSync(path.join(ud,'license.dat'),tok,'utf8');
  const out=execFileSync(process.execPath,['-e',`
    const lic=require(${JSON.stringify(R+'license.js')});
    lic.init({userDataDir:${JSON.stringify(ud)},appVersion:'t'});
    const s=lic.status();
    console.log(JSON.stringify({mode:s.mode,canSave:s.canSave,label:s.label}));
  `],{env:Object.assign({},process.env,{USERPROFILE:fakeHome,HOME:fakeHome}),encoding:'utf8'});
  const s=JSON.parse(out.trim().split('\n').pop());
  const ok=s.mode===wantMode && s.canSave===wantSave;
  if(ok){pass++;console.log('  ✔',name,'→',s.label);}else{fail++;console.log('  ✘',name,'실제:',JSON.stringify(s),'기대:',wantMode,wantSave);}
  fs.rmSync(ud,{recursive:true,force:true});
}
// 시계 되돌리기: 미래 시각 마크를 남긴 뒤 판정
const ud2=fs.mkdtempSync(path.join(os.tmpdir(),'licud_'));
fs.writeFileSync(path.join(ud2,'license.dat'),mk({}),'utf8');
fs.writeFileSync(path.join(ud2,'lic.mark'),Math.floor(now+30*D).toString(36),'utf8');
const out2=execFileSync(process.execPath,['-e',`
  const lic=require(${JSON.stringify(R+'license.js')});
  lic.init({userDataDir:${JSON.stringify(ud2)},appVersion:'t'});
  const s=lic.status(); console.log(JSON.stringify({mode:s.mode,canSave:s.canSave,label:s.label}));
`],{env:Object.assign({},process.env,{USERPROFILE:fakeHome,HOME:fakeHome}),encoding:'utf8'});
const s2=JSON.parse(out2.trim().split('\n').pop());
if(s2.mode==='expired'&&!s2.canSave){pass++;console.log('  ✔ 시계 되돌리기 감지 →',s2.label);}
else{fail++;console.log('  ✘ 시계 되돌리기 미감지',JSON.stringify(s2));}
fs.rmSync(ud2,{recursive:true,force:true});fs.rmSync(fakeHome,{recursive:true,force:true});fs.rmSync(tmp,{recursive:true,force:true});
// 레지스트리 흔적 정리 (테스트가 남긴 미래 시각 마크가 실제 앱에 영향 주지 않도록)
try{execFileSync('reg',['delete','HKCU\Software\PDFEditor\Lic','/f'],{stdio:'ignore'});}catch(e){}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail?1:0);
