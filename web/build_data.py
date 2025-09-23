#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
数据构建（带时间线）：
- 读取 episode50 的车辆日志，提取每辆车在各站的停靠区间与区间行驶时间
- 输出时间线（按车划分的分段 schedule），前端据此计算速度以严格对齐时间

输出：
- web/data/stations.json  （累计距离）
- web/data/stats.json     （汇总统计）
- web/data/timeline.json  （按车的分段时间线）
"""
from __future__ import annotations

import json
import os
import re
from typing import Dict, List, Tuple

WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
BUS_LOG = os.path.join(WORKSPACE, 'busoperation', 'outputs', 'log', 'bus_epsisode50.log')
PAX_LOG = os.path.join(WORKSPACE, 'busoperation', 'outputs', 'log', 'pax_epsisode50.log')
SPACING_CSV = os.path.join(WORKSPACE, 'busoperation', 'setup', 'beijing_57_data', 'spacing.csv')
OUT_DIR = os.path.join(WORKSPACE, 'web', 'data')


def ensure_out_dir():
    os.makedirs(OUT_DIR, exist_ok=True)


def read_spacing() -> Tuple[Dict[int, float], Dict[int, float], List[int]]:
    spacing_by_stop: Dict[int, float] = {}
    ordered_stop_ids: List[int] = []
    with open(SPACING_CSV, 'r', encoding='utf-8') as f:
        _ = f.readline()
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split(',')
            try:
                sid = int(parts[0])
            except Exception:
                continue
            spacing = float(parts[1]) if len(parts) > 1 and parts[1] else 0.0
            spacing_by_stop[sid] = spacing
            ordered_stop_ids.append(sid)
    ordered_stop_ids = sorted(ordered_stop_ids)
    xcum: Dict[int, float] = {}
    x = 0.0
    for idx, sid in enumerate(ordered_stop_ids):
        if idx == 0:
            xcum[sid] = 0.0
            continue
        x += spacing_by_stop.get(sid, 0.0)
        xcum[sid] = x
    return spacing_by_stop, xcum, ordered_stop_ids


BUS_RE = re.compile(r"t:(?P<t>\d+),bus_id:(?P<bus_id>\d+),.*?status:(?P<status>[^,]+),speed:(?P<speed>[-+]?\d*\.?\d+)")


def read_bus_stats():
    seen = set()
    sum_speed = 0.0
    cnt_speed = 0
    t_min, t_max = None, None
    if not os.path.exists(BUS_LOG):
        return 0, 0.0, 0.0
    with open(BUS_LOG, 'r', encoding='utf-8') as f:
        for line in f:
            if 'INFO:root:' not in line:
                continue
            payload = line.split('INFO:root:')[1]
            m = BUS_RE.search(payload)
            if not m:
                continue
            t = int(m.group('t'))
            bus_id = int(m.group('bus_id'))
            speed = float(m.group('speed'))
            seen.add(bus_id)
            if speed >= 0:
                sum_speed += speed
                cnt_speed += 1
            if t_min is None or t < t_min:
                t_min = t
            if t_max is None or t > t_max:
                t_max = t
    avg_kmh = (sum_speed / cnt_speed) * 3.6 if cnt_speed else 0.0
    duration_min = ((t_max - t_min) / 60.0) if (t_max is not None and t_min is not None) else 0.0
    return len(seen), round(avg_kmh, 2), round(duration_min, 1)


def read_pax_lines():
    if not os.path.exists(PAX_LOG):
        return 0
    with open(PAX_LOG, 'r', encoding='utf-8') as f:
        return sum(1 for _ in f)


LOG_RE = re.compile(
    r"t:(?P<t>\d+),bus_id:(?P<bus_id>\d+),spot_type:(?P<spot_type>\w+),spot_id:(?P<spot_id>-?\d+),dis:(?P<dis>[-+]?\d*\.?\d+),status:(?P<status>[^,]+),speed:(?P<speed>[-+]?\d*\.?\d+),pax_num:(?P<pax_num>\d+)"
)


def build_timeline(xcum: Dict[int, float]):
    segments_by_bus: Dict[int, List[Dict]] = {}
    state: Dict[int, Dict] = {}
    t_min, t_max = None, None

    if not os.path.exists(BUS_LOG):
        return 0, 0, {}

    with open(BUS_LOG, 'r', encoding='utf-8') as f:
        for line in f:
            if 'INFO:root:' not in line:
                continue
            payload = line.split('INFO:root:')[1]
            m = LOG_RE.search(payload)
            if not m:
                continue
            t = int(m.group('t'))
            bus_id = int(m.group('bus_id'))
            spot_type = m.group('spot_type')
            spot_id = int(m.group('spot_id'))
            status = m.group('status')
            pax_num = int(m.group('pax_num'))

            if t_min is None or t < t_min:
                t_min = t
            if t_max is None or t > t_max:
                t_max = t

            st = state.setdefault(bus_id, {'last_type': None, 'last_stop': None, 'run_from': None, 't_run': None, 't_dwell': None,
                                           'acc_type': None, 'acc_sum': 0, 'acc_cnt': 0, 'pax0': None, 'pax1': None})
            segs = segments_by_bus.setdefault(bus_id, [])

            if spot_type == 'stop':
                if st['last_type'] != 'stop' or st['last_stop'] != spot_id:
                    if st['t_run'] is not None and st['run_from'] is not None and st['last_type'] == 'link':
                        from_stop = st['run_from']
                        to_stop = spot_id
                        if from_stop in xcum and to_stop in xcum and t > st['t_run']:
                            x0 = float(xcum[from_stop])
                            x1 = float(xcum[to_stop])
                            dt = max(1, t - st['t_run'])
                            v_mps = (x1 - x0) / dt
                            pax_avg = (st['acc_sum'] / st['acc_cnt']) if st['acc_cnt'] > 0 else pax_num
                            segs.append({'type': 'run', 'from': from_stop, 'to': to_stop, 't0': st['t_run'], 't1': t,
                                         'x0': x0, 'x1': x1, 'v_mps': v_mps, 'v_kmh': v_mps * 3.6,
                                         'pax_avg': pax_avg, 'pax0': st['pax0'], 'pax1': st['pax1']})
                    # 切换到停靠段，重置累积器
                    st['acc_type'] = 'dwell'
                    st['acc_sum'] = 0
                    st['acc_cnt'] = 0
                    st['pax0'] = pax_num
                    st['pax1'] = pax_num
                    st['t_dwell'] = t
                    st['last_stop'] = spot_id
                else:
                    # dwell 段累积 pax
                    if st['acc_type'] != 'dwell':
                        st['acc_type'] = 'dwell'
                        st['acc_sum'] = 0
                        st['acc_cnt'] = 0
                        st['pax0'] = pax_num if st['pax0'] is None else st['pax0']
                    st['acc_sum'] += pax_num
                    st['acc_cnt'] += 1
                    st['pax1'] = pax_num
                st['last_type'] = 'stop'

            elif spot_type == 'link':
                if st['last_type'] == 'stop':
                    if st['t_dwell'] is not None and st['last_stop'] is not None and t > st['t_dwell']:
                        s = st['last_stop']
                        if s in xcum:
                            pax_avg = (st['acc_sum'] / st['acc_cnt']) if st['acc_cnt'] > 0 else pax_num
                            segs.append({'type': 'dwell', 'stop': s, 't0': st['t_dwell'], 't1': t, 'x': float(xcum[s]),
                                         'pax_avg': pax_avg, 'pax0': st['pax0'], 'pax1': st['pax1']})
                    st['t_dwell'] = None
                    st['run_from'] = st['last_stop'] if st['last_stop'] is not None else spot_id
                    st['t_run'] = t
                if st['t_run'] is None:
                    st['run_from'] = spot_id
                    st['t_run'] = t
                st['last_type'] = 'link'
                # run 段累积 pax
                if st['acc_type'] != 'run':
                    st['acc_type'] = 'run'
                    st['acc_sum'] = 0
                    st['acc_cnt'] = 0
                    st['pax0'] = pax_num
                    st['pax1'] = pax_num
                st['acc_sum'] += pax_num
                st['acc_cnt'] += 1
                st['pax1'] = pax_num
            else:
                st['last_type'] = spot_type

    for bus_id, st in state.items():
        segs = segments_by_bus.setdefault(bus_id, [])
        if st.get('last_type') == 'stop' and st.get('t_dwell') is not None:
            # 将最后一个停靠段延长到 t_max，保证终点期间车辆仍可见
            s = st['last_stop']
            if s in xcum and t_max and t_max > st['t_dwell']:
                segs.append({'type': 'dwell', 'stop': s, 't0': st['t_dwell'], 't1': t_max, 'x': float(xcum[s])})
        # 如果最后状态是 link，不做强制收尾，避免错误推断终点

    for bus_id, segs in segments_by_bus.items():
        segs.sort(key=lambda s: (s['t0'], 0 if s['type'] == 'dwell' else 1))

    return t_min or 0, t_max or 0, segments_by_bus


def main():
    ensure_out_dir()
    spacing_by_stop, xcum, stop_ids = read_spacing()
    stations = [{
        'id': sid,
        'name': str(sid),
        'x': round(xcum[sid], 3),
        'spacing': float(spacing_by_stop.get(sid, 0.0)),
    } for sid in stop_ids]
    with open(os.path.join(OUT_DIR, 'stations.json'), 'w', encoding='utf-8') as f:
        json.dump({'stations': stations}, f, ensure_ascii=False)

    bus_count, avg_kmh, duration_min = read_bus_stats()
    pax_total = read_pax_lines()
    stats = {
        'bus_count': bus_count,
        'avg_speed_kmh': avg_kmh,
        'duration_min': duration_min,
        'total_pax': pax_total,
    }
    with open(os.path.join(OUT_DIR, 'stats.json'), 'w', encoding='utf-8') as f:
        json.dump(stats, f, ensure_ascii=False)

    t_min, t_max, segs = build_timeline(xcum)
    timeline = {
        't_min': t_min,
        't_max': t_max,
        'segments_by_bus': {str(k): v for k, v in segs.items()}
    }
    with open(os.path.join(OUT_DIR, 'timeline.json'), 'w', encoding='utf-8') as f:
        json.dump(timeline, f, ensure_ascii=False)

    print('[OK] Wrote:', os.path.join(OUT_DIR, 'stations.json'))
    print('[OK] Wrote:', os.path.join(OUT_DIR, 'stats.json'))
    print('[OK] Wrote:', os.path.join(OUT_DIR, 'timeline.json'))


if __name__ == '__main__':
    main()
