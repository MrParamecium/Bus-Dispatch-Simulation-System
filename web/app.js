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
  // 日志时间线驱动
    tMin: 0,
    tMax: 0,
  totalSpanSec: 0,
  segmentsByBus: {}, // { [busId]: Array<segment> }, segment: {type:'dwell'|'run', t0,t1, from?, to?, stop?, x0?, x1?}
  speedMul: 1,
  strictStatus: true, // 严格按日志状态：run 时移动，dwell 时停靠；不做合成段
  reverseDirection: true, // 使 0 号站映射为最左端（西端）
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
      if (state.reverseDirection) {
        if (idx === westIdx) icon = makeIcon(START_ICON_URL);
        else if (idx === eastIdx) icon = makeIcon(END_ICON_URL);
      } else {
      if (idx === eastIdx) icon = makeIcon(START_ICON_URL);
      else if (idx === westIdx) icon = makeIcon(END_ICON_URL);
      }
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
        if (state.reverseDirection) {
          if (idx === westIdx) icon = makeIcon(START_ICON_URL);
          else if (idx === eastIdx) icon = makeIcon(END_ICON_URL);
        } else {
        if (idx === eastIdx) icon = makeIcon(START_ICON_URL);
        else if (idx === westIdx) icon = makeIcon(END_ICON_URL);
        }
        const marker = new AMap.Marker({ position: item.p, icon, anchor: 'bottom-center', title: item.name });
        state.stationMarkers.push(marker);
      });

      // 使用构建数据中的累计距离
      state.stopXs = state.stations.map(s => s.x);
    }
  }

  if (state.stationMarkers.length) state.map.add(state.stationMarkers);
}
function mapStopIndex(idx) {
  const n = state.stopXs ? state.stopXs.length : 0;
  const clamped = Math.max(0, Math.min(n - 1, idx || 0));
  if (!state.reverseDirection || n === 0) return clamped;
  return (n - 1) - clamped;
}

function mapDistanceX(x) {
  const total = (state.stopXs && state.stopXs.length) ? (state.stopXs[state.stopXs.length - 1] || 0) : 0;
  const base = Math.max(0, x || 0);
  if (!state.reverseDirection) return base;
  return Math.max(0, total - base);
}

function extractLngLat(p) {
  if (!p) return [0, 0];
  if (Array.isArray(p)) return [p[0], p[1]];
  if (typeof p.lng === 'number' && typeof p.lat === 'number') return [p.lng, p.lat];
  return [0, 0];
}

