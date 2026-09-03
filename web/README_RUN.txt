本地启动步骤：
1) 在 web/index.html 中，将 AMap JS API 的 key 替换为你的真实 Key：
   <script src="https://webapi.amap.com/maps?v=2.0&key=你的Key"></script>
   获取方式：高德开放平台控制台创建 Web JS 应用。

2) 运行仿真生成日志（busoperation/outputs/log）：
   python3 busoperation/main.py

3) 生成可视化数据（默认自动选择最新 episode，也可手动指定）：
   python3 web/build_data.py
   python3 web/build_data.py --episode 0
   输出位于 web/data/ 目录。

4) 启动本地静态服务器（端口 8080）：
   python3 -m http.server 8080 --directory web
   然后打开浏览器访问： http://localhost:8080/

页面说明：
- 左侧高德地图显示路线与站点，蓝/粉线为线路。
- 车辆运行按 timeline.json 的日志时间线驱动；停站时状态为“停靠/holding”。
- 右侧显示统计指标与部分车辆状态列表。
- 播放控制：播放/暂停与速度调节（0.25x~5x）。

如需调整线路经纬度（更贴近真实 57 路）：
- 编辑 web/app.js 中 DEFAULT_ROUTE 数组，填入更密集的经纬度点。
- 若后端有真实站点坐标数据，可扩展 stations.json 增加 lng/lat 字段并修改绘制逻辑优先使用真实坐标。
