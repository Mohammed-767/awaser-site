/* Discipline section of awaser.web.app.
   Visitors see the ranking from discipline/public (summed points only, no reasons).
   The discipline manager signs in to record outings; full records live in
   dsc_members, dsc_outings and dsc_meta. The Firestore rules decide which account may
   read and write them: a signed-in account without access gets a clear message.
   Every write also refreshes discipline/public in the same batch. */
import{getApp}from"https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import{getFirestore,doc,collection,onSnapshot,writeBatch}from"https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import{getAuth,onAuthStateChanged,signInWithEmailAndPassword}from"https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

/* Local test copy only: data stays in this browser. */
const TEST=!!window.AWASER_TEST;

const P={absent:25,excused:15,maghrib:5,isha:10,left:15,hosp:5,idaa:5,streak:10,carry:15};
const app=getApp(),db=getFirestore(app),au=getAuth(app);
const PUB=doc(db,"discipline","public");

let el=null,user=null,admin=false,full=false;
let S={members:{},outings:{},meta:null};   /* full records (manager only) */
let PD=null;                                /* public summary */
let tab="rank",viewCycle=null,open=null,q="",rq="",draft=null,confirmKey=null,exp=new Set(),sel={t:new Set(),b:new Set()},carryOn=true,saved=null,renamed=null,unsub=[];

const $=s=>el.querySelector(s);
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const riyadhToday=()=>new Date(Date.now()+3*36e5).toISOString().slice(0,10);
const fmtDate=s=>{try{return new Date(s+"T12:00:00").toLocaleDateString("ar-SA-u-ca-gregory-nu-latn",{weekday:"long",day:"numeric",month:"long"})}catch(e){return s}};
const sgn=n=>n>0?"+"+n:n<0?"−"+Math.abs(n):"0";
const uid=p=>p+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
const reduceMotion=()=>{try{return matchMedia("(prefers-reduced-motion: reduce)").matches}catch(e){return false}};
const clone=v=>JSON.parse(JSON.stringify(v));
function canon(v){return JSON.stringify(v,(k,x)=>x&&typeof x==="object"&&!Array.isArray(x)?Object.keys(x).sort().reduce((o,kk)=>(o[kk]=x[kk],o),{}):x)}

/* ---------- data access: the same shape for the manager's full data and the public summary ---------- */
const D=()=>full?S:(PD||{members:{},outings:{},meta:null});
function meta(){return D().meta||{current:"c1",cycles:[{id:"c1",name:"الدورة 1",start:riyadhToday(),bonus:{}}]}}
function cycle(id){return meta().cycles.find(c=>c.id===id)||meta().cycles[0]}
function memberList(){return Object.entries(D().members||{}).map(([id,m])=>({id,...m})).sort((a,b)=>(a.order??0)-(b.order??0)||a.name.localeCompare(b.name,"ar"))}
function outingsOf(cid){return Object.entries(D().outings||{}).filter(([,o])=>o.cycle===cid).map(([id,o])=>({id,...o})).sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:a.id<b.id?-1:1)}

function recLines(r){
  if(!r)return[];
  if("n" in r){const L=[];if(r.n)L.push({t:"",p:r.n});if(r.p)L.push({t:"",p:r.p});return L}  /* public summary */
  if(r.st==="absent")return[{t:"غياب بدون عذر",p:-P.absent}];
  if(r.st==="excused")return[{t:"غياب بعذر",p:-P.excused}];
  if(r.st==="perm")return[{t:"غائب بعذر دائم",p:0}];
  const L=[];
  if(r.late==="maghrib")L.push({t:"تأخر بعد المغرب",p:-P.maghrib});
  if(r.late==="isha")L.push({t:"تأخر بعد العشاء",p:-P.isha});
  if(r.left)L.push({t:"انقطاع بعد الحضور",p:-P.left});
  if(r.hosp)L.push({t:"تأخر في الضيافة",p:-P.hosp});
  const e=Math.abs(+r.enrich||0);if(e)L.push({t:"تقصير في البرنامج الإثرائي",p:-e});
  if(r.idaa)L.push({t:"تقديم برنامج «إضاءة»",p:P.idaa});
  return L;
}
function compute(cid){
  const c=cycle(cid),outs=outingsOf(cid),ms=memberList(),ended=cid!==meta().current;
  const rows=ms.map(m=>{
    const hist=[];let streak=0,sum=0,last=null;
    const bonus=(c.bonus&&c.bonus[m.id])||0;
    for(const o of outs){
      const r=o.rec&&o.rec[m.id];
      if(!r){streak=0;continue}
      last=r.st;
      const L=recLines(r);
      if(L.some(x=>x.p<0)){streak++;if(streak===3){L.push({t:"تكرار المخالفات 3 أسابيع متتالية",p:-P.streak});streak=0}}else streak=0;
      L.forEach(x=>sum+=x.p);
      if(L.length)hist.push({date:o.date,L});
    }
    return{...m,bonus,bal:100+bonus+sum,hist,perm:last==="perm"};
  }).sort((a,b)=>b.bal-a.bal||a.name.localeCompare(b.name,"ar"));
  const main=rows.filter(r=>!r.perm),perm=rows.filter(r=>r.perm),n=main.length;
  const rankify=L=>L.forEach(r=>{const above=L.filter(x=>x.bal>r.bal).length,below=L.filter(x=>x.bal<r.bal).length;r.rank=above+1;r.tie=L.filter(x=>x.bal===r.bal).length>1;r.out=r.bal<=0;r.above=above;r.below=below});
  rankify(main);rankify(perm);
  main.forEach(r=>{
    if(ended&&Array.isArray(c.top)){r.top=c.top.includes(r.id);r.bottom=(c.bottom||[]).includes(r.id)}
    else{r.top=n>=4&&r.above<2;r.bottom=n>=4&&r.below<2}
  });
  perm.forEach(r=>{r.top=r.bottom=false});
  return{rows:main,perm,outs,c};
}
/* Public summary: names, dates and summed points only. */
function summary(src){
  const members={},outings={};
  Object.entries(src.members||{}).forEach(([id,m])=>{members[id]={name:m.name,order:m.order??null}});
  Object.entries(src.outings||{}).forEach(([id,o])=>{const rec={};
    Object.entries(o.rec||{}).forEach(([mid,r])=>{const L=recLines(r);rec[mid]={st:r.st==="perm"?"perm":"x",n:L.filter(x=>x.p<0).reduce((a,x)=>a+x.p,0),p:L.filter(x=>x.p>0).reduce((a,x)=>a+x.p,0)}});
    outings[id]={date:o.date,cycle:o.cycle,rec}});
  return{updated:riyadhToday(),members,outings,meta:src.meta||null};
}

