#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
数据构建（带时间线）：
- 读取 busoperation/outputs/log 下的车辆/乘客日志（默认自动选择最新 episode）
- 提取每辆车在各站的停靠区间与区间行驶时间
- 输出时间线（按车划分的分段 schedule），前端据此计算速度以严格对齐时间

输出：
- web/data/stations.json  （累计距离）
- web/data/stats.json     （汇总统计）
- web/data/timeline.json  （按车的分段时间线）
"""
from __future__ import annotations

import argparse
import json
import os
import re
from typing import Dict, List, Tuple, Optional

WORKSPACE = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
DEFAULT_LOG_DIR = os.path.join(WORKSPACE, 'busoperation', 'outputs', 'log')
DEFAULT_SPACING_CSV = os.path.join(WORKSPACE, 'busoperation', 'setup', 'beijing_57_data', 'spacing.csv')
DEFAULT_OUT_DIR = os.path.join(WORKSPACE, 'web', 'data')


def ensure_out_dir(out_dir: str):
    os.makedirs(out_dir, exist_ok=True)


def read_spacing(spacing_csv: str) -> Tuple[Dict[int, float], Dict[int, float], List[int]]:
    spacing_by_stop: Dict[int, float] = {}
    ordered_stop_ids: List[int] = []
    with open(spacing_csv, 'r', encoding='utf-8') as f:
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


def read_bus_stats(bus_log_path: str):
    seen = set()
    sum_speed = 0.0
    cnt_speed = 0
    t_min, t_max = None, None
    if not os.path.exists(bus_log_path):
        return 0, 0.0, 0.0
    with open(bus_log_path, 'r', encoding='utf-8') as f:
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


def read_pax_lines(pax_log_path: str):
    if not os.path.exists(pax_log_path):
        return 0
    with open(pax_log_path, 'r', encoding='utf-8') as f:
        return sum(1 for _ in f)

# pax 行解析：INFO:root:pax_id:3,origin:1,destination:2,arrival_time:91,board_time504,alight_time:778,out_vehicle:413,in_vehicle:274
PAX_RE = re.compile(
    r"pax_id:(?P<pid>\d+),origin:(?P<o>\d+),destination:(?P<d>\d+),arrival_time:(?P<arr>\d+),board_time[: ]?(?P<board>\d+),alight_time:(?P<alight>\d+)"
)

def build_pax_index(pax_log_path: str):
    """构建一个按站点聚合的乘客索引，用于前端显示。
    返回：
      pax_index = {
        'by_stop': {stop_id: {'arrivals': [times], 'boards': [times], 'alights': [times]}},
        'by_time': 可选
      }
    以及一个用于 dwell 段注入的字典：dwell_key=(bus_id, stop, t0, t1) -> {on, off, onboard}
    onboard 通过累积上车-下车近似估计。
    """
    if not os.path.exists(pax_log_path):
        return {'by_stop': {}}, {}
    by_stop = {}
    pax_records = []
    with open(pax_log_path, 'r', encoding='utf-8') as f:
        for line in f:
            if 'INFO:root:' not in line:
                continue
            payload = line.split('INFO:root:')[1]
            m = PAX_RE.search(payload)
            if not m:
                continue
            o = int(m.group('o'))
            d = int(m.group('d'))
            arr = int(m.group('arr'))
            brd = int(m.group('board'))
            alt = int(m.group('alight'))
            by_stop.setdefault(o, {'arrivals': [], 'boards': [], 'alights': []})
            by_stop.setdefault(d, {'arrivals': [], 'boards': [], 'alights': []})
            by_stop[o]['arrivals'].append(arr)
            by_stop[o]['boards'].append(brd)
            by_stop[d]['alights'].append(alt)
            pax_records.append((o, d, arr, brd, alt))
    # 为 dwell 注入 on/off。我们不在日志里直接知道 bus_id 对应的乘客上下车，
    # 但可以基于时间窗统计：某站点 [t0,t1) 内 board/alight 的数量。
    dwell_aggregate = {}
    # 为了能匹配 bus 的 dwell 段，需要先构建一次 segments（轻读取）
    # 简化：在 build_timeline 之后再做注入。
    return {'by_stop': by_stop}, dwell_aggregate


LOG_RE = re.compile(
    r"t:(?P<t>\d+),bus_id:(?P<bus_id>\d+),spot_type:(?P<spot_type>\w+),spot_id:(?P<spot_id>-?\d+),dis:(?P<dis>[-+]?\d*\.?\d+),status:(?P<status>[^,]+),speed:(?P<speed>[-+]?\d*\.?\d+),pax_num:(?P<pax_num>\d+)"
)


def build_timeline(xcum: Dict[int, float], bus_log_path: str):
    segments_by_bus: Dict[int, List[Dict]] = {}
    state: Dict[int, Dict] = {}
    t_min, t_max = None, None

    if not os.path.exists(bus_log_path):
        return 0, 0, {}

    with open(bus_log_path, 'r', encoding='utf-8') as f:
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
            try:
                inst_speed = float(m.group('speed'))  # m/s 瞬时速度
            except Exception:
                inst_speed = None
            pax_num = int(m.group('pax_num'))

            if t_min is None or t < t_min:
                t_min = t
            if t_max is None or t > t_max:
                t_max = t

            st = state.setdefault(bus_id, {'last_type': None, 'last_stop': None, 'run_from': None, 't_run': None, 't_dwell': None,
                                           'acc_type': None, 'acc_sum': 0, 'acc_cnt': 0, 'pax0': None, 'pax1': None, 'v_inst_mps': None})
            segs = segments_by_bus.setdefault(bus_id, [])

            if spot_type == 'stop' or spot_type == 'holder':
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
                            v_inst = st.get('v_inst_mps') if st.get('v_inst_mps') is not None else None
                            segs.append({'type': 'run', 'from': from_stop, 'to': to_stop, 't0': st['t_run'], 't1': t,
                                         'x0': x0, 'x1': x1, 'v_mps': v_mps, 'v_kmh': v_mps * 3.6,
                                         'v_mps_inst': v_inst, 'v_kmh_inst': (v_inst * 3.6) if (isinstance(v_inst, (int, float))) else None,
                                         'pax_avg': pax_avg, 'pax0': st['pax0'], 'pax1': st['pax1']})
                    # 切换到停靠段，重置累积器
                    st['acc_type'] = 'dwell'
                    st['acc_sum'] = 0
                    st['acc_cnt'] = 0
                    st['pax0'] = pax_num
                    st['pax1'] = pax_num
                    st['t_dwell'] = t
                    st['last_stop'] = spot_id
                    st['dwell_status'] = 'holding' if spot_type == 'holder' or status == 'holding' else 'dwelling'
                    st['v_inst_mps'] = None
                else:
                    # dwell 段累积 pax
                    if st['acc_type'] != 'dwell':
                        st['acc_type'] = 'dwell'
                        st['acc_sum'] = 0
                        st['acc_cnt'] = 0
                        st['pax0'] = pax_num if st['pax0'] is None else st['pax0']
                    # 若停靠过程中状态从 normal 切到 holding（或反之），则切分前一段
                    current_dwell_status = 'holding' if spot_type == 'holder' or status == 'holding' else 'dwelling'
                    if st.get('dwell_status') and st['dwell_status'] != current_dwell_status and st.get('t_dwell') is not None and st.get('last_stop') is not None:
                        s = st['last_stop']
                        if s in xcum and t > st['t_dwell']:
                            pax_avg = (st['acc_sum'] / st['acc_cnt']) if st['acc_cnt'] > 0 else pax_num
                            segs.append({'type': 'dwell', 'stop': s, 't0': st['t_dwell'], 't1': t, 'x': float(xcum[s]), 'status': st['dwell_status'],
                                         'pax_avg': pax_avg, 'pax0': st['pax0'], 'pax1': st['pax1']})
                        st['t_dwell'] = t
                        st['acc_sum'] = 0
                        st['acc_cnt'] = 0
                        st['pax0'] = pax_num
                        st['pax1'] = pax_num
                        st['dwell_status'] = current_dwell_status
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
                            segs.append({'type': 'dwell', 'stop': s, 't0': st['t_dwell'], 't1': t, 'x': float(xcum[s]), 'status': st.get('dwell_status') or 'dwelling',
                                         'pax_avg': pax_avg, 'pax0': st['pax0'], 'pax1': st['pax1']})
                    st['t_dwell'] = None
                    st['run_from'] = st['last_stop'] if st['last_stop'] is not None else spot_id
                    st['t_run'] = t
                    # 记录本次区间起始时刻的瞬时速度（m/s）
                    if inst_speed is not None and inst_speed >= 0:
                        st['v_inst_mps'] = inst_speed
                    else:
                        st['v_inst_mps'] = None
                if st['t_run'] is None:
                    st['run_from'] = spot_id
                    st['t_run'] = t
                    if inst_speed is not None and inst_speed >= 0:
                        st['v_inst_mps'] = inst_speed
                    else:
                        st['v_inst_mps'] = None
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


EP_RE = re.compile(r'^(?P<prefix>bus|pax)_epsisode(?P<ep>\d+)\.log$')


def pick_episode(log_dir: str, episode: Optional[int]) -> int:
    if episode is not None:
        return episode
    if not os.path.isdir(log_dir):
        raise SystemExit(f'[ERR] log_dir not found: {log_dir}')

    bus_eps = set()
    pax_eps = set()
    for name in os.listdir(log_dir):
        m = EP_RE.match(name)
        if not m:
            continue
        ep = int(m.group('ep'))
        if m.group('prefix') == 'bus':
            bus_eps.add(ep)
        else:
            pax_eps.add(ep)
    common = sorted(bus_eps & pax_eps)
    if not common:
        raise SystemExit(f'[ERR] No matched bus/pax logs under: {log_dir}')
    return common[-1]


def main():
    parser = argparse.ArgumentParser(description='Build web/data/*.json from simulation logs.')
    parser.add_argument('--episode', type=int, default=None, help='Episode id to use (default: latest available).')
    parser.add_argument('--log-dir', default=DEFAULT_LOG_DIR, help='Directory containing bus/pax logs.')
    parser.add_argument('--spacing-csv', default=DEFAULT_SPACING_CSV, help='Path to spacing.csv.')
    parser.add_argument('--out-dir', default=DEFAULT_OUT_DIR, help='Output directory (web/data).')
    args = parser.parse_args()

    episode = pick_episode(args.log_dir, args.episode)
    bus_log_path = os.path.join(args.log_dir, f'bus_epsisode{episode}.log')
    pax_log_path = os.path.join(args.log_dir, f'pax_epsisode{episode}.log')

    ensure_out_dir(args.out_dir)
    spacing_by_stop, xcum, stop_ids = read_spacing(args.spacing_csv)
    stations = [{
        'id': sid,
        'name': str(sid),
        'x': round(xcum[sid], 3),
        'spacing': float(spacing_by_stop.get(sid, 0.0)),
    } for sid in stop_ids]
    with open(os.path.join(args.out_dir, 'stations.json'), 'w', encoding='utf-8') as f:
        json.dump({'stations': stations}, f, ensure_ascii=False)

    bus_count, avg_kmh, duration_min = read_bus_stats(bus_log_path)
    pax_total = read_pax_lines(pax_log_path)
    pax_index, _dwell_aggregate = build_pax_index(pax_log_path)
    stats = {
        'episode': episode,
        'bus_count': bus_count,
        'avg_speed_kmh': avg_kmh,
        'duration_min': duration_min,
        'total_pax': pax_total,
    }
    with open(os.path.join(args.out_dir, 'stats.json'), 'w', encoding='utf-8') as f:
        json.dump(stats, f, ensure_ascii=False)

    t_min, t_max, segs = build_timeline(xcum, bus_log_path)
    timeline = {
        't_min': t_min,
        't_max': t_max,
        'segments_by_bus': {str(k): v for k, v in segs.items()}
    }
    with open(os.path.join(args.out_dir, 'timeline.json'), 'w', encoding='utf-8') as f:
        json.dump(timeline, f, ensure_ascii=False)

    # 乘客索引单独输出
    with open(os.path.join(args.out_dir, 'pax_index.json'), 'w', encoding='utf-8') as f:
        json.dump(pax_index, f, ensure_ascii=False)

    print(f'[OK] episode={episode}')
    print('[OK] Wrote:', os.path.join(args.out_dir, 'stations.json'))
    print('[OK] Wrote:', os.path.join(args.out_dir, 'stats.json'))
    print('[OK] Wrote:', os.path.join(args.out_dir, 'timeline.json'))
    print('[OK] Wrote:', os.path.join(args.out_dir, 'pax_index.json'))


if __name__ == '__main__':
    main()