function haversineDistanceMeters(a, b) {
  const [lng1, lat1] = extractLngLat(a);
  const [lng2, lat2] = extractLngLat(b);
  const toRad = (d) => d * Math.PI / 180;
  const R = 6371000; // meters
  const φ1 = toRad(lat1), φ2 = toRad(lat2);
  const Δφ = toRad(lat2 - lat1);
  const Δλ = toRad(lng2 - lng1);
  const s = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function distanceMeters(a, b) {
  if (typeof AMap !== 'undefined' && AMap.GeometryUtil && typeof AMap.GeometryUtil.distance === 'function') {
    try { return AMap.GeometryUtil.distance(a, b); } catch (_) { /* fallthrough */ }
  }
  return haversineDistanceMeters(a, b);
}

function approximatePolylineLength(path) {
  let sum = 0;
  for (let i = 1; i < path.length; i++) {
    sum += distanceMeters(path[i - 1], path[i]);
  }
  return sum; // 单位：米
}

function projectDistanceToPolyline(path, dist, totalLen) {
  if (!path || path.length < 2) return null;
  const target = Math.max(0, Math.min(dist, totalLen));
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const segLen = distanceMeters(path[i - 1], path[i]);
    if (acc + segLen >= target) {
      const ratio = segLen > 0 ? (target - acc) / segLen : 0;
      const [lng1, lat1] = extractLngLat(path[i - 1]);
      const [lng2, lat2] = extractLngLat(path[i]);
      const lng = lng1 + (lng2 - lng1) * ratio;
      const lat = lat1 + (lat2 - lat1) * ratio;
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
  const statusClass = (bus.status === 'dwelling_at_stop') ? 'dwelling' : (bus.status === 'holding' ? 'holding' : 'running');
  const html = `
    <div class="bus-marker">
      <img src="bus.png" alt="bus"/>
      <div class="bus-badge ${statusClass}">${bus.id}</div>
    </div>`;
  if (!mk) {
    mk = new AMap.Marker({ content: html, anchor: 'center', offset: new AMap.Pixel(0, -16), zIndex: 110 });
    state.map.add(mk);
    state.markersByBus.set(bus.id, mk);

    // 悬停显示信息
    mk.on('mouseover', () => {
      const d = mk.getExtData() || {};
      const speedStr = (typeof d.v_kmh_inst === 'number')
        ? `速度：${Math.round(d.v_kmh_inst * 10) / 10} km/h`
        : ((typeof d.v_kmh === 'number') ? `速度：${Math.round(d.v_kmh * 10) / 10} km/h` : '');
      const lines = [
        `Bus ${d.id ?? ''}`,
        d.status ? `状态：${d.status === 'dwelling_at_stop' ? '停靠' : (d.status === 'holding' ? '等待(holding)' : '行驶')}` : '',
        speedStr,
        (typeof d.dist_m === 'number') ? `距离：${Math.round(d.dist_m)} m` : ((typeof d.x === 'number') ? `距离：${Math.round(d.x)} m` : '')
      ].filter(Boolean).join('<br/>');
      state.infoWindow && state.infoWindow.setContent(`<div style="min-width:140px;color:#111;line-height:1.4;font-size:14px">${lines}</div>`);
      state.infoWindow && state.infoWindow.open(state.map, mk.getPosition());
    });
    mk.on('mouseout', () => { state.infoWindow && state.infoWindow.close(); });
  } else {
    if (typeof mk.setContent === 'function') mk.setContent(html);
  }
  const totalLen = state.routeLength > 0 ? state.routeLength : (state.stopXs[state.stopXs.length - 1] || 0);
  const pos = projectDistanceToPolyline(state.routeLngLats, Math.min(bus.x, totalLen), totalLen);
  if (pos) mk.setPosition(pos);
  // 标签与扩展数据
  const vKmh = (typeof bus.v_kmh === 'number') ? bus.v_kmh : ((bus.status === 'running_on_link') ? (state.speedMps * 3.6) : 0);
  const totalForDisplay = state.routeLength > 0 ? state.routeLength : (state.stopXs[state.stopXs.length - 1] || 0);
  const distFromStart = (!state.reverseDirection) ? bus.x : Math.max(0, totalForDisplay - bus.x);
  mk.setExtData({ id: bus.id, status: bus.status, v_kmh: vKmh, v_kmh_log: bus.v_kmh_log, v_kmh_inst: bus.v_kmh_inst, x: bus.x, dist_m: distFromStart });
  mk.setTitle(`Bus ${bus.id}`);
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

// ========= 基于日志的时间线驱动（使用日志时刻，不使用日志坐标/速度） =========
function prepareTimelineFromJson(timelineJson) {
  const m = timelineJson || {};
  const segsRaw = m.segments_by_bus || {};
  const byBus = {};
  const toNum = (v) => {
    const n = (typeof v === 'string') ? parseFloat(v) : v;
    return Number.isFinite(n) ? n : undefined;
  };
  for (const k of Object.keys(segsRaw)) {
    const busId = String(k);
    const arr = Array.isArray(segsRaw[k]) ? segsRaw[k] : [];
    byBus[busId] = arr.map(s => {
      if (s.type === 'dwell') {
        // 数值统一转 number；坐标仍用前端站点
        return { type: 'dwell', stop: toNum(s.stop), t0: toNum(s.t0), t1: toNum(s.t1), x: toNum(s.x) };
      } else if (s.type === 'run') {
        // 保留 x0/x1（距离），但最终投影到前端 polyline；不使用日志中的站点坐标
        return { type: 'run', from: toNum(s.from), to: toNum(s.to), t0: toNum(s.t0), t1: toNum(s.t1), x0: toNum(s.x0), x1: toNum(s.x1), v_kmh_log: toNum(s.v_kmh), v_kmh_inst: toNum(s.v_kmh_inst) };
      } else {
        return null;
      }
    }).filter(Boolean).sort((a, b) => a.t0 - b.t0);
  }
  state.tMin = toNum(m.t_min) ?? 0;
  state.tMax = toNum(m.t_max) ?? 0;
  state.totalSpanSec = Math.max(0, state.tMax - state.tMin);
  // 严格模式：完全使用时间线原段，既有 run 才移动，dwell 必停靠；不做任何合成或裁剪
  if (state.strictStatus) {
    state.segmentsByBus = byBus;
    return;
  }
  // 插入“起点→首段起点”的合成段，确保 time=tMin 时刻车辆显示在起点
  for (const busId of Object.keys(byBus)) {
    const segs = byBus[busId];
    if (!segs || segs.length === 0) continue;
    const first = segs[0];
    const startStop = (first.type === 'run') ? (first.from ?? 0) : (first.stop ?? 0);
    const t0 = state.tMin;
    const t1 = Math.max(state.tMin, first.t0 || state.tMin);
    if (t1 > t0) {
      segs.unshift({ type: 'run', from: 0, to: startStop, t0, t1 });
    } else {
      segs.unshift({ type: 'dwell', stop: 0, t0, t1 });
    }

    // 修复 run 段端点：若缺少 from/to 或 x0/x1，则用相邻 dwell 的 stop 推断
    // 第一遍：自前向后，用最近一次 dwell.stop 作为缺失的 from
    let lastStop = 0;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (s.type === 'dwell' && s.stop != null) {
        lastStop = s.stop;
      } else if (s.type === 'run') {
        if (!(Number.isFinite(s.from))) s.from = lastStop;
      }
    }
    // 第二遍：自后向前，用下一次 dwell.stop 作为缺失的 to
    let nextStop = 0;
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      if (s.type === 'dwell' && s.stop != null) {
        nextStop = s.stop;
      } else if (s.type === 'run') {
        if (!(Number.isFinite(s.to))) s.to = nextStop;
        // 若 t0==t1，扩大为 [t0, t0+1e-3]，避免零时长导致 r 跳变
        if (s.t1 <= s.t0) s.t1 = (s.t0 ?? 0) + 1e-3;
      }
    }

    // 第三步：若任意两个相邻 dwell 之间不存在有效 run，则插入合成 run；
    // 若两段 dwell 紧贴（t1 == 下一段 t0），从前一 dwell 尾部“借用”一小段 epsilon 作为 run，保持到站时刻不变
    const filled = [];
    const EPS = 0.5; // 秒，最小可视化行驶时间
    for (let i = 0; i < segs.length; i++) {
      const cur = segs[i];
      const next = segs[i + 1];
      if (!next) { filled.push(cur); continue; }
      if (cur.type === 'dwell' && next.type === 'dwell') {
        const fromStop = (cur.stop != null) ? cur.stop : 0;
        const toStop = (next.stop != null) ? next.stop : fromStop;
        const curLen = Math.max(0, (cur.t1 || 0) - (cur.t0 || 0));
        let t0r = (typeof cur.t1 === 'number') ? cur.t1 : 0;
        const t1r = (typeof next.t0 === 'number') ? next.t0 : t0r + 1e-3;
        // 若没有间隔（或极小），从 cur 尾部借用 epsilon，使 run 至少 EPS 秒
        if (!(t1r > t0r + 1e-6)) {
          const borrow = Math.min(EPS, Math.max(1e-3, curLen / 2));
          // 推入缩短后的 cur
          const curAdj = { ...cur, t1: (cur.t1 || 0) - borrow };
          filled.push(curAdj);
          t0r = curAdj.t1;
          if (toStop !== fromStop) filled.push({ type: 'run', from: fromStop, to: toStop, t0: t0r, t1: t1r });
          continue;
        }
        // 正常有间隔
        filled.push(cur);
        if (toStop !== fromStop) filled.push({ type: 'run', from: fromStop, to: toStop, t0: t0r, t1: t1r });
      } else {
        filled.push(cur);
      }
    }
    // 第四步：裁剪 run 段时间到相邻 dwell 之间，避免与 dwell 重叠导致不停靠
    const trimmed = [];
    for (let i = 0; i < filled.length; i++) {
      const s = filled[i];
      if (s.type !== 'run') { trimmed.push(s); continue; }
      // 前一个/后一个 dwell
      let prevDwell = null, nextDwell = null;
      for (let j = i - 1; j >= 0; j--) { if (filled[j].type === 'dwell') { prevDwell = filled[j]; break; } }
      for (let j = i + 1; j < filled.length; j++) { if (filled[j].type === 'dwell') { nextDwell = filled[j]; break; } }
      const origT0 = (typeof s.t0 === 'number') ? s.t0 : 0;
      const origT1 = (typeof s.t1 === 'number') ? s.t1 : (origT0 + 1e-3);
      const newT0 = Math.max(origT0, prevDwell ? (prevDwell.t1 || origT0) : origT0);
      const newT1 = Math.min(origT1, nextDwell ? (nextDwell.t0 || origT1) : origT1);
      if (newT1 > newT0 + 5e-4) {
        trimmed.push({ ...s, t0: newT0, t1: newT1 });
      } else {
        // 去掉零长度 run，确保停靠
      }
    }
    byBus[busId] = trimmed;
  }
  state.segmentsByBus = byBus;
}

function findSegmentForTime(segments, t) {
  // 若命中某个 dwell 的时间窗，优先返回 dwell，确保停靠；
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    if (s.type === 'dwell') {
      const t0 = (typeof s.t0 === 'number') ? s.t0 : 0;
      const t1 = (typeof s.t1 === 'number') ? s.t1 : t0 + 1e-6;
      if (t >= t0 && t < t1) return s;
    }
  }
  // 其次选择 run 段（保证区间内平滑）
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const t0 = (typeof s.t0 === 'number') ? s.t0 : 0;
    const t1 = (typeof s.t1 === 'number') ? s.t1 : t0 + 1e-6;
    if (t >= t0 && t < t1) return s;
  }
  // 不匹配任何段时，返回 null（不要用“最后一段”兜底，防止一开始就把车画在终点）
  return null;
}

