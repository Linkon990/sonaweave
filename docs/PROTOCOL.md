# SWP-1 Protocol Notes

SWP-1 是 SonaWeave 的演示帧格式。所有多字节整数均使用网络字节序（big-endian）。

## 发送链路

1. 使用 `TextEncoder` 把文本转换为 UTF-8 字节。
2. 生成固定 12-bit 码字的 LZW 候选载荷；仅当候选严格小于原始字节时才采用。
3. 写入 SWP-1 头部和 CRC16-CCITT。
4. 每个帧字节拆成两个 4-bit 半字节，分别编码为 Hamming(8,4) SECDED 码字。
5. 使用 FSK 的 0/1 比特或 DTMF 的 0..F 符号生成 48 kHz PCM 音频。

## 帧布局

| Offset | Length | Field | Description |
|---:|---:|---|---|
| 0 | 2 | Magic | ASCII `SW`，即 `0x53 0x57` |
| 2 | 1 | Version | 当前为 `0x01` |
| 3 | 1 | Flags | bit 0 表示载荷使用 LZW12 |
| 4 | 2 | Message ID | 发送端生成的 16-bit 消息号 |
| 6 | 2 | Original length | 解压后的 UTF-8 字节数 |
| 8 | 2 | Payload length | 帧内载荷字节数 |
| 10 | N | Payload | 原始 UTF-8 或 LZW12 数据 |
| 10+N | 2 | CRC16 | 对头部和载荷计算 CRC16-CCITT |

## LZW12

- 初始字典包含全部 0..255 单字节值。
- 动态字典码从 256 开始，最大码值为 4095。
- 码字固定占 12 bit，以 MSB-first 连续打包。
- 压缩载荷前两个字节保存码字数量，用于排除末尾补齐位。
- 字典满后停止新增条目，不做隐式重置，因此编解码结果确定。

## Hamming(8,4) SECDED

数据位放在位置 3、5、6、7，Hamming 校验位放在 1、2、4，位置 8 保存整体彩 parity。接收端根据三位 syndrome 和整体奇偶性区分：

- syndrome = 0、overall = 0：无错误。
- syndrome != 0、overall = 1：1..7 中存在单比特错误，可定位并纠正。
- syndrome = 0、overall = 1：整体校验位错误，可纠正。
- syndrome != 0、overall = 0：至少双比特错误，只检测不误纠正。

每 4 bit 变为 8 bit，因此纠错编码会让帧长度翻倍。CRC16 在纠错之后再次判断整帧是否可信。

## FSK 参数

| Parameter | Value |
|---|---:|
| Sample rate | 48,000 Hz |
| Baud rate | 600 symbols/s |
| Samples/symbol | 80 |
| Bit 0 | 1,800 Hz |
| Bit 1 | 3,000 Hz |
| Preamble | 32 个交替 0/1 |
| Sync word | `0xD391` |

接收端先按 8 ms 窗口扫描整段录音，用低分位噪声底与峰值估算载波起点；再在起点附近滑动训练序列，比较两个目标频率的正交相关能量，选出得分最高的码元边界，最后按固定窗口判决后续比特。这允许用户先开始录音、稍后再播放发送音频。

## DTMF 参数

使用四个低频行 `[697, 770, 852, 941]` 和四个高频列 `[1209, 1336, 1477, 1633]` 组成 16 个符号。每个符号直接表示一个半字节。

| Parameter | Value |
|---|---:|
| Tone | 36 ms |
| Gap | 6 ms |
| Training symbols | `A 5 A 5 D E A D` |

接收端分别计算四个行频率和四个列频率的能量，选择能量最大的行列交点作为符号。它和 Goertzel 检测使用同一个原则：只测少数已知频率，而不是计算完整 FFT。

## 信道模型

实验台按固定随机种子生成结果，便于复现：

- AWGN：由信号 RMS 和目标 SNR 推导噪声 RMS。
- 突发衰落：以 12 ms 为块随机衰减最多 94%。
- 回声：叠加延迟 7 ms 的原信号副本。

这个模型用于相对比较，不等价于真实房间脉冲响应或标准无线衰落模型。
