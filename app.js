/* 메트로놈 — Web Audio 정밀 스케줄러 기반
 * 핵심: setInterval 은 수십 ms 씩 흔들리므로 박자 결정에 쓰지 않는다.
 *       25ms 마다 깨어나 "앞으로 100ms 안에 울릴 소리"를 오디오 클럭 시각에 미리 예약한다.
 *       실제 발음 오차는 1ms 이하이며, UI 가 버벅여도 소리는 밀리지 않는다.
 */
(() => {
'use strict';

// ── 설정값 ────────────────────────────────────────────────
const LOOKAHEAD_MS = 25;      // 스케줄러가 깨어나는 주기
const SCHEDULE_AHEAD = 0.12;  // 미리 예약해 둘 구간(초)
const BPM_MIN = 30, BPM_MAX = 300;

const METERS = [
  { label: '1/4',  beats: 1,  denom: 4, accents: [2] },
  { label: '2/4',  beats: 2,  denom: 4, accents: [2,0] },
  { label: '3/4',  beats: 3,  denom: 4, accents: [2,0,0] },
  { label: '4/4',  beats: 4,  denom: 4, accents: [2,0,1,0] },
  { label: '5/4',  beats: 5,  denom: 4, accents: [2,0,0,1,0] },
  { label: '6/8',  beats: 6,  denom: 8, accents: [2,0,0,1,0,0] },
  { label: '9/8',  beats: 9,  denom: 8, accents: [2,0,0,1,0,0,1,0,0] },
  { label: '12/8', beats: 12, denom: 8, accents: [2,0,0,1,0,0,1,0,0,1,0,0] },
];

const SUBDIVS = [
  { label: '기본',  n: 1 },
  { label: '8분',   n: 2 },
  { label: '3연음', n: 3 },
  { label: '16분',  n: 4 },
];

// 이탈리아어 빠르기말 (하한 BPM 기준)
const TEMPO_NAMES = [
  [40,'Grave'],[46,'Largo'],[52,'Lento'],[56,'Adagio'],[66,'Adagietto'],
  [76,'Andante'],[92,'Andante moderato'],[108,'Moderato'],[120,'Allegro moderato'],
  [140,'Allegro'],[168,'Vivace'],[178,'Presto'],[200,'Prestissimo'],
];

// ── 상태 ──────────────────────────────────────────────────
const state = {
  bpm: 120,
  meter: 3,      // 4/4
  subdiv: 0,     // 기본
  volume: 0.8,
  vibrate: false,
  wakeOn: true,
  accentOn: true,
};

let audioCtx = null, masterGain = null;
let playing = false;
let noteIndex = 0;        // 마디 내 위치 (0 ~ beats*subdiv-1)
let nextNoteTime = 0;     // 다음 소리의 오디오 클럭 시각(초)
let timerId = null;
let drawQueue = [];       // {beat, time, strength} — 화면 표시용
let lastDrawnBeat = -1;
let wakeLock = null;

// ── DOM ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  beats: $('beats'), bpmNum: $('bpmNum'), tempoName: $('tempoName'),
  slider: $('bpmSlider'), minus: $('btnMinus'), plus: $('btnPlus'),
  meterChips: $('meterChips'), subChips: $('subChips'),
  play: $('btnPlay'), tap: $('btnTap'), reset: $('btnReset'),
  settings: $('btnSettings'), lock: $('btnLock'),
  sheet: $('sheet'), closeSheet: $('btnCloseSheet'),
  vol: $('volSlider'), tglVibe: $('tglVibe'), tglWake: $('tglWake'), tglAccent: $('tglAccent'),
};

// ── 저장/복원 ─────────────────────────────────────────────
const STORE_KEY = 'metronome.v1';
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* 사생활 보호 모드 등 */ }
}
function load() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return;
    Object.assign(state, JSON.parse(raw));
    state.bpm = clampBpm(state.bpm);
    if (!METERS[state.meter]) state.meter = 3;
    if (!SUBDIVS[state.subdiv]) state.subdiv = 0;
  } catch (e) { /* 손상된 값이면 기본값 사용 */ }
}

// ── 오디오 ────────────────────────────────────────────────
function ensureAudio() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtx = new Ctx();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = state.volume;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
}

// strength: 2=강박, 1=중강박, 0=약박, -1=분할음
function click(time, strength) {
  const spec = strength === 2 ? { f: 1760, g: 1.00, d: 0.055 }
             : strength === 1 ? { f: 1320, g: 0.70, d: 0.045 }
             : strength === 0 ? { f: 990,  g: 0.62, d: 0.045 }
             :                  { f: 760,  g: 0.26, d: 0.030 };

  const osc = audioCtx.createOscillator();
  const env = audioCtx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(spec.f, time);
  env.gain.setValueAtTime(0.0001, time);
  env.gain.exponentialRampToValueAtTime(spec.g, time + 0.002);
  env.gain.exponentialRampToValueAtTime(0.0001, time + spec.d);
  osc.connect(env); env.connect(masterGain);
  osc.start(time);
  osc.stop(time + spec.d + 0.02);
}

