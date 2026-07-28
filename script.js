/* ============================================================
   선크림 재도포 알림 앱 - script.js
   모든 계산은 규칙 기반(Rule-based)이며 AI를 사용하지 않는다.
   ============================================================ */

/* ------------------------------------------------------------
   1. 설정값 (CONFIG)
   유지보수를 쉽게 하기 위해 모든 상수를 한 곳에 모아둔다.
   공식/민감도 조정이 필요하면 이 객체 값만 수정하면 된다.
------------------------------------------------------------ */
const CONFIG = {
  // 보호율 누적 감소 계산용 상수 (1분당 감소량)
  BASE_LOSS_PER_MINUTE: 0.3,         // 기본 시간당 감소율
  UV_LOSS_PER_MINUTE_PER_UV: 0.05,   // UV 지수 1당 추가 감소율(분당)
  ACTIVITY_MULTIPLIER: 2.0,          // 활동량 점수 1당 배수 증가량 (예: 땀을 흘리면 선크림이 최대 4배 빨리 씻겨나감)

  // 갱신 주기
  UI_UPDATE_INTERVAL_MS: 1000,             // UI 갱신 주기 (1초)
  UV_REFRESH_INTERVAL_MS: 10 * 60 * 1000,  // UV API 재조회 주기 (10분)
  LOCATION_REFRESH_INTERVAL_MS: 5 * 60 * 1000, // 위치 재조회 주기 (5분)

  // 센서 관련 설정
  SENSOR_WINDOW_MS: 5000,   // 센서 데이터 평균에 사용할 시간창(5초) - 노이즈 제거
  ACCEL_WEIGHT: 0.15,       // 가속도 변동폭 가중치 (기기별 보정 필요)
  GYRO_WEIGHT: 0.02,        // 자이로 회전속도 가중치 (기기별 보정 필요)
  MAX_ACTIVITY_SCORE: 1.5,  // 활동량 점수 최대값 (격렬한 운동)

  // 알림 임계값 (요구사항: 70 이상 초록 / 30~70 노랑 / 30 이하 빨강)
  NOTIFY_THRESHOLD: 30,
  WARN_THRESHOLD: 70,

  UV_FALLBACK: 5,
  STORAGE_KEY_APPLIED_AT: 'sunscreen_applied_at',
  STORAGE_KEY_ACCUMULATED_LOSS: 'sunscreen_accumulated_loss',
  STORAGE_KEY_LAST_UPDATE: 'sunscreen_last_update',
};

/* ------------------------------------------------------------
   2. 전역 상태
------------------------------------------------------------ */
const state = {
  appliedAt: null,
  currentUV: null,
  currentLocation: null,
  activityScore: 0,
  protection: 100,
  accumulatedLoss: 0,
  lastUpdateTime: null,
  notified: false,
  sensorsAttached: false,
};

let accelBuffer = []; // { t, value } 가속도 크기 버퍼
let gyroBuffer = [];  // { t, value } 회전속도 크기 버퍼

/* ------------------------------------------------------------
   3. DOM 캐싱
------------------------------------------------------------ */
const dom = {
  overlay: document.getElementById('permissionOverlay'),
  startBtn: document.getElementById('startBtn'),
  permissionError: document.getElementById('permissionError'),

  uvValue: document.getElementById('uvValue'),
  locationValue: document.getElementById('locationValue'),
  timeValue: document.getElementById('timeValue'),

  gaugeProgress: document.getElementById('gaugeProgress'),
  protectionValue: document.getElementById('protectionValue'),
  statusText: document.getElementById('statusText'),

  elapsedValue: document.getElementById('elapsedValue'),
  activityValue: document.getElementById('activityValue'),
  uvInfoValue: document.getElementById('uvInfoValue'),
  protectionInfoValue: document.getElementById('protectionInfoValue'),

  warningBanner: document.getElementById('warningBanner'),

  applyBtn: document.getElementById('applyBtn'),
  lastAppliedText: document.getElementById('lastAppliedText'),
};

