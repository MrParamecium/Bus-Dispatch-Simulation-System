from typing import Dict, Any

from setup.blueprint import Blueprint

from .agent import Agent

class DoNothing(Agent):
    def __init__(self, agent_config: Dict[str, Any], blueprint: Blueprint) -> None:
        super().__init__(agent_config)
        self._blueprint = blueprint

    def calculate_hold_time(self, snapshot):
        stop_bus_hold_time = {}
        for (stop_id, route_id, bus_id) in snapshot.holder_snapshot.action_buses:
            stop_bus_hold_time[(stop_id, route_id, bus_id)] = 0

        return stop_bus_hold_time

    def calculate_speed(self, x_loc, stop_id, current_time, enter_time, enter_id, bus_id, route_id, last_deviation, enter_speed, length):
        # fall back values if no predecessor info
        avg_speed = enter_speed.get(bus_id, max(1e-6, length / max(1.0,  self._blueprint.route_schema.route_details_by_id[route_id].schedule_headway)))
        if bus_id == '1':
            return avg_speed, 0.0
        H = self._blueprint.route_schema.route_details_by_id[route_id].schedule_headway
        last_bus_id = str(int(bus_id) - 1)
        if last_bus_id not in enter_id:
            return avg_speed, 0.0
        h = current_time - enter_time[last_bus_id]
        last_enter_speed = enter_speed[last_bus_id]
        delay = H - h
        try:
            speed_ = length / (length / max(1e-6, last_enter_speed) + delay)
        except ZeroDivisionError:
            speed_ = avg_speed
        if speed_ < 0 or speed_ > 16:
            speed_ = avg_speed
        return speed_, delay

    def reset(self, episode: int):
        pass