// ── 스케줄러 ──────────────────────────────────────────────
function beatDuration() {
  // BPM 은 4분음표 기준(♩=). 분모가 8이면 한 박은 그 절반 길이.
  return (60 / state.bpm) * (4 / METERS[state.meter].denom);
}

function strengthOf(beat) {
  const m = METERS[state.meter];
  const a = m.accents[beat] ?? 0;
  if (!state.accentOn) return 0;
  return a;
}

function scheduleNext() {
  const m = METERS[state.meter];
  const sub = SUBDIVS[state.subdiv].n;
  const beat = Math.floor(noteIndex / sub);
  const isBeat = noteIndex % sub === 0;
  const strength = isBeat ? strengthOf(beat) : -1;

  click(nextNoteTime, strength);
  if (isBeat) drawQueue.push({ beat, time: nextNoteTime, strength });

  nextNoteTime += beatDuration() / sub;
  noteIndex = (noteIndex + 1) % (m.beats * sub);
}

function scheduler() {
  const now = audioCtx.currentTime;
  // 다른 앱을 보다 돌아오면 브라우저가 타이머를 묶어두어 예약이 밀린다.
  // 이때 밀린 박자를 몰아서 내보내면 "다다다닥" 하고 터지므로, 따라잡지 않고 현재 시각에 다시 맞춘다.
  if (nextNoteTime < now - 0.05) {
    nextNoteTime = now + 0.03;
    noteIndex = 0;
    drawQueue = [];
    lastDrawnBeat = -1;
  }
  while (nextNoteTime < audioCtx.currentTime + SCHEDULE_AHEAD) scheduleNext();
}

function start() {
  ensureAudio();
  playing = true;
  noteIndex = 0;
  drawQueue = [];
  lastDrawnBeat = -1;
  nextNoteTime = audioCtx.currentTime + 0.06; // 첫 소리 여유
  timerId = setInterval(scheduler, LOOKAHEAD_MS);
  requestAnimationFrame(draw);
  el.play.textContent = '■';
  el.play.classList.add('playing');
  el.play.setAttribute('aria-label', '정지');
  requestWakeLock();
}

function stop() {
  playing = false;
  clearInterval(timerId);
  timerId = null;
  drawQueue = [];
  el.play.textContent = '▶';
  el.play.classList.remove('playing');
  el.play.setAttribute('aria-label', '재생');
  clearDots();
  releaseWakeLock();
}

function toggle() { playing ? stop() : start(); }

// 재생 중 박자/분할음이 바뀌면 마디 처음부터 다시 세도록 맞춘다.
function resyncMeasure() {
  if (!playing) return;
  noteIndex = 0;
  drawQueue = [];
  lastDrawnBeat = -1;
  nextNoteTime = Math.max(nextNoteTime, audioCtx.currentTime + 0.03);
}

// ── 화면 표시 ─────────────────────────────────────────────
function buildDots() {
  const m = METERS[state.meter];
  el.beats.innerHTML = '';
  for (let i = 0; i < m.beats; i++) {
    const d = document.createElement('div');
    d.className = 'dot' + (m.accents[i] === 2 ? ' strong' : '');
    el.beats.appendChild(d);
  }
}
function clearDots() {
  el.beats.querySelectorAll('.dot').forEach(d => d.classList.remove('on'));
}

function draw() {
  if (!playing) return;
  const now = audioCtx.currentTime;
  let current = lastDrawnBeat;
  while (drawQueue.length && drawQueue[0].time <= now) {
    current = drawQueue[0].beat;
    drawQueue.shift();
  }
  if (current !== lastDrawnBeat) {
    lastDrawnBeat = current;
    const dots = el.beats.querySelectorAll('.dot');
    dots.forEach((d, i) => d.classList.toggle('on', i === current));
    if (state.vibrate && navigator.vibrate) {
      const m = METERS[state.meter];
      navigator.vibrate(m.accents[current] === 2 ? 32 : 14);
    }
  }
  requestAnimationFrame(draw);
}

// ── 화면 켜짐 유지 ────────────────────────────────────────
async function requestWakeLock() {
  if (!state.wakeOn || !('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch (e) { /* 배터리 절약 모드 등에서 거부될 수 있음 */ }
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !playing) return;
  ensureAudio();                 // 전화 수신 등으로 중단된 오디오 복구 (특히 아이폰)
  if (!wakeLock) requestWakeLock();
});

// ── UI 갱신 ───────────────────────────────────────────────
function clampBpm(v) { return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(v))); }

function tempoNameOf(bpm) {
  let name = TEMPO_NAMES[0][1];
  for (const [limit, n] of TEMPO_NAMES) { if (bpm >= limit) name = n; }
  if (bpm < TEMPO_NAMES[0][0]) name = 'Larghissimo';
  return name;
}

function setBpm(v, fromSlider) {
  state.bpm = clampBpm(v);
  el.bpmNum.textContent = state.bpm;
  el.tempoName.textContent = tempoNameOf(state.bpm);
  if (!fromSlider) el.slider.value = state.bpm;
  save();
}

