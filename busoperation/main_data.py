from runner import run
from config import build_simulation_elements
import numpy as np
import matplotlib.pyplot as plt
from setup.chengdu_route_3_data.dataloader import DataLoader
from scipy.stats import norm
from setup.blueprint import Blueprint
import pickle


# blueprint, agent, run_config, record_config = build_simulation_elements()
# name_metric, route_trip_times = run(
#     blueprint, agent, run_config, record_config)
#
# simulate_trip_times = route_trip_times['3']
real_trip_times = DataLoader().trip_times
virtual_bus_rtd_info=DataLoader().virtual_bus_rtd_info
link_time_info=DataLoader().link_time_info
spacing=DataLoader().spacing
dispatching_headway=DataLoader().dispatching_headway
node_ids=DataLoader().node_ids
stop_pax_arrival_rate=DataLoader().stop_pax_arrival_rate
env_name= 'cd_route_3'
blueprint = Blueprint(env_name)
node_and_link_map=blueprint._generate_node_and_link_map()
total_arrival_rate=blueprint._calculate_total_arrival_rate()
route_stop_arrival_rate=blueprint._route_stop_arrival_rate
data = pickle.load(open('setup/chengdu_route_3_data/data.pickle', 'rb'))
tt_data = pickle.load(open('setup/chengdu_route_3_data/distribution.pickle', 'rb'))
lambda_data = pickle.load(open('setup/chengdu_route_3_data/lamda_station.pickle', 'rb'))
pass
