from __future__ import annotations

import argparse
import os
import sys
import webbrowser
from pathlib import Path
from threading import Timer

import uvicorn

from kiln.app import DATA_DIR, create_app


def _headless() -> bool:
    if sys.platform == "win32" or sys.platform == "darwin":
        return False
    return not (os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="kiln",
        description="Kiln — 用浏览器配置并启动 Python 训练/推理脚本",
    )
    parser.add_argument("--host", default="127.0.0.1", help="绑定地址，服务器上可改成 0.0.0.0")
    parser.add_argument("--port", type=int, default=8787, help="端口")
    parser.add_argument("--data-dir", default=None, help="数据目录，默认 ~/.kiln")
    parser.add_argument("--no-open", action="store_true", help="不要自动打开浏览器")
    args = parser.parse_args()

    data_dir = Path(args.data_dir).expanduser().resolve() if args.data_dir else DATA_DIR
    app = create_app(data_dir)
    url = f"http://{args.host}:{args.port}"
    should_open = (not args.no_open) and (not _headless())
    if should_open:
        def _open() -> None:
            try:
                webbrowser.open(url)
            except Exception as exc:
                print(f"无法打开浏览器: {exc}")

        Timer(0.8, _open).start()

    print(f"Kiln  → {url}")
    print(f"数据  → {data_dir}")
    if args.host in {"0.0.0.0", "::"}:
        print("本机或 SSH 转发访问: http://127.0.0.1:%s" % args.port)
    if _headless() and not args.no_open:
        print("当前无图形界面，未打开浏览器。可用 ssh -L %s:127.0.0.1:%s 转发。" % (args.port, args.port))
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
