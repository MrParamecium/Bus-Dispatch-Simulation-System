from typing import Literal
from collections import defaultdict

import matplotlib.pyplot as plt

from dataclasses import dataclass
from pathlib import Path
import os
import logging

OUTPUT_DIR = Path(__file__).resolve().parents[1] / 'outputs'
LOG_DIR = OUTPUT_DIR / 'log'

@dataclass
class TrajectoryPoint:
    spot_type: str
    spot_id: str
    distance_from_terminal: float
    speed: float
    status: Literal['running_on_link', 'queueing_at_stop',
                    'dwelling_at_stop', 'holding', 'finished']

@dataclass
class InfoPoint:
    spot_type: str
    spot_id: str
    distance_from_terminal: float
    speed: float
    status: Literal['running_on_link', 'queueing_at_stop',
                    'dwelling_at_stop', 'holding', 'finished']
    pax_num: int
    total_pax: int
    pax_out_vehicle_time:int
    pax_in_vehicle_time:int
    leaving_pax_in_vehicle_time:int



def plot_time_space_diagram(buses, save_root=None, show=True, episide:int=0):
    _, ax = plt.subplots()
    ax.set_xlabel('Time (sec)', fontsize=12)
    ax.set_ylabel('Offset (m)', fontsize=12)

    for bus in buses:
        # if not bus.route_id == 'B2A':
        #     continue

        # plot trajectory
        x = []
        y = []
        for t, point in bus.trajectory.items():
            x.append(t)
            y.append(point.distance_from_terminal)
        ax.plot(x, y, 'k')

        # # plot holding durations
        # hold_xs = defaultdict(list)
        # hold_ys = {}
        # for t, point in bus.trajectory.items():
        #     if point.spot_type == 'holder':
        #         hold_xs[point.spot_id].append(t)
        #         hold_ys[point.spot_id] = point.distance_from_terminal
        # for spot_id, xs in hold_xs.items():
        #     start, end = min(xs), max(xs)
        #     y = hold_ys[spot_id]
        #     ax.hlines(y=y, xmin=start, xmax=end,
        #               color='green', linewidth=3.0)
        #
        # # plot queueing durations
        # queue_xs = defaultdict(list)
        # queue_ys = {}
        # for t, point in bus.trajectory.items():
        #     if point.status == 'queueing_at_stop':
        #         queue_xs[point.spot_id].append(t)
        #         queue_ys[point.spot_id] = point.distance_from_terminal
        #
        # for spot_id, xs in queue_xs.items():
        #     start, end = min(xs), max(xs)
        #     y = queue_ys[spot_id]
        #     ax.hlines(y=y, xmin=start, xmax=end,
        #               color='red', linewidth=3.0)

    if save_root:
        plt.savefig(os.path.join(save_root, "episode_{:0>5s}.png".format(str(episide))))
        plt.close()

    if show:
        plt.show()


def save_bus_info(buses, episide:int=0):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        handlers=[
            logging.FileHandler(str(LOG_DIR / f"bus_epsisode{episide}.log"), mode='w', encoding="utf-8"),
        ],
        force=True  # Python 3.8+
    )
    for bus in buses:
        for t, point in bus._info.items():
            logging.info(
                f"t:{t},bus_id:{bus.bus_id},spot_type:{point.spot_type},spot_id:{point.spot_id},dis:{point.distance_from_terminal:.2f},status:{point.status},speed:{point.speed:.2f},pax_num:{point.pax_num},total_pax:{point.total_pax},out_vehicle:{point.pax_out_vehicle_time},in_vehicle:{point.pax_in_vehicle_time},leaving_pax_time:{point.leaving_pax_in_vehicle_time}")


def save_pax_info(paxs, episide:int=0):
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        handlers=[
            logging.FileHandler(str(LOG_DIR / f"pax_epsisode{episide}.log"), mode='w', encoding="utf-8"),
        ],
        force=True  # Python 3.8+
    )
    for pax in paxs:
        logging.info(
            f"pax_id:{pax.pax_id},origin:{pax.origin},destination:{pax.destination},arrival_time:{pax.arrival_time},board_time{pax.board_time},alight_time:{pax.alight_time},out_vehicle:{pax.out_vehicle_delay},in_vehicle:{pax.in_vehicle_delay}")
