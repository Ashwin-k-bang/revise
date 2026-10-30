/* ===== Revise: standalone revision tracker. Local storage + GitHub sync (data/revise.json) =====
   Has its own sync settings (localStorage key 'rv-sync'), independent of Daylog.
   Records: topic {id,k:'t',name,o,r,c,u}   revision log {id,k:'r',t:topicId,ts,u}   delete marker {id,del:true,u}
   Each record is merged on its own (newest u wins), so two devices logging at once never lose a revision. */
/* ----- small helpers ----- */
const $=s=>document.querySelector(s), pad=n=>String(n).padStart(2,'0');
const ymd=d=>`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const parseD=s=>{const[y,m,d]=s.split('-').map(Number);return new Date(y,m-1,d)};
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

/* ----- one-link device setup: open  .../revise/#token=github_pat_xxx  once on a device ----- */
(()=>{const m=location.hash.match(/^#token=([^&]+)/);if(!m)return;
  let o={};try{o=JSON.parse(localStorage.getItem('rv-sync')||'{}')}catch(e){}
  o.token=decodeURIComponent(m[1]).trim();localStorage.setItem('rv-sync',JSON.stringify(o));
  history.replaceState(null,'',location.pathname+location.search)})();

const RV=(()=>{
  let db,rev=0,etag=null,sha=null,remote=[],busy=false,again=false,kt=null,pt=null,st='off',msg='',last=0,pause=0;
  const dataL=[],statL=[],BCr=window.BroadcastChannel?new BroadcastChannel('daylog-revise'):null;
  const tabsR=()=>{try{BCr&&BCr.postMessage(1)}catch(e){}};
  const cfg=()=>{
    let s={};try{s=JSON.parse(localStorage.getItem('rv-sync')||'{}')}catch(e){}
    const m=location.hostname.match(/^([^.]+)\.github\.io$/);
    return{owner:s.owner||(m?m[1]:''),repo:s.repo||(m?(location.pathname.split('/')[1]||''):''),
      branch:s.branch||'',path:'data/revise.json',token:(s.token||'').trim()};
  };
  const save=o=>{localStorage.setItem('rv-sync',JSON.stringify(o));etag=null;sha=null;remote=[];pause=0;last=0};
  const set=(s,m)=>{st=s;msg=m||'';statL.forEach(f=>f(st,msg))};
  const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,7);

  /* local storage (IndexedDB, works offline) */
  const open=()=>new Promise((res,rej)=>{const r=indexedDB.open('daylog-revise',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('items',{keyPath:'id'});
    r.onsuccess=()=>{db=r.result;res()};r.onerror=()=>rej(r.error)});
  const tx=(mode,f)=>new Promise((res,rej)=>{const t=db.transaction('items',mode);const o=f(t.objectStore('items'));t.oncomplete=()=>res(o&&o.result);t.onerror=()=>rej(t.error)});
  const allRaw=()=>tx('readonly',s=>s.getAll());
  const putRaw=l=>tx('readwrite',s=>{l.forEach(e=>s.put(e))});
  const putNewer=l=>new Promise((res,rej)=>{let n=0;const t=db.transaction('items','readwrite'),s=t.objectStore('items');
    l.forEach(e=>{const g=s.get(e.id);g.onsuccess=()=>{const o=g.result;if(!o||(e.u||0)>(o.u||0)){s.put(e);n++}}});
    t.oncomplete=()=>res(n>0);t.onerror=()=>rej(t.error)});
  const put=e=>{const r=putRaw([{...e,u:Date.now()}]);kick();tabsR();return r};
  const putMany=l=>{const n=Date.now();const r=putRaw(l.map(e=>({...e,u:n})));kick();tabsR();return r};
  const del=ids=>{const n=Date.now();const r=putRaw([].concat(ids).map(id=>({id,del:true,u:n})));kick();tabsR();return r};

  /* read helpers: returns {topics:[...], logs:[...]} without deleted items */
  async function all(){
    const raw=(await allRaw()).filter(e=>!e.del);
    const topics=raw.filter(e=>e.k==='t').sort((a,b)=>(a.c||0)-(b.c||0)||(a.id<b.id?-1:1));
    const ids=new Set(topics.map(t=>t.id));
    const logs=raw.filter(e=>e.k==='r'&&ids.has(e.t)).sort((a,b)=>b.ts-a.ts);
    return{topics,logs};
  }

  /* GitHub */
  const b64d=b=>new TextDecoder().decode(Uint8Array.from(atob(b.replace(/\s/g,'')),c=>c.charCodeAt(0)));
  const b64e=s=>{const u=new TextEncoder().encode(s);let o='';for(let i=0;i<u.length;i+=8192)o+=String.fromCharCode.apply(null,u.subarray(i,i+8192));return btoa(o)};
  const url=c=>`https://api.github.com/repos/${c.owner}/${c.repo}/contents/${c.path.split('/').map(encodeURIComponent).join('/')}`;
  const hdr=(c,x)=>({Accept:'application/vnd.github+json',...(c.token?{Authorization:'Bearer '+c.token}:{}),...x});
  const fail=r=>{
    const e=new Error(r.status===401?'GitHub rejected the token. Make a new one.':
      r.status===403?(r.headers.get('x-ratelimit-remaining')==='0'?(pause=(+r.headers.get('x-ratelimit-reset')||0)*1000||Date.now()+36e5,'GitHub rate limit reached. Retrying later.'):'Token lacks permission. It needs Contents: Read and write on this repo.'):
      r.status===404?'Repo or file not found (check owner and repo name, and that the token covers this repo).':
      r.status===409||r.status===422?'conflict':`GitHub error ${r.status}`);
    e.status=r.status;return e;
  };
  const nEnt=e=>e.del?{id:e.id,del:true,u:e.u||0}
    :e.k==='t'?{id:e.id,k:'t',name:e.name||'',o:e.o,r:e.r,c:e.c||0,u:e.u||0}
    :{id:e.id,k:'r',t:e.t,ts:e.ts,u:e.u||0};
  const ser=l=>'{\n"v":1,\n"items":[\n'+[...l].map(nEnt).sort((a,b)=>a.id<b.id?-1:1).map(e=>JSON.stringify(e)).join(',\n')+'\n]\n}\n';
  function parse(t){
    if(!t.trim())return[];
    let j;try{j=JSON.parse(t)}catch(e){throw new Error('data/revise.json is not valid JSON. Sync stopped so nothing gets overwritten.')}
    return Array.isArray(j.items)?j.items:[];
  }
  /* newest timestamp wins; on a tie the remote copy wins, so every device converges */
  function merge(a,b){const m=new Map();a.forEach(e=>m.set(e.id,e));b.forEach(e=>{const o=m.get(e.id);if(!o||(e.u||0)>(o.u||0))m.set(e.id,e)});return[...m.values()]}
  async function pull(c){
    const q=c.branch?'?ref='+encodeURIComponent(c.branch):'';
    const r=await fetch(url(c)+q,{headers:hdr(c,etag?{'If-None-Match':etag}:{}),cache:'no-store'});
    if(r.status===304)return{same:true};
    if(r.status===404){etag=null;sha=null;return{doc:[]}}
    if(!r.ok)throw fail(r);
    const j=await r.json();etag=r.headers.get('ETag');sha=j.sha;
    let t=j.content?b64d(j.content):'';
    if(!j.content){const r2=await fetch(url(c)+q,{headers:hdr(c,{Accept:'application/vnd.github.raw+json'}),cache:'no-store'});if(!r2.ok)throw fail(r2);t=await r2.text()}
    return{doc:parse(t)};
  }
  async function push(c,list){
    const body={message:'Revise sync '+new Date().toISOString().slice(0,16).replace('T',' '),content:b64e(ser(list))};
    if(sha)body.sha=sha;if(c.branch)body.branch=c.branch;
    const r=await fetch(url(c),{method:'PUT',headers:hdr(c,{'Content-Type':'application/json'}),body:JSON.stringify(body)});
    if(r.status===409||r.status===422)return false;
    if(!r.ok)throw fail(r);
    sha=(await r.json()).content.sha;etag=null;return true;
  }
  async function run(force){
    const c=cfg();
    if(!c.owner||!c.repo){set('off','Sync is not set up.');return}
    if(!navigator.onLine){set('err','Offline. Changes are kept on this device and sync later.');return}
    if(force!==true){if(Date.now()<pause)return;if(!c.token&&Date.now()-last<60000)return}
    if(busy){again=true;return}
    last=Date.now();busy=true;set('busy');let changed=false;
    try{
      for(let i=0;i<4;i++){
        const r0=rev;
        const f=await pull(c);
        if(!f.same)remote=f.doc;
        const local=await allRaw();
        if(rev!==r0)continue;
        const merged=merge(remote,local);
        if(merged.length&&await putNewer(merged.map(nEnt)))changed=true;
        if(rev!==r0)continue;
        if(c.token&&ser(merged)!==ser(remote)){
          if(await push(c,merged)){remote=merged;break}
          etag=null;continue;
        }
        break;
      }
      set(c.token?'ok':'ro',c.token?'':'Read-only. Add a GitHub token to save from this device.');
    }catch(e){set('err',e.message||String(e))}
    finally{busy=false;if(changed){dataL.forEach(f=>f());tabsR()}if(again){again=false;run()}}
  }
  function kick(){rev++;clearTimeout(kt);kt=setTimeout(()=>run(true),700)}
  function start(ms){
    run(true);clearInterval(pt);pt=setInterval(()=>{if(document.visibilityState==='visible')run()},ms||5000);
    document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')run()});
    addEventListener('online',()=>run(true));
  }
  if(BCr)BCr.onmessage=()=>dataL.forEach(f=>f());
  return{open,all,put,putMany,del,uid,start,cfg,save,run:()=>run(true),on:f=>dataL.push(f),onStatus:f=>{statL.push(f);f(st,msg)},state:()=>({st,msg})};
})();

