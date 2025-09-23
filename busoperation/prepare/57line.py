# -*- coding: utf-8 -*-
"""
Created on Tue Apr 15 15:00:55 2025

@author: lpf
"""

import pandas as pd
import glob
# result=pd.DataFrame()
# for fname in glob.glob(r"E:\data\公交数据\公交到站\6.*\*"):
#     data=pd.read_csv(fname,encoding='gbk',header=None)
#     data=data[data[0].isin(['57(四惠枢纽站-靛厂新村)','57(靛厂新村-四惠枢纽站)'])]
#     result=pd.concat([result,data])
#     print(fname,len(data))

# result.to_csv("57路到站时间数据.csv",index=False)
#%%
result=pd.read_csv("57路到站时间数据.csv")
result=result[result['5']==-1]

group_cols = [col for col in result.columns if col != '6']
idx = result.groupby(group_cols)['6'].idxmin()
result = result.loc[idx].reset_index(drop=True)

result=result.sort_values(['4','6']).reset_index(drop=True)

result = result.rename(columns={
    '0': 'line_name',
    '1': 'direction',
    '2': 'stop_name',
    '3': 'stop_id',
    '4': 'vehicle_id',
    '5': 'arrival_flag',
    '6': 'arrival_time',
    '7': 'trip_id'
})

#%%

result['arrival_time'] = pd.to_datetime(result['arrival_time'], format='%Y%m%d%H%M%S')


result['next_line_name'] = result['line_name'].shift(-1)
result['next_direction'] = result['direction'].shift(-1)
result['next_vehicle_id'] = result['vehicle_id'].shift(-1)
result['next_stop_id'] = result['stop_id'].shift(-1)
result['next_stop_name'] = result['stop_name'].shift(-1)
result['next_arrival_time'] = result['arrival_time'].shift(-1)


mask = (
    (result['line_name'] == result['next_line_name']) &
    (result['direction'] == result['next_direction']) &
    (result['vehicle_id'] == result['next_vehicle_id']) &
    (result['next_stop_id'] == result['stop_id'] + 1)
)

# 筛选并计算时间差
result = result.loc[mask, [
    'line_name', 'direction', 'stop_id', 'stop_name',
    'next_stop_id', 'next_stop_name', 'arrival_time', 'next_arrival_time'
]]

result['arrival_time_diff'] = (result['next_arrival_time'] - result['arrival_time']).dt.total_seconds()


result = result.rename(columns={
    'stop_id': 'current_stop_id',
    'stop_name': 'current_stop_name',
    'next_stop_id': 'next_stop_id',
    'next_stop_name': 'next_stop_name',
    'arrival_time': 'current_arrival_time'
})[[
    'line_name', 'direction',
    'current_stop_id', 'current_stop_name',
    'next_stop_id', 'next_stop_name',
    'current_arrival_time', 'arrival_time_diff'
]]
#%%
date_mask = result['current_arrival_time'].dt.date.between(pd.to_datetime('2019-06-03').date(),
                                                pd.to_datetime('2019-06-08').date())
time_mask = result['current_arrival_time'].dt.time.between(pd.to_datetime('06:30:00').time(),
                                                pd.to_datetime('09:30:00').time())
morning_df = result[date_mask&time_mask]

#%%

# 分组字段
group_cols = [
    'line_name', 'current_stop_id', 'current_stop_name',
    'next_stop_id', 'next_stop_name']

# 分组并计算均值和标准差
agg_result = morning_df.groupby(group_cols)['arrival_time_diff'].agg(['mean', 'std','size','median','min']).reset_index()


agg_result = agg_result.rename(columns={
    'mean': 'arrival_time_diff_mean',
    'std': 'arrival_time_diff_std'
})

agg_result.to_csv(r"57路区间行程.csv",index=False)