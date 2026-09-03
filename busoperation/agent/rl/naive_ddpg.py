from copy import deepcopy
from collections import deque, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Tuple, Optional, List
import random
import numpy as np
import torch

from simulator.snapshot import Snapshot
from setup.blueprint import Blueprint
from simulator.virtual_bus import VirtualBus
from simulator.simulator import Simulator

from .rl_agent import RLAgent
from .net import Actor_Net, Critic_Net

DEFAULT_ACTOR_NET_PATH = Path(__file__).resolve().parents[2] / 'outputs' / 'weights' / 'actor_net.pth'


@dataclass(frozen=True)
class SAR:
    state: List[float]
    action: float
    reward: Optional[float]


@dataclass(frozen=True)
class SARS:
    state: List[float]
    action: float
    reward: Optional[float]
    next_state: List[float]


class Naive_DDPG(RLAgent):
    def __init__(self, agent_config: Dict[str, Any], blueprint: Blueprint) -> None:
        super().__init__(agent_config, blueprint)

        self._blueprint = blueprint
        self._actor_net = Actor_Net(
            state_size=agent_config['state_size'], hidde_size=tuple(agent_config['hidden_size']))
        self._max_hold_time = agent_config['max_hold_time']
        self._max_speed = agent_config['max_speed']
        # self._H = 300 if agent_config['env_name'] == 'homogeneous_one_route' else 170
        self._H = agent_config['schedule_headway']
        self._w = agent_config['w']
        self._state_size = agent_config['state_size']
        if not agent_config['is_train']:
            # evaluation mode
            model_path = agent_config.get('actor_net_path', str(DEFAULT_ACTOR_NET_PATH))
            self.load_net(path=model_path)
        else:
            # training mode
            self._critic_net = Critic_Net(
                state_size=agent_config['state_size'], hidde_size=tuple(agent_config['hidden_size']))
            self._target_actor_net = deepcopy(self._actor_net)
            self._target_critic_net = deepcopy(self._critic_net)
            # Freeze target networks with respect to optimizers (only update via polyak averaging)
            for param in self._target_actor_net.parameters():
                param.requires_grad = False
            for param in self._target_critic_net.parameters():
                param.requires_grad = False
            self._actor_optim = torch.optim.Adam(
                self._actor_net.parameters(), lr=agent_config['actor_lr'])
            self._critic_optim = torch.optim.Adam(
                self._critic_net.parameters(), lr=agent_config['critic_lr'])

            self._gamma = agent_config['gamma']
            self._polya = agent_config['polya']
            self._memory = deque(maxlen=agent_config['memory_size'])

            # {{route_id, bus_id}: [(stop_id, SAR)]}
            self._bus_stop_sar: Dict[Tuple[str, str],
            List[Tuple[str, SAR]]] = defaultdict(list)
            self._add_event_count = 0
            self._update_cycle = agent_config['update_cycle']
            self._batch_size = agent_config['batch_size']
            self._init_noise_level = agent_config['init_noise_level']
            self._decay_rate = agent_config['decay_rate']
            self._noise_level = self._init_noise_level

    def reset(self, episode: int):
        if self._is_train:
            self._noise_level = self._decay_rate ** episode * self._init_noise_level
            print('noise level:', self._noise_level)

    # def _transform_snapshot_to_SR(self, snapshot: Snapshot, acting_bus: Tuple[str, str], stop_id: str) -> Tuple[List[float], float]:
    #     ''' Transform the snapshot to state, reward.
    #
    #     Args:
    #         snapshot: the snapshot of the current time step
    #         acting_bus: the bus that is acting: (route_id, bus_id)
    #
    #     '''
    #
    #     stop_snapshots = snapshot.stop_snapshots
    #     # all the buses' arrival time at this stop
    #     current_stop_arrival_info = stop_snapshots[stop_id].route_arrival_time_seq[acting_bus[0]]
    #     # current_stop_departure_info = holder_snapshots.route_stop_departure_time_seq[acting_bus[0]][stop_id]
    #     # the pervious bus's arrival time at this stop
    #     pervious_bus_arrival_time = current_stop_arrival_info[-2]
    #     # the current bus's arrival time at this stop
    #     current_bus_arrival_time = current_stop_arrival_info[-1]
    #     headway = current_bus_arrival_time - pervious_bus_arrival_time
    #     normalized_headway = headway / self._H
    #
    #     reward = -abs((self._H - headway) / self._H)
    #     return [normalized_headway], reward

    def _push_transitions_to_memory(self):
        for (route_id, bus_id), sar_list in self._bus_stop_sar.items():
            if len(sar_list) > 1:
                for (stop_id, sar), (next_stop_id, next_sar) in zip(sar_list[0:-1], sar_list[1:]):
                    # node_type, found_prev_stop_id = self._blueprint.get_previous_node(
                    #     route_id, next_stop_id)
                    # assert node_type != 'terminal', 'The previous node cannot be a terminal'
                    #
                    # if found_prev_stop_id == stop_id:
                    visit_seq_stops = self._blueprint.route_schema.route_details_by_id[route_id].visit_seq_stops
                    #and (stop_id in visit_seq_stops) and (next_stop_id in visit_seq_stops)
                    if (int(next_stop_id) - int(stop_id) == 1) :
                        state = sar.state
                        action = sar.action
                        reward = next_sar.reward
                        next_state = next_sar.state

                        if any(var is None for var in [state, action, reward, next_state]):
                            continue
                        else:
                            reward -= self._w * action

                        sars = SARS(state, action, reward, next_state)
                        self._memory.append(sars)
                #print(next_stop_id,stop_id)
        self._bus_stop_sar.clear()

    def calculate_hold_time(self, snapshot: Snapshot):
        stop_bus_hold_time = {}
        for (stop_id, route_id, bus_id) in snapshot.holder_snapshot.action_buses:
            stop_bus_hold_time[(stop_id, route_id, bus_id)] = 0
            # if not snapshot.bus_snapshots[(route_id, bus_id)].is_need_to_hold:
            #     stop_bus_hold_time[(stop_id, route_id, bus_id)] = 0
            #     continue
            #
            # _, forward_spacing, _, backward_spacing = self.extract_local_info_from_snapshot(
            #     bus_id, snapshot, ['spacing'])
            #
            # state, reward = self._transform_snapshot_to_SR(
            #     snapshot, (route_id, bus_id), stop_id)
            # action = 0.0
            # if forward_spacing == float('inf') or backward_spacing == float('inf'):
            #     action, hold_time = 0.0, 0.0
            #     reward = None
            # else:
            #     action, hold_time = self.infer(state)
            #
            # stop_bus_hold_time[(stop_id, route_id, bus_id)] = hold_time
            #
            # if self.is_train:
            #     sar = SAR(state, action, reward)
            #     self._bus_stop_sar[(route_id, bus_id)].append((stop_id, sar))
            #     self._add_event_count += 1
            #     if self._add_event_count % self._batch_size == 0:
            #         self._push_transitions_to_memory()
            #     self.learn()
            snapshot.record_holding_time(stop_bus_hold_time)

        return stop_bus_hold_time

    def custom_huber_penalty(self,x, delta=0.2):
        if abs(x) <= delta:
            return -0.5 * x ** 2
        else:
            return -delta * (abs(x) - 0.5 * delta)

    def calculate_speed(self, x_loc, stop_id, current_time, enter_time, enter_id, bus_id, route_id, last_deviation, enter_speed, length):

        route_stop_rtd_time = {
            '4': {
                '0': 0, '1': 90, '2': 292, '3': 466, '4': 547, '5': 673, '6': 835,
                '7': 991, '8': 1173, '9': 1554, '10': 1719, '11': 1861,
                '12': 2074, '13': 2243, '14': 2385, '15': 2563, '16': 2694,
                '17': 2780, '18': 2947, '19': 3027, '20': 3075, '21': 3180,
                '22': 3245, '23': 3387, '24': 3546, '25': 3623, '26': 3692,
                '27': 3836, '28': 3944, '29': 4267, '30': 4356, '31': 4511,
                '32': 4668, '33': 4781, '34': 5106
            }
        }

        # route_virtual_bus_speed = {
        #     '4': {
        #         '0': 5.6, '1': 6.225, '2': 4.442455243, '3': 6.716302953, '4': 7.540616246, '5': 3.240388507,
        #         '6': 5.958173077, '7': 6.710344828, '8': 2.088441086, '9': 3.951794322, '10': 7.358139535,
        #         '11': 8.418818536, '12': 4.437608319, '13': 4.392644135, '14': 6.275849197, '15': 4.154550076,
        #         '16': 8.094977169, '17': 5.071231799, '18': 5.330024814, '19': 9.309707242, '20': 2.758965315,
        #         '21': 6.587677725, '22': 4.445814073, '23': 4.880866426, '24': 5.586592179, '25': 6.915254237,
        #         '26': 6.878123406, '27': 5.836374696, '28': 2.773746702, '29': 2.367688022, '30': 5.983282006,
        #         '31': 3.485639687, '32': 5.733333333, '33': 12.03531599, '34': 5.6
        #     }
        # }
        route_virtual_bus_speed = {
            '4': {
                '0': 5.6, '1': 6.2, '2': 4.4, '3': 6.7, '4': 7.5, '5': 3.2,
                '6': 6.0, '7': 6.7, '8': 2.1, '9': 4.0, '10': 7.4,
                '11': 8.4, '12': 4.4, '13': 4.4, '14': 6.3, '15': 4.2,
                '16': 8.1, '17': 5.1, '18': 5.3, '19': 9.3, '20': 2.8,
                '21': 6.6, '22': 4.4, '23': 4.9, '24': 5.6, '25': 6.9,
                '26': 6.9, '27': 5.8, '28': 2.8, '29': 2.4, '30': 6.0,
                '31': 3.5, '32': 5.7, '33': 12.0, '34': 5.6
            }
        }
        H = self._blueprint.route_schema.route_details_by_id[route_id].schedule_headway

        overtake = 0

        virtual_arrival_time = [90, 170, 423, 515, 636, 818, 958, 1136, 1448, 1687, 1826, 2027, 2201, 2356, 2542, 2673, 2763,
                        2929, 3014, 3061, 3164, 3222, 3366, 3526, 3599, 3675, 3815, 3923, 4247, 4331, 4498, 4638, 4758, 5088, 5196]

        if bus_id == '1':
            rtd_time = route_stop_rtd_time[route_id][stop_id]
            last_speed=route_virtual_bus_speed[route_id][stop_id]
            h = current_time - rtd_time
            deviation = h - H
            # if current_time > rtd_time:
            #     r2 = 0
            # else:
            #     overtake = 1
            #
            #     r2 = -abs(deviation / H)
            # print(bus_id, stop_id, current_time, rtd_time,last_speed)

        else:
            last_bus_id = str(int(bus_id) - 1)

            if last_bus_id not in enter_id:
                overtake = 1
                est_h = -(x_loc - self.bus_id_loc[last_bus_id]) / self.bus_id_speed[last_bus_id]
                deviation = est_h - H
                last_speed = self.bus_id_speed[last_bus_id]
                r2 = -abs(deviation / H)
            else:
                h = current_time - enter_time[last_bus_id]
                deviation = h - H
                last_speed = enter_speed[last_bus_id]
                r2 =0
        # r1=np.exp(-abs(deviation / H))*100
        r1 = -abs(deviation / H)
        # print(r1)

        r3=torch.sigmoid(torch.tensor(last_deviation - deviation))*100
        state = [deviation/H,last_speed, int(stop_id)]  # last_deviation
        # r2= np.exp(-in_vehicle_time / total_pax_num if total_pax_num != 0 else 0)
        # r3= np.exp(-wait_time / total_pax_num if total_pax_num != 0 else 0)
        action, speed = self.infer(state)
        # if speed < route_virtual_bus_speed[route_id][stop_id]:
        #     speed = route_virtual_bus_speed[route_id][stop_id]

        # print(stop_id,bus_id,'speed:',speed)

        current_travel_time = length / speed

        # print(stop_id,virtual_arrival_time[int(stop_id)])
        r5 =0
        if bus_id != '1':
            loc_deviation = x_loc + length - self.bus_id_loc[last_bus_id]
            last_travel_time = loc_deviation / last_speed
            if current_travel_time < last_travel_time:
                r5 = -0.4
        else:
            if (current_time+current_travel_time) < virtual_arrival_time[int(stop_id)]:
                r5 = -0.4


        r4=np.exp(-abs(last_speed - speed))*100

        reward = r1+r5
        #print(f"bus_id:{bus_id},stop_id:{stop_id},r1:{r1},r3:{r3},r4:{r4}")
        if self.is_train:
            sar = SAR(state, action, reward)
            self._bus_stop_sar[(route_id, bus_id)].append((stop_id, sar))
            self._add_event_count += 1
            if self._add_event_count % self._batch_size == 0:
                self._push_transitions_to_memory()
            self.learn()

        # print(self.bus_id_loc,bus_id)
        # print(self.bus_id_loc)
        return speed,deviation

    def infer(self, state: List[float]) -> Tuple[float, float]:
        state_ = torch.tensor(state, dtype=torch.float32).reshape(-1, self._state_size)
        with torch.no_grad():
            action = self._actor_net(state_)
            # when training, add noise
            if self._is_train:
                noise = np.random.normal(0, self._noise_level)
                action = (action).clip(0.3, 1)
            action = float(action)
        speed = action * self._max_speed
        return action, speed

    def learn(self):
        if self._add_event_count % self._update_cycle != 0 or len(self._memory) < self._batch_size:
            return

        self._actor_net.train()
        samples = random.sample(self._memory, self._batch_size)
        stats = []
        actis = []
        rewas = []
        next_stats = []
        for sample in samples:
            stats.append(sample.state)
            actis.append(sample.action)
            rewas.append(sample.reward)
            next_stats.append(sample.next_state)

        s = torch.tensor(stats, dtype=torch.float32).reshape(-1, self._state_size)
        # LongTensor for idx selection
        a = torch.tensor(actis, dtype=torch.float32)
        r = torch.tensor(rewas, dtype=torch.float32)
        n_s = torch.tensor(next_stats, dtype=torch.float32).reshape(-1, self._state_size)

        # update critic network
        # self.__criti_net.zero_grad()
        self._critic_optim.zero_grad()
        # current estimate
        s_a = torch.concat((s, a.unsqueeze(dim=1)), dim=1)
        for param in self._critic_net.parameters():
            param.requires_grad = True
        Q = self._critic_net(s_a)

        # Bellman backup for Q function
        targe_imagi_a = self._target_actor_net(n_s)  # (batch_size, 1)
        s_targe_imagi_a = torch.concat((n_s, targe_imagi_a), dim=1)
        with torch.no_grad():
            q_polic_targe = self._target_critic_net(s_targe_imagi_a)
            # r is (batch_size, ), need to align with output from NN
            back_up = r.unsqueeze(1) + self._gamma * q_polic_targe
        # MSE loss against Bellman backup
        # Unfreeze Q-network so as to optimize it
        td = Q - back_up
        criti_loss = (td ** 2).mean()
        # update critic parameters
        criti_loss.backward()
        self._critic_optim.step()

        # update actor network
        self._actor_optim.zero_grad()
        imagi_a = self._actor_net(s)
        s_imagi_a = torch.concat((s, imagi_a), dim=1)
        # Freeze Q-network to save computational efforts
        for param in self._critic_net.parameters():
            param.requires_grad = False
        Q = self._critic_net(s_imagi_a)
        actor_loss = -Q.mean()
        actor_loss.backward()
        self._actor_optim.step()

        # Finally, update target networks by polyak averaging.
        with torch.no_grad():
            for p, p_targ in zip(self._actor_net.parameters(), self._target_actor_net.parameters()):
                p_targ.data.mul_(self._polya)
                p_targ.data.add_((1 - self._polya) * p.data)
            for p, p_targ in zip(self._critic_net.parameters(), self._target_critic_net.parameters()):
                p_targ.data.mul_(self._polya)
                p_targ.data.add_((1 - self._polya) * p.data)

    def save_net(self, path: str) -> None:
        torch.save(self._actor_net.state_dict(), path)

    def load_net(self, path):
        self._actor_net.load_state_dict(torch.load(path))