/* ---------- storage ---------- */
const COL={members:"dsc_members",outings:"dsc_outings",meta:"dsc_meta"};
function applyLocal(src,ops){const T=clone(src);ops.forEach(([kind,p,v])=>{const[c,id]=p.split("/");if(c==="meta"){T.meta=kind==="del"?null:v}else{if(kind==="del")delete T[c][id];else T[c][id]=v}});return T}
async function commit(ops){
  const next=applyLocal(S,ops);
  if(TEST){S=next;PD=summary(next);try{localStorage.setItem("awaser-dsc-test",JSON.stringify(S));localStorage.setItem("awaser-dsc-test-pub",JSON.stringify(PD))}catch(e){}render();return}
  const b=writeBatch(db);
  ops.forEach(([kind,p,v])=>{const[c,id]=p.split("/"),r=doc(db,COL[c],id);kind==="del"?b.delete(r):b.set(r,v)});
  b.set(PUB,summary(next));
  await b.commit();
}
const put=(p,v)=>commit([["put",p,v]]);
const del=p=>commit([["del",p]]);
async function ensureMeta(){if(!S.meta)await put("meta/state",clone(meta()))}

function watchPublic(){
  if(TEST){try{PD=JSON.parse(localStorage.getItem("awaser-dsc-test-pub")||"null")}catch(e){}if(PD){render();return}loadFile();return}
  onSnapshot(PUB,s=>{if(s.exists()){PD=s.data();render()}else loadFile()},()=>loadFile());
}
/* Until the first save from the manager, the ranking comes from data.json. */
function loadFile(){if(PD)return;fetch("data.json",{cache:"no-store"}).then(r=>{if(!r.ok)throw 0;return r.json()}).then(d=>{if(!PD){PD=d;render()}}).catch(()=>{if(!PD){$("#d-view").innerHTML='<div class="card empty">ما قدرت أحمّل بيانات الترتيب.</div>'}})}

function startAdmin(){
  stopAdmin();admin=true;full=false;tab="rank";
  if(TEST){
    try{const d=JSON.parse(localStorage.getItem("awaser-dsc-test")||"null");if(d)S=d}catch(e){}
    if(Object.keys(S.members).length){full=true;render();return}
    /* Test copy only: start from the exported live data instead of an empty list. */
    render();
    fetch("dsc-export.json",{cache:"no-store"}).then(r=>r.ok?r.json():null).then(async d=>{
      if(d&&d.members){await commit([...Object.entries(d.members).map(([id,m])=>["put","members/"+id,{name:m.name,order:m.order??null}]),...Object.entries(d.outings||{}).map(([id,o])=>["put","outings/"+id,{date:o.date,cycle:o.cycle,rec:o.rec||{}}]),...(d.meta?[["put","meta/state",d.meta]]:[])])}
    }).catch(()=>{}).finally(()=>{full=true;render()});
    return}
  const got={m:0,o:0,x:0},done=()=>{if(got.m&&got.o&&got.x)full=true;render()};
  const fail=e=>{console.error(e);stopAdmin();toast(e&&e.code==="permission-denied"?"هذا الحساب ما له صلاحية تعديل الانضباط.":"ما قدرت أفتح بيانات الانضباط. تأكد من الاتصال.");render()};
  unsub.push(onSnapshot(collection(db,COL.members),s=>{S.members=Object.fromEntries(s.docs.map(d=>[d.id,d.data()]));got.m=1;done()},fail));
  unsub.push(onSnapshot(collection(db,COL.outings),s=>{S.outings=Object.fromEntries(s.docs.map(d=>[d.id,d.data()]));got.o=1;done()},fail));
  unsub.push(onSnapshot(doc(db,COL.meta,"state"),d=>{S.meta=d.exists()?d.data():null;got.x=1;done()},fail));
  render();
}
function stopAdmin(){unsub.forEach(f=>f());unsub=[];admin=false;full=false;S={members:{},outings:{},meta:null};draft=null;saved=null;confirmKey=null;open=null;if(tab==="rec"||tab==="mem")tab="rank"}

/* ---------- feedback ---------- */
function toast(t,undo){
  const box=$(".d-toast");if(!box)return;box.textContent=t;clearTimeout(toast.t);
  if(undo){const b=document.createElement("button");b.type="button";b.textContent="تراجع";b.onclick=async()=>{clearTimeout(toast.t);box.hidden=true;await undo()};box.appendChild(b)}
  box.hidden=false;toast.t=setTimeout(()=>{box.hidden=true},undo?8000:2600);
}
async function act(fn,ok,fail){try{await fn();if(ok)toast(ok);return true}catch(e){console.error(e);toast(e&&e.code==="permission-denied"?"ما عندك صلاحية تعديل الانضباط":(fail||"ما انحفظ. تأكد من الاتصال وجرّب مرة ثانية"));return false}}

