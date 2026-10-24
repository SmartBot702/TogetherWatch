(function(){
const $=id=>document.getElementById(id);
const socket=io();
let roomId=null,myName='',isHost=false,player=null,playerReady=false,media=null,remote=false,remoteUntil=0;

socket.on('connect',()=>{$('connection').textContent='● Serverga ulandi'});
socket.on('disconnect',()=>{$('connection').textContent='● Aloqa uzildi'});
function name(){return $('nickname').value.trim().replace(/[<>]/g,'').slice(0,24)}
function enter(kind){
  myName=name();
  if(!myName){$('entryError').textContent='Ismingizni kiriting.';return}
  if(kind==='create')socket.emit('room:create',{name:myName});
  else socket.emit('room:join',{roomId:$('roomInput').value.trim().toUpperCase(),name:myName});
}
$('createRoom').onclick=()=>enter('create');
$('joinRoom').onclick=()=>{
  if(!/^[A-Z0-9]{6}$/.test($('roomInput').value.trim().toUpperCase())){$('entryError').textContent='Xona kodi 6 ta harf yoki raqam bo‘lishi kerak.';return}
  enter('join');
};
$('roomInput').oninput=e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
socket.on('room:error',m=>{$('entryError').textContent=m;$('videoError').textContent=m});
socket.on('room:joined',d=>{
  roomId=d.roomId;isHost=d.isHost;
  $('entry').classList.add('hidden');$('how').classList.add('hidden');$('workspace').classList.remove('hidden');
  $('roomCode').textContent=roomId;$('role').textContent=isHost?'Xona egasi':'Ishtirokchi';
  $('loadVideo').disabled=!isHost;$('youtubeUrl').disabled=!isHost;$('chat').innerHTML='';
  history.replaceState({},'',location.pathname+'?room='+roomId);
  if(d.state&&(d.state.mediaType||d.state.videoId))loadMedia(normalizeState(d.state),d.state);
});
socket.on('room:role',d=>{
  isHost=d.isHost;$('role').textContent=isHost?'Xona egasi':'Ishtirokchi';
  $('loadVideo').disabled=!isHost;$('youtubeUrl').disabled=!isHost;
  ['playPause','back','forward'].forEach(id=>$(id).disabled=!isHost||!playerReady);
});
socket.on('room:people',list=>{
  $('peopleCount').textContent=list.length;$('people').replaceChildren();
  list.forEach(p=>{const el=document.createElement('span');el.className='person';el.textContent=p.name+(p.isHost?' ★':'');$('people').append(el)});
});
function system(t){const e=document.createElement('div');e.className='system';e.textContent=t;$('chat').append(e);scroll()}
function scroll(){$('chat').scrollTop=$('chat').scrollHeight}
socket.on('room:system',system);
socket.on('chat:message',m=>{
  const e=document.createElement('div');e.className='message';const b=document.createElement('b');b.textContent=m.name;
  const p=document.createElement('p');p.textContent=m.text;e.append(b,p);$('chat').append(e);scroll();
});
$('chatForm').onsubmit=e=>{e.preventDefault();const text=$('chatText').value.trim();if(text&&roomId){socket.emit('chat:send',{text});$('chatText').value=''}};
$('copyInvite').onclick=async()=>{
  const u=location.origin+location.pathname+'?room='+roomId;
  try{await navigator.clipboard.writeText(u);$('copyInvite').textContent='Nusxalandi ✓';setTimeout(()=>$('copyInvite').textContent='Havolani nusxalash',1500)}
  catch(e){prompt('Havolani nusxalang',u)}
};
$('leaveRoom').onclick=()=>{
  socket.emit('room:leave');destroyPlayer();roomId=null;history.replaceState({},'',location.pathname);
  $('workspace').classList.add('hidden');$('entry').classList.remove('hidden');$('how').classList.remove('hidden');
};
function parseMedia(raw){
  try{
    const u=new URL(raw);
    if(!['http:','https:'].includes(u.protocol))return null;
    const host=u.hostname.toLowerCase().replace(/^www\./,'');
    let id=null;
    if(host==='youtu.be')id=u.pathname.split('/').filter(Boolean)[0]||null;
    else if(host==='youtube.com'||host.endsWith('.youtube.com')){
      if(u.pathname==='/watch')id=u.searchParams.get('v');
      else if(u.pathname.startsWith('/embed/')||u.pathname.startsWith('/shorts/'))id=u.pathname.split('/')[2]||null;
    }
    if(id&&/^[A-Za-z0-9_-]{11}$/.test(id))return{mediaType:'youtube',mediaId:id,mediaUrl:'https://www.youtube.com/watch?v='+id,videoId:id};
    if(host==='vimeo.com'||host==='player.vimeo.com'){
      const parts=u.pathname.split('/').filter(Boolean);id=parts.find(x=>/^\d{1,15}$/.test(x))||null;
      if(id)return{mediaType:'vimeo',mediaId:id,mediaUrl:'https://player.vimeo.com/video/'+id,videoId:null};
    }
    if(/\.(mp4|webm)$/i.test(u.pathname))return{mediaType:'file',mediaId:u.href,mediaUrl:u.href,videoId:null};
    return null;
  }catch(e){return null}
}
function normalizeState(s){
  if(s.mediaType&&s.mediaId)return{mediaType:s.mediaType,mediaId:s.mediaId,mediaUrl:s.mediaUrl||s.mediaId,videoId:s.videoId||null};
  if(s.videoId)return{mediaType:'youtube',mediaId:s.videoId,mediaUrl:'https://www.youtube.com/watch?v='+s.videoId,videoId:s.videoId};
  return null;
}
function destroyPlayer(){
  if(player){
    try{if(media&&media.mediaType==='youtube'&&player.destroy)player.destroy();else if(media&&media.mediaType==='vimeo'&&player.destroy)player.destroy();else if(media&&media.mediaType==='file'){player.pause();player.removeAttribute('src');player.load()}}catch(e){}
  }
  $('player').replaceChildren();player=null;playerReady=false;media=null;
  $('placeholder').classList.remove('hidden');
  $('playPause').disabled=true;$('back').disabled=true;$('forward').disabled=true;
}
function markReady(state){
  playerReady=true;
  ['playPause','back','forward'].forEach(k=>$(k).disabled=!isHost);
  $('placeholder').classList.add('hidden');
  $('playState').textContent='Tayyor';
  if(state)applyState(state);
}
function loadMedia(next,state){
  if(!next)return;
  destroyPlayer();media=next;$('videoError').textContent='';$('placeholder').classList.add('hidden');
  $('playState').textContent='Video yuklanmoqda…';
  if(next.mediaType==='youtube'){
    if(!window.YT||!YT.Player){setTimeout(()=>loadMedia(next,state),200);return}
    const el=document.createElement('div');el.id='ytPlayer';$('player').append(el);
    player=new YT.Player('ytPlayer',{videoId:next.mediaId,playerVars:{playsinline:1,rel:0,controls:0,disablekb:1,origin:location.origin},events:{
      onReady:()=>markReady(state),
      onStateChange:e=>{if(remote||Date.now()<remoteUntil||!isHost)return;if(e.data===YT.PlayerState.PLAYING||e.data===YT.PlayerState.PAUSED)emitPlayback(e.data===YT.PlayerState.PLAYING,getTime())},
      onError:()=>{$('videoError').textContent='YouTube videosini ochib bo‘lmadi.'}
    }});
  }else if(next.mediaType==='vimeo'){
    const frame=document.createElement('iframe');frame.id='vimeoPlayer';frame.src=next.mediaUrl+'?controls=0&title=0&byline=0&portrait=0';frame.allow='autoplay; fullscreen; picture-in-picture';frame.allowFullscreen=true;frame.title='Vimeo video';$('player').append(frame);
    const init=()=>{if(!window.Vimeo||!window.Vimeo.Player){setTimeout(init,150);return}
      player=new Vimeo.Player(frame);
      player.ready().then(()=>markReady(state)).catch(()=>{$('videoError').textContent='Vimeo videosini ochib bo‘lmadi yoki video maxfiy.'});
      player.on('play',()=>{if(!remote&&Date.now()>=remoteUntil&&isHost)getTimeAsync().then(t=>emitPlayback(true,t))});
      player.on('pause',()=>{if(!remote&&Date.now()>=remoteUntil&&isHost)getTimeAsync().then(t=>emitPlayback(false,t))});
    };init();
  }else if(next.mediaType==='file'){
    const video=document.createElement('video');video.id='filePlayer';video.src=next.mediaUrl;video.playsInline=true;video.preload='auto';video.controls=false;video.style.width='100%';video.style.height='100%';video.style.position='absolute';video.style.inset='0';$('player').append(video);player=video;
    video.addEventListener('loadedmetadata',()=>markReady(state),{once:true});
    video.addEventListener('error',()=>{$('videoError').textContent='Videoni ochib bo‘lmadi. Havola ochiq va MP4/WebM formatida ekanini tekshiring.'});
    video.addEventListener('play',()=>{if(!remote&&Date.now()>=remoteUntil&&isHost)emitPlayback(true,video.currentTime)});
    video.addEventListener('pause',()=>{if(!remote&&Date.now()>=remoteUntil&&isHost&&!video.ended)emitPlayback(false,video.currentTime)});
    video.addEventListener('seeked',()=>{if(!remote&&Date.now()>=remoteUntil&&isHost)emitPlayback(!video.paused,video.currentTime)});
  }
}
function getTime(){
  if(!player||!playerReady)return 0;
  try{if(media.mediaType==='youtube')return player.getCurrentTime()||0;if(media.mediaType==='file')return player.currentTime||0}catch(e){}
  return 0;
}
async function getTimeAsync(){
  if(!player||!playerReady)return 0;
  try{if(media.mediaType==='vimeo')return await player.getCurrentTime();return getTime()}catch(e){return 0}
}
async function isPlaying(){
  if(!player||!playerReady)return false;
  try{if(media.mediaType==='youtube')return player.getPlayerState()===YT.PlayerState.PLAYING;if(media.mediaType==='file')return !player.paused;if(media.mediaType==='vimeo')return (await player.getPaused())===false}catch(e){}
  return false;
}
function emitPlayback(playing,time){
  if(!media||!roomId||!isHost)return;
  socket.emit('video:state',{mediaType:media.mediaType,mediaId:media.mediaId,mediaUrl:media.mediaUrl,videoId:media.videoId,isPlaying:!!playing,currentTime:Math.max(0,Number(time)||0)});
}
async function seekTo(t){
  if(!player||!playerReady)return;
  const v=Math.max(0,Number(t)||0);
  try{if(media.mediaType==='youtube')player.seekTo(v,true);else if(media.mediaType==='file')player.currentTime=v;else if(media.mediaType==='vimeo')await player.setCurrentTime(v)}catch(e){}
}
async function play(){if(!player||!playerReady)return;try{if(media.mediaType==='youtube')player.playVideo();else await player.play()}catch(e){$('videoError').textContent='Ijro etish uchun videoni sahifada ishga tushiring.'}}
async function pause(){if(!player||!playerReady)return;try{if(media.mediaType==='youtube')player.pauseVideo();else await player.pause()}catch(e){}}
async function applyState(s){
  if(!playerReady||!player||!s)return;
  const normalized=normalizeState(s);
  if(normalized&&(!media||normalized.mediaType!==media.mediaType||normalized.mediaId!==media.mediaId)){loadMedia(normalized,s);return}
  remote=true;remoteUntil=Date.now()+1200;
  const t=Math.max(0,Number(s.currentTime)||0)+(s.isPlaying?Math.max(0,Date.now()-(s.updatedAt||Date.now()))/1000:0);
  try{
    const current=await getTimeAsync();
    if(Math.abs(current-t)>2)await seekTo(t);
    if(s.isPlaying)await play();else await pause();
    $('playState').textContent=s.isPlaying?'▶ Ijro etilmoqda':'Ⅱ Pauza';
  }catch(e){}
  setTimeout(()=>{remote=false},1300);
}
$('loadVideo').onclick=()=>{
  const next=parseMedia($('youtubeUrl').value.trim());
  if(!next){$('videoError').textContent='YouTube, Vimeo yoki to‘g‘ridan-to‘g‘ri MP4/WebM havolasini kiriting.';return}
  socket.emit('video:load',next);
};
socket.on('video:loaded',s=>{const next=normalizeState(s);if(next)loadMedia(next,s)});
socket.on('video:state',s=>{const next=normalizeState(s);if(next&&(!media||next.mediaType!==media.mediaType||next.mediaId!==media.mediaId))loadMedia(next,s);else applyState(s)});
$('playPause').onclick=async()=>{
  if(!playerReady||!isHost)return;
  const playing=await isPlaying(),t=await getTimeAsync();
  if(playing)await pause();else await play();
  emitPlayback(!playing,t);
};
async function seek(d){
  if(!playerReady||!isHost)return;
  const t=Math.max(0,(await getTimeAsync())+d);
  await seekTo(t);emitPlayback(await isPlaying(),t);
}
$('back').onclick=()=>seek(-10);$('forward').onclick=()=>seek(10);
setInterval(async()=>{
  if(isHost&&roomId&&playerReady&&media&&await isPlaying())emitPlayback(true,await getTimeAsync());
},2500);
socket.on('room:state',s=>{const next=s&&normalizeState(s);if(next){$('youtubeUrl').value=next.mediaUrl;loadMedia(next,s)}});
const r=new URLSearchParams(location.search).get('room');if(r)$('roomInput').value=r.toUpperCase();
$('year').textContent=new Date().getFullYear();
})();