"""Fake inference script."""

from __future__ import annotations

import argparse
import time


def main() -> None:
    parser = argparse.ArgumentParser(description="示例：推理（模拟）")
    parser.add_argument("--checkpoint", type=str, required=True, help="权重路径")
    parser.add_argument("--image", type=str, default="", help="单张图片")
    parser.add_argument("--input-dir", type=str, default="", help="图片目录")
    parser.add_argument("--size", type=int, default=224)
    parser.add_argument("--tta", action="store_true", help="test-time augmentation")
    parser.add_argument("--device", type=str, default="cpu", choices=["cuda", "cpu"])
    parser.add_argument("--save", type=str, default="preds.json")
    args = parser.parse_args()

    print("=== Kiln demo infer ===", flush=True)
    print(args, flush=True)
    n = 8 if args.input_dir else 1
    for i in range(n):
        print(f"[{i+1}/{n}] pred=cat  conf={0.91 - i * 0.03:.3f}", flush=True)
        time.sleep(0.4)
    print(f"wrote {args.save}", flush=True)


if __name__ == "__main__":
    main()
