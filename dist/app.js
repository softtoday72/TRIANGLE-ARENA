(() => {
  'use strict';
  const CFG = window.ARENA_CONFIG, W = window.WEAPONS, ITEMS = window.ITEMS;
  // All battle rules live in game-core.js; this file only handles screens, input and drawing.
  const core = window.ArenaCore.createCore({config:CFG,weapons:W,items:ITEMS});
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const TAU = Math.PI * 2, clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const fmtTime=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(Math.max(0,Math.ceil(s%60))).padStart(2,'0')}`;
  const esc=s=>String(s).replace(/[&<>"']/g,c=>`&#${c.charCodeAt(0)};`);
  const colors=['#41e7e1','#ff5165','#c8ff4b','#ff9d42','#a98bff','#66a7ff','#ff6fd1','#f0e86b'];
  const teamPalettes=[['#41e7e1','#7ff7f0','#24aaa7','#bafffb'],['#ff5165','#ff8795','#c62f43','#ffbbc3'],['#c8ff4b','#dcff8a','#8fc51f','#efffc7'],['#a98bff','#c5afff','#7754d6','#e2d7ff']];
  const SPARKS={shield:8,hit:10,kill:28},WEAPON_KEYS=Object.keys(W),LEVEL_MARK=['','Ⅱ','Ⅲ'];
  // Bounce bullets change colour on every wall hit so a hard-to-predict path is still easy to follow.
  const BOUNCE_COLORS=['#e9f0f2','#ffd34d','#ff9d42','#ff6fd1','#a98bff','#66a7ff'];
  const weaponLabel=p=>`${W[p.weapon].name}${p.weaponLevel>1?' Lv'+p.weaponLevel:''}`;

  // localId is the pilot this browser controls; everything "mine" on screen is looked up through it.
  const state={screen:'setup',run:null,battle:null,localId:0,particles:[],rings:[],pendingSwitch:null,raf:0,last:0,resultTimer:0,paused:false,useItemQueued:false,keys:new Set()};
  // While net.room is set the server owns the run and the battle; this client only sends intent and draws what it is told.
  const net={ws:null,room:null,phase:null,invite:[],rooms:null,serverUp:false,deadline:null,sentInput:'',snapAt:0,tick:1/60,seq:0,inputs:[],base:null,ex:0,ey:0,angle:null};
  const online=()=>!!net.room,isHost=()=>online()&&net.room.hostId===net.room.you;
  const netSend=m=>{if(net.ws&&net.ws.readyState===1)net.ws.send(JSON.stringify(m));};
  const localPilot=()=>state.run.pilots[state.localId], localCraft=()=>state.battle.crafts[state.localId];
  const canvas=$('#arena'),ctx=canvas.getContext('2d');

  function show(id){$$('.screen').forEach(x=>x.classList.remove('active'));$(`#${id}`).classList.add('active');state.screen=id;window.scrollTo({top:0,behavior:'smooth'});}
  function radio(name){return $(`input[name="${name}"]:checked`).value;}
  function setupListeners(){
    const setupChanged=()=>{refreshSetup();if(isHost())netSend({t:'settings',settings:readSetup()});};
    $('.setup-grid').addEventListener('input',setupChanged);$('.setup-grid').addEventListener('change',setupChanged);
    $('#createRun').addEventListener('click',()=>{if(!online())createRun();else if(isHost())netSend({t:'start'});});
    $('#startRound').addEventListener('click',()=>online()?netSend({t:'ready'}):beginBattle());
    $('#continueRun').addEventListener('click',()=>online()?netSend({t:'ready'}):nextRound());$('#newRun').addEventListener('click',resetToSetup);
    $('#resumeGame').addEventListener('click',resume);$('#endGame').addEventListener('click',()=>{$('#confirmModal').classList.add('active');});
    $('#cancelEnd').addEventListener('click',()=>$('#confirmModal').classList.remove('active'));$('#confirmEnd').addEventListener('click',()=>online()?leaveRoom():resetToSetup());
    $('#cancelSwitch').addEventListener('click',()=>{state.pendingSwitch=null;$('#switchModal').classList.remove('active');});
    $('#confirmSwitch').addEventListener('click',()=>{const k=state.pendingSwitch;state.pendingSwitch=null;$('#switchModal').classList.remove('active');if(k)sendBuy('weapon',k);});
    $('#createRoom').addEventListener('click',createRoom);$('#roomName').addEventListener('keydown',e=>{if(e.key==='Enter')createRoom();});$('#leaveRoom').addEventListener('click',leaveRoom);$('#playerName').addEventListener('change',()=>{try{localStorage.setItem('arenaName',$('#playerName').value);}catch{}});
    window.addEventListener('keydown',e=>{if(e.target?.tagName==='INPUT'&&e.target.type==='text')return;if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code))e.preventDefault();state.keys.add(e.code);if(e.code==='Escape'&&state.screen==='gameScreen')togglePause();if(e.code==='KeyZ'){if(online()){if(net.phase==='battle')netSend({t:'item'});}else if(state.battle&&!state.paused)state.useItemQueued=true;}});
    window.addEventListener('keyup',e=>state.keys.delete(e.code));
    // An online fight cannot be paused, so losing focus just lets go of every key instead.
    window.addEventListener('blur',()=>{if(online()){state.keys.clear();if(net.phase==='battle')sendInput();}else if(state.screen==='gameScreen'&&!state.paused)pause();});
  }
  function readSetup(){return{ai:+$('#aiCount').value,mode:radio('mode'),teams:+$('#teamCount').value,maxHp:+radio('health'),difficulty:$('#difficulty').value,rounds:radio('rounds')};}
  function applySetup(s){const check=(name,v)=>{const x=$(`input[name="${name}"][value="${v}"]`);if(x)x.checked=true;};const ai=$('#aiCount');ai.min=0;ai.max=7;ai.value=s.ai;check('mode',s.mode);$('#teamCount').value=s.teams;check('health',s.maxHp);check('rounds',s.rounds);$('#difficulty').value=s.difficulty;}
  // Keeps the setup form consistent with who may edit it: anyone offline, only the host online.
  function refreshSetup(){
    const r=net.room,host=isHost(),locked=!!r&&!host,humans=r?r.players.length:1,ai=$('#aiCount');
    ai.min=r&&humans>1?0:1;ai.max=8-humans;
    $$('#setupScreen .setup-grid input,#setupScreen .setup-grid select').forEach(x=>x.disabled=locked);
    const total=+ai.value+humans;$('#teamCount option[value="4"]').disabled=total<4;if(total<4)$('#teamCount').value='2';
    $('#teamCount').disabled=locked||radio('mode')==='ffa';
    $('#aiValue').textContent=ai.value;$('#totalValue').textContent=total;
    $('#createRun').innerHTML=!r?'進入第一場 <span>→</span>':host?'開始連線對戰 <span>→</span>':'等待房主開始';$('#createRun').disabled=locked;
    renderLobby();
  }

  function createRun(){
    const s=readSetup();state.localId=0;
    state.run=core.createRun({count:s.ai+1,mode:s.mode,teams:s.teams,maxHp:s.maxHp,difficulty:s.difficulty,rounds:s.rounds});
    state.run.pilots.forEach(p=>p.color=pickColor(p.id));
    openShop();
  }
  function pickColor(i){const s=state.run.settings;return s.mode==='team'?teamPalettes[i%s.teams][Math.floor(i/s.teams)%4]:colors[i%colors.length];}
  function openShop(){core.autoBuy(state.run);renderShop();show('shopScreen');}
  function readyCount(){const ps=net.room.players;return `(${ps.filter(p=>p.ready).length}/${ps.length})`;}
  function iAmReady(){return !!net.room.players.find(p=>p.cid===net.room.you)?.ready;}
  // The server moves on by itself when the countdown runs out, so stragglers cannot hold the room up.
  function countdownText(){return net.deadline===null?'':` · ${Math.max(0,Math.ceil((net.deadline-performance.now())/1000))} 秒`;}
  function shopButton(){const waiting=online()&&iAmReady();$('#startRound').disabled=waiting;$('#startRound').innerHTML=!online()?'部署並開戰 <span>→</span>':waiting?`等待其他玩家 ${readyCount()}${countdownText()}`:`準備完成 ${readyCount()}${countdownText()} <span>→</span>`;}
  function resultButton(){const done=!state.run.infinite&&state.run.round>=state.run.maxRounds,waiting=online()&&iAmReady();$('#continueRun').disabled=waiting;$('#continueRun').innerHTML=waiting?`等待其他玩家 ${readyCount()}${countdownText()}`:`${done?'查看本輪總結':'前往下一場'}${online()?' '+readyCount()+countdownText():''} <span>→</span>`;}
  function renderShop(){
    const run=state.run,p=localPilot(),total=run.infinite?'∞':String(run.maxRounds).padStart(2,'0');
    $('#shopRoundLabel').textContent=`ROUND ${String(run.round).padStart(2,'0')} / ${total}`;$('#shopMoney').textContent=p.money;$('#heldWeapon').textContent=weaponLabel(p);$('#heldItem').textContent=p.item?`${ITEMS[p.item].name} × ${p.itemCharges}`:'—';$('#recordText').textContent=`${p.wins} 勝 · ${p.totalKills} 擊殺`;
    $('#battleIntel').textContent=`${run.settings.mode==='ffa'?'個人混戰':run.settings.teams+' 隊團戰'} · ${run.settings.count} 台機體 · ${run.settings.maxHp} 格耐久`;
    // The held weapon is listed first; that is also the only way the basic weapon appears, as an upgrade.
    const weapons=Object.keys(W).map(k=>[k,core.weaponOffer(run,p,k)]).filter(([,o])=>o).sort((a,z)=>(z[0]===p.weapon)-(a[0]===p.weapon));
    $('#weaponShop').innerHTML=weapons.map(([k,o])=>weaponCard(k,o,p)).join('');
    $('#itemShop').innerHTML=Object.keys(ITEMS).map(k=>itemCard(k,core.itemOffer(p,k),p)).join('');
    $$('.shop-card button').forEach(b=>b.addEventListener('click',()=>buy(b.dataset.type,b.dataset.key)));
    shopButton();

  }
  function weaponCard(k,o,p){const v=W[k],held=o.kind!=='buy',next=o.kind==='upgrade'?`升級 Lv${o.level}：${v.levelDesc[o.level-2]}`:o.kind==='max'?'已達最高等級':v.desc;
    const label=o.kind==='max'?'已滿級':o.kind==='upgrade'?`升級 $${o.price}`:'$'+o.price;
    return `<article class="shop-card ${held?'owned':''}"><div><h3>${v.name}${held?` Lv${p.weaponLevel} · 已裝備`:''}</h3><p>${held&&o.kind!=='max'?`目前：${p.weaponLevel>1?v.levelDesc[p.weaponLevel-2]:v.desc}<br>`:''}${next}</p></div><button data-type="weapon" data-key="${k}" ${o.kind==='max'||o.price>p.money?'disabled':''}>${label}</button></article>`;}
  function itemCard(k,o,p){const v=ITEMS[k],held=o.kind!=='buy',label=o.kind==='full'?'已滿':o.kind==='refill'?`補充 $${o.price}`:'$'+o.price;
    return `<article class="shop-card ${held?'owned':''}"><div><h3>${v.name}${held?` × ${p.itemCharges} · 已持有`:''}</h3><p>${v.desc}</p></div><button data-type="item" data-key="${k}" ${o.kind==='full'||o.price>p.money?'disabled':''}>${label}</button></article>`;}
  // Switching away from an upgraded weapon throws its levels away, so ask first.
  function buy(type,key){const p=localPilot();if(type==='weapon'&&key!==p.weapon&&p.weaponLevel>1){state.pendingSwitch=key;$('#switchText').textContent=`目前的 ${weaponLabel(p)} 會消失，${W[key].name} 從 Lv1 重新開始。`;$('#switchModal').classList.add('active');return;}sendBuy(type,key);}
  function sendBuy(type,key){if(online())netSend({t:'buy',kind:type,key});else if(core.buy(state.run,state.localId,type,key))renderShop();}

  function beginBattle(){
    state.battle=core.startBattle(state.run);state.particles=[];state.rings=[];state.useItemQueued=false;
    state.paused=false;updateHUD();show('gameScreen');canvas.focus();state.last=performance.now();cancelAnimationFrame(state.raf);state.raf=requestAnimationFrame(loop);
  }
  function loop(now){const dt=Math.min(.033,(now-state.last)/1000||0);state.last=now;if(state.screen!=='gameScreen')return;if(!state.paused){if(online())updateOnline(dt);else update(dt);if(state.battle)draw();}state.raf=requestAnimationFrame(loop);}
  function update(dt){const b=state.battle;if(!b||b.ended)return;
    const cmd=playerCommand();cmd.useItem=state.useItemQueued;state.useItemQueued=false;
    const fought=core.step(b,dt,{[state.localId]:cmd});
    if(!fought){$('#countdown').textContent=b.started?'':b.countdown>0?Math.ceil(b.countdown):'FIGHT';updateHUD();return;}
    b.events.forEach(sparkEvent);b.events.length=0;updateParticles(dt);updateHUD();
    if(b.ended)state.resultTimer=setTimeout(()=>{renderResults();show('resultScreen');},850);
  }
  function playerCommand(){let x=0,y=0;if(state.keys.has('ArrowLeft'))x--;if(state.keys.has('ArrowRight'))x++;if(state.keys.has('ArrowUp'))y--;if(state.keys.has('ArrowDown'))y++;return{move:!!(x||y),angle:x||y?Math.atan2(y,x):null,fire:state.keys.has('Space')};}
  function sparkEvent(e){if(e.type==='blast'){state.rings.push({x:e.x,y:e.y,r:e.r,t:.35});spark(e.x,e.y,'#c8ff4b',12);return;}spark(e.x,e.y,e.type==='shield'?'#66a7ff':state.run.pilots[e.pilotId].color,SPARKS[e.type]);}
  function spark(x,y,color,n){for(let i=0;i<n;i++){const a=Math.random()*TAU,s=40+Math.random()*180;state.particles.push({x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,t:.35+Math.random()*.5,color});}}
  function updateParticles(dt){for(const p of state.particles){p.t-=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vx*=.97;p.vy*=.97;}state.particles=state.particles.filter(p=>p.t>0);for(const r of state.rings)r.t-=dt;state.rings=state.rings.filter(r=>r.t>0);}
  function renderResults(){const b=state.battle,p=localPilot(),winners=b.winnerIds.map(id=>state.run.pilots[id].name);$('#winnerBadge').textContent=`勝者 ${winners.join(' / ')}`;const pr=b.resultRows.find(r=>r.c.pilot.id===state.localId);$('#payoutSummary').innerHTML=`<div><small>擊殺獎金</small><b>+$${pr.killPay}</b></div><div><small>存活獎金</small><b>+$${pr.survivePay}</b></div><div><small>${pr.win?'勝方獎勵':'輸方補償'}</small><b>+$${pr.outcome}</b></div><div><small>目前資金</small><b>$${p.money}</b></div>`;
    const rows=[...b.resultRows].sort((a,z)=>(+z.win-+a.win)||(z.c.kills-a.c.kills)||(z.c.survival-a.c.survival));$('#scoreBody').innerHTML=rows.map((r,i)=>`<tr class="${r.c.pilot.id===state.localId?'player-row':''}"><td>${String(i+1).padStart(2,'0')}</td><td><span class="pilot-cell"><i class="color-dot" style="background:${r.c.pilot.color}"></i>${esc(r.c.pilot.name)}</span></td><td>${r.c.kills}</td><td>${r.c.survival.toFixed(1)}s</td><td>$${r.killPay}</td><td>$${r.survivePay}</td><td>${r.win?'勝利':'補償'} +$${r.outcome}</td><td class="money-cell">+$${r.total}</td></tr>`).join('');
    resultButton();

  }
  function nextRound(){if(!core.advanceRound(state.run)){showFinal();return;}openShop();}
  function showFinal(){const p=localPilot(),rank=[...state.run.pilots].sort((a,b)=>b.wins-a.wins||b.totalKills-a.totalKills).findIndex(x=>x.id===state.localId)+1;$('#finalStats').innerHTML=`<div><small>最終排名</small><b>#${rank}</b></div><div><small>勝場</small><b>${p.wins}</b></div><div><small>總擊殺</small><b>${p.totalKills}</b></div><div><small>剩餘資金</small><b>$${p.money}</b></div>`;show('finalScreen');}
  function updateHUD(){const b=state.battle;if(!b)return;const p=localCraft();$('#hudRound').textContent=`ROUND ${String(state.run.round).padStart(2,'0')}`;$('#hudAlive').textContent=`${b.crafts.filter(c=>c.alive).length} ALIVE`;$('#hudTimer').textContent=fmtTime(b.timeLeft);$('#hudMoney').textContent=p.pilot.money;$('#hudWeapon').textContent=weaponLabel(p.pilot);$('#hudItem').textContent=p.pilot.item?`${ITEMS[p.pilot.item].name} × ${p.pilot.itemCharges}`:'—';$('#hudHealth').innerHTML=Array.from({length:p.maxHp},(_,i)=>`<i class="${i<p.hp?'':'empty'}"></i>`).join('');}
  function pause(){const on=online();if(!on)state.paused=true;$('#pauseKicker').textContent=on?'MATCH STILL RUNNING':'SYSTEM PAUSED';$('#pauseTitle').textContent=on?'選單':'暫停';$('#endGame').textContent=on?'離開房間':'結束本輪';$('#confirmTitle').textContent=on?'確定離開房間？':'確定結束本輪？';$('#confirmText').textContent=on?'你的機體會交給 AI 接手。之後可以從房間列表再加入，但會接手錢最少的那台。':'目前資金、裝備與戰績都會清空。';$('#confirmEnd').textContent=on?'確定離開':'確定結束';$('#pauseModal').classList.add('active');}
  function resume(){state.paused=false;$('#pauseModal').classList.remove('active');state.last=performance.now();canvas.focus();}
  function togglePause(){$('#pauseModal').classList.contains('active')?resume():pause();}
  function resetToSetup(){cancelAnimationFrame(state.raf);clearTimeout(state.resultTimer);state.battle=null;state.keys.clear();state.paused=false;$('#pauseModal').classList.remove('active');$('#confirmModal').classList.remove('active');show('setupScreen');}

  // ---- online mode ----

  // The page keeps one connection to the server while it is up: outside a room it shows the room list,
  // inside a room it carries the game. If it drops, the client keeps trying to reconnect.
  function connectServer(){
    if(net.ws)return;
    const ws=net.ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);
    ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.t==='s')onSnapshot(m);else if(m.t==='room')onRoom(m);else if(m.t==='rooms'){net.rooms=m.rooms;net.maxRooms=m.max;if(!online())renderRoomList();}else if(m.t==='error'){if(online())backToBrowse(m.msg);else $('#onlineNote').textContent=m.msg;}};
    ws.onclose=()=>{if(net.ws!==ws)return;net.ws=null;net.rooms=null;const wasInRoom=online();backToBrowse(wasInRoom?'與伺服器的連線中斷了，正在重新連線…':'');renderRoomList();setTimeout(connectServer,3000);};
  }
  function playerName(){return $('#playerName').value.trim();}
  function createRoom(){if(!net.ws||online())return;$('#onlineNote').textContent='';netSend({t:'create',name:playerName(),roomName:$('#roomName').value});}
  function joinRoom(id){if(!net.ws||online())return;$('#onlineNote').textContent='';netSend({t:'join',name:playerName(),roomId:id});}
  function leaveRoom(){netSend({t:'leave'});backToBrowse('');}
  function backToBrowse(note){const wasInRoom=online();net.room=null;net.phase=null;net.deadline=null;if(wasInRoom||state.screen!=='setupScreen')resetToSetup();refreshSetup();renderRoomList();$('#onlineNote').textContent=note;}
  const PHASES={lobby:'等待中',shop:'商店',battle:'對戰中',result:'結算',final:'結算'};
  function renderRoomList(){
    const list=$('#roomList');if(!list||online())return;
    if(net.rooms===null){$('#onlineStatus').textContent='';list.replaceChildren(Object.assign(document.createElement('small'),{textContent:net.serverUp?'正在連線到伺服器…':''}));return;}
    $('#onlineStatus').textContent=`${net.rooms.length} 間房`;
    if(!net.rooms.length){list.replaceChildren(Object.assign(document.createElement('small'),{textContent:'目前沒有房間，建立一個吧。'}));return;}
    list.replaceChildren(...net.rooms.map(r=>{
      const row=document.createElement('button'),cell=(tag,text,cls)=>{const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;};
      const status=r.phase==='lobby'?'等待中':`第 ${r.round}/${r.maxRounds??'∞'} 場・${PHASES[r.phase]}`;
      const action=r.phase==='lobby'?(r.joinable?'加入':'已滿'):(r.joinable?`接手 AI（${r.aiSeats}）`:'沒有空位');
      row.type='button';row.className='room-row'+(r.phase==='lobby'?'':' busy');row.disabled=!r.joinable;
      row.append(cell('b',r.name),cell('span','房主 '+r.host),cell('span',status),cell('span',`${r.humans}/${r.crafts}`,'count'),cell('em',action));
      row.addEventListener('click',()=>joinRoom(r.id));return row;}));
  }
  function renderLobby(){
    const r=net.room;$('#onlineBrowse').hidden=!!r;$('#onlineRoom').hidden=!r;if(!r)return;$('#onlineStatus').textContent=`${r.name} · ${r.players.length} 人`;
    $('#playerList').replaceChildren(...r.players.map(p=>{const li=document.createElement('li');li.textContent=p.name;if(p.cid===r.you)li.className='me';if(p.cid===r.hostId){const em=document.createElement('em');em.textContent='房主';li.append(em);}return li;}));
    // Friends need nothing but a link; show the ones that actually reach this server from another machine.
    $('#inviteList').replaceChildren(...(net.invite.length?net.invite:[location.origin]).map(url=>{const row=document.createElement('div'),box=document.createElement('input'),btn=document.createElement('button');row.className='online-row';box.type='text';box.readOnly=true;box.value=url;box.setAttribute('aria-label','邀請網址');box.addEventListener('focus',()=>box.select());btn.type='button';btn.className='ghost-btn';btn.textContent='複製';btn.addEventListener('click',()=>copyInvite(box,btn));row.append(box,btn);return row;}));
    $('#onlineHint').textContent=isHost()?'把邀請網址傳給朋友，對方打開後在房間列表點這一間。人到齊後按「開始連線對戰」。':'等待房主設定並開始。';$('#onlineNote').textContent='';
  }
  function copyInvite(box,btn){
    const done=()=>{btn.textContent='已複製';setTimeout(()=>btn.textContent='複製',1500);};
    // The clipboard API only exists on https and localhost; a plain http LAN address falls back to the selection.
    if(navigator.clipboard)navigator.clipboard.writeText(box.value).then(done,()=>box.select());else{box.select();if(document.execCommand('copy'))done();}
  }
  function onRoom(m){
    const prev=net.phase;net.room=m;net.phase=m.phase;net.tick=1/m.hz;net.deadline=m.left===null||m.left===undefined?null:performance.now()+m.left;
    if(m.run){m.run.maxRounds=m.run.infinite?Infinity:m.run.maxRounds;state.run=m.run;state.localId=m.pilotId;state.run.pilots.forEach(p=>p.color=pickColor(p.id));}
    if(m.phase==='lobby'){
      // A finished run leaves its summary on screen until the player dismisses it.
      applySetup(m.settings);refreshSetup();if(state.screen!=='finalScreen'&&state.screen!=='setupScreen')resetToSetup();
    }else if(m.phase==='shop'){renderShop();if(state.screen!=='shopScreen')show('shopScreen');}
    else if(m.phase==='battle'){if(prev!=='battle')beginOnlineBattle();}
    else if(m.phase==='result'){
      if(!state.battle)state.battle={crafts:[],bullets:[],lasers:[],mines:[],bountyIds:new Set()};
      state.battle.winnerIds=m.result.winnerIds;state.battle.resultRows=m.result.rows.map(r=>({...r,c:{pilot:state.run.pilots[r.id],kills:r.kills,survival:r.survival}}));
      if(prev===null){renderResults();show('resultScreen');}else if(prev!=='result')state.resultTimer=setTimeout(()=>{renderResults();show('resultScreen');},850);else if(state.screen==='resultScreen')renderResults();
    }else if(m.phase==='final')showFinal();
  }
  function beginOnlineBattle(){state.battle=null;state.particles=[];state.rings=[];net.sentInput='';net.seq=0;net.inputs=[{s:0,vx:0,vy:0,t:performance.now()}];net.base=null;net.ex=net.ey=0;net.angle=null;state.paused=false;$('#pauseModal').classList.remove('active');$('#countdown').textContent='';show('gameScreen');canvas.focus();state.last=performance.now();cancelAnimationFrame(state.raf);state.raf=requestAnimationFrame(loop);}
  // Rebuilds a battle object shaped like the core's, so drawing and the HUD work the same in both modes.
  function onSnapshot(m){
    if(net.phase!=='battle'||!state.run)return;const run=state.run,me=localPilot(),now=performance.now();
    const before=net.base?predictSelf(now):null;
    [me.money,me.weapon,me.item,me.itemCharges,me.weaponLevel]=m.me;
    state.battle={time:m.tm,snapTime:m.tm,started:m.st,ended:m.en,timeLeft:m.tl,countdown:m.cd,bountyIds:new Set(m.bo),winnerIds:[],resultRows:[],
      crafts:m.c.map((c,i)=>({pilot:run.pilots[i],alive:!!c.al,hidden:!!c.hid,sx:c.x,sy:c.y,x:c.x,y:c.y,vx:c.vx||0,vy:c.vy||0,angle:c.a||0,r:CFG.craft.radius,hp:c.hp||0,maxHp:run.settings.maxHp,shield:c.sh||0,cloak:c.ck?1:0,knocked:!!c.kn,satReady:c.le||0})),
      bullets:m.b.map(([x,y,vx,vy,k,r,bounced,flags])=>({sx:x,sy:y,x,y,vx,vy,type:WEAPON_KEYS[k],r,bounced,blast:flags&1,wrap:!!(flags&2)})),
      lasers:m.l.map(([x,y,angle,active,w,full])=>({x,y,angle,active:!!active,w,full:!!full})),
      mines:m.m.map(([x,y])=>({x,y,team:me.team}))};
    net.snapAt=now;m.ev.forEach(sparkEvent);rebasePrediction(m,now,before);
  }
  // ---- local prediction ----
  // The server only reports where this craft was a round trip ago. To make it answer the keys at once, the client keeps
  // every input the server has not finished applying and replays them on top of the newest authoritative position.
  function predictSelf(now){
    const log=net.inputs,r=CFG.craft.radius;let{x,y}=net.base;
    for(let i=0;i<log.length;i++){
      // The oldest entry is the one the server acknowledged; the part it already simulated is in the base position.
      let dur=((i+1<log.length?log[i+1].t:now)-log[i].t)/1000;if(i===0)dur-=net.base.n*net.tick;
      if(dur<=0)continue;dur=Math.min(dur,.5);x=clamp(x+log[i].vx*dur,r,1200-r);y=clamp(y+log[i].vy*dur,r,800-r);
    }
    return{x,y};
  }
  function rebasePrediction(m,now,before){
    const b=state.battle,me=b.crafts[state.localId],[ack,applied]=m.k,log=net.inputs;
    while(log.length>1&&log[0].s<ack)log.shift();
    // An input held while the server was not simulating this craft (countdown) has not really been running that long.
    if(now-log[0].t-applied*net.tick*1000>400)log[0].t=now-applied*net.tick*1000;
    // While knocked back the server moves this craft regardless of input, so there is nothing to predict.
    if(!me.alive||!b.started||b.ended||me.knocked){net.base=null;net.ex=net.ey=0;return;}
    net.base={x:me.sx,y:me.sy,n:applied};
    // Whatever the new snapshot disagrees with is kept as an offset and faded out, so corrections never show as a jump.
    if(before){const after=predictSelf(now);net.ex+=before.x-after.x;net.ey+=before.y-after.y;if(Math.hypot(net.ex,net.ey)>80)net.ex=net.ey=0;}
  }
  function applyPrediction(dt){
    const b=state.battle,me=b.crafts[state.localId];if(!net.base||!me.alive)return;
    const p=predictSelf(performance.now()),fade=Math.exp(-dt*12);net.ex*=fade;net.ey*=fade;
    me.x=p.x+net.ex;me.y=p.y+net.ey;if(net.angle!==null)me.angle=net.angle;
    // Other crafts are not predicted, so just refuse to draw this one inside them.
    for(const o of b.crafts){if(o===me||!o.alive||o.hidden)continue;const dx=me.x-o.x,dy=me.y-o.y,d=Math.hypot(dx,dy)||.001,over=me.r+o.r-d;if(over>0){me.x+=dx/d*over;me.y+=dy/d*over;}}
  }
  function sendInput(){const c=playerCommand(),d=c.move?((Math.round(c.angle/(Math.PI/4))%8)+8)%8:-1,sig=`${d}${c.fire?'f':''}`;if(sig===net.sentInput)return;net.sentInput=sig;const a=d*Math.PI/4,v=d<0?0:CFG.craft.speed;if(d>=0)net.angle=a;net.inputs.push({s:++net.seq,vx:Math.cos(a)*v,vy:Math.sin(a)*v,t:performance.now()});netSend({t:'input',s:net.seq,d,f:c.fire});}
  function updateOnline(dt){
    sendInput();const b=state.battle;if(!b)return;
    // Snapshots arrive at half the simulation rate; coast everything along its last known velocity in between.
    const age=b.started&&!b.ended?Math.min(.1,(performance.now()-net.snapAt)/1000):0;
    for(const c of b.crafts)if(c.alive&&!c.hidden){c.x=clamp(c.sx+c.vx*age,c.r,1200-c.r);c.y=clamp(c.sy+c.vy*age,c.r,800-c.r);}
    for(const s of b.bullets){s.x=s.sx+s.vx*age;s.y=s.sy+s.vy*age;}
    b.time=b.snapTime+age;
    applyPrediction(dt);
    $('#countdown').textContent=b.started?'':b.countdown>0?Math.ceil(b.countdown):'FIGHT';
    if(b.started&&!b.ended)updateParticles(dt);updateHUD();
  }

  function draw(){ctx.fillStyle='#020304';ctx.fillRect(0,0,1200,800);drawGrid();const b=state.battle,me=localCraft();
    if(me?.alive)drawAimAssist(me);for(const m of b.mines)drawMine(m);for(const l of b.lasers)drawLaser(l);for(const bullet of b.bullets)drawBullet(bullet);for(const c of b.crafts)if(c.alive){drawCraft(c);drawSatellites(c,b);}for(const r of state.rings){ctx.globalAlpha=clamp(r.t/.35,0,1);ctx.strokeStyle='#c8ff4b';ctx.lineWidth=2;ctx.beginPath();ctx.arc(r.x,r.y,r.r*(1.15-r.t/.35*.3),0,TAU);ctx.stroke();}for(const p of state.particles){ctx.globalAlpha=clamp(p.t*2,0,1);ctx.fillStyle=p.color;ctx.fillRect(p.x-2,p.y-2,4,4);}ctx.globalAlpha=1;
    if(!me.alive){ctx.fillStyle='#0008';ctx.fillRect(0,0,1200,800);ctx.textAlign='center';ctx.fillStyle='#e9f0f2';ctx.font='700 28px Cascadia Mono, monospace';ctx.fillText('觀戰模式',600,380);ctx.fillStyle='#84919b';ctx.font='14px Cascadia Mono, monospace';ctx.fillText('等待本場結束',600,410);}
  }
  function drawGrid(){ctx.strokeStyle='#0d1519';ctx.lineWidth=1;for(let x=40;x<1200;x+=40){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,800);ctx.stroke();}for(let y=40;y<800;y+=40){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(1200,y);ctx.stroke();}ctx.strokeStyle='#263039';ctx.lineWidth=3;ctx.strokeRect(2,2,1196,796);}
  function drawAimAssist(c){const lock=core.findAimAssist(state.battle,c),angle=lock?.angle??c.angle,endX=lock?lock.target.x:c.x+Math.cos(angle)*CFG.aimAssist.guideLength,endY=lock?lock.target.y:c.y+Math.sin(angle)*CFG.aimAssist.guideLength;ctx.save();ctx.strokeStyle=c.pilot.color;ctx.lineWidth=1;ctx.globalAlpha=lock?.3:.12;ctx.setLineDash(lock?[5,8]:[3,9]);ctx.beginPath();ctx.moveTo(c.x+Math.cos(angle)*28,c.y+Math.sin(angle)*28);ctx.lineTo(endX,endY);ctx.stroke();if(lock){ctx.globalAlpha=.7;ctx.setLineDash([]);ctx.beginPath();ctx.arc(lock.target.x,lock.target.y,lock.target.r+8,0,TAU);ctx.stroke();}ctx.restore();}
  function drawCraft(c){const isEnemy=c.pilot.team!==localPilot().team;if(c.cloak>0&&isEnemy)return;ctx.save();ctx.translate(c.x,c.y);ctx.rotate(c.angle);ctx.globalAlpha=c.cloak>0?.3:1;ctx.shadowColor=c.pilot.color;ctx.shadowBlur=12;ctx.strokeStyle=c.pilot.color;ctx.fillStyle='#050608';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(24,0);ctx.lineTo(-16,-15);ctx.lineTo(-10,0);ctx.lineTo(-16,15);ctx.closePath();ctx.fill();ctx.stroke();ctx.shadowBlur=0;if(c.shield>0){ctx.strokeStyle='#66a7ff';ctx.lineWidth=2;ctx.setLineDash([4,5]);ctx.beginPath();ctx.arc(0,0,27,0,TAU);ctx.stroke();ctx.setLineDash([]);}ctx.restore();ctx.globalAlpha=1;
    ctx.textAlign='center';ctx.font='10px Cascadia Mono, monospace';ctx.fillStyle='#84919b';ctx.fillText(c.pilot.name,c.x,c.y+36);if(state.battle.bountyIds.has(c.pilot.id)){ctx.fillStyle='#ffd34d';ctx.font='17px sans-serif';ctx.fillText('♛',c.x,c.y-27);}for(let i=0;i<c.hp;i++){ctx.fillStyle=c.pilot.color;ctx.fillRect(c.x-(c.maxHp*7)/2+i*7,c.y+24,5,2);}
    // Weapon level next to the health bar, so opponents can tell an upgraded craft from afar.
    const lv=c.pilot.weaponLevel||1;if(lv>1){ctx.fillStyle='#c8ff4b';ctx.font='700 11px Cascadia Mono, monospace';ctx.textAlign='left';ctx.fillText(LEVEL_MARK[lv-1],c.x+(c.maxHp*7)/2+4,c.y+29);}}
  function drawSatellites(c,b){if(c.pilot.weapon!=='laser'||(c.cloak>0&&c.pilot.team!==localPilot().team))return;const n=Math.max(0,(c.pilot.weaponLevel||1)-1);if(!n)return;
    const ready=c.satReady??(c.satellites||[]).filter(t=>t<=0).length;ctx.save();ctx.shadowColor='#ff5165';for(let i=0;i<n;i++){const a=b.time*2.5+i*TAU/n,x=c.x+Math.cos(a)*34,y=c.y+Math.sin(a)*34;ctx.globalAlpha=c.cloak>0?.3:1;ctx.shadowBlur=i<ready?12:0;ctx.fillStyle=i<ready?'#ff5165':'#3a1118';ctx.strokeStyle='#ff5165';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(x,y,4.5,0,TAU);ctx.fill();ctx.stroke();}ctx.restore();}
  function drawBullet(b){const color=b.blast?'#c8ff4b':b.type==='heavy'?'#ff9d42':b.type==='homing'?'#41e7e1':b.type==='bounce'?BOUNCE_COLORS[Math.min(b.bounced||0,BOUNCE_COLORS.length-1)]:'#e9f0f2';
    // A wrapping bullet near an edge is also drawn where it is about to come back in.
    const spots=[[b.x,b.y]];if(b.wrap){const gx=b.x<30?1200:b.x>1170?-1200:0,gy=b.y<30?800:b.y>770?-800:0;if(gx)spots.push([b.x+gx,b.y]);if(gy)spots.push([b.x,b.y+gy]);}
    ctx.save();ctx.fillStyle=color;ctx.shadowColor=color;ctx.shadowBlur=b.type==='homing'||b.blast?16:10;for(const[x,y]of spots){ctx.beginPath();ctx.arc(x,y,b.r,0,TAU);ctx.fill();}ctx.restore();}
  function drawMine(m){const visible=m.team===localPilot().team&&CFG.rules.friendlyMinesVisible;if(!visible)return;ctx.save();ctx.translate(m.x,m.y);ctx.strokeStyle='#ff9d42';ctx.globalAlpha=.65;ctx.setLineDash([3,4]);ctx.beginPath();ctx.arc(0,0,12,0,TAU);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='#ff9d42';ctx.fillRect(-2,-2,4,4);ctx.restore();}
  // The warning shows the beam's real width, so players can see how far they need to move.
  // The warning shows the beam's real width, so players can see how far they need to move. Summoned beams cross the whole arena.
  function drawLaser(l){const w=l.w||3,from=l.full?-1500:0;ctx.save();ctx.translate(l.x,l.y);ctx.rotate(l.angle);if(!l.active&&w>3){ctx.fillStyle='#ff5165';ctx.globalAlpha=.12;ctx.fillRect(from,-w,1500-from,w*2);}ctx.strokeStyle=l.active?'#fff':'#ff5165';ctx.lineWidth=l.active?Math.max(5,w*2):1;ctx.globalAlpha=l.active?clamp((l.t??.15)/.15,.2,1):.65;ctx.shadowColor='#ff5165';ctx.shadowBlur=l.active?25:8;ctx.beginPath();ctx.moveTo(from,0);ctx.lineTo(1500,0);ctx.stroke();ctx.restore();}

  setupListeners();refreshSetup();
  // The multiplayer entry only appears when this page was served by the game server.
  try{$('#playerName').value=localStorage.getItem('arenaName')||'';}catch{}
  fetch('api/status').then(r=>r.ok?r.json():null).then(s=>{if(s?.ok){net.invite=s.lan||[];net.serverUp=true;$('#onlineCard').hidden=false;renderRoomList();connectServer();setInterval(()=>{if(!online())return;if(net.phase==='shop'&&state.screen==='shopScreen')shopButton();else if(net.phase==='result'&&state.screen==='resultScreen')resultButton();},500);}}).catch(()=>{});
})();