/* ===== shared revision logic ===== */
const DEF_O=14,DEF_R=25;
const RC={green:'#16A34A',orange:'#EA7A0C',red:'#DC2626',none:'#64748B'};
const dayStart=ms=>{const d=new Date(ms);return new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime()};
const daysSince=ts=>Math.round((dayStart(Date.now())-dayStart(ts))/864e5);
/* green = revised less than O days ago, orange = O to R-1 days, red = R days or more, grey = never revised */
function status(t,lastTs){
  const o=t.o>0?t.o:DEF_O,r=t.r>o?t.r:Math.max(DEF_R,o+1);
  if(!lastTs)return{k:'none',days:null,label:'Not revised yet'};
  const d=daysSince(lastTs),k=d>=r?'red':d>=o?'orange':'green';
  return{k,days:d,label:d===0?'Today':d===1?'1 day ago':d+' days ago'};
}
const lastOf=(logs,id)=>logs.reduce((m,l)=>l.t===id&&l.ts>m?l.ts:m,0);
document.documentElement.dataset.theme=localStorage.getItem('rv-theme')||(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light');
function bindSyncButton(){
  const css=document.createElement('style');
  css.textContent='#sdlg{border:1px solid var(--line);border-radius:var(--r);background:var(--card);color:var(--ink);padding:18px;width:min(92vw,420px)}#sdlg::backdrop{background:rgba(0,0,0,.45)}#sdlg h3{margin:0}#sdlg label{display:block;font-size:13px;color:var(--mute);margin:10px 0 4px}#sdlg input{font:inherit;color:inherit;width:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 10px;min-width:0}#sdlg ol{font-size:13px;color:var(--mute);padding-left:20px;margin:10px 0}#sdlg .btns{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;margin-top:10px}#sdlg .btns button{font:inherit;color:inherit;cursor:pointer;border:1px solid var(--line);background:var(--card);border-radius:10px;padding:8px 14px}#sdlg .btns .pri{background:var(--acc);border-color:var(--acc);color:var(--bg);font-weight:600;width:auto;margin:0}#sMsg{font-size:13px;min-height:18px;margin-top:8px}';
  document.head.appendChild(css);
  const d=document.createElement('dialog');d.id='sdlg';
  d.innerHTML=`<h3>Sync across devices</h3>
    <p class="note" style="margin:6px 0 0">Your revision data is saved in this GitHub repo (<code>data/revise.json</code>), so every device shows the same boxes. Each device needs the token once.</p>
    <label>GitHub username<input id="sOwner" autocomplete="off" autocapitalize="off"></label>
    <label>Repository name<input id="sRepo" autocomplete="off" autocapitalize="off"></label>
    <label>Branch (leave empty for the default)<input id="sBranch" autocomplete="off" autocapitalize="off"></label>
    <label>Access token<input id="sTok" type="password" autocomplete="off" placeholder="github_pat_..."></label>
    <ol><li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a></li>
      <li>Repository access: <b>Only select repositories</b>, pick this repo</li>
      <li>Permissions &rarr; Repository &rarr; <b>Contents: Read and write</b></li>
      <li>Generate, copy, paste above</li></ol>
    <div id="sMsg" role="status"></div>
    <div class="btns"><button type="button" id="sOff">Remove token</button><button type="button" id="sX">Close</button><button type="button" class="pri" id="sGo">Save &amp; sync</button></div>`;
  document.body.appendChild(d);
  const open=()=>{const c=RV.cfg();$('#sOwner').value=c.owner;$('#sRepo').value=c.repo;$('#sBranch').value=c.branch;$('#sTok').value=c.token;$('#sMsg').textContent=RV.state().msg;d.showModal()};
  $('#syncb').addEventListener('click',e=>{e.preventDefault();open()});
  $('#sX').onclick=()=>d.close();
  $('#sGo').onclick=()=>{if(!$('#sTok').value.trim()){$('#sMsg').textContent='The token box is empty. Paste your github_pat_... token first.';$('#sTok').focus();return}
    RV.save({owner:$('#sOwner').value.trim(),repo:$('#sRepo').value.trim(),branch:$('#sBranch').value.trim(),token:$('#sTok').value.trim()});$('#sMsg').textContent='Connecting...';RV.run()};
  $('#sOff').onclick=()=>{const c=RV.cfg();RV.save({...c,token:''});$('#sTok').value='';$('#sMsg').textContent='Token removed from this device.';RV.run()};
  RV.onStatus((s,m)=>{const b=$('#syncb');if(!b)return;b.className=s;
    b.textContent={ok:'● Synced',busy:'● Syncing...',ro:'Set up sync',off:'Set up sync',err:'⚠ Sync issue'}[s]||'Sync';b.title=m||'';
    if(d.open)$('#sMsg').textContent=s==='ok'?'Connected. Your data is saved to GitHub.':(m||'')});
  if(location.hash==='#sync')setTimeout(open,300);
}

/* installable app: runtime manifest + offline service worker */
if(location.protocol.startsWith('http')){
  const base=new URL('./',location.href).href;
  const mf={name:'Revise',short_name:'Revise',start_url:base,scope:base,display:'standalone',orientation:'portrait',background_color:'#EEF1EF',theme_color:'#D9822B',
    icons:[{src:base+'icon-192.png',sizes:'192x192',type:'image/png',purpose:'any maskable'},{src:base+'icon-512.png',sizes:'512x512',type:'image/png',purpose:'any maskable'}]};
  const l=document.createElement('link');l.rel='manifest';l.href=URL.createObjectURL(new Blob([JSON.stringify(mf)],{type:'application/manifest+json'}));document.head.appendChild(l);
  navigator.serviceWorker?.register('sw.js').catch(()=>{});
}