const GAUGE_RADIUS = 85;
const GAUGE_CIRCUMFERENCE = 2 * Math.PI * GAUGE_RADIUS;
dom.gaugeProgress.style.strokeDasharray = `${GAUGE_CIRCUMFERENCE}`;
dom.gaugeProgress.style.strokeDashoffset = `0`;

/* ------------------------------------------------------------
   4. 유틸 함수
------------------------------------------------------------ */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function average(arr) {
  if (!arr.length) return 0;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
}

// SENSOR_WINDOW_MS 이전의 오래된 데이터를 버퍼에서 제거
function trimBuffer(buffer, now = Date.now()) {
  while (buffer.length && now - buffer[0].t > CONFIG.SENSOR_WINDOW_MS) {
    buffer.shift();
  }
}

function formatElapsed(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}시간 ${minutes}분`;
  return `${minutes}분`;
}

/* ------------------------------------------------------------
   5. 위치(GPS) 함수
------------------------------------------------------------ */

/** 현재 위치를 1회 조회한다 (Geolocation API) */
function getLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('이 브라우저는 Geolocation을 지원하지 않습니다.'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lon: pos.coords.longitude }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    );
  });
}

/** 위치 정보를 갱신하고 화면에 표시한다 */
async function refreshLocation() {
  try {
    const loc = await getLocation();
    state.currentLocation = loc;
    dom.locationValue.textContent = `${loc.lat.toFixed(3)}, ${loc.lon.toFixed(3)}`;
  } catch (err) {
    console.error('위치 조회 실패:', err);
    dom.locationValue.textContent = '위치 조회 실패';
  }
}

/* ------------------------------------------------------------
   6. UV Index 함수
------------------------------------------------------------ */

/**
 * UV Index를 조회한다.
 * 실제 서비스에서는 OpenUV / OpenWeatherMap 등의 API를 호출한다.
 * API 키가 없는 개발 환경을 고려해 현재는 mock 데이터를 반환한다.
 */
async function getUV(lat, lon) {
  try {
    // Open-Meteo의 무료 API를 사용하여 현재 위치의 실시간 UV 지수를 가져옵니다. (API 키 불필요)
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=uv_index`
    );
    if (!response.ok) throw new Error('UV API 응답 오류');
    const data = await response.json();
    return data.current.uv_index;
  } catch (err) {
    console.error('UV 조회 실패, 가상 데이터로 대체:', err);
    return generateMockUV();
  }
}

/** 시간대에 따라 그럴듯한 UV 목업 데이터 생성 (정오 근처 최고치) */
function generateMockUV() {
  const hour = new Date().getHours() + new Date().getMinutes() / 60;
  const base = Math.max(0, 10 - Math.abs(hour - 13) * 1.3);
  const noise = (Math.random() - 0.5) * 0.6;
  return Math.round((base + noise) * 10) / 10;
}

/** UV 정보를 갱신하고 화면에 표시한다 */
async function refreshUV() {
  if (!state.currentLocation) return;
  try {
    const uv = await getUV(state.currentLocation.lat, state.currentLocation.lon);
    state.currentUV = uv;
    dom.uvValue.textContent = uv.toFixed(1);
    dom.uvInfoValue.textContent = uv.toFixed(1);
  } catch (err) {
    console.error('UV 갱신 실패:', err);
  }
}

/* ------------------------------------------------------------
   7. 센서(가속도/자이로) 함수
------------------------------------------------------------ */

/** DeviceMotion 이벤트: 가속도 크기 + 회전속도(자이로) 기록 */
function handleMotion(event) {
  const now = Date.now();

  const acc = event.accelerationIncludingGravity || event.acceleration;
  if (acc && acc.x !== null) {
    const magnitude = Math.sqrt(
      (acc.x || 0) ** 2 + (acc.y || 0) ** 2 + (acc.z || 0) ** 2
    );
    accelBuffer.push({ t: now, value: magnitude });
  }

  const rot = event.rotationRate;
  if (rot && rot.alpha !== null) {
    const gyroMagnitude = Math.sqrt(
      (rot.alpha || 0) ** 2 + (rot.beta || 0) ** 2 + (rot.gamma || 0) ** 2
    );
    gyroBuffer.push({ t: now, value: gyroMagnitude });
  }

  trimBuffer(accelBuffer, now);
  trimBuffer(gyroBuffer, now);
}