/* ---------- views ---------- */
function rowHtml(r,isCur){
  const w=Math.max(0,Math.min(100,r.bal)),cls=r.bal<33?"low":r.bal<66?"mid":"";
  const chips=[r.out?'<span class="chip bad">مستبعد</span>':"",!isCur&&r.top?'<span class="chip good">من الأوائل</span>':"",!isCur&&r.bottom&&!r.out?'<span class="chip warn">كُلِّف بمهام</span>':"",r.bonus?`<span class="chip good">رصيد مرحّل +${r.bonus}</span>`:""].join("");
  const inner=`<span class="pos"${r.tie?' title="متعادل"':""}>${r.rank}${r.tie?"<small>تعادل</small>":""}</span><span class="d-who"><span class="d-name">${esc(r.name)}</span><span class="bar"><i class="${cls}" style="width:${w}%"></i></span>${chips?`<span class="chips">${chips}</span>`:""}</span><span class="score ${cls==="low"?"low":""}">${r.bal}</span>`;
  if(!full)return`<li>${inner}</li>`;
  return`<li class="d-open"><button type="button" class="d-toggle" data-open="${r.id}" aria-expanded="${open===r.id}">${inner}</button>
    ${open===r.id?`<div class="d-detail">${r.hist.length?r.hist.map(x=>`<span><b>${fmtDate(x.date)}</b>${x.L.map(l=>`<span class="d-ln"><span>${l.t}</span><span class="${l.p<0?"minus":l.p>0?"plus":""}">${sgn(l.p)}</span></span>`).join("")}</span>`).join(""):"<span>ما عليه شي في هذي الدورة.</span>"}
      <div class="d-row"><button type="button" class="btn d-sm" data-copym="${r.id}">نسخ تفاصيله كرسالة</button></div></div>`:""}</li>`;
}
function memberMsg(id,cid){
  const{rows,perm,c}=compute(cid),r=[...rows,...perm].find(x=>x.id===id);if(!r)return"";
  const isPerm=perm.includes(r),list=isPerm?perm:rows;
  let t=`📋 تفاصيل الانضباط: ${r.name}\n${c.name} · الرصيد ${r.bal} من 100${r.bonus?` (منها +${r.bonus} مرحّلة)`:""}\nالمركز ${r.rank} من ${list.length}${isPerm?" (أصحاب العذر الدائم)":""}${r.out?" · مستبعد":""}\n`;
  if(!r.hist.length)t+="\nما عليه أي خصم في هذي الدورة.";
  else{r.hist.forEach(x=>{t+=`\n${fmtDate(x.date)}\n`;x.L.forEach(l=>{t+=`  ${l.t}: ${sgn(l.p)}\n`})});
    const ded=r.hist.reduce((a,x)=>a+x.L.filter(l=>l.p<0).reduce((s2,l)=>s2+l.p,0),0),add=r.hist.reduce((a,x)=>a+x.L.filter(l=>l.p>0).reduce((s2,l)=>s2+l.p,0),0);
    t+=`\nمجموع الخصم: ${Math.abs(ded)}${add?` · الإضافات: +${add}`:""}`}
  return t.trim();
}
const match=(r,s)=>!s||r.name.replace(/\s+/g," ").includes(s.trim().replace(/\s+/g," "));
function board(){
  const cid=viewCycle||meta().current,{rows,perm,outs,c}=compute(cid),isCur=cid===meta().current;
  if(!rows.length&&!perm.length)return'<div class="card empty">ما فيه بيانات للحين.</div>';
  const R=rows.filter(r=>match(r,q)),Pm=perm.filter(r=>match(r,q));
  if(!R.length&&!Pm.length)return`<div class="card empty">ما فيه اسم يطابق «${esc(q.trim())}».</div>`;
  let h="";
  if(R.length){
    h+=`<div class="card"><div class="card-head"><h3>${esc(c.name)}</h3><span class="muted">${outs.length} طلعة مسجّلة</span></div>`;
    if(full&&isCur&&outs.length&&rows.length>=4){
      const tb=(cmp,lab,edge)=>{const g=rows.filter(cmp),cut=g.length>2?g:null;if(!cut)return"";const v=edge==="top"?cut[cut.length-1].bal:cut[0].bal,tied=rows.filter(r=>r.bal===v);return tied.length>1&&tied.length<rows.length?`<p class="d-tie">${lab}: تعادل بين ${tied.length===2?"عضوين":tied.length<=10?tied.length+" أعضاء":tied.length+" عضو"} على ${v} نقطة.</p>`:""};
      h+=tb(r=>r.top,"حد الأوائل","top")+tb(r=>r.bottom,"حد المكلّفين بمهام","bottom");
    }
    h+=`<ol class="board">${R.map(r=>rowHtml(r,isCur)).join("")}</ol></div>`;
  }
  if(Pm.length)h+=`<div class="card"><div class="card-head"><h3>أصحاب العذر الدائم</h3><span class="muted">${perm.length} عضو</span></div><p class="muted" style="margin:0 0 4px">ترتيب منفصل، ما يدخلون في منافسة المراكز ولا في زيادة النقاط أو المهام.</p><ol class="board">${Pm.map(r=>rowHtml(r,isCur)).join("")}</ol></div>`;
  if(!full&&D().updated)h+=`<p class="muted">آخر تحديث: ${fmtDate(D().updated)}.</p>`;
  return h;
}
function vRank(){
  const cid=viewCycle||meta().current,isCur=cid===meta().current,cycles=meta().cycles;
  if(full&&!memberList().length)return vImport();
  let h=`<div class="d-row">${cycles.length>1?`<select id="d-cyc" aria-label="الدورة">${cycles.map(x=>`<option value="${x.id}" ${x.id===cid?"selected":""}>${esc(x.name)}${x.id===meta().current?" (الحالية)":""}</option>`).join("")}</select>`:""}<input type="search" id="d-q" class="d-grow" placeholder="دوّر اسمك" aria-label="دوّر اسم عضو"></div><div id="d-board">${board()}</div>`;
  if(!full)return h;
  h+=`<div class="card"><div class="card-head"><div><h3>تقرير للقروب</h3><span class="muted">نسخة نصية جاهزة تلصقها بالواتساب</span></div><button type="button" class="btn p" data-act="copy">نسخ الترتيب</button></div><textarea id="d-copybox" hidden readonly></textarea>
    <div class="d-row"><button type="button" class="btn d-sm" data-act="pdf">تصدير PDF</button></div></div>`;
  if(isCur){
    h+=`<div class="card"><h3>نهاية الدورة</h3><p class="muted">زيادة النقاط وتكليف المهام ما تتطبق كل أسبوع. لما تقرر تنهي الدورة (كل كم شهر)، اضغط الزر وتطلع لك النتائج قبل التأكيد. بعدها يبدأ الكل من 100 من جديد.</p>`;
    const{rows}=compute(cid),outs=outingsOf(cid);
    if(confirmKey==="cycle"){
      if(rows.length>=4){
        const tops=rows.filter(r=>r.top),bots=rows.filter(r=>r.bottom);
        const pick=(L,k,title,tie)=>`<fieldset class="d-choice"><legend>${title}</legend>${tie?`<div class="d-banner" role="status">فيه تعادل على المركز، فيه ${L.length} بنفس النقاط تقريباً. اختر مين يدخل.</div>`:""}${L.map(r=>`<label class="d-check"><input type="checkbox" data-pick="${k}" data-id="${r.id}" ${sel[k].has(r.id)?"checked":""}> <span class="d-grow">${esc(r.name)}</span><span>${r.bal}</span></label>`).join("")}</fieldset>`;
        h+=pick(tops,"t","الأول والثاني",tops.length>2)+pick(bots,"b","يُكلَّفون بمهام",bots.length>2);
        h+=`<label class="d-check"><input type="checkbox" id="d-carry" ${carryOn?"checked":""}> إضافة 15 نقطة للأوائل المختارين في الدورة الجديدة</label>`;
      }else h+=`<p class="muted">لازم 4 أعضاء على الأقل عشان يتحدد الأوائل والأواخر.</p>`;
      h+=`<div class="d-row"><button type="button" class="btn d-danger" data-act="newcycle">تأكيد: إنهاء الدورة</button><button type="button" class="btn" data-act="cancel">إلغاء</button></div>`;
    }else{
      h+=`<button type="button" class="btn" data-act="askcycle">إنهاء الدورة وإعلان النتائج</button>`;
      if(meta().cycles.length>1&&!outs.length)h+=`<p class="muted">أنهيت ${esc(meta().cycles[meta().cycles.length-2].name)} بالغلط؟ تقدر تتراجع لين تسجّل أول طلعة في هذي الدورة.</p><div class="d-row"><button type="button" class="btn" data-act="undocycle">تراجع عن إنهاء الدورة</button></div>`;
    }
    h+="</div>";
  }
  return h;
}
function vImport(){
  return`<div class="card"><h3>نقل البيانات من صفحة الإدارة القديمة</h3><p class="muted">بيانات الانضباط ما انتقلت للموقع للحين. اختر ملف التصدير (JSON) وتنتقل الأعضاء والطلعات والدورات كلها، وبعدها يتحدث الترتيب للزوار.</p>
    <div class="d-row"><input type="file" id="d-import" accept="application/json,.json" aria-label="ملف بيانات الانضباط"></div>
    <p class="muted">أو ابدأ من الصفر: <button type="button" class="d-linkish" data-tab="mem">أضف الأعضاء</button>.</p></div>`;
}
function report(cid){
  const{rows,perm,outs,c}=compute(cid);
  let t=`📋 ترتيب الانضباط – ${c.name}\n(${outs.length} طلعة، حتى ${fmtDate(outs.length?outs[outs.length-1].date:riyadhToday())})\n\n`;
  rows.forEach(r=>{t+=`${r.rank}. ${r.name} — ${r.bal}${r.out?" (مستبعد)":""}\n`});
  if(perm.length){t+="\nأصحاب العذر الدائم:\n";perm.forEach(r=>{t+=`${r.rank}. ${r.name} — ${r.bal}\n`})}
  const ended=cid!==meta().current,top=ended?rows.filter(r=>r.top):[],bot=ended?rows.filter(r=>r.bottom):[];
  if(top.length)t+=`\n🥇 الأوائل: ${top.map(r=>r.name).join(" و ")}`;
  if(bot.length)t+=`\n⚠️ المكلّفون بمهام: ${bot.map(r=>r.name).join(" و ")}`;
  return t.trim();
}

