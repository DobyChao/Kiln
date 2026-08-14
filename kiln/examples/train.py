"""Fake training script so Kiln can be tried without PyTorch."""

from __future__ import annotations

import argparse
import random
import time


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="示例：图像分类训练（模拟）")
    parser.add_argument("--data-dir", type=str, default="./data", help="数据集路径")
    parser.add_argument("--arch", type=str, default="resnet50", choices=["resnet50", "vit_b_16", "swin_t"])
    parser.add_argument("--epochs", type=int, default=5, help="训练轮数")
    parser.add_argument("--batch-size", "--bs", type=int, default=32)
    parser.add_argument("--lr", type=float, default=1e-4, help="学习率")
    parser.add_argument("--wd", type=float, default=0.05, help="weight decay")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--amp", action="store_true", help="混合精度")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--output", type=str, default="./runs/exp")
    parser.add_argument("--resume", type=str, default="", help="checkpoint 路径")
    parser.add_argument("--note", type=str, default="", help="实验备注")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    rng = random.Random(args.seed)
    print("=== Kiln demo trainer ===", flush=True)
    print(args, flush=True)
    loss = 2.4
    for epoch in range(1, args.epochs + 1):
        steps = 24
        for step in range(1, steps + 1):
            filled = int(20 * step / steps)
            bar = "█" * filled + "░" * (20 - filled)
            print(
                f"\repoch {epoch:03d}/{args.epochs}  {bar}  {step}/{steps}  lr={args.lr}",
                end="",
                flush=True,
            )
            time.sleep(0.08)
        loss *= 0.72 + rng.random() * 0.08
        acc = min(0.99, 0.35 + epoch * 0.11 + rng.random() * 0.03)
        print(
            f"\repoch {epoch:03d}/{args.epochs}  loss={loss:.4f}  acc={acc:.4f}  "
            f"arch={args.arch} lr={args.lr} amp={args.amp}",
            flush=True,
        )
    print(f"saved to {args.output}/last.ckpt", flush=True)


if __name__ == "__main__":
    main()