/**
 * DeviceOrientation 이벤트: rotationRate를 지원하지 않는 기기를 위한
 * 보조 데이터로, 방향각 변화량을 자이로 지표에 함께 반영한다.
 */
let lastOrientation = null;
function handleOrientation(event) {
  const now = Date.now();
  const current = { alpha: event.alpha, beta: event.beta, gamma: event.gamma };

  if (lastOrientation) {
    const delta =
      Math.abs((current.alpha ?? 0) - (lastOrientation.alpha ?? 0)) +
      Math.abs((current.beta ?? 0) - (lastOrientation.beta ?? 0)) +
      Math.abs((current.gamma ?? 0) - (lastOrientation.gamma ?? 0));

    gyroBuffer.push({ t: now, value: delta * 0.5 });
    trimBuffer(gyroBuffer, now);
  }
  lastOrientation = current;
}

/**
 * 최근 SENSOR_WINDOW_MS 동안의 센서 데이터를 평균 내어
 * 활동량(Activity Score)을 계산한다.
 * 기준(예시): 정지=0, 걷기=0.3, 빠르게걷기=0.6, 달리기=1.0, 격렬한운동=1.5
 */
function calculateActivity() {
  const now = Date.now();
  trimBuffer(accelBuffer, now);
  trimBuffer(gyroBuffer, now);

  if (accelBuffer.length < 2) return 0; // 데이터 부족 = 정지 상태로 간주

  const accelValues = accelBuffer.map((b) => b.value);
  const accelAvg = average(accelValues);
  // 평균 대비 변동폭 (정지 시 중력값만 감지되어 변동폭이 0에 가까움)
  const accelDeviation = average(accelValues.map((v) => Math.abs(v - accelAvg)));

  const gyroValues = gyroBuffer.map((b) => b.value);
  const gyroAvg = gyroValues.length ? average(gyroValues) : 0;

  const rawScore = accelDeviation * CONFIG.ACCEL_WEIGHT + gyroAvg * CONFIG.GYRO_WEIGHT;

  // 센서 노이즈 필터: 미세한 잔류값(데스크톱 등)은 0으로 처리
  if (rawScore < 0.02) return 0;

  const score = clamp(rawScore, 0, CONFIG.MAX_ACTIVITY_SCORE);
  return Math.round(score * 100) / 100;
}

/** 센서 리스너 등록 (권한 허용 후 호출) */
function attachSensorListeners() {
  if (state.sensorsAttached) return;
  window.addEventListener('devicemotion', handleMotion);
  window.addEventListener('deviceorientation', handleOrientation);
  state.sensorsAttached = true;
}

/* ------------------------------------------------------------
   8. 보호율 계산 함수 (누적 방식)
------------------------------------------------------------ */

/**
 * 시간, UV, 활동량을 바탕으로 매초(또는 경과 시간만큼) 보호율 감소량을 누적한다.
 * 땀을 흘리면 선크림이 씻겨나가 유지 시간이 절반 이상 줄어드는 과학적 원리를 반영하여,
 * 활동량에 비례하는 배수(Multiplier)를 감소량에 곱한다.
 */
function updateProtection(now) {
  if (!state.appliedAt) {
    state.protection = 100;
    return;
  }

  if (!state.lastUpdateTime) {
    state.lastUpdateTime = now;
  }

  const dtMs = now - state.lastUpdateTime;
  if (dtMs <= 0) return;

  const dtMinutes = dtMs / 60000;
  const uv = state.currentUV ?? CONFIG.UV_FALLBACK;
  
  // 기본 감소량 + UV에 의한 감소량
  const baseLoss = (CONFIG.BASE_LOSS_PER_MINUTE + uv * CONFIG.UV_LOSS_PER_MINUTE_PER_UV) * dtMinutes;
  
  // 활동량에 따른 배수 (활동량 0일때 1배, 격렬한 운동시 최대 4배)
  const activityMultiplier = 1 + (state.activityScore * CONFIG.ACTIVITY_MULTIPLIER);
  
  const tickLoss = baseLoss * activityMultiplier;
  
  state.accumulatedLoss += tickLoss;
  state.lastUpdateTime = now;
  
  localStorage.setItem(CONFIG.STORAGE_KEY_ACCUMULATED_LOSS, String(state.accumulatedLoss));
  localStorage.setItem(CONFIG.STORAGE_KEY_LAST_UPDATE, String(state.lastUpdateTime));

  state.protection = Math.round(clamp(100 - state.accumulatedLoss, 0, 100));
}

