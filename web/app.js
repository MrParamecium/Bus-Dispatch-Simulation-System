/*
  Episode50 可视化：
  - 读取 web/data/*.json
  - 使用高德地图绘制路线与站点
  - 已移除前端车辆运行/动画逻辑
*/

const DATA_BASE = './data';
// 站点图标
const START_ICON_URL = 'icons/marker-start.svg'; // 绿色“起”
const END_ICON_URL = 'icons/marker-end.svg';     // 红色“终”
const VIA_ICON_URL = 'icons/marker-via.svg';     // 蓝色“经”
// 高德 Web 服务（REST）Key，用于查询真实公交线路
const AMAP_WEB_SERVICE_KEY = '301206d11cfeb8fad4d0a3760c14d613';

const state = {
  map: null,
  polyline: null,
  stations: [], // {id, name, x, spacing}
  stats: null,
  routeLngLats: [], // polyline 的经纬度序列
  routeLength: 0,
  realStops: null,
  stationMarkers: [],
  stationLabels: [],
  stopXs: [], // 站点沿路线的累计距离（米）
  // 简化一致速度前端仿真
  markersByBus: new Map(),
  buses: [], // {id, x, nextStopIndex, status: 'running'|'dwelling', dwellUntil}
  timer: null,
  timeSec: 0,
  speedMps: 0,
  dwellSec: 20,
  busCount: 0,
  phases: [], // [{type:'run'|'dwell', t0,t1,x0,x1}]
  cycleDurationSec: 0,
  headwaySec: 0,
  isPlaying: false,
  infoWindow: null,
  busIds: [],
};

// 可选：自定义一条近似 57 路的 polyline 经纬度（若无后端提供坐标，可用该简化路径）
// 这些点覆盖北京东—西走向，非精确站点，仅用于演示。
const DEFAULT_ROUTE = [
  [116.286658, 39.908926], // 靛厂新村(西)
  [116.305, 39.907],
  [116.325, 39.904],
  [116.34, 39.905],
  [116.358, 39.905],
  [116.37, 39.903],
  [116.386, 39.900],
  [116.405, 39.898],
  [116.421, 39.897],
  [116.436, 39.897],
  [116.454, 39.907], // 四惠枢纽站(东)
];

async function loadJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error('加载失败: ' + path);
  return await res.json();
}

function $(id) { return document.getElementById(id); }

function initMap() {
  state.map = new AMap.Map('map', {
    zoom: 12,
    center: DEFAULT_ROUTE[0],
    viewMode: '3D',
  });

  // 悬浮信息窗口
  state.infoWindow = new AMap.InfoWindow({
    isCustom: false,
    offset: new AMap.Pixel(0, -20)
  });

  state.polyline = new AMap.Polyline({
    path: DEFAULT_ROUTE,
    isOutline: true,
    outlineColor: '#663399',
    borderWeight: 2,
    strokeColor: '#FF69B4',
    strokeOpacity: 0.9,
    strokeWeight: 6,
  });
  state.map.add(state.polyline);

  // 站点绘制（优先真实线路）
  drawStationsOnRoute();
}

function drawStationsOnRoute() {
  // 先清理旧的站点标记
  if (state.stationMarkers.length) {
    state.map.remove(state.stationMarkers);
    state.stationMarkers = [];
  }
  if (state.stationLabels.length) {
    state.map.remove(state.stationLabels);
    state.stationLabels = [];
  }

  const route = state.polyline.getPath();
  state.routeLngLats = route;
  state.routeLength = approximatePolylineLength(route);

  // 统一图标
  const makeIcon = (url) => new AMap.Icon({ image: url, size: new AMap.Size(36, 56), imageSize: new AMap.Size(36, 56) });

  // 若已获取真实站点，优先使用真实站点经纬度
  if (state.realStops && state.realStops.length) {
    let eastIdx = 0, westIdx = 0;
    for (let i = 1; i < state.realStops.length; i++) {
      if (state.realStops[i].lnglat[0] > state.realStops[eastIdx].lnglat[0]) eastIdx = i;
      if (state.realStops[i].lnglat[0] < state.realStops[westIdx].lnglat[0]) westIdx = i;
    }
    state.realStops.forEach((st, idx) => {
      let icon = makeIcon(VIA_ICON_URL);
      if (idx === eastIdx) icon = makeIcon(START_ICON_URL);
      else if (idx === westIdx) icon = makeIcon(END_ICON_URL);
      const marker = new AMap.Marker({ position: st.lnglat, icon, anchor: 'bottom-center', title: `${st.name}` });
      state.stationMarkers.push(marker);
    });

    // 计算这些站点沿 polyline 的累计距离（近似：匹配到最近折线顶点）
    state.stopXs = computeStopXsFromRoute(route, state.realStops.map(s => s.lnglat));
  } else {
    const positions = [];
    for (const s of state.stations) {
      const p = projectDistanceToPolyline(route, s.x, state.routeLength);
      if (!p) continue; positions.push({ p, name: s.name || String(s.id) });
    }
    if (positions.length) {
      let eastIdx = 0, westIdx = 0;
      for (let i = 1; i < positions.length; i++) {
        if (positions[i].p[0] > positions[eastIdx].p[0]) eastIdx = i;
        if (positions[i].p[0] < positions[westIdx].p[0]) westIdx = i;
      }
      positions.forEach((item, idx) => {
        let icon = makeIcon(VIA_ICON_URL);
        if (idx === eastIdx) icon = makeIcon(START_ICON_URL);
        else if (idx === westIdx) icon = makeIcon(END_ICON_URL);
        const marker = new AMap.Marker({ position: item.p, icon, anchor: 'bottom-center', title: item.name });
        state.stationMarkers.push(marker);
      });

      // 使用构建数据中的累计距离
      state.stopXs = state.stations.map(s => s.x);
    }
  }

  if (state.stationMarkers.length) state.map.add(state.stationMarkers);
}

function approximatePolylineLength(path) {
  let sum = 0;
  for (let i = 1; i < path.length; i++) {
    sum += AMap.GeometryUtil.distance(path[i - 1], path[i]);
  }
  return sum; // 单位：米
}

function projectDistanceToPolyline(path, dist, totalLen) {
  if (!path || path.length < 2) return null;
  const target = Math.max(0, Math.min(dist, totalLen));
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const segLen = AMap.GeometryUtil.distance(path[i - 1], path[i]);
    if (acc + segLen >= target) {
      const ratio = (target - acc) / segLen;
      const lng = path[i - 1].lng + (path[i].lng - path[i - 1].lng) * ratio;
      const lat = path[i - 1].lat + (path[i].lat - path[i - 1].lat) * ratio;
      return [lng, lat];
    }
    acc += segLen;
  }
  return path[path.length - 1];
}