/* ---------- recording ---------- */
const lastMonday=()=>{const d=new Date(Date.now()+3*36e5);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));return d.toISOString().slice(0,10)};
const DK="awaser-dsc-draft";
function saveDraft(){try{localStorage.setItem(DK,JSON.stringify(draft))}catch(e){}}
function clearDraft(){try{localStorage.removeItem(DK)}catch(e){}}
function loadDraft(){try{const d=JSON.parse(localStorage.getItem(DK)||"null");if(d&&d.rec&&(!d.id||S.outings[d.id])){d.restored=true;return d}}catch(e){}return null}
function newDraft(){const outs=outingsOf(meta().current),last=outs[outs.length-1],rec={};memberList().forEach(m=>{const p=last&&last.rec&&last.rec[m.id];rec[m.id]={st:p&&p.st==="perm"?"perm":"absent",late:"none"}});return{id:null,date:lastMonday(),rec}}
const LATE={maghrib:"بعد المغرب −5",isha:"بعد العشاء −10"};
function extras(r){const a=[];if(r.late&&r.late!=="none")a.push(["bad",LATE[r.late]]);if(r.left)a.push(["bad","انقطع −15"]);if(r.hosp)a.push(["bad","ضيافة −5"]);if(+r.enrich)a.push(["bad","إثرائي −"+Math.abs(+r.enrich)]);if(r.idaa)a.push(["good","إضاءة +5"]);return a}
/* Maghrib = sunset (NOAA solar formulas, Umm al-Qura convention); Isha = Maghrib + 90 min (120 in Ramadan). */
const CITIES={riyadh:["الرياض",24.7136,46.6753],buraydah:["بريدة",26.3260,43.9750],unaizah:["عنيزة",26.0843,43.9935],rass:["الرس",25.8694,43.4973],jeddah:["جدة",21.5433,39.1728],makkah:["مكة",21.4225,39.8262],madinah:["المدينة",24.4672,39.6111],dammam:["الدمام",26.4207,50.0888]};
function sunsetMin(dateStr,lat,lng){
  const r=Math.PI/180,tz=3,base=Date.UTC(+dateStr.slice(0,4),+dateStr.slice(5,7)-1,+dateStr.slice(8,10));let t=17*60;
  for(let k=0;k<3;k++){
    const jd=(base+(t-tz*60)*60e3)/864e5+2440587.5,T=(jd-2451545)/36525;
    const L0=(280.46646+T*(36000.76983+T*0.0003032))%360,M=357.52911+T*(35999.05029-0.0001537*T),e=0.016708634-T*(0.000042037+0.0000001267*T);
    const C=Math.sin(M*r)*(1.914602-T*(0.004817+0.000014*T))+Math.sin(2*M*r)*(0.019993-0.000101*T)+Math.sin(3*M*r)*0.000289;
    const om=125.04-1934.136*T,lam=L0+C-0.00569-0.00478*Math.sin(om*r);
    const eps=23+(26+((21.448-T*(46.815+T*(0.00059-T*0.001813))))/60)/60+0.00256*Math.cos(om*r);
    const dec=Math.asin(Math.sin(eps*r)*Math.sin(lam*r)),y=Math.tan(eps/2*r)**2;
    const eot=4/r*(y*Math.sin(2*L0*r)-2*e*Math.sin(M*r)+4*e*y*Math.sin(M*r)*Math.cos(2*L0*r)-0.5*y*y*Math.sin(4*L0*r)-1.25*e*e*Math.sin(2*M*r));
    const ha=Math.acos(Math.cos(90.833*r)/(Math.cos(lat*r)*Math.cos(dec))-Math.tan(lat*r)*Math.tan(dec))/r;
    t=720-4*lng-eot+tz*60+ha*4;
  }
  return Math.floor(t);
}
function isRamadan(dateStr){try{return new Intl.DateTimeFormat("en-u-ca-islamic-umalqura",{month:"numeric"}).format(new Date(dateStr+"T12:00:00"))==="9"}catch(e){return false}}
const hm=m=>{const h=Math.floor(m/60)%24,mm=String(m%60).padStart(2,"0");return`${h>12?h-12:h||12}:${mm} ${h>=12?"م":"ص"}`};
function prayerInfo(dateStr){const key=(meta().city&&CITIES[meta().city])?meta().city:"buraydah",[name,lat,lng]=CITIES[key],mg=sunsetMin(dateStr,lat,lng),ram=isRamadan(dateStr);return{key,name,maghrib:mg,lateFrom:mg+60,isha:mg+(ram?120:90),ram}}
function recRow(m){
  const r=draft.rec[m.id],tot=recLines(r).reduce((a,x)=>a+x.p,0),pres=r.st==="present",ex=extras(r),isOpen=exp.has(m.id);
  let h=`<div class="d-roll" data-m="${m.id}"><div class="d-roll-head"><span class="d-name">${esc(m.name)}</span><span class="d-total ${tot<0?"minus":tot>0?"plus":""}">${sgn(tot)}</span></div>
    <div class="d-seg" role="group" aria-label="حضور ${esc(m.name)}">${[["present","حاضر"],["excused","بعذر"],["absent","بدون عذر"],["perm","عذر دائم"]].map(([v,l])=>`<button type="button" data-f="st" data-v="${v}" aria-pressed="${r.st===v}" class="${v==="excused"||v==="absent"?"neg":""}">${l}</button>`).join("")}</div>`;
  if(pres){
    h+=`<div class="d-seg" role="group" aria-label="تأخر ${esc(m.name)}">${[["none","في الوقت"],["maghrib",LATE.maghrib],["isha",LATE.isha]].map(([v,l])=>`<button type="button" data-f="late" data-v="${v}" aria-pressed="${(r.late||"none")===v}" class="${v!=="none"?"neg":""}">${l}</button>`).join("")}</div>`;
    if(isOpen){
      h+=`<div class="d-row"><button type="button" class="d-toggle-chip" data-f="left" aria-pressed="${!!r.left}">انقطع −15</button><button type="button" class="d-toggle-chip" data-f="hosp" aria-pressed="${!!r.hosp}">تأخر بالضيافة −5</button><button type="button" class="d-toggle-chip positive" data-f="idaa" aria-pressed="${!!r.idaa}">قدّم «إضاءة» +5</button></div>
      <div class="d-row d-spread"><label class="d-enrich" for="en-${m.id}">خصم البرنامج الإثرائي (نقاط)<input type="number" min="0" max="25" step="1" inputmode="numeric" id="en-${m.id}" data-f="enrich" value="${r.enrich||""}" placeholder="0"></label><button type="button" class="btn d-sm" data-x="${m.id}" aria-expanded="true">تم</button></div>`;
    }else{
      const ex2=ex.filter(([,t])=>t!==LATE.maghrib&&t!==LATE.isha);
      h+=`<div class="d-row">${ex2.map(([k,t])=>`<span class="chip ${k}">${t}</span>`).join("")}<button type="button" class="btn d-sm d-ghost" data-x="${m.id}" aria-expanded="false">${ex2.length?"تعديل":"+ انقطاع، ضيافة، إضاءة…"}</button></div>`;
    }
  }
  return h+"</div>";
}
function vRec(){
  const ms=memberList();
  if(!ms.length)return`<div class="card empty"><p>أضف الأعضاء أول عشان تسجّل الطلعات.</p><button type="button" class="btn p" data-tab="mem">إضافة الأعضاء</button></div>`;
  if(!draft)draft=loadDraft()||newDraft();
  ms.forEach(m=>{if(!draft.rec[m.id])draft.rec[m.id]={st:"absent",late:"none"}});
  const cur=meta().current,dup=!draft.id&&outingsOf(cur).find(o=>o.date===draft.date);
  if(saved)return`<div class="card d-success" role="status"><h3>${saved.edit?"انحفظ التعديل":"انحفظت الطلعة"}</h3>
      <p>${fmtDate(saved.date)} · ${saved.abs} غياب · مجموع الخصم ${saved.ded}</p>
      <p class="muted">الترتيب على الموقع تحدّث للزوار. الخطوة الجاية عادةً: أرسل الترتيب الجديد للقروب.</p>
      <div class="d-row"><button type="button" class="btn p" data-act="copy">نسخ الترتيب للقروب</button><button type="button" class="btn" data-act="nextoute">طلعة جديدة</button><button type="button" class="btn" data-edit="${saved.id}">تعديلها</button></div>
      <textarea id="d-copybox" hidden readonly></textarea></div>`;
  let h=`<div class="card"><div class="card-head"><h3>${draft.id?"تعديل طلعة":"طلعة جديدة"}</h3><label class="d-inline">التاريخ <input type="date" id="d-odate" value="${draft.date}"></label></div>`;
  const pi=prayerInfo(draft.date);
  h+=`<div class="d-adhan" role="note"><div><span class="muted">التأخر بعد المغرب يبدأ من</span> <b>${hm(pi.lateFrom)}</b></div>
    <div class="muted">أذان المغرب ${hm(pi.maghrib)} · أذان العشاء ${hm(pi.isha)}${pi.ram?" (رمضان)":""} · <label for="d-city">حسب توقيت</label> <select id="d-city">${Object.entries(CITIES).map(([k,[n]])=>`<option value="${k}" ${k===pi.key?"selected":""}>${n}</option>`).join("")}</select></div></div>`;
  if(draft.restored)h+=`<div class="d-banner" role="status">رجّعت لك آخر تسجيل ما انحفظ. كمّل عليه أو <button type="button" class="d-linkish" data-act="newdraft">ابدأ من جديد</button>.</div>`;
  const remote=draft.id?S.outings[draft.id]:null,conflict=draft.id&&draft.base&&(!remote||canon(remote)!==draft.base);
  if(conflict)h+=remote?`<div class="d-banner" role="status">هذي الطلعة انعدلت من جهاز ثاني وأنت تعدّل. <button type="button" class="d-linkish" data-act="takeremote">اعرض النسخة الجديدة</button>، أو احفظ نسختك فوقها.</div>`:`<div class="d-banner" role="status">هذي الطلعة انحذفت من جهاز ثاني. لو حفظت، ترجع بنسختك.</div>`;
  if(dup)h+=`<div class="d-banner" role="status">فيه طلعة مسجّلة بنفس التاريخ (${fmtDate(dup.date)}). <button type="button" class="d-linkish" data-edit="${dup.id}">افتحها للتعديل</button> بدل ما تنخصم النقاط مرتين.</div>`;
  const shown=ms.filter(m=>match(m,rq)),nPres=ms.filter(m=>draft.rec[m.id].st==="present").length;
  h+=`<p class="muted">الكل «غائب بدون عذر» افتراضياً. اختر «حاضر» للي جا، وبعدها حدد التأخر. الانقطاع والضيافة والإضاءة تحت «+». العذر الدائم يبقى تلقائياً في الطلعات الجاية.</p>
  <div class="d-row"><input type="search" id="d-rq" class="d-grow" placeholder="دوّر اسم" aria-label="دوّر اسم عضو في الكشف"><span class="muted">${nPres} حاضر من ${ms.length}</span></div>
  <div id="d-rolls">${shown.length?shown.map(recRow).join(""):`<p class="muted">ما فيه اسم يطابق «${esc(rq)}».</p>`}</div></div>`;
  const outs=outingsOf(cur).reverse();
  h+=`<div class="card"><h3>طلعات ${esc(cycle(cur).name)}</h3>`;
  if(!outs.length)h+='<p class="muted">ما سجّلت أي طلعة في هذي الدورة للحين.</p>';
  else{h+='<div class="d-list">';
    for(const o of outs){
      const recs=Object.entries(o.rec||{}).filter(([id])=>S.members[id]);
      const abs=recs.filter(([,r])=>r.st==="absent"||r.st==="excused").length,ded=recs.reduce((a,[,r])=>a+recLines(r).filter(x=>x.p<0).reduce((s,x)=>s+x.p,0),0);
      h+=`<div class="d-item"><div><div class="d-name">${fmtDate(o.date)}</div><div class="muted">${abs} غياب · مجموع الخصم ${Math.abs(ded)}</div></div>
      <div class="d-row"><button type="button" class="btn d-sm" data-edit="${o.id}">تعديل</button><button type="button" class="btn d-sm d-danger" data-delo="${o.id}">حذف</button></div></div>`;
    }
    h+="</div>"}
  h+="</div>";
  const vals=ms.map(m=>draft.rec[m.id]);
  const nAbs=vals.filter(r=>r.st==="absent"||r.st==="excused").length,nViol=vals.filter(r=>r.st==="present"&&extras(r).some(x=>x[0]==="bad")).length;
  const ded=vals.reduce((a,r)=>a+recLines(r).filter(x=>x.p<0).reduce((s,x)=>s+x.p,0),0);
  const label=conflict?(remote?"احفظ نسختي فوقها":"احفظها من جديد"):draft.id?"حفظ التعديل":dup?(confirmKey==="dup"?"تأكيد: احفظها كطلعة ثانية":"حفظ كطلعة ثانية"):"حفظ الطلعة";
  h+=`<div class="d-savebar"><div class="d-savebar-in"><div class="muted"><b>${nAbs}</b> غياب · <b>${nViol}</b> مخالفة · خصم <b>${Math.abs(ded)}</b></div><div class="d-row">${draft.id?'<button type="button" class="btn d-sm" data-act="newdraft">إلغاء التعديل</button>':""}<button type="button" class="btn p" data-act="save">${label}</button></div></div></div>`;
  return h;
}
function vMem(){
  const ms=memberList(),permIds=new Set(compute(meta().current).perm.map(r=>r.id));
  let h=`<div class="card"><h3>إضافة أعضاء</h3><p class="muted">اكتب كل اسم في سطر، وكل عضو يبدأ بـ 100 نقطة.</p><textarea id="d-newnames" aria-label="أسماء الأعضاء الجدد، كل اسم في سطر" placeholder="محمد&#10;عبدالله&#10;فهد"></textarea><div class="d-row"><button type="button" class="btn p" data-act="addm">إضافة</button></div></div>`;
  h+=`<div class="card"><div class="card-head"><h3>أعضاء المجموعة</h3><span class="muted">${ms.length} عضو${permIds.size?` · ${permIds.size} عذر دائم`:""}</span></div>`;
  if(!ms.length)h+='<p class="muted">القائمة فاضية.</p>';
  else{h+='<div class="d-list">';
    for(const m of ms)h+=`<div class="d-item"><input type="text" data-rename="${m.id}" value="${esc(m.name)}" aria-label="اسم العضو" class="d-grow">${permIds.has(m.id)?'<span class="chip warn">عذر دائم</span>':""}${renamed===m.id?'<span class="d-saved">محفوظ ✓</span>':""}<button type="button" class="btn d-sm d-danger" data-delm="${m.id}">حذف</button></div>`;
    h+="</div>"}
  return h+"</div>";
}
function vRules(){
  const R=[["الغياب عن الطلعة دون عذر",-25],["الغياب عن الطلعة بعذر",-15],["غائب بعذر دائم (بدون خصم)",0],["التأخر عن الحضور بعد صلاة المغرب",-5],["التأخر عن الحضور بعد العشاء",-10],["الانقطاع عن الطلعة بعد الحضور",-15],["التأخر في الضيافة",-5],["التقصير في متطلبات البرنامج الإثرائي","يُحدد"],["تقديم برنامج «إضاءة»",5]];
  return`<div class="card"><h3>بنود الخصم والإضافة</h3><dl class="rules">${R.map(([t,p])=>`<dt>${t}</dt><dd class="${typeof p==="number"?(p<0?"minus":p>0?"plus":""):""}">${typeof p==="number"?sgn(p):p}</dd>`).join("")}</dl></div>
  <div class="card"><h3>ضوابط التطبيق</h3><ol class="terms">
  <li>تُحتسب نهاية الطلعة اعتبارًا من وقت تقديم وجبة العشاء.</li>
  <li>تكرار المخالفات ثلاثة أسابيع متتالية (نفس المخالفة أو مختلفة) يضيف خصم 10 نقاط. <span class="muted">الموقع يحسبها تلقائياً: كل 3 طلعات متتالية فيها مخالفة للعضو = −10، ثم يبدأ العدّ من جديد.</span></li>
  <li>الرصيد الأساسي 100 نقطة، ويُستبعد العضو عند وصول رصيده إلى صفر.</li>
  <li>صاحبا المركزين الأخيرين يُكلّفان بمهام، وصاحبا المركزين الأول والثاني يحصلان على 15 نقطة في الدورة التالية. <span class="muted">تتطبق لما ينهي مسؤول الانضباط الدورة (كل كم شهر)، مو كل أسبوع.</span></li>
  <li>يُحتسب الانقطاع بعد ساعة وعشر دقائق من وقت الخروج.</li>
  </ol><p class="muted">أصحاب العذر الدائم لهم ترتيب منفصل وما ينافسون على المراكز.</p><p class="muted">المتساوين في النقاط ياخذون نفس رقم المركز.</p><p class="muted">لون الرصيد: أحمر إذا كان أقل من 33، وأصفر إذا كان أقل من 66.</p></div>`;
}