/* ------------------------------------------------------------
   9. 알림 함수
------------------------------------------------------------ */

/** 재도포 권장 알림 표시. 권한 없으면 화면 내 배너로 대체 */
function showNotification(title, body) {
  dom.warningBanner.classList.remove('hidden'); // 화면 내 배너는 항상 표시

  if (!('Notification' in window)) {
    console.warn('이 브라우저는 Notification API를 지원하지 않습니다.');
    return;
  }

  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: 'icon-192.png' });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') {
        new Notification(title, { body, icon: 'icon-192.png' });
      }
    });
  }
}

/* ------------------------------------------------------------
   10. UI 갱신 함수
------------------------------------------------------------ */
function updateUI() {
  const now = new Date();
  dom.timeValue.textContent = now.toLocaleTimeString('ko-KR', { hour12: false });

  const elapsedMs = state.appliedAt ? now.getTime() - state.appliedAt : 0;
  const elapsedMinutes = elapsedMs / 60000;
  dom.elapsedValue.textContent = formatElapsed(elapsedMs);

  state.activityScore = calculateActivity();
  dom.activityValue.textContent = state.activityScore.toFixed(2);

  updateProtection(now.getTime());

  dom.protectionValue.textContent = `${state.protection}%`;
  dom.protectionInfoValue.textContent = `${state.protection}%`;

  const offset = GAUGE_CIRCUMFERENCE * (1 - state.protection / 100);
  dom.gaugeProgress.style.strokeDashoffset = `${offset}`;

  // 색상/상태 텍스트: 70↑ 초록, 30~70 노랑, 30↓ 빨강
  let color, statusText;
  if (state.protection >= CONFIG.WARN_THRESHOLD) {
    color = 'var(--color-green)';
    statusText = '안전';
  } else if (state.protection > CONFIG.NOTIFY_THRESHOLD) {
    color = 'var(--color-yellow)';
    statusText = '주의';
  } else {
    color = 'var(--color-red)';
    statusText = '위험';
  }
  dom.gaugeProgress.style.stroke = color;
  dom.statusText.textContent = statusText;
  dom.statusText.style.color = color;

  // 재도포 알림 체크 (중복 알림 방지)
  if (state.appliedAt && state.protection <= CONFIG.NOTIFY_THRESHOLD) {
    if (!state.notified) {
      showNotification(
        '🧴 재도포 시간이에요!',
        '선크림 보호 효과가 낮아졌습니다. 지금 재도포해주세요.'
      );
      state.notified = true;
    }
  } else {
    dom.warningBanner.classList.add('hidden');
    state.notified = false;
  }
}

/* ------------------------------------------------------------
   11. 선크림 바름 처리
------------------------------------------------------------ */
function applySunscreen() {
  state.appliedAt = Date.now();
  state.accumulatedLoss = 0;
  state.lastUpdateTime = state.appliedAt;
  state.notified = false;
  
  localStorage.setItem(CONFIG.STORAGE_KEY_APPLIED_AT, String(state.appliedAt));
  localStorage.setItem(CONFIG.STORAGE_KEY_ACCUMULATED_LOSS, String(state.accumulatedLoss));
  localStorage.setItem(CONFIG.STORAGE_KEY_LAST_UPDATE, String(state.lastUpdateTime));
  
  dom.warningBanner.classList.add('hidden');
  updateLastAppliedText();
  updateUI();
}

