from collections import defaultdict
from pathlib import Path
from typing import Dict, Tuple, List

import numpy as np
try:
    import wandb  # type: ignore
except Exception:  # wandb is optional; disable recording if unavailable
    wandb = None  # type: ignore
from agent.agent import Agent
from agent.rl.rl_agent import RLAgent
from setup.blueprint import Blueprint
from simulator.simulator import Simulator
from simulator.trajectory import plot_time_space_diagram,save_pax_info,save_bus_info

import logging

OUTPUT_DIR = Path(__file__).resolve().parent / 'outputs'
WEIGHTS_DIR = OUTPUT_DIR / 'weights'
IMAGES_DIR = OUTPUT_DIR / 'images'

def run(blueprint: Blueprint, agent: Agent, run_config: Dict, record_config: Dict) -> Tuple[Dict[str, float], Dict[str, List[float]]]:
    ''' Run the simulation for multiple episodes and return the metrics

    Given a `blueprint` and an `agent`, run the simulation according to the `run_config` for one or multiple times and return the metrics. 
    If `is_record_wandb` in `config.yaml` is specified, the metrics of each episode will be recorded in `wandb`.

    Args:
        blueprint: blueprint that provide network and route information as a whole
        agent: specific Agent object
        run_config: configuration for running the simulation
        record_config: configuration for recording in wandb, an empty dict if not need recording

    Returns:
        name_metric_value: a dict mapping the name of the metric to its value, averaged across all episodes
        route_trip_times: a dict mapping the route id to a list of trip times that all buses experience in all episodes

    '''
    is_record = True if len(record_config) > 0 else False
    if is_record and wandb is None:
        is_record = False
    if is_record:
        wandb_project_name = record_config['wandb_config']['wandb_project_name']
        wandb.init(project=wandb_project_name, config=record_config)

    name_episode_metrics: Dict[str, List[float]] = defaultdict(list)
    route_trip_times: Dict[str, List[float]] = defaultdict(list)

    for epsisode in range(run_config['episode_num']):
        # at the beginning of each episode, we reset the simulator
        simulator = Simulator(blueprint, agent, run_config)

        # stop_bus_hold_action: {(stop_id, route_id, bus_id) -> specified holding time}
        stop_bus_hold_action: Dict[Tuple[str, str, str], float] = {}

        # main opeartion loop for each episode
        for t in range(run_config['episode_duration']):
            snapshot = simulator.step(t, stop_bus_hold_action)
            stop_bus_hold_action= agent.calculate_hold_time(snapshot)
            snapshot.record_holding_time(stop_bus_hold_action)
            agent.extrat_bus_info_from_snapshot(snapshot)

            # for bus in simulator.total_buses:
            #     logging.info(f"t:{t},bus_id:{bus.bus_id},speed:{bus.speed:.2f},t:{t},pax_num:{len(bus._paxs)},status:{bus._status},dis:{bus.loc_relative_to_terminal:.2f},total_pax:{bus.total_pas_num},waiting:{bus.total_pas_out_vehicle_time},in_vehicle:{bus.total_pas_in_vehicle_time}")

        # for bus in simulator.total_buses:
        #     logging.info(f"t:{t},bus_id:{bus.bus_id},speed:{bus.speed:.2f},t:{t},pax_num:{len(bus._paxs)},status:{bus._status},dis:{bus.loc_relative_to_terminal:.2f},total_pax:{bus.total_pas_num},waiting:{bus.total_pas_out_vehicle_time},in_vehicle:{bus.total_pas_in_vehicle_time}")


        # for pax in simulator._left_paxs:
        #     logging.info(f"pax_id:{pax.pax_id},start:{pax.origin},end:{pax.destination},arrrival:{pax.arrival_time},boarding:{pax.board_time},alighting:{pax.alight_time},total_waiting:{pax.out_vehicle_delay:.2f},total_in_vehicle:{pax.in_vehicle_delay:.2f}")
        # get the metrics for each episode and store them
        metrics, route_dispatch_time_trip_time = simulator.get_metrics()
        for name, metric in metrics.items():
            name_episode_metrics[name].append(metric)

        # get the route trip times
        for route, dispatch_time_trip_time in route_dispatch_time_trip_time.items():
            for dispatch_time, trip_time in dispatch_time_trip_time.items():
                route_trip_times[route].append(trip_time)
        route_trip_times = dict(route_trip_times)

        print(f'---------- episode {epsisode} ------------')
        print(f'metrics is {metrics}')
        agent.reset(epsisode)
        if epsisode % 3 == 0:

            WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
            IMAGES_DIR.mkdir(parents=True, exist_ok=True)
            plot_time_space_diagram(simulator.total_buses, save_root=str(IMAGES_DIR), show=False, episide=epsisode)
            save_bus_info(simulator.total_buses, episide=epsisode)
            save_pax_info(simulator._left_paxs, episide=epsisode)

        if epsisode == run_config['episode_num'] - 1:
            # plot_time_space_diagram(simulator.total_buses)
            # save the model if the agent is an RL agent and it is training
            if isinstance(agent, RLAgent) and agent.is_train:
                WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)
                agent.save_net(path=str(WEIGHTS_DIR / 'actor_net.pth'))
            # for bus in simulator.total_buses:
            #     print(bus.bus_id,bus.bus_log.stop_link_speed) # 打印车辆速度和停留时间
            #     print(bus.bus_id, bus.bus_log.stop_dwell_time)
        if is_record:
            wandb.log(metrics)
    if is_record:
        wandb.finish()

    # return the averaged metrics across all episodes, and the route trip times
    name_metric_value = {}
    for name, episode_metrics in name_episode_metrics.items():
        metric_mean = np.mean(np.array(episode_metrics))
        name_metric_value[name] = metric_mean
    return name_metric_value, route_trip_times