function render(){
  if(!el)return;
  const tabs=full?[["rank","الترتيب"],["rec","تسجيل طلعة"],["mem","الأعضاء"],["rules","اللائحة"]]:[["rank","الترتيب"],["rules","اللائحة"]];
  if(!tabs.some(t=>t[0]===tab))tab="rank";
  $("#d-tabs").innerHTML=tabs.map(([k,l])=>`<button class="tab" role="tab" type="button" data-tab="${k}" aria-selected="${k===tab}">${l}</button>`).join("");
  const has=full||PD;
  $("#d-cycle").textContent=has?cycle(meta().current).name+" · بدأت "+fmtDate(cycle(meta().current).start):"";
  $("#d-mode").textContent=admin?"إغلاق وضع المنشئ":"وضع المنشئ";
  $("#d-admin-note").hidden=!admin;
  if(admin&&!full){$("#d-view").innerHTML='<div class="card empty">جاري فتح بيانات الانضباط…</div>';return}
  if(!has&&tab!=="rules"){$("#d-view").innerHTML='<div class="card empty">جاري التحميل…</div>';return}
  const ae=document.activeElement,fid=ae&&el.contains(ae)&&ae.id,ss=ae&&ae.selectionStart,nn=$("#d-newnames")?.value;
  $("#d-view").innerHTML=tab==="rank"?vRank():tab==="rec"?vRec():tab==="mem"?vMem():vRules();
  if($("#d-q"))$("#d-q").value=q;
  if($("#d-rq"))$("#d-rq").value=rq;
  if(nn&&$("#d-newnames"))$("#d-newnames").value=nn;
  document.body.classList.toggle("d-bar-on",!!$(".d-savebar"));
  if(fid){const n=el.querySelector("#"+CSS.escape(fid));if(n&&n!==ae){n.focus({preventScroll:true});try{if(ss!=null&&n.setSelectionRange)n.setSelectionRange(ss,ss)}catch(e){}}}
}

