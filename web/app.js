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
  const [stationsJson, statsJson] = await Promise.all([
    loadJSON(`${DATA_BASE}/stations.json`),
    loadJSON(`${DATA_BASE}/stats.json`),
  ]);
  state.stations = stationsJson.stations || [];
  state.stats = statsJson || {};
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
}

window.addEventListener('DOMContentLoaded', bootstrap);


