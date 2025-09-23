from runner import run
from config import build_simulation_elements
import pprint
import json
blueprint, agent, run_config, record_config = build_simulation_elements()
# blueprint_data = blueprint.network.link_distribution
# print(blueprint_data)
name_metric, trip_times = run(blueprint, agent, run_config, record_config)
pass
