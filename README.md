# Bus Dispatch Simulation System

> 公交车调度模拟系统

A bus dispatch and operational control simulator for evaluating control strategies with passenger-level metrics. It is based on a slimmed, Beijing Route 57-focused version of EXACT and includes:

- `Do_Nothing` baseline
- `Naive_DDPG` (RL)
- Beijing Route 57 dataset (`bj_route_57`)
- the front-end visualizer under `web/`

# Environment setup

The following steps will guide you through the process of setting up the environment.

**Create a virtual environment**

```bash
 conda create -n my_env python==3.9
 conda activate my_env
```

**Install dependencies**

```bash
 pip install -r requirements.txt
```

# Run simulation

## Configure

Edit `busoperation/config.yaml`:
- `running_agent`: `Do_Nothing` or `Naive_DDPG`

## Run

```bash
python3 busoperation/main.py
```

# Web visualizer

```bash
python3 web/build_data.py
python3 -m http.server 8080 --directory web
```

Then open `http://localhost:8080/`.

# References
[1] Daganzo, C. F., 2009. A headway-based approach to eliminate bus bunching: Systematic analysis and comparisons. Transportation Research Part B: Methodological 43 (10), 913–921.

[2] Xuan, Y., Argote, J., Daganzo, C. F., 2011. Dynamic bus holding strategies for schedule reliability: Optimal linear control and performance analysis. Transportation Research Part B: Methodological 45 (10), 1831–1845.

[3] Alesiani, F., Gkiotsalitis, K., 2018. Reinforcement learning-based bus holding for high-frequency services. In: 2018 21st International Conference on Intelligent Transportation Systems (ITSC). IEEE, pp. 3162–3168.

[4] Wang, J., Sun, L., 2021. Reducing bus bunching with asynchronous multi-agent reinforcement learning. arXiv preprint arXiv:2105.00376.