function updateLastAppliedText() {
  if (!state.appliedAt) {
    dom.lastAppliedText.textContent = '아직 기록이 없습니다';
    return;
  }
  const timeStr = new Date(state.appliedAt).toLocaleTimeString('ko-KR', { hour12: false });
  dom.lastAppliedText.textContent = `마지막 도포: ${timeStr}`;
}

/* ------------------------------------------------------------
   12. 추적 시작 (메인 루프)
------------------------------------------------------------ */
async function startTracking() {
  // 위치를 먼저 확보한 뒤 UV를 조회해야 UV API에 좌표를 전달할 수 있다
  await refreshLocation();
  await refreshUV();

  setInterval(updateUI, CONFIG.UI_UPDATE_INTERVAL_MS);
  setInterval(refreshUV, CONFIG.UV_REFRESH_INTERVAL_MS);
  setInterval(refreshLocation, CONFIG.LOCATION_REFRESH_INTERVAL_MS);

  updateUI();
}

/* ------------------------------------------------------------
   13. 권한 요청 처리
------------------------------------------------------------ */

/** 위치/센서/알림 권한을 순서대로 요청 (iOS는 사용자 클릭 안에서 호출 필요) */
async function requestAllPermissions() {
  dom.permissionError.textContent = '';

  try {
    await getLocation();
  } catch (err) {
    console.warn('위치 권한 거부/실패:', err);
    dom.permissionError.textContent = '위치 권한이 거부되었습니다. 일부 기능이 제한됩니다.';
  }

  try {
    if (
      typeof DeviceMotionEvent !== 'undefined' &&
      typeof DeviceMotionEvent.requestPermission === 'function'
    ) {
      const motionPerm = await DeviceMotionEvent.requestPermission();
      const orientPerm =
        typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function'
          ? await DeviceOrientationEvent.requestPermission()
          : 'granted';

      if (motionPerm === 'granted' && orientPerm === 'granted') {
        attachSensorListeners();
      } else {
        dom.permissionError.textContent = '센서 권한이 거부되어 활동량 측정이 제한됩니다.';
      }
    } else {
      attachSensorListeners(); // Android 등은 별도 요청 불필요
    }
  } catch (err) {
    console.warn('센서 권한 요청 실패:', err);
    dom.permissionError.textContent = '센서 권한 요청 중 오류가 발생했습니다.';
  }

  try {
    if ('Notification' in window && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  } catch (err) {
    console.warn('알림 권한 요청 실패:', err);
  }

  dom.overlay.classList.add('hidden');
  startTracking();
}

/* ------------------------------------------------------------
   14. 초기화
------------------------------------------------------------ */
function init() {
  const saved = localStorage.getItem(CONFIG.STORAGE_KEY_APPLIED_AT);
  if (saved) {
    state.appliedAt = Number(saved);
    state.accumulatedLoss = Number(localStorage.getItem(CONFIG.STORAGE_KEY_ACCUMULATED_LOSS) || 0);
    state.lastUpdateTime = Number(localStorage.getItem(CONFIG.STORAGE_KEY_LAST_UPDATE) || state.appliedAt);
    
    // 앱이 종료되어 있던 시간 동안의 감소량 보정 (활동량은 기본 1배로 가정)
    const now = Date.now();
    if (state.lastUpdateTime < now) {
      const dtMinutes = (now - state.lastUpdateTime) / 60000;
      const baseLoss = (CONFIG.BASE_LOSS_PER_MINUTE + CONFIG.UV_FALLBACK * CONFIG.UV_LOSS_PER_MINUTE_PER_UV) * dtMinutes;
      state.accumulatedLoss += baseLoss;
      state.lastUpdateTime = now;
    }
    
    updateLastAppliedText();
  }

  dom.startBtn.addEventListener('click', requestAllPermissions);
  dom.applyBtn.addEventListener('click', applySunscreen);

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker
        .register('service-worker.js')
        .catch((err) => console.error('서비스워커 등록 실패:', err));
    });
  }
}

document.addEventListener('DOMContentLoaded', init);