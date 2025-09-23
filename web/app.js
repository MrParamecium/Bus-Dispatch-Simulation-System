/*
  Episode50 可视化：
  - 读取 web/data/*.json
  - 使用高德地图绘制路线与站点
  - 基于 frames 做车辆位置动画；支持播放/暂停、倍速
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
  frames: [],   // [{t, buses: [{id, x, status, v, pax, seg, spotType}]}]
  stats: null,
  // 播放
  timer: null,
  speed: 1,
  frameIndex: 0,
  markersByBus: new Map(),
  routeLngLats: [], // polyline 的经纬度序列
  routeLength: 0,
  realStops: null,
  stationMarkers: [],
  stationLabels: [],
  totalFrames: 0,
  stopXs: [], // 站点沿路线的累计距离（米）
  infoWindow: null, // 悬浮信息窗口
  // 简化调度仿真模式
  simMode: true,
  sim: {
    busCount: 0,
    headwaySec: 300,   // 每5分钟一辆
    baseSpeed: 7.0,    // m/s，约25.2km/h
    dwellSec: 20,      // 每站停靠时长
    timeSec: 0,        // 当前仿真时间
    totalSpanSec: 0,   // 整个回放跨度（含最后一辆发车+全程）
    timeline: null,    // 从日志构建的分段 schedule
    tMin: 0,
    tMax: 0,
  },
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

  // 通用信息窗口（鼠标悬停展示）
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

function createOrUpdateBusMarker(bus) {
  let mk = state.markersByBus.get(bus.id);
  if (!mk) {
    const icon = new AMap.Icon({
      image: 'bus.png',
      size: new AMap.Size(70, 70),
      imageSize: new AMap.Size(70, 70),
    });
    mk = new AMap.Marker({
      icon,
      anchor: 'center',
      offset: new AMap.Pixel(0, -12),
      zIndex: 110,
    });
    state.map.add(mk);
    state.markersByBus.set(bus.id, mk);

    // 仅绑定一次悬停事件
    mk.on('mouseover', () => {
      const d = mk.getExtData() || {};
      const parts = [
        `Bus ${d.id ?? ''}`,
        d.status ? `状态：${statusText(d.status)}` : '',
        (typeof d.v_log === 'number' && d.v_log > 0) ? `log速：${d.v_log} km/h` : '',
        (typeof d.dis_log === 'number' && d.dis_log > 0) ? `段已行驶：${d.dis_log} m` : '',
        (typeof d.pax === 'number') ? `车上：${Math.round(d.pax)}` : ''
      ].filter(Boolean).join('<br/>');
      state.infoWindow.setContent(`<div style="min-width:160px;color:#111;line-height:1.4;font-size:14px">${parts}</div>`);
      state.infoWindow.open(state.map, mk.getPosition());
    });
    mk.on('mouseout', () => {
      state.infoWindow && state.infoWindow.close();
    });
  }
  // 仅在停靠时吸附到站点，避免行驶过程中来回跳动
  const near = nearestStopX(bus.x, 30); // 阈值 30m 更稳
  const isDwelling = !!(bus.status && bus.status.indexOf('dwelling') !== -1);
  const xToUse = (isDwelling && near.near) ? near.stopX : bus.x;
  const pos = projectDistanceToPolyline(state.routeLngLats, xToUse, state.routeLength);
  if (pos) mk.setPosition(pos);
  // 更新悬浮所需数据
  mk.setExtData({
    id: bus.id,
    status: bus.status,
    v_log: bus.v_log,
    dis_log: bus.dis_log,
    pax: bus.pax
  });
  mk.setTitle(`Bus ${bus.id}`);
}

function renderFrame(i) {
  // 仿真渲染：根据当前时间生成车辆位置
  const { active, all } = getBusesFromTimeline(state.sim.timeSec);
  // 地图上展示：在途 + 已到达（未发车的不显示）
  const visible = all.filter(b => b.status !== 'not_departed');
  // 清理不存在的车辆（以可见集合为准）
  const presentIds = new Set(visible.map(b => b.id));
  for (const [busId, marker] of state.markersByBus.entries()) {
    if (!presentIds.has(busId)) { state.map.remove(marker); state.markersByBus.delete(busId); }
  }
  // 更新或创建
  for (const b of visible) createOrUpdateBusMarker(b);
  renderSidePanel({ buses: all });
  // 显示端取两位小数，避免浮点尾数
  const t = Math.round(state.sim.timeSec * 100) / 100;
  const total = state.sim.totalSpanSec || 0;
  $('clock').innerText = `${formatClock(t, 2)} / ${formatClock(Math.floor(total), 0)}`;
  $('seekRange').value = Math.floor((t / Math.max(1, total)) * 100);
}

function renderSidePanel(frame) {
  $('busList').innerHTML = '';
  const busesSorted = [...frame.buses].sort((a, b) => a.id - b.id);
  for (const b of busesSorted) {
    const li = document.createElement('li');
    li.className = 'bus-item';
    const badge = document.createElement('span');
    let cls = 'run'; let text = '行驶';
    if (b.status === 'not_departed') { cls = 'pending'; text = '未发车'; }
    else if (b.status === 'arrived_terminal') { cls = 'arrived'; text = '到达'; }
    else if (busIsDwelling(b)) { cls = 'stop'; text = '停靠'; }
    badge.className = 'badge ' + cls;
    badge.innerText = text;
    li.appendChild(badge);

    const labelEl = document.createElement('span');
    const meta = document.createElement('div');
    meta.className = 'bus-meta';
    const line1 = document.createElement('div');
    line1.innerText = `Bus ${b.id}`;
    const line2 = document.createElement('div');
    const vLogTxt = (typeof b.v_log === 'number' && b.v_log > 0) ? `log速: ${b.v_log} km/h` : '';
    const disTxt = (typeof b.dis_log === 'number' && b.dis_log > 0) ? `段已行驶: ${b.dis_log} m` : '';
    const paxTxt = (typeof b.pax === 'number') ? `车上: ${Math.round(b.pax)}` : '';
    line2.innerText = [
      `v: ${b.v}`,
      vLogTxt,
      disTxt,
      paxTxt
    ].filter(Boolean).join(' | ');
    meta.appendChild(line1);
    meta.appendChild(line2);
    li.appendChild(meta);

    $('busList').appendChild(li);
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

function nearestStopX(x, thresholdMeters) {
  if (!state.stopXs || state.stopXs.length === 0) return { near: false, stopX: x };
  let best = state.stopXs[0];
  let minAbs = Math.abs(x - best);
  for (let i = 1; i < state.stopXs.length; i++) {
    const diff = Math.abs(x - state.stopXs[i]);
    if (diff < minAbs) { minAbs = diff; best = state.stopXs[i]; }
  }
  return { near: minAbs <= (thresholdMeters || 50), stopX: best };
}

function busIsDwelling(bus) {
  // 在“时间线驱动”模式下，v 为 0 不代表停靠。
  // 仅依据状态判断是否停靠，避免靠站附近被误判。
  const rawDwelling = !!(bus.status && bus.status.indexOf('dwelling') !== -1);
  return rawDwelling;
}

function updateStatsPanel() {
  if (!state.stats) return;
  $('statBus').innerText = String(state.stats.bus_count);
  $('statSpeed').innerText = String(state.stats.avg_speed_kmh);
  $('statPax').innerText = String(state.stats.total_pax);
  $('statDuration').innerText = String(state.stats.duration_min);
}

function prepareTimelinePlayback(timelineJson) {
  const m = timelineJson || {};
  state.sim.timeline = m.segments_by_bus || {};
  state.sim.tMin = m.t_min || 0;
  state.sim.tMax = m.t_max || 0;
  state.sim.timeSec = 0;
  state.sim.totalSpanSec = Math.max(1, state.sim.tMax - state.sim.tMin);
  state.stopXs = state.stations.map(s => s.x);

  // 将“停在最后一站(如34)”的车辆，改造为在 [t0,t1] 以内跑完最后 34→35 段，
  // 使其在日志最后时刻恰好到达终点（仅调整这一段速度，不改前段时间）
  const totalLen = state.stopXs.length ? state.stopXs[state.stopXs.length - 1] : 0;
  for (const busId of Object.keys(state.sim.timeline)) {
    const segs = state.sim.timeline[busId];
    if (!Array.isArray(segs) || segs.length === 0) continue;
    const last = segs[segs.length - 1];
    if (last && last.type === 'dwell' && typeof last.x === 'number') {
      const dx = totalLen - last.x;
      const dt = (last.t1 ?? 0) - (last.t0 ?? 0);
      if (dx > 1 && dt > 0) {
        const v = dx / dt;
        segs[segs.length - 1] = {
          type: 'run',
          t0: last.t0,
          t1: last.t1,
          x0: last.x,
          x1: totalLen,
          v_mps: v,
          v_kmh: v * 3.6,
          pax_avg: last.pax_avg
        };
      }
    }
    // 若最后为运行段且终点未到总里程，则追加一个“尾段”在最后一秒补齐至终点
    const lastRun = segs[segs.length - 1];
    if (lastRun && lastRun.type === 'run' && typeof lastRun.x1 === 'number') {
      const dx2 = totalLen - lastRun.x1;
      if (dx2 > 1) {
        const t1 = lastRun.t1;
        const t0 = Math.max((t1 || 0) - 1, (lastRun.t0 || 0));
        const dt = Math.max(1, (t1 || 0) - t0);
        const v = dx2 / dt;
        segs.push({
          type: 'run',
          t0,
          t1,
          x0: lastRun.x1,
          x1: totalLen,
          v_mps: v,
          v_kmh: v * 3.6,
          pax_avg: lastRun.pax_avg
        });
      }
    }
  }
}

function interpolateRun(x0, x1, t0, t1, t) {
  if (t <= t0) return x0;
  if (t >= t1) return x1;
  const r = (t - t0) / (t1 - t0);
  return x0 + (x1 - x0) * r;
}

function getBusesFromTimeline(tSec) {
  // 禁用小车运行与渲染
  return { active: [], all: [] };
}

function statusText(status) {
  if (!status) return '';
  if (status.indexOf('not_departed') !== -1) return '未发车';
  if (status.indexOf('arrived_terminal') !== -1) return '到达';
  if (status.indexOf('dwelling') !== -1) return '停靠';
  return '行驶';
}

function formatClock(sec, decimals) {
  let total = Math.max(0, sec);
  let m = Math.floor(total / 60);
  let s = total - m * 60;
  if (decimals && decimals > 0) {
    const pow = Math.pow(10, decimals);
    s = Math.round(s * pow) / pow; // 四舍五入到指定位数
    if (s >= 60) { m += 1; s = 0; }
    const intSec = Math.floor(s);
    const frac = (Math.round((s - intSec) * pow) / pow).toFixed(decimals).slice(1); // like .ss
    const intStr = String(intSec).padStart(2, '0');
    return `${m}:${intStr}${frac}`;
  } else {
    s = Math.round(s);
    if (s >= 60) { m += 1; s = 0; }
    return `${m}:${String(s).padStart(2, '0')}`;
  }
}

function play() {
  stop();
  // 平滑推进：固定 30fps，根据 speed 按比例推进时间
  const fps = 30;
  const interval = Math.max(16, Math.floor(1000 / fps));
  state.timer = setInterval(() => {
    const deltaSec = state.speed * (interval / 1000);
    state.sim.timeSec += deltaSec;
    if (state.sim.timeSec > state.sim.totalSpanSec) state.sim.timeSec = 0;
    renderFrame(0);
  }, interval);
}

function stop() {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

async function bootstrap() {
  initMap();
  // 加载数据
  const [stationsJson, statsJson, timelineJson] = await Promise.all([
    loadJSON(`${DATA_BASE}/stations.json`),
    loadJSON(`${DATA_BASE}/stats.json`),
    loadJSON(`${DATA_BASE}/timeline.json`),
  ]);
  state.stations = stationsJson.stations || [];
  state.stats = statsJson || {};
  // 基于日志时间线驱动
  prepareTimelinePlayback(timelineJson);
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
  renderFrame(0);

  // 事件
  $('btnPlay').onclick = () => play();
  $('btnPause').onclick = () => stop();
  $('speedRange').oninput = (e) => {
    const v = parseFloat(e.target.value);
    state.speed = v;
    $('speedText').innerText = `${v}x`;
    if (state.timer) play(); // 重启定时器以应用新速度
  };

  // 进度条拖动跳播
  let isSeeking = false;
  $('seekRange').addEventListener('input', (e) => {
    if (!isSeeking) { stop(); isSeeking = true; }
    const pct = parseInt(e.target.value, 10) / 100;
    const t = Math.round(pct * Math.max(1, state.sim.totalSpanSec));
    state.sim.timeSec = t;
    renderFrame(0);
  });
  $('seekRange').addEventListener('change', () => {
    isSeeking = false;
    // 不自动恢复播放，由用户点击“播放”控制；如需自动继续，请取消下一行注释
    // play();
  });
}

window.addEventListener('DOMContentLoaded', bootstrap);


