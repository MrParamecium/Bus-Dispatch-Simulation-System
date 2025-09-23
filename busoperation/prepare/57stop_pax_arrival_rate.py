# -*- coding: utf-8 -*-
"""
Created on Wed Apr 16 08:34:50 2025

@author: lpf
"""

# import pandas as pd
# result=pd.DataFrame()
# for fname in ["20190603-匹配.csv","20190604-匹配.csv","20190605-匹配.csv","20190606-匹配.csv"]:
#     df=pd.read_csv(fname,usecols=['LINE_CODE', 'direction', 'UP_TIME',
#                        'ON_STATION', 'OFF_STATION', 'on_name', 'off_name'])


#     df['UP_TIME'] = pd.to_datetime(df['UP_TIME'])  # 如果还没转格式的话

# # 筛选条件
#     mask = (
#         (df['LINE_CODE'] == 57) &
#         (df['direction'] == 1) &
#         (df['UP_TIME'].dt.time >= pd.to_datetime('06:30:00').time()) &
#         (df['UP_TIME'].dt.time < pd.to_datetime('09:30:00').time())
#     )


# # 应用筛选
#     filtered_df = df.loc[mask,]
#     result=pd.concat([filtered_df,result])

# result.to_csv("57路早高峰刷卡数据.csv",index=False)

#%%
import pandas as pd

result=pd.read_csv("57路早高峰刷卡数据.csv")
result=result[result['ON_STATION']<=result['OFF_STATION']]
result['UP_TIME'] = pd.to_datetime(result['UP_TIME'])

len(result[result['on_name']==result['off_name']])

#除以3天，除以3小时，除以60分钟，到达率单位：人/min
pax_arrival_rate = result.groupby(['ON_STATION','on_name']).size().reset_index(name='count')
pax_arrival_rate['count']=pax_arrival_rate['count']/3/3/60
#最后一个站点不上人，人工设置为0
pax_arrival_rate = pax_arrival_rate[pax_arrival_rate['ON_STATION'] != 35]

pax_arrival_rate.loc[pax_arrival_rate['ON_STATION'] == 34, 'count'] = 0
#%%

# 1分离正常数据和异常数据
normal_df = result[result['on_name'] != result['off_name']].copy()
error_df = result[result['on_name'] == result['off_name']].copy()

# 2统计每个 OD 对的人数
od_counts = normal_df.groupby(['on_name', 'off_name']).size().reset_index(name='count')

# 3计算每个 OD 对占该上车站点总上车人数的比例
on_total = od_counts.groupby('on_name')['count'].sum().reset_index(name='total')
od_prob = od_counts.merge(on_total, on='on_name')
od_prob['prob'] = od_prob['count'] / od_prob['total']

# 4分配异常数据
# 首先统计每个异常上车站点的数量
error_counts = error_df.groupby('on_name').size().reset_index(name='error_count')

# 将概率分布与异常数量合并
od_prob = od_prob.merge(error_counts, on='on_name', how='left')
od_prob['error_count'] = od_prob['error_count'].fillna(0)

# 按概率分配异常数量
od_prob['redistributed'] = od_prob['prob'] * od_prob['error_count']
#od_prob['redistributed'] = od_prob['redistributed'].round().astype(int)

# 5 将正常数据和分配后的异常数据合并
od_prob['final_count'] = od_prob['count'] + od_prob['redistributed']
final_result = od_prob[['on_name', 'off_name', 'final_count']].copy()
final_result.final_count.sum()

final_result.loc[final_result['on_name'] == '四惠枢纽站', 'final_count'] = 0

#%%
station_dict = pax_arrival_rate.set_index('on_name')['ON_STATION'].to_dict()

final_result['ON_STATION'] = final_result['on_name'].map(station_dict)
final_result['OFF_STATION'] = final_result['off_name'].map(station_dict)

#除以3天，除以3小时，除以60分钟，OD分布单位：人/min
final_result['final_count']=final_result['final_count']/3/3/60

pivot_df = final_result.pivot_table(
    index='ON_STATION',
    columns='OFF_STATION',
    values='final_count',
    fill_value=0
)

