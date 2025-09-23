import numpy as np
from scipy.stats import norm
from typing import List, Dict, Tuple
from abc import ABC, abstractmethod

from setup.config_dataclass import LinkGeometry, LinkDistribution

from .bus import Bus
from .log import LinkLog
from .snapshot import LinkSnapshot
from agent.agent import Agent

class Link(ABC):
    def __init__(self, link_id: str, link_geometry: LinkGeometry) -> None:
        self._link_id = link_id
        self._head_node = link_geometry.head_node
        self._tail_node = link_geometry.tail_node
        # traveling distance from terminal for the head node
        # self._distance_from_terminal = link_geometry.distance_from_terminal
        self._length = link_geometry.length
        # buses running on this link
        self._buses: List[Bus] = []

        # buses' relative locations (to the head_node) on this link
        self._bus_link_loc: Dict[Tuple[str, str], float] = {}
        self._x_head=link_geometry.x_head
    def __repr__(self) -> str:
        return f"Link {self._link_id} from {self._head_node} to {self._tail_node}"

    @property
    def buses(self) -> List[Bus]:
        return self._buses

    # @property
    # def tail_node(self) -> str:
    #     return self._tail_node

    # accept a bus entering this link
    @abstractmethod
    def enter_bus(self, bus: Bus, t: int) -> None:
        ...

    # move buses one step (delta t) forward
    @abstractmethod
    def forward(self, t: int) -> List[Bus]:
        ...


class DistributionLink(Link):
    def __init__(self, link_id: str, link_geometry: LinkGeometry, link_distribution: LinkDistribution, agent: Agent) -> None:
        super().__init__(link_id, link_geometry)

        self._tt_mean = link_distribution.tt_mean
        self._tt_cv = link_distribution.tt_cv
        self._tt_type = link_distribution.tt_type
        self.link_log = LinkLog(link_id)
        if self._tt_type == "normal":
            mu, sigma = self._tt_mean, self._tt_mean * self._tt_cv
            self._tt_distribution = norm(mu, sigma)
        self.agent=agent #将agent传入

    def enter_bus(self, bus: Bus, t: int) -> None:
        # generate link travel time
        #sampled_tt = self._tt_distribution.rvs(size=1).item()
        sampled_tt=self._tt_mean
        avg_speed = self._length / sampled_tt
        enter_time=self.link_log.route_enter_time_seq[bus.route_id]
        enter_speed=self.link_log.route_enter_speed_seq[bus.route_id]
        enter_id=self.link_log.route_enter_bus_id_seq[bus.route_id]
        last_enter_time = None
        last_bus_id=str(int(bus.bus_id)-1)
        # if last_bus_id in enter_id:
        #     last_enter_time = enter_time[last_bus_id]
        # else:
        #     overtake=True
        in_vehicle_time=bus.total_pax_in_vehicle_time
        wait_time=bus.total_pax_out_vehicle_time
        total_pax_num=bus.total_pax_num
        #self, x_loc,stop_id,current_time, last_enter_time,  bus_id,last_bus_id, route_id,overtake, in_vehicle_time,wait_time,total_pax_num
        bus.speed,bus._last_deviation = self.agent.calculate_speed(self._x_head,self._head_node,t,enter_time,enter_id,bus.bus_id,bus.route_id,bus._last_deviation, enter_speed, self._length) #当车辆进入链路时，计算速度
        bus.bus_log.record_when_enter_link(
            self._link_id, sampled_tt-self._tt_mean,bus.speed) #记录车辆进入链路的时间，速度，tt_deviation没有用到

        self._buses.append(bus)

        # bus relative location (to the head node) on this link
        self._bus_link_loc[(bus.route_id, bus.bus_id)] = 0.0

        bus.update_location(t, 'link', self._link_id,
                            self._head_node, 0, 'running_on_link')
        bus.set_status('running_on_link')
        self.link_log.record_when_bus_enter(bus.route_id, bus.bus_id, bus.speed,t)
    def forward(self, t: int) -> List[Bus]:
        finished_buses = []
        for bus in self._buses:
            self._bus_link_loc[(bus.route_id, bus.bus_id)] += bus.speed * 1.0

            offset = self._bus_link_loc[(bus.route_id, bus.bus_id)]
            bus.update_location(t, 'link', self._link_id,
                                self._head_node, offset, 'running_on_link')
            bus.set_status('running_on_link')

            if self._bus_link_loc[(bus.route_id, bus.bus_id)] >= self._length:
                self._bus_link_loc.pop((bus.route_id, bus.bus_id))
                finished_buses.append(bus)
                self._buses.remove(bus)
        return finished_buses

    def take_snapshot(self) -> LinkSnapshot:
        link_snapshot = LinkSnapshot(self._link_id,self.link_log.route_enter_time_seq,self.link_log.route_enter_bus_id_seq,self.link_log.route_enter_speed_seq)
        return link_snapshot