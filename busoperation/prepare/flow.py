# -*- coding: utf-8 -*-
"""
Created on Tue Jun 24 16:22:42 2025

@author: lpf
"""

import pandas as pd

# 读取数据
df = pd.read_csv(r"57路早高峰刷卡数据.csv")
df=df[df.on_name!=df.off_name]
station_map = df[['ON_STATION', 'on_name']].dropna().drop_duplicates()
station_map=station_map[station_map.ON_STATION!=35]
# 识别新车次：on_name 是靛厂新村，ON_STATION == 1，且前一条记录的 ON_STATION > 1
df['prev_ON_STATION'] = df['ON_STATION'].shift(1)
df['is_new_trip'] = ((df['on_name'] == '靛厂新村') &
                     (df['ON_STATION'] == 1) &
                     (df['prev_ON_STATION'] > 1))
df['trip_id'] = df['is_new_trip'].cumsum()
df.drop(columns=['prev_ON_STATION', 'is_new_trip'], inplace=True)

# 统计上车人数
on_counts = df.groupby(['trip_id', 'on_name']).size().reset_index(name='on_count')

# 统计下车人数（注意：off_name 需要重命名为 on_name 才能合并）
off_counts = df.groupby(['trip_id', 'off_name']).size().reset_index(name='off_count')
off_counts = off_counts.rename(columns={'off_name': 'on_name'})

# 合并上下车数据
stats = pd.merge(on_counts, off_counts, how='outer', on=['trip_id', 'on_name']).fillna(0)
stats['on_count'] = stats['on_count'].astype(int)
stats['off_count'] = stats['off_count'].astype(int)

station_dict = station_map.set_index('on_name')['ON_STATION'].to_dict()
stats['ON_STATION'] = stats['on_name'].map(station_dict)

# 获取每个车次每站的第一个上车时间，作为到站时间
arrival_times = df.groupby(['trip_id', 'on_name'])['UP_TIME'].min().reset_index()
arrival_times = arrival_times.rename(columns={'UP_TIME': 'arrival_time'})
stats = pd.merge(stats, arrival_times, how='left', on=['trip_id', 'on_name'])

# 站点顺序直接使用 ON_STATION
stats = stats.rename(columns={'ON_STATION': 'station_order'})

# 排序以计算车内人数
stats = stats.sort_values(by=['trip_id', 'station_order']).reset_index(drop=True)

# 计算车内人数
onboard_list = []
onboard = 0
last_trip_id = None

for i, row in stats.iterrows():
    if row['trip_id'] != last_trip_id:
        onboard = 0  # 新车次重置
        last_trip_id = row['trip_id']
    onboard += row['on_count'] - row['off_count']
    onboard_list.append(onboard)

stats['onboard'] = onboard_list

stats=stats[['trip_id', 'on_name','station_order','arrival_time', 'on_count', 'off_count',  'onboard']]

stats.groupby('on_name')[['on_count', 'off_count',  'onboard']].mean()