function getDisplayPositionForSegment(seg, tNow) {
  if (!seg) return null;
  if (!state.stopXs || state.stopXs.length === 0) return null;
  if (seg.type === 'dwell') {
    let x;
    if (seg.stop != null && state.stopXs && state.stopXs.length) {
      const idx = mapStopIndex(seg.stop);
      x = state.stopXs[idx] || 0;
    } else if (typeof seg.x === 'number') {
      x = mapDistanceX(seg.x);
    } else {
      x = state.stopXs[0] || 0;
    }
    const status = (seg.status === 'holding') ? 'holding' : 'dwelling_at_stop';
    return { x, v_kmh: 0, status };
  } else if (seg.type === 'run') {
    let x0, x1;
    // 优先使用 from/to 映射到当前站点
    if (Number.isFinite(seg.from) && Number.isFinite(seg.to) && state.stopXs && state.stopXs.length) {
      const fromIdx = mapStopIndex(seg.from);
      const toIdx = mapStopIndex(seg.to);
      x0 = state.stopXs[fromIdx] || 0;
      x1 = state.stopXs[toIdx] || 0;
    }
    // 若缺失，则退化为使用日志的距离 x0/x1（仍投影到前端 polyline，不用日志坐标）
    if (!(typeof x0 === 'number' && typeof x1 === 'number')) {
      if (typeof seg.x0 === 'number' && typeof seg.x1 === 'number') {
        x0 = mapDistanceX(seg.x0);
        x1 = mapDistanceX(seg.x1);
      } else {
        // 仍然缺失时，保持当前位置（避免跳动）。
        // 尝试从邻近 dwell 段推断一个短 run，避免纯跳变
        const near = 1; // 由调用方按当前 tNow 查到的 seg 已经是运行段；此处兜底给极小位移
        x0 = state.stopXs[0] || 0;
        x1 = x0 + 1e-3;
      }
    }
    // 如果 from/to 得到的距离没有位移而 x0/x1 有效，则优先使用 x0/x1
    if ((typeof seg.x0 === 'number' && typeof seg.x1 === 'number')) {
      const altX0 = mapDistanceX(seg.x0);
      const altX1 = mapDistanceX(seg.x1);
      if (Math.abs((x1 - x0)) < 1e-6 && Math.abs(altX1 - altX0) > 1e-6) {
        x0 = altX0;
        x1 = altX1;
      }
    }
    const t0 = seg.t0, t1 = seg.t1;
    const dt = Math.max(1e-6, (t1 - t0));
    const r = Math.max(0, Math.min(1, (tNow - t0) / dt));
    const x = x0 + (x1 - x0) * r;
    const v_kmh = ((x1 - x0) / dt) * 3.6; // 按两站间平均速度
    const v_kmh_log = (typeof seg.v_kmh_log === 'number') ? seg.v_kmh_log : undefined;
    const v_kmh_inst = (typeof seg.v_kmh_inst === 'number') ? seg.v_kmh_inst : undefined;
    return { x, v_kmh, v_kmh_log, v_kmh_inst, status: 'running_on_link' };
  }
  return null;
}

