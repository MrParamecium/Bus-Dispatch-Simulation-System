# segment_lengths = [90, 292, 466, 547, 673, 835, 991, 1173, 1554, 1719, 1861, 2074, 2243,
#                    2385, 2563, 2694, 2780, 2947, 3027, 3075, 3180, 3245, 3387, 3546, 3623, 3692, 3836,
#                    3944, 4267, 4356, 4511, 4668, 4781, 5106,5217]
# dwell_times = [0,122, 43, 32, 37, 17, 33, 37, 106, 32, 35, 47, 42, 29, 21, 21, 17,
#                18, 13, 14, 16, 23, 21, 20, 24, 17, 21, 21, 20, 25, 13, 30, 23, 18,21]
# differences = [seg - dwell for seg, dwell in zip(segment_lengths, dwell_times)]
#
# print("差值列表:", differences)


def calculate_position(time, segment_lengths, segment_speeds, dwell_times):
    total_time = 0
    current_position = 0

    # 确保三个列表长度一致（路段数 = 速度数 = 停留时间数）
    assert len(segment_lengths) == len(segment_speeds) == len(dwell_times), "参数列表长度不匹配"

    for i in range(len(segment_lengths)):
        length = segment_lengths[i]
        speed = segment_speeds[i]
        dwell_time = dwell_times[i]  # 当前段的停留时间

        # 计算通过本段路的行驶时间（不含停留）
        drive_time = length / speed
        # 本段路的总耗时 = 行驶时间 + 停留时间
        total_segment_time = drive_time + dwell_time

        if total_time + drive_time > time:
            # 时间在本段行驶过程中，未到达停留阶段
            time_in_segment = time - total_time
            current_position += time_in_segment * speed
            break
        else:
            # 先完成本段行驶
            total_time += drive_time
            current_position += length

            # 检查是否有足够时间停留
            if total_time + dwell_time > time:
                # 时间在本段停留过程中，位置不变
                break
            else:
                # 完成停留，进入下一段
                total_time += dwell_time

    # 如果所有路段都走完，返回最终位置（超出时间范围时也返回最后位置）
    return current_position

stop_times = [0, 122, 43, 32, 37, 17, 33, 37, 106, 32, 35, 47, 42, 29, 21, 21, 17,
              18, 13, 14, 16, 23, 21, 20, 24, 17, 21, 21, 20, 25, 13, 30, 23, 18, 21]
segment_lengths = [
    500, 498, 579, 327, 673, 471, 729, 973, 574, 527, 791, 1400, 569, 491, 989,
    454, 554, 758, 358, 318, 247, 278, 541, 676, 300, 357, 843, 505, 841,
    150, 850, 445, 516, 3700, 500
]
segment_speeds = [5.6, 6.225, 4.442455243, 6.716302953, 7.540616246, 3.240388507, 5.958173077, 6.710344828,
                  2.088441086, 3.951794322, 7.358139535, 8.418818536, 4.437608319, 4.392644135, 6.275849197,
                  4.154550076, 8.094977169, 5.071231799, 5.330024814, 9.309707242, 2.758965315, 6.587677725,
                  4.445814073, 4.880866426, 5.586592179, 6.915254237, 6.878123406, 5.836374696, 2.7737]