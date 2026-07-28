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
  // 보호율 감소 공식 가중치
  // loss = elapsedMinutes * TIME_FACTOR + UV * UV_FACTOR + activityScore * ACTIVITY_FACTOR
  TIME_FACTOR: 0.2,      // 경과 시간(분) 1당 감소율
  UV_FACTOR: 0.8,        // UV 지수 1당 감소율
  ACTIVITY_FACTOR: 15,   // 활동량 점수 1당 감소율

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
    // ---------------------------------------------------------
    // [실제 API 연동 예시] 주석 해제 후 API 키 입력하면 사용 가능
    //
    // const API_KEY = 'YOUR_OPENUV_API_KEY';
    // const response = await fetch(
    //   `https://api.openuv.io/api/v1/uv?lat=${lat}&lng=${lon}`,
    //   { headers: { 'x-access-token': API_KEY } }
    // );
    // if (!response.ok) throw new Error('UV API 응답 오류');
    // const data = await response.json();
    // return data.result.uv;
    // ---------------------------------------------------------

    return generateMockUV();
  } catch (err) {
    console.error('UV 조회 실패:', err);
    return CONFIG.UV_FALLBACK;
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
   8. 보호율 계산 함수
------------------------------------------------------------ */

/**
 * loss = elapsedMinutes * TIME_FACTOR + UV * UV_FACTOR + activityScore * ACTIVITY_FACTOR
 * protection = clamp(100 - loss, 0, 100)
 */
function calculateProtection(elapsedMinutes, uv, activityScore) {
  const loss =
    elapsedMinutes * CONFIG.TIME_FACTOR +
    uv * CONFIG.UV_FACTOR +
    activityScore * CONFIG.ACTIVITY_FACTOR;

  return Math.round(clamp(100 - loss, 0, 100));
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

  const uv = state.currentUV ?? CONFIG.UV_FALLBACK;

  state.protection = state.appliedAt
    ? calculateProtection(elapsedMinutes, uv, state.activityScore)
    : 100;

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
  state.notified = false;
  localStorage.setItem(CONFIG.STORAGE_KEY_APPLIED_AT, String(state.appliedAt));
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
function startTracking() {
  setInterval(updateUI, CONFIG.UI_UPDATE_INTERVAL_MS);

  refreshUV();
  setInterval(refreshUV, CONFIG.UV_REFRESH_INTERVAL_MS);

  refreshLocation();
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