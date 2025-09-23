from runner import run
from config import build_simulation_elements
import numpy as np
import matplotlib.pyplot as plt
from setup.beijing_57_data.dataloader import DataLoader
from setup.beijing_factory import Bj_Route57_Components_Factory

from scipy.stats import norm
from setup.blueprint import Blueprint
import pickle


blueprint, agent, run_config, record_config = build_simulation_elements()
# name_metric, route_trip_times = run(
#     blueprint, agent, run_config, record_config)

# simulate_trip_times = route_trip_times['3']
# real_trip_times = DataLoader().trip_times
link_time_info=DataLoader().link_time_info
spacing=DataLoader().spacing
dispatching_headway=DataLoader().dispatching_headway
# node_ids=DataLoader().node_ids
# stop_pax_arrival_rate=DataLoader().stop_pax_arrival_rate
# env_name= 'bj_route_57'
# blueprint = Blueprint(env_name)
# Bj=Bj_Route57_Components_Factory(blueprint)
# virtual_bus=Bj.create_virtual_bus()
node_and_link_map=blueprint._generate_node_and_link_map()
total_arrival_rate=blueprint._calculate_total_arrival_rate()
route_stop_arrival_rate=blueprint._route_stop_arrival_rate

pass