function renderTimelineFrame() {
  const tNow = state.timeSec;
  const presentIds = new Set();
  for (const busId of Object.keys(state.segmentsByBus)) {
    const segs = state.segmentsByBus[busId];
    if (!segs || segs.length === 0) continue;
    if (tNow < state.tMin || tNow > state.tMax) continue;
    const seg = findSegmentForTime(segs, tNow);
    const pos = getDisplayPositionForSegment(seg, tNow);
    if (!pos) continue;
    const bus = { id: Number.isFinite(parseInt(busId, 10)) ? parseInt(busId, 10) : busId, x: pos.x, status: pos.status, v_kmh: pos.v_kmh, v_kmh_log: pos.v_kmh_log, v_kmh_inst: pos.v_kmh_inst };
    createOrUpdateBusMarker(bus);
    presentIds.add(String(busId));
  }
  // 清理不在当前时刻出现的车辆
  for (const [id, marker] of state.markersByBus.entries()) {
    if (!presentIds.has(String(id))) { state.map.remove(marker); state.markersByBus.delete(id); }
  }
  const rel = Math.max(0, Math.min(state.totalSpanSec || 1, tNow - state.tMin));
  if ($('clock')) $('clock').innerText = `${formatClock(rel, 0)} / ${formatClock(state.totalSpanSec || 1, 0)}`;
  if ($('seekRange')) $('seekRange').value = String(Math.floor(((rel) / Math.max(1, state.totalSpanSec)) * 100));
}

