import pickle
import pandas as pd
from scipy.stats import norm
from copy import deepcopy
import pandas as pd
import os
from ast import literal_eval


class DataLoader:
    def __init__(self) -> None:
        self.station_list = pd.read_table(r'setup/beijing_57_data/station_list.txt')
        self.tt_data = pd.read_excel(r'setup/beijing_57_data/distribution.xlsx')
        self.spacing_data = pd.read_excel('setup/beijing_57_data/spacing.xlsx')

    # @property
    # def trip_times(self):
    #     trip_times = []
    #     for day_id in self.day_ids:
    #         df = self.data['travel_time_{}'.format(day_id)]
    #         df['trip_time_seconds'] = df['trip_time'].dt.total_seconds()
    #         trip_time_seconds_list = df['trip_time_seconds'].tolist()
    #         trip_times.extend(trip_time_seconds_list)
    #     return trip_times

    @property
    def node_ids(self):
        node_ids = [str(x) for x in self.station_list['station_list']]
        return node_ids

    # @property
    # def virtual_bus_rtd_info(self):
    #     df = deepcopy(self.virtual_data)
    #     df['ACTDATETIME_8'] = pd.to_datetime(df['ACTDATETIME_8'])
    #     df['ACTDATETIME_9'] = pd.to_datetime(df['ACTDATETIME_9'])
    #     df['ACTDATETIME_10'] = pd.to_datetime(df['ACTDATETIME_10'])
    #     df['time_diff_ACTDATETIME_8'] = (
    #         df['ACTDATETIME_8'] - df['ACTDATETIME_8'].iloc[0]).dt.total_seconds()
    #     df['time_diff_ACTDATETIME_9'] = (
    #         df['ACTDATETIME_9'] - df['ACTDATETIME_9'].iloc[0]).dt.total_seconds()
    #     df['time_diff_ACTDATETIME_10'] = (
    #         df['ACTDATETIME_10'] - df['ACTDATETIME_10'].iloc[0]).dt.total_seconds()
    #     df['mean_time_diff'] = df[['time_diff_ACTDATETIME_8',
    #                                'time_diff_ACTDATETIME_9', 'time_diff_ACTDATETIME_10']].mean(axis=1)
    #     df['std_time_diff'] = df[['time_diff_ACTDATETIME_8',
    #                               'time_diff_ACTDATETIME_9', 'time_diff_ACTDATETIME_10']].std(axis=1)
    #     stop_rtd_time_info = dict(df.set_index('stationnum').apply(
    #         lambda row: (row['mean_time_diff'], row['std_time_diff']), axis=1))
    #
    #     stop_rtd_time_info = {str(k): v for k, v in stop_rtd_time_info.items()}
    #
    #     return stop_rtd_time_info

    @property
    def stop_pax_arrival_rate(self):
        df = deepcopy(self.lambda_data)
        stop_pax_arrival_rate = dict(zip(df['station_id'], df['lamda']))
        stop_pax_arrival_rate = {
            str(k): v/60 for k, v in stop_pax_arrival_rate.items()}
        return stop_pax_arrival_rate

    @property
    def link_time_info(self):
        link_time_info = {}
        self.tt_data['params']=self.tt_data['params'].apply(literal_eval) # 将字符串转换为字典
        for stop_id, params in zip(self.tt_data['station_num'], self.tt_data['params']):
            link_time_info[str(stop_id)] = params['norm']
        return link_time_info

    @property
    def spacing(self):
        link_spacing = {}
        for stop_id, spacing in zip(self.spacing_data['station_num'], self.spacing_data['spacing']):
            link_spacing[str(stop_id)] = spacing
        return link_spacing

    @property
    def dispatching_headway(self):
        # Hs = []
        # for day_id in self.day_ids:
        #     df = self.data['dep_fre_{}'.format(day_id)]
        #     # Convert the 'dep_fre' column to timedelta format
        #     df['dep_fre'] = pd.to_timedelta(df['dep_fre'])
        #     # Convert timedelta to seconds
        #     df['dep_fre_seconds'] = df['dep_fre'].dt.total_seconds()
        #     Hs.extend(df['dep_fre_seconds'].values.tolist())
        #
        # mu, std = norm.fit(Hs)
        return 420, 0
