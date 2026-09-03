import random
from pathlib import Path
from typing import Tuple, Dict

import numpy as np
import torch
import yaml

from agent.agent import Agent
from agent.do_nothing import DoNothing
from agent.rl.naive_ddpg import Naive_DDPG
from setup.blueprint import Blueprint


def build_simulation_elements() -> Tuple[Blueprint, Agent, Dict, Dict]:
    ''' Build simulation elements as per config.yaml file

    Returns:
        blueprint: a Blueprint object that provide network and route schema as a whole
        agent: a specific Agent object
        run_config: specify episode number, episode duration, hold start time and hold end time
        record_config: configuration for recording in wandb, return an empty dict if not recording

    '''
    config_path = Path(__file__).resolve().parent / 'config.yaml'
    with open(config_path, 'r', encoding='utf-8') as file:
        config = yaml.safe_load(file)
        sanity_check(config)

    record_config = {}
    if config['wandb_config']['is_record_wandb']:
        running_agent_name = config['running_agent']
        record_config.update(config['agent_config'][running_agent_name])
        record_config['env_name'] = config['env_name']
        record_config['seed'] = config['seed']
        record_config['episode_num'] = config['episode_num']
        record_config['wandb_config'] = config['wandb_config']
        record_config['env_name'] = config['env_name']
        # record_config['lambda'] = 4
        # record_config['sigma'] = 5
        record_config['is_train'] = config['is_train']
    else:
        record_config = {}

    # set seed
    if 'seed' in config:
        seed = config['seed']
        np.random.seed(seed)
        random.seed(seed)
        torch.random.manual_seed(seed)

    # set running config
    run_config = {}
    run_config['episode_num'] = config['episode_num']
    run_config['episode_duration'] = config['episode_duration']
    run_config['hold_start_time'] = config['hold_start_time']
    run_config['hold_end_time'] = config['hold_end_time']
    run_config['has_schedule'] = config['has_schedule']
    run_config['metric_names'] = config['metric_names']

    # build blueprint for the environment
    env_name = config['env_name']
    blueprint = Blueprint(env_name)

    # create agent
    running_agent = config['running_agent']
    agent_config = config['agent_config'][running_agent]
    if agent_config['agent_name'] == 'Do_Nothing':
        agent = DoNothing(agent_config, blueprint)
    elif agent_config['agent_name'] == 'Naive_DDPG':
        agent = Naive_DDPG(agent_config, blueprint)
    else:
        raise ValueError(f"Unsupported agent_name: {agent_config['agent_name']}")

    return blueprint, agent, run_config, record_config


def sanity_check(config: Dict):
    ''' Check if neccessary parameters are specified in the `config.yaml' file 

    '''
    assert 'episode_num' in config, 'episode_num must be specified in the config.yaml file'
    assert 'hold_start_time' in config, 'hold_start_time must be specified in the config.yaml file'
    assert 'hold_end_time' in config, 'hold_end_time must be specified in the config.yaml file'
    assert 'episode_duration' in config, 'episode_duration must be specified in the config.yaml file'
    assert 'env_name' in config, 'env_name must be specified in the config.yaml file'

    # slimmed version only keeps the Beijing Route 57 env
    assert config['env_name'] == 'bj_route_57', 'Only env_name=bj_route_57 is supported in this version'

    assert 'agent_config' in config, 'agent_config must be specified in the config.yaml file'
    assert 'running_agent' in config, 'running_agent must be specified in the config.yaml file'

    running_agent = config['running_agent']
    assert running_agent in config['agent_config'], 'running_agent must exist in agent_config'
    agent_config = config['agent_config'][running_agent]
    assert agent_config.get('agent_name') in {'Do_Nothing', 'Naive_DDPG'}, 'Only Do_Nothing and Naive_DDPG are supported'

    # check conflicts between metric_names and has_schedule
    if config['has_schedule'] is False:
        assert 'schedule_deviation' not in config[
            'metric_names'], 'schedule_deviation cannot be calculated if has_schedule is False in the `config.yaml`'

    # check the headway_std is always in the metric_names
    assert 'headway_std' in config['metric_names'], 'headway_std must be specified in the metric_names in the `config.yaml`'