function startTimelinePlayback() {
  stopUniformSim();
  if (!state.segmentsByBus || Object.keys(state.segmentsByBus).length === 0) return;
  // 若 tMin 不命中任何段，则用全局最早段起点，避免一开始把车画在末段
  let initial = state.tMin || 0;
  // 统一从全局最早时刻开始播放，但初始位置强制显示在起点
  state.timeSec = state.tMin || initial;
  // 不立即渲染，等待用户点击“播放”后再渲染车辆
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
  if (!(state.totalSpanSec > 0) && (!state.phases || state.phases.length === 0)) return;
  const fps = 30;
  const interval = Math.max(16, Math.floor(1000 / fps));
  state.isPlaying = true;
  state.timer = setInterval(() => {
    state.timeSec += (interval / 1000) * Math.max(0.25, Math.min(10, state.speedMul || 1));
    if (state.totalSpanSec && state.totalSpanSec > 0) {
      if (state.timeSec > state.tMax) state.timeSec = state.tMin || 0;
      renderTimelineFrame();
    } else {
      renderUniformFrame();
    }
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
    acc[i] = acc[i - 1] + distanceMeters(path[i - 1], path[i]);
  }
  return acc; // 与 path 等长，最后一个为总长
}

function computeStopXsFromRoute(path, stopLngLats) {
  const cum = buildRouteCumLen(path);
  return stopLngLats.map(p => {
    let minIdx = 0;
    let minD = Number.POSITIVE_INFINITY;
    for (let i = 0; i < path.length; i++) {
      const d = distanceMeters(path[i], p);
      if (d < minD) { minD = d; minIdx = i; }
    }
    return cum[minIdx];
  });
}
function updateStatsPanel() {
  const s = state.stats || {};
  const setText = (id, v) => {
    const el = $(id);
    if (el) el.innerText = String(v != null ? v : '-');
  };
  setText('statBus', s.bus_count);
  setText('statSpeed', s.avg_speed_kmh);
  setText('statPax', s.total_pax);
  setText('statDuration', s.duration_min);
}

async function bootstrap() {
  const $loading = document.getElementById('loading');
  if ($loading) $loading.setAttribute('aria-hidden', 'false');
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
    // 准备基于日志的时间线：总仿真时间与到站时间按日志
    prepareTimelineFromJson(timelineJson);
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
  // 若有日志：仅完成时间线准备与初始时间设置，不立即渲染车辆（保持隐藏）
  // 无日志则回退统一速度仿真，保持原行为
  if (timelineJson && timelineJson.segments_by_bus) {
    state.timeSec = state.tMin || 0; // 延后到用户点击“播放”时再渲染
  } else {
    startUniformSim();
  }
  if ($loading) $loading.setAttribute('aria-hidden', 'true');

  // 控件事件
  const btnPlay = $('btnPlay');
  const btnPause = $('btnPause');
  const seek = $('seekRange');
  const speedRange = $('speedRange');
  const speedText = $('speedText');
  if (btnPlay) btnPlay.onclick = () => play();
  if (btnPause) btnPause.onclick = () => pause();
  if (seek) {
    let wasPlaying = false;
    seek.addEventListener('input', (e) => {
    const pct = parseInt(e.target.value, 10) / 100;
      if (state.totalSpanSec && state.totalSpanSec > 0) {
        // 日志模式：绝对时间范围 [tMin, tMax]
        const rel = Math.max(0, Math.min(1, pct)) * state.totalSpanSec;
        state.timeSec = (state.tMin || 0) + rel;
        renderTimelineFrame();
      } else if (state.phases && state.phases.length > 0) {
        // 统一速度模式：按单周期
        const T = state.cycleDurationSec > 0 ? state.cycleDurationSec : 1;
        const tNorm = Math.max(0, Math.min(1, pct)) * T;
        const k = Math.floor(state.timeSec / T);
        state.timeSec = k * T + tNorm;
        renderUniformFrame();
      }
    });
  }
  if (speedRange) {
    speedRange.addEventListener('input', (e) => {
      const v = parseFloat(e.target.value);
      state.speedMul = Math.max(0.25, Math.min(10, isNaN(v) ? 1 : v));
      if (speedText) speedText.innerText = `${state.speedMul}x`;
    });
  }
}

window.addEventListener('DOMContentLoaded', bootstrap);


