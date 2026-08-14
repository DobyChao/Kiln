# Kiln

本地 Web 控制台，用来发现、填写、消融并启动你的 Python / PyTorch 训练和推理脚本。

把仓库根目录加进工作区，在浏览器里填参数、预览命令、点运行。消融可以把同一个参数填成多个值，自动排成一组任务。

## 启动

需要 Python 3.9+（Windows / Linux 均可）。在本仓库根目录：

```bash
pip install -e .
python -m kiln
```

浏览器打开 `http://127.0.0.1:8787`。数据写在 `~/.kiln/`。

```bash
python -m kiln --port 8787
python -m kiln --host 0.0.0.0          # 训练机上给局域网或 SSH 转发用
python -m kiln --no-open               # 无桌面的 Linux 服务器建议加上
```

在 GPU 服务器上（无图形界面会自动不弹浏览器）：

```bash
python -m kiln --host 0.0.0.0 --port 8787 --no-open
```

本机转发：

```bash
ssh -L 8787:127.0.0.1:8787 user@gpu-box
```

然后访问本机 `http://127.0.0.1:8787`。

## 怎么用

1. **工作区**：添加训练项目根目录（或先「加载示例」）。
2. **脚本列表**：第一次进入只自动收可启动脚本（有 `main` / CLI）。漏掉的可「扫描全部」或手动添加；不需要的可勾选后批量移除（不删磁盘文件）。
3. **运行**：填参数，同一参数点 `+` 做消融；看右侧命令预览后点运行。
4. **任务**：看排队/运行状态、日志和 tqdm 进度，可停止。

## 前端

界面是 React + Vite + Tailwind，源码在 `web/`，构建产物写入 `kiln/static/`，`python -m kiln` 直接提供。改 UI 时：

```bash
cd web
npm install
npm run dev          # http://127.0.0.1:5173 ，/api 代理到 8787
```

另开一个终端跑 `python -m kiln`。改完后构建进 Python 包：

```bash
cd web
npm run build
```

## 能做什么

- 多个工作区；脚本可扫描、手动添加、移除、恢复
- 静态解析 argparse / Hydra / Fire / Click（不会 import 训练脚本）
- 命令预览、预设、环境变量、解释器、工作目录
- 多卡：每卡一进程轮转，或一个进程看见多张卡（DDP）；默认同卡不叠
- 并发队列（1–64 路）
- 实时日志（含 `\r` 进度条）

## 注意

Kiln 在本机或训练机上起普通子进程，不是 Slurm。适合单机多卡、反复改参开跑。