/* ---------- login ---------- */
function sheet(html){const s=document.getElementById("sheet"),b=document.getElementById("box");b.innerHTML=html;s.className="sheet on";b.querySelector("[data-close]")?.addEventListener("click",()=>{s.className="sheet"})}
function login(){
  sheet('<h2>دخول مسؤول الانضباط</h2><p>أدخل بريدك وكلمة المرور.</p><input id="d-em" type="email" autocomplete="username" placeholder="البريد"><input id="d-pw" type="password" autocomplete="current-password" placeholder="كلمة المرور" style="margin-top:10px"><p id="d-er" role="alert" style="color:#d33;margin:8px 0 0"></p><div class="row"><button class="btn p" id="d-go" type="button">دخول</button><button class="btn" type="button" data-close>إغلاق</button></div>');
  document.getElementById("d-go").onclick=()=>{
    signInWithEmailAndPassword(au,document.getElementById("d-em").value.trim(),document.getElementById("d-pw").value)
      .then(()=>{document.getElementById("sheet").className="sheet";startAdmin()})
      .catch(e=>{document.getElementById("d-er").textContent="تعذر الدخول ("+(e&&e.code?e.code:"unknown")+")"})}
}

/* ---------- PDF ---------- */
const LIBS={h2c:"https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js",pdf:"https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js"};
function loadScript(src){return new Promise((ok,no)=>{if(document.querySelector(`script[src="${src}"]`))return ok();const s=document.createElement("script");s.src=src;s.onload=ok;s.onerror=()=>no(new Error("load"));document.head.appendChild(s)})}
async function savePdf(){
  await Promise.all([loadScript(LIBS.h2c),loadScript(LIBS.pdf)]);
  const root=document.documentElement,prevMode=root.dataset.mode,q0=q,open0=open;
  root.dataset.mode="light";q="";open=null;render();
  const cid=viewCycle||meta().current,c=cycle(cid),day=riyadhToday();
  const sheetEl=document.createElement("div");sheetEl.className="d-pdf";sheetEl.dir="rtl";sheetEl.lang="ar";
  sheetEl.innerHTML=`<h2>ترتيب الانضباط · طلعة أواصر</h2><p class="muted">${esc(c.name)} · حتى ${fmtDate(day)}</p>`;
  el.querySelectorAll("#d-board .card").forEach(p=>sheetEl.appendChild(p.cloneNode(true)));
  sheetEl.insertAdjacentHTML("beforeend",'<p class="muted">الأرصدة من 100 نقطة حسب لائحة الانضباط.</p><h2 class="d-pdf-rules">لائحة الانضباط</h2>'+vRules());
  document.body.appendChild(sheetEl);
  try{
    if(document.fonts&&document.fonts.ready)await document.fonts.ready;
    const bg=getComputedStyle(document.body).backgroundColor;
    const canvas=await window.html2canvas(sheetEl,{scale:2,backgroundColor:bg,useCORS:true,logging:false});
    const top=sheetEl.getBoundingClientRect().top,k=canvas.height/sheetEl.getBoundingClientRect().height;
    const forced=[...sheetEl.querySelectorAll(".d-pdf-rules")].map(x=>Math.round((x.getBoundingClientRect().top-top)*k)-8);
    const cuts=[...sheetEl.querySelectorAll("ol.board li,.card,h2,p,dl.rules dd,ol.terms li")].map(x=>Math.round((x.getBoundingClientRect().bottom-top)*k)).sort((a,b)=>a-b);
    const{jsPDF}=window.jspdf,pdf=new jsPDF({unit:"pt",format:"a4",compress:true});
    const pw=pdf.internal.pageSize.getWidth(),ph=pdf.internal.pageSize.getHeight(),m=24,iw=pw-2*m;
    const pxPerPt=canvas.width/iw,slice=Math.floor((ph-2*m)*pxPerPt);
    for(let y=0,page=0,h;y<canvas.height;y+=h,page++){
      h=Math.min(slice,canvas.height-y);const f=forced.find(v=>v>y+20&&v<=y+h);if(f)h=f-y;else if(y+h<canvas.height){const cc=cuts.filter(v=>v>y+slice*0.5&&v<=y+slice).pop();if(cc)h=cc-y+2}
      const part=document.createElement("canvas");part.width=canvas.width;part.height=h;
      const ctx=part.getContext("2d");ctx.fillStyle=bg;ctx.fillRect(0,0,part.width,h);ctx.drawImage(canvas,0,y,canvas.width,h,0,0,canvas.width,h);
      if(page)pdf.addPage();pdf.setFillColor(243,245,244);pdf.rect(0,0,pw,ph,"F");
      pdf.addImage(part.toDataURL("image/jpeg",0.92),"JPEG",m,m,iw,h/pxPerPt);
    }
    pdf.save(`ترتيب الانضباط ${day}.pdf`);
  }finally{
    sheetEl.remove();q=q0;open=open0;
    if(prevMode===undefined)delete root.dataset.mode;else root.dataset.mode=prevMode;
    render();
  }
}