function renderChips() {
  el.meterChips.innerHTML = '';
  METERS.forEach((m, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (i === state.meter ? ' sel' : '');
    b.textContent = m.label;
    b.addEventListener('click', () => {
      state.meter = i; save();
      renderChips(); buildDots(); resyncMeasure();
    });
    el.meterChips.appendChild(b);
  });

  el.subChips.innerHTML = '';
  SUBDIVS.forEach((s, i) => {
    const b = document.createElement('button');
    b.className = 'chip' + (i === state.subdiv ? ' sel' : '');
    b.textContent = s.label;
    b.addEventListener('click', () => {
      state.subdiv = i; save();
      renderChips(); resyncMeasure();
    });
    el.subChips.appendChild(b);
  });
}

function renderToggles() {
  el.tglVibe.classList.toggle('on', state.vibrate);
  el.tglWake.classList.toggle('on', state.wakeOn);
  el.tglAccent.classList.toggle('on', state.accentOn);
  el.lock.classList.toggle('on', state.wakeOn);
  el.vol.value = Math.round(state.volume * 100);
}

// ── 버튼 동작 ─────────────────────────────────────────────
// 길게 누르면 연속 증감 (누를수록 빨라짐)
function holdRepeat(button, step) {
  let t1 = null, t2 = null, speed = 130;
  const fire = () => setBpm(state.bpm + step);
  const begin = e => {
    e.preventDefault();
    ensureAudio();
    fire();
    speed = 130;
    t1 = setTimeout(() => {
      t2 = setInterval(() => {
        fire();
        if (speed > 45) { speed -= 8; clearInterval(t2); t2 = setInterval(fire, speed); }
      }, speed);
    }, 420);
  };
  const end = () => { clearTimeout(t1); clearInterval(t2); t1 = t2 = null; };
  button.addEventListener('pointerdown', begin);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => button.addEventListener(ev, end));
}
holdRepeat(el.minus, -1);
holdRepeat(el.plus, +1);

el.slider.addEventListener('input', () => setBpm(+el.slider.value, true));
el.play.addEventListener('click', toggle);

// TAP — 최근 두드림 간격의 평균으로 BPM 산출
let taps = [];
el.tap.addEventListener('click', () => {
  ensureAudio();
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2200) taps = []; // 오래 쉬면 새로 시작
  taps.push(now);
  if (taps.length > 6) taps.shift();
  if (taps.length >= 2) {
    let sum = 0;
    for (let i = 1; i < taps.length; i++) sum += taps[i] - taps[i - 1];
    setBpm(60000 / (sum / (taps.length - 1)));
  }
});

el.reset.addEventListener('click', () => {
  setBpm(120);
  state.meter = 3; state.subdiv = 0;
  save(); renderChips(); buildDots(); resyncMeasure();
});

el.settings.addEventListener('click', () => el.sheet.classList.add('open'));
el.closeSheet.addEventListener('click', () => el.sheet.classList.remove('open'));
el.sheet.addEventListener('click', e => { if (e.target === el.sheet) el.sheet.classList.remove('open'); });

el.vol.addEventListener('input', () => {
  state.volume = +el.vol.value / 100;
  if (masterGain) masterGain.gain.value = state.volume;
  save();
});
el.tglVibe.addEventListener('click', () => {
  state.vibrate = !state.vibrate;
  if (state.vibrate && navigator.vibrate) navigator.vibrate(20);
  save(); renderToggles();
});
el.tglWake.addEventListener('click', () => {
  state.wakeOn = !state.wakeOn;
  state.wakeOn ? (playing && requestWakeLock()) : releaseWakeLock();
  save(); renderToggles();
});
el.lock.addEventListener('click', () => el.tglWake.click());
el.tglAccent.addEventListener('click', () => {
  state.accentOn = !state.accentOn;
  save(); renderToggles();
});

// 스페이스바로 재생/정지 (PC 확인용)
document.addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); toggle(); }
  else if (e.code === 'ArrowUp')   { e.preventDefault(); setBpm(state.bpm + 1); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); setBpm(state.bpm - 1); }
});

// 확대 방지 (iOS 더블탭)
document.addEventListener('dblclick', e => e.preventDefault(), { passive: false });

// ── 화면 높이 보정 ────────────────────────────────────────
// 모바일 브라우저의 100vh 는 주소창 높이를 빼지 않아 아래쪽 버튼이 화면 밖으로 밀린다.
// 실제로 보이는 높이를 직접 재서 --appH 로 넘긴다.
function setAppHeight() {
  const h = window.innerHeight || document.documentElement.clientHeight;
  if (h) document.documentElement.style.setProperty('--appH', h + 'px');
}
setAppHeight();
window.addEventListener('resize', setAppHeight);
window.addEventListener('orientationchange', () => setTimeout(setAppHeight, 200));
if (window.visualViewport) window.visualViewport.addEventListener('resize', setAppHeight);

// ── 시작 ──────────────────────────────────────────────────
load();
setBpm(state.bpm);
renderChips();
buildDots();
renderToggles();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
})();
