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

    def calculate_speed(self,length,current_time,last_enter_time,last_enter_speed,bus_id,route_id,avg_speed):
        if bus_id == '1':
            speed = avg_speed
        else:
            H = self._blueprint.route_schema.route_details_by_id[route_id].schedule_headway
            h = current_time - last_enter_time
            delay = H - h
            try:
                speed_ = length / (length / last_enter_speed + delay)
            except ZeroDivisionError:
                speed_ = avg_speed
            if speed_ < 0:
                speed_=avg_speed
            elif speed_ > 16:
                speed_ = avg_speed
            speed = speed_
        return speed

    def reset(self, episode: int):
        pass