/* ---------- events ---------- */
async function copyText(txt,okMsg){try{await navigator.clipboard.writeText(txt);toast(okMsg)}catch(err){const b=$("#d-copybox");if(b){b.value=txt;b.hidden=false;b.focus();b.select();toast("حدد النص وانسخه")}else toast("ما قدرت أنسخ")}}
async function onClick(e){
  const t=e.target.closest("button");if(!t||!el.contains(t))return;
  if(t.id==="d-mode"){
    if(admin){stopAdmin();render();return}
    if(TEST){startAdmin();return}
    if(user){startAdmin();return}
    login();return}
  if(t.dataset.tab){tab=t.dataset.tab;confirmKey=null;if(tab!=="rec")saved=null;render();return}
  if(t.dataset.copym){copyText(memberMsg(t.dataset.copym,viewCycle||meta().current),"انسخت التفاصيل، ألصقها له بالواتساب");return}
  if(t.dataset.open){open=open===t.dataset.open?null:t.dataset.open;render();return}
  const recEl=t.closest(".d-roll");
  if(recEl&&t.dataset.f){const id=recEl.dataset.m,r=draft.rec[id],f=t.dataset.f;
    if(f==="st"||f==="late")r[f]=t.dataset.v;else r[f]=!r[f];
    if(r.st!=="present"){r.late="none";r.left=r.hosp=r.idaa=false;r.enrich=0;exp.delete(id)}
    saveDraft();render();return}
  if(t.dataset.x){const id=t.dataset.x;exp.has(id)?exp.delete(id):exp.add(id);render();el.querySelector(`.d-roll[data-m="${id}"] [data-x]`)?.focus();return}
  if(t.dataset.edit){const o=S.outings[t.dataset.edit];draft={id:t.dataset.edit,date:o.date,rec:clone(o.rec||{}),base:canon(o)};saved=null;exp.clear();confirmKey=null;tab="rec";saveDraft();window.scrollTo({top:0,behavior:reduceMotion()?"auto":"smooth"});render();return}
  if(t.dataset.delo){const id=t.dataset.delo,copy=clone(S.outings[id]);confirmKey=null;if(draft&&draft.id===id){draft=null;clearDraft()}
    if(await act(()=>del("outings/"+id)))toast("انحذفت طلعة "+fmtDate(copy.date),async()=>{if(await act(()=>put("outings/"+id,copy),"رجعت الطلعة"))render()});render();return}
  if(t.dataset.delm){const id=t.dataset.delm,copy=clone(S.members[id]);confirmKey=null;
    if(await act(()=>del("members/"+id)))toast("انحذف "+copy.name,async()=>{if(await act(()=>put("members/"+id,copy),"رجع "+copy.name))render()});render();return}
  switch(t.dataset.act){
    case "cancel":confirmKey=null;render();break;
    case "newdraft":rq="";draft=newDraft();exp.clear();clearDraft();confirmKey=null;render();break;
    case "save":{
      const date=$("#d-odate").value||riyadhToday(),rec={};
      const dup=!draft.id&&outingsOf(meta().current).find(o=>o.date===date);
      if(dup&&confirmKey!=="dup"){confirmKey="dup";render();break}
      memberList().forEach(m=>{const r=draft.rec[m.id];rec[m.id]={st:r.st,late:r.late||"none",left:!!r.left,hosp:!!r.hosp,idaa:!!r.idaa,enrich:Math.abs(+r.enrich||0)}});
      const id=draft.id||uid("o"),cyc=draft.id?(S.outings[draft.id]?.cycle||meta().current):meta().current,wasEdit=!!draft.id;
      t.disabled=true;t.textContent="جاري الحفظ…";
      const ops=[["put","outings/"+id,{date,cycle:cyc,rec}]];if(!S.meta)ops.unshift(["put","meta/state",clone(meta())]);
      const ok=await act(()=>commit(ops),null,"ما انحفظ. تأكد من الاتصال وجرّب مرة ثانية، واللي سجّلته باقي على جهازك.");
      confirmKey=null;
      if(ok){const vals=Object.values(rec);saved={id,date,edit:wasEdit,abs:vals.filter(r=>r.st==="absent"||r.st==="excused").length,ded:Math.abs(vals.reduce((a,r)=>a+recLines(r).filter(x=>x.p<0).reduce((s2,x)=>s2+x.p,0),0))};draft=newDraft();exp.clear();clearDraft();window.scrollTo({top:0,behavior:reduceMotion()?"auto":"smooth"})}
      render();break}
    case "nextoute":saved=null;render();$("#d-odate")?.focus();break;
    case "takeremote":{const o=S.outings[draft.id];draft={id:draft.id,date:o.date,rec:clone(o.rec||{}),base:canon(o)};saveDraft();toast("عرضت لك النسخة الجديدة");render();break}
    case "undocycle":{
      const M=clone(meta()),last=M.cycles[M.cycles.length-1];
      if(M.cycles.length<2||outingsOf(last.id).length){toast("ما ينفع التراجع بعد تسجيل طلعة في الدورة الجديدة");break}
      M.cycles.pop();const prev=M.cycles[M.cycles.length-1];delete prev.end;delete prev.top;delete prev.bottom;M.current=prev.id;viewCycle=null;draft=null;
      if(await act(()=>put("meta/state",M),"رجعت "+prev.name))render();break}
    case "addm":{
      const names=$("#d-newnames").value.split("\n").map(s=>s.trim()).filter(Boolean);
      if(!names.length){toast("اكتب اسم واحد على الأقل");break}
      t.disabled=true;t.textContent="جاري الإضافة…";
      let base=memberList().reduce((a,m)=>Math.max(a,m.order||0),0);
      const ops=names.map(n=>["put","members/"+uid("m"),{name:n.slice(0,60),order:++base}]);if(!S.meta)ops.unshift(["put","meta/state",clone(meta())]);
      if(await act(()=>commit(ops),`انضاف ${names.length} عضو`))$("#d-newnames").value="";
      draft=null;render();break}
    case "copy":copyText(report(viewCycle||meta().current),"انسخ الترتيب");break;
    case "pdf":{const lab=t.textContent;t.disabled=true;t.textContent="جاري التجهيز…";try{await savePdf()}catch(err){console.error(err);toast("ما قدرت أجهّز الملف")}finally{t.disabled=false;t.textContent=lab}break}
    case "askcycle":{const{rows}=compute(meta().current);sel={t:new Set(rows.filter(r=>r.top).map(r=>r.id)),b:new Set(rows.filter(r=>r.bottom).map(r=>r.id))};
      if(sel.t.size>2)sel.t=new Set(rows.filter(r=>rows.filter(x=>x.bal>=r.bal).length<=2).map(r=>r.id));
      if(sel.b.size>2)sel.b=new Set(rows.filter(r=>rows.filter(x=>x.bal<=r.bal).length<=2).map(r=>r.id));
      carryOn=true;confirmKey="cycle";render();break}
    case "newcycle":{
      const cur=meta().current,{rows}=compute(cur),M=clone(meta());
      const bonus={},big=rows.length>=4;if(big&&carryOn)sel.t.forEach(id=>bonus[id]=P.carry);
      const C=M.cycles.find(x=>x.id===cur);C.end=riyadhToday();if(big){C.top=[...sel.t];C.bottom=[...sel.b]}
      const nid="c"+(M.cycles.length+1);M.cycles.push({id:nid,name:"الدورة "+(M.cycles.length+1),start:riyadhToday(),bonus});M.current=nid;
      confirmKey=null;viewCycle=null;draft=null;
      await act(()=>put("meta/state",M),"بدأت دورة جديدة");render();break}
  }
}
function onInput(e){
  const t=e.target;if(!el.contains(t))return;
  if(t.dataset.f==="enrich"){const m=t.closest(".d-roll").dataset.m;let v=Math.abs(+t.value||0);if(v>25){v=25;t.value=25;toast("الحد الأعلى لخصم البرنامج الإثرائي 25 نقطة")}draft.rec[m].enrich=v;
    const tot=recLines(draft.rec[m]).reduce((a,x)=>a+x.p,0),x=t.closest(".d-roll").querySelector(".d-total");x.textContent=sgn(tot);x.className="d-total "+(tot<0?"minus":tot>0?"plus":"");saveDraft()}
  if(t.id==="d-odate"&&draft){draft.date=t.value;saveDraft()}
  if(t.id==="d-q"){q=t.value;$("#d-board").innerHTML=board()}
  if(t.id==="d-rq"){rq=t.value;const ms=memberList().filter(m=>match(m,rq));$("#d-rolls").innerHTML=ms.length?ms.map(recRow).join(""):`<p class="muted">ما فيه اسم يطابق «${esc(rq)}».</p>`}
}
async function onChange(e){
  const t=e.target;if(!el.contains(t))return;
  if(t.id==="d-cyc"){viewCycle=t.value;open=null;render()}
  if(t.id==="d-city"){const M=clone(meta());M.city=t.value;if(await act(()=>put("meta/state",M),"صار التوقيت حسب "+CITIES[t.value][0]))render()}
  if(t.id==="d-odate"||t.dataset.f==="enrich"){confirmKey=null;render()}
  if(t.dataset.pick){const S2=sel[t.dataset.pick];t.checked?S2.add(t.dataset.id):S2.delete(t.dataset.id)}
  if(t.id==="d-carry")carryOn=t.checked;
  if(t.dataset.rename){const id=t.dataset.rename,n=t.value.trim();
    if(!n){t.value=S.members[id]?.name||"";toast("الاسم ما يكون فاضي");return}
    if(n!==S.members[id]?.name&&await act(()=>put("members/"+id,{...S.members[id],name:n.slice(0,60)}))){renamed=id;render();setTimeout(()=>{if(renamed===id){renamed=null;render()}},2500)}}
  if(t.id==="d-import"&&t.files&&t.files[0]){
    try{
      const d=JSON.parse(await t.files[0].text());
      if(!d||typeof d.members!=="object"||typeof d.outings!=="object")throw new Error("shape");
      const ops=[];
      Object.entries(d.members).forEach(([id,m])=>ops.push(["put","members/"+id,{name:String(m.name).slice(0,60),order:m.order??null}]));
      Object.entries(d.outings).forEach(([id,o])=>ops.push(["put","outings/"+id,{date:o.date,cycle:o.cycle,rec:o.rec||{}}]));
      if(d.meta)ops.push(["put","meta/state",d.meta]);
      if(await act(()=>commit(ops),`انتقل ${Object.keys(d.members).length} عضو و${Object.keys(d.outings).length} طلعة`))render();
    }catch(err){console.error(err);toast("الملف ما هو ملف بيانات الانضباط")}
  }
}

/* ---------- mount ---------- */
export function mount(target){
  if(el)return;el=target;
  el.innerHTML=`<div class="d-head"><h2>ترتيب الانضباط</h2><span class="muted" id="d-cycle"></span></div>
    <div class="tabs" role="tablist" id="d-tabs"></div>
    <p class="d-banner" id="d-admin-note" hidden>أنت في وضع المنشئ: التسجيل والتعديل يظهر للزوار مباشرة بعد الحفظ.</p>
    <div id="d-view"><div class="card empty">جاري التحميل…</div></div>
    <div class="foot"><button class="link" id="d-mode" type="button">وضع المنشئ</button></div>
    <div class="d-toast" role="status" aria-live="polite" hidden></div>`;
  el.addEventListener("click",onClick);
  document.addEventListener("input",onInput);
  document.addEventListener("change",onChange);
  onAuthStateChanged(au,u=>{user=u;if(admin&&!TEST&&!u){stopAdmin();render()}});
  watchPublic();render();
}