function parsePolyline(polyline) {
  // "lng,lat;lng,lat;..."
  if (!polyline) return [];
  return polyline.split(';').map(pair => {
    const [lng, lat] = pair.split(',').map(Number);
    return [lng, lat];
  }).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

async function loadRealRouteFromAmap(lineName = '57路', city = '北京') {
  const url = `https://restapi.amap.com/v3/bus/linename?city=${encodeURIComponent(city)}&keywords=${encodeURIComponent(lineName)}&offset=20&output=json&extensions=all&key=${AMAP_WEB_SERVICE_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data || data.status !== '1' || !data.buslines || data.buslines.length === 0) {
    throw new Error('未查询到公交线路');
  }

  // 选择包含“靛厂”与“四惠”的方向，若没有则取第一条
  let best = data.buslines.find(b => /靛厂|靛廠/.test(b.name) || /靛厂|靛廠/.test(b.stations?.[0]?.name || '')) || data.buslines[0];
  // 更精确：优先 name 中包含“靛厂新村-四惠枢纽站”或相反方向
  const prefer = data.buslines.find(b => /57.*(靛|四惠)/.test(b.name));
  if (prefer) best = prefer;

  const path = parsePolyline(best.polyline);
  const stops = (best.busstops || []).map(s => {
    const [lng, lat] = (s.location || '').split(',').map(Number);
    return { name: s.name, lnglat: [lng, lat] };
  }).filter(s => Number.isFinite(s.lnglat[0]) && Number.isFinite(s.lnglat[1]));

  return { path, stops };
}

function findNextStopIndex(x) {
  if (!state.stopXs || state.stopXs.length === 0) return 0;
  for (let i = 0; i < state.stopXs.length; i++) {
    if (state.stopXs[i] > x + 1e-6) return i;
  }
  return state.stopXs.length - 1;
}

function createOrUpdateBusMarker(bus) {
  let mk = state.markersByBus.get(bus.id);
  if (!mk) {
    const icon = new AMap.Icon({
      image: 'bus.png',
      size: new AMap.Size(70, 70),
      imageSize: new AMap.Size(70, 70),
    });
    mk = new AMap.Marker({ icon, anchor: 'center', offset: new AMap.Pixel(0, -12), zIndex: 110 });
    state.map.add(mk);
    state.markersByBus.set(bus.id, mk);

    // 悬停显示信息
    mk.on('mouseover', () => {
      const d = mk.getExtData() || {};
      const lines = [
        `Bus ${d.id ?? ''}`,
        d.status ? `状态：${d.status === 'dwelling' ? '停靠' : '行驶'}` : '',
        (typeof d.v_kmh === 'number') ? `速度：${Math.round(d.v_kmh * 10) / 10} km/h` : '',
        (typeof d.x === 'number') ? `距离：${Math.round(d.x)} m` : ''
      ].filter(Boolean).join('<br/>');
      state.infoWindow && state.infoWindow.setContent(`<div style="min-width:140px;color:#111;line-height:1.4;font-size:14px">${lines}</div>`);
      state.infoWindow && state.infoWindow.open(state.map, mk.getPosition());
    });
    mk.on('mouseout', () => { state.infoWindow && state.infoWindow.close(); });
  }
  const totalLen = state.routeLength > 0 ? state.routeLength : (state.stopXs[state.stopXs.length - 1] || 0);
  const pos = projectDistanceToPolyline(state.routeLngLats, Math.min(bus.x, totalLen), totalLen);
  if (pos) mk.setPosition(pos);
  // 标签与扩展数据
  const vKmh = (bus.status === 'running') ? (state.speedMps * 3.6) : 0;
  mk.setExtData({ id: bus.id, status: bus.status, v_kmh: vKmh, x: bus.x });
  mk.setTitle(`Bus ${bus.id}`);
  if (typeof mk.setLabel === 'function') {
    mk.setLabel({ content: String(bus.id), direction: 'top' });
  }
}

function stopUniformSim() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
  state.isPlaying = false;
}

function prepareUniformPhases() {
  // 构建一次“起点→终点”的时间轴，含站点停靠
  state.phases = [];
  state.cycleDurationSec = 0;
  if (!state.stopXs || state.stopXs.length < 2) return;
  for (let i = 0; i < state.stopXs.length - 1; i++) {
    const x0 = state.stopXs[i];
    const x1 = state.stopXs[i + 1];
    const runT = Math.max(0, (x1 - x0) / Math.max(1e-6, state.speedMps));
    const t0 = state.cycleDurationSec;
    const t1 = t0 + runT;
    state.phases.push({ type: 'run', t0, t1, x0, x1 });
    state.cycleDurationSec = t1;
    // 到达站点后停靠
    const d0 = state.cycleDurationSec;
    const d1 = d0 + state.dwellSec;
    state.phases.push({ type: 'dwell', t0: d0, t1: d1, x0: x1, x1 });
    state.cycleDurationSec = d1;
  }
}

function interpolateRun(x0, x1, t0, t1, t) {
  if (t <= t0) return x0;
  if (t >= t1) return x1;
  const r = (t - t0) / (t1 - t0);
  return x0 + (x1 - x0) * r;
}

function busPositionAtLocalTime(localT) {
  if (!state.phases || state.phases.length === 0) return { x: state.stopXs[0] || 0, status: 'dwelling' };
  const T = state.cycleDurationSec > 0 ? state.cycleDurationSec : 1;
  let t = localT % T;
  if (t < 0) t += T;
  for (const ph of state.phases) {
    if (t < ph.t1) {
      if (ph.type === 'run') {
        return { x: interpolateRun(ph.x0, ph.x1, ph.t0, ph.t1, t), status: 'running' };
      } else {
        return { x: ph.x0, status: 'dwelling' };
      }
    }
  }
  // 兜底
  const last = state.phases[state.phases.length - 1];
  return { x: last.x1, status: 'dwelling' };
}

function renderUniformFrame() {
  // 计算各车在当前全局时间的位置
  const T = state.cycleDurationSec > 0 ? state.cycleDurationSec : 1;
  for (const b of state.buses) {
    const localT = state.timeSec - b.departTimeSec;
    if (localT < 0) {
      b.x = state.stopXs[0] || 0;
      b.status = 'dwelling';
    } else {
      const p = busPositionAtLocalTime(localT);
      b.x = p.x;
      b.status = p.status;
    }
    createOrUpdateBusMarker(b);
  }
  // 更新进度条与时钟（以单次循环为基准）
  const tNorm = state.timeSec % T;
  if ($( 'clock')) {
    $('clock').innerText = `${formatClock(tNorm, 0)} / ${formatClock(T, 0)}`;
  }
  if ($('seekRange')) {
    $('seekRange').value = String(Math.floor((tNorm / T) * 100));
  }
}

function startUniformSim() {
  stopUniformSim();
  if (!state.stopXs || state.stopXs.length < 2) return;
  const lastLen = state.stopXs[state.stopXs.length - 1];
  if (!(lastLen > 0)) return;

  // 统一速度（km/h -> m/s），优先使用统计数据
  const avgKmh = (state.stats && state.stats.avg_speed_kmh) ? state.stats.avg_speed_kmh : 25;
  state.speedMps = avgKmh / 3.6;
  state.dwellSec = 20; // 每站固定停靠 20 秒

  // 构建阶段
  prepareUniformPhases();
  if (!(state.cycleDurationSec > 0)) return;

  // 车辆数量：优先使用统计中的 bus_count
  const ids = Array.isArray(state.busIds) && state.busIds.length ? state.busIds : null;
  if (ids) {
    state.busCount = Math.max(1, Math.min(ids.length, 100));
  } else {
    const desiredCount = (state.stats && state.stats.bus_count) ? state.stats.bus_count : 20;
    state.busCount = Math.max(1, Math.min(desiredCount, 100));
  }
  state.headwaySec = state.cycleDurationSec / state.busCount;

  // 初始化车辆：全在起点，设定均匀发车时刻
  state.buses = [];
  for (let i = 0; i < state.busCount; i++) {
    const busIdRaw = ids ? ids[i] : (i + 1);
    const busId = Number.isFinite(parseInt(busIdRaw, 10)) ? parseInt(busIdRaw, 10) : String(busIdRaw);
    state.buses.push({ id: busId, x: state.stopXs[0] || 0, nextStopIndex: 1, status: 'dwelling', dwellUntil: 0, departTimeSec: i * state.headwaySec });
  }

  // 初始渲染（暂停状态）
  state.timeSec = 0;
  renderUniformFrame();
}

function play() {
  if (state.isPlaying) return;
  if (!state.phases || state.phases.length === 0) return;
  const fps = 30;
  const interval = Math.max(16, Math.floor(1000 / fps));
  state.isPlaying = true;
  state.timer = setInterval(() => {
    state.timeSec += interval / 1000;
    renderUniformFrame();
  }, interval);
}

function pause() {
  stopUniformSim();
}

function formatClock(sec, decimals) {
  let total = Math.max(0, sec);
  let m = Math.floor(total / 60);
  let s = total - m * 60;
  if (decimals && decimals > 0) {
    const pow = Math.pow(10, decimals);
    s = Math.round(s * pow) / pow;
    if (s >= 60) { m += 1; s = 0; }
    const intSec = Math.floor(s);
    const frac = (Math.round((s - intSec) * pow) / pow).toFixed(decimals).slice(1);
    const intStr = String(intSec).padStart(2, '0');
    return `${m}:${intStr}${frac}`;
  } else {
    s = Math.round(s);
    if (s >= 60) { m += 1; s = 0; }
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}

function buildRouteCumLen(path) {
  const acc = [0];
  for (let i = 1; i < path.length; i++) {
    acc[i] = acc[i - 1] + AMap.GeometryUtil.distance(path[i - 1], path[i]);
  }
  return acc; // 与 path 等长，最后一个为总长
}

function computeStopXsFromRoute(path, stopLngLats) {
  const cum = buildRouteCumLen(path);
  return stopLngLats.map(p => {
    let minIdx = 0;
    let minD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < path.length; i++) {
      const d = AMap.GeometryUtil.distance(path[i], p);
      if (d < minD) { minD = d; minIdx = i; }
    }
    return cum[minIdx];
  });
}
function updateStatsPanel() {
  if (!state.stats) return;
  $('statBus').innerText = String(state.stats.bus_count);
  $('statSpeed').innerText = String(state.stats.avg_speed_kmh);
  $('statPax').innerText = String(state.stats.total_pax);
  $('statDuration').innerText = String(state.stats.duration_min);
}

async function bootstrap() {
  initMap();
  // 加载数据
  const [stationsJson, statsJson, timelineJson] = await Promise.all([
    loadJSON(`${DATA_BASE}/stations.json`),
    loadJSON(`${DATA_BASE}/stats.json`),
    loadJSON(`${DATA_BASE}/timeline.json`).catch(() => null),
  ]);
  state.stations = stationsJson.stations || [];
  state.stats = statsJson || {};
  // 从日志时间线提取 busId 列表
  if (timelineJson && timelineJson.segments_by_bus) {
    state.busIds = Object.keys(timelineJson.segments_by_bus);
  } else {
    state.busIds = [];
  }
  updateStatsPanel();

  // 先尝试拉取真实 57 路路径与站点
  try {
    const { path, stops } = await loadRealRouteFromAmap('57路', '北京');
    if (path && path.length > 1) {
      state.polyline.setPath(path);
      state.realStops = stops;
    }
  } catch (e) {
    console.warn('获取真实公交线路失败，使用默认路径:', e);
  }

  // 绘制站点（真实/投影）并准备路线几何
  drawStationsOnRoute();
  // 准备一致速度仿真：默认暂停，等待用户点击播放
  startUniformSim();

  // 控件事件
  const btnPlay = $('btnPlay');
  const btnPause = $('btnPause');
  const seek = $('seekRange');
  if (btnPlay) btnPlay.onclick = () => play();
  if (btnPause) btnPause.onclick = () => pause();
  if (seek) {
    let wasPlaying = false;
    seek.addEventListener('input', (e) => {
      if (!state.phases || state.phases.length === 0) return;
      const T = state.cycleDurationSec > 0 ? state.cycleDurationSec : 1;
      const pct = parseInt(e.target.value, 10) / 100;
      const tNorm = Math.max(0, Math.min(1, pct)) * T;
      // 将全局时间对齐到当前所在周期
      const k = Math.floor(state.timeSec / T);
      state.timeSec = k * T + tNorm;
      renderUniformFrame();
    });
  }
}

window.addEventListener('DOMContentLoaded', bootstrap);


