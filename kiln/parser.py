from __future__ import annotations

import ast
import os
from pathlib import Path
from typing import Any


def parse_script(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8", errors="replace")
    try:
        tree = ast.parse(text)
    except SyntaxError as exc:
        return {
            "kind": "raw",
            "error": f"语法错误: {exc.msg} (line {exc.lineno})",
            "description": None,
            "args": [],
            "configs": [],
        }

    hydra = _hydra(tree, path)
    click_args = _click(tree)
    fire_args, fire_fn = _fire(tree)
    argparse_args, description = _argparse(tree)

    if argparse_args:
        return {
            "kind": "argparse",
            "description": description,
            "args": argparse_args,
            "configs": [],
        }
    if hydra:
        return hydra
    if click_args:
        return {
            "kind": "click",
            "description": None,
            "args": click_args,
            "configs": [],
        }
    if fire_args:
        return {
            "kind": "fire",
            "description": f"fire.Fire({fire_fn})" if fire_fn else "fire.Fire",
            "args": fire_args,
            "configs": [],
        }
    return {
        "kind": "raw",
        "description": None,
        "args": [],
        "configs": [],
    }


def _literal(node: ast.AST | None) -> Any:
    if node is None:
        return None
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        mapping = {
            "True": True,
            "False": False,
            "None": None,
            "int": "int",
            "float": "float",
            "str": "str",
            "bool": "bool",
            "Path": "path",
        }
        return mapping.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.USub):
        val = _literal(node.operand)
        if isinstance(val, (int, float)):
            return -val
        return None
    if isinstance(node, ast.List):
        return [_literal(x) for x in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(_literal(x) for x in node.elts)
    if isinstance(node, ast.Set):
        return [_literal(x) for x in node.elts]
    if isinstance(node, ast.Call):
        func_name = ""
        if isinstance(node.func, ast.Name):
            func_name = node.func.id
        elif isinstance(node.func, ast.Attribute):
            func_name = node.func.attr
        if func_name == "cpu_count":
            return os.cpu_count()
        if func_name in {"Path", "PurePath"} and node.args:
            val = _literal(node.args[0])
            return str(val) if val is not None else None
    return None


def _type_name(value: Any) -> str:
    if value in ("int", int):
        return "int"
    if value in ("float", float):
        return "float"
    if value in ("str", str):
        return "str"
    if value in ("bool", bool):
        return "bool"
    if value in ("path", "Path"):
        return "path"
    if isinstance(value, str):
        return value
    return "str"


def _argparse(tree: ast.Module) -> tuple[list[dict[str, Any]], str | None]:
    description = None
    args: list[dict[str, Any]] = []
    seen: set[str] = set()

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        name = ""
        if isinstance(func, ast.Attribute):
            name = func.attr
        elif isinstance(func, ast.Name):
            name = func.id

        if name in {"ArgumentParser", "ArgumentParser"}:
            for kw in node.keywords:
                if kw.arg == "description":
                    description = _literal(kw.value)
                    if not isinstance(description, str):
                        description = None

        if name != "add_argument":
            continue

        flags: list[str] = []
        for arg in node.args:
            val = _literal(arg)
            if isinstance(val, str):
                flags.append(val)

        kwargs: dict[str, Any] = {}
        for kw in node.keywords:
            if kw.arg:
                kwargs[kw.arg] = _literal(kw.value)

        if not flags:
            continue

        long_flags = [f for f in flags if f.startswith("--")]
        short_flags = [f for f in flags if f.startswith("-") and not f.startswith("--")]
        positional = [f for f in flags if not f.startswith("-")]
        primary = (long_flags or short_flags or positional)[0]
        dest = kwargs.get("dest")
        if not dest:
            dest = primary.lstrip("-").replace("-", "_")

        if dest in seen:
            continue
        seen.add(dest)

        action = kwargs.get("action") or "store"
        arg_type = kwargs.get("type")
        default = kwargs.get("default")
        if action == "store_true":
            arg_type = "bool"
            if default is None:
                default = False
        elif action == "store_false":
            arg_type = "bool"
            if default is None:
                default = True
        elif action == "count":
            arg_type = "int"
            if default is None:
                default = 0
        elif arg_type is None:
            if isinstance(default, bool):
                arg_type = "bool"
            elif isinstance(default, int) and not isinstance(default, bool):
                arg_type = "int"
            elif isinstance(default, float):
                arg_type = "float"
            else:
                arg_type = "str"
        else:
            arg_type = _type_name(arg_type)

        nargs = kwargs.get("nargs")
        required = bool(kwargs.get("required")) or bool(positional)
        help_text = kwargs.get("help")
        if not isinstance(help_text, str):
            help_text = None

        choices = kwargs.get("choices")
        if isinstance(choices, tuple):
            choices = list(choices)
        if not isinstance(choices, list):
            choices = None

        args.append(
            {
                "name": primary,
                "dest": dest,
                "flags": flags,
                "type": arg_type,
                "default": default,
                "required": required,
                "help": help_text,
                "choices": choices,
                "action": action,
                "nargs": nargs,
                "positional": bool(positional) and not long_flags and not short_flags,
            }
        )
    return args, description


def _hydra(tree: ast.Module, path: Path) -> dict[str, Any] | None:
    aliases = {"hydra.main"}
    for n in tree.body:
        if isinstance(n, ast.ImportFrom) and n.module == "hydra":
            for a in n.names:
                if a.name == "main":
                    aliases.add(a.asname or "main")
    config_path = None
    config_name = None
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        is_hydra = False
        if isinstance(func, ast.Attribute) and func.attr == "main":
            if isinstance(func.value, ast.Name) and func.value.id == "hydra":
                is_hydra = True
        if isinstance(func, ast.Name) and func.id in aliases:
            is_hydra = True
        if not is_hydra:
            continue
        for kw in node.keywords:
            if kw.arg == "config_path":
                config_path = _literal(kw.value)
            if kw.arg == "config_name":
                config_name = _literal(kw.value)
        for i, arg in enumerate(node.args):
            if i == 0 and config_path is None:
                config_path = _literal(arg)
            if i == 1 and config_name is None:
                config_name = _literal(arg)

    text_has = any(
        isinstance(n, ast.Import) and any(a.name == "hydra" for a in n.names)
        or isinstance(n, ast.ImportFrom) and n.module == "hydra"
        for n in tree.body
        if isinstance(n, (ast.Import, ast.ImportFrom))
    )
    if config_path is None and config_name is None and not text_has:
        return None
    if config_path is None and config_name is None:
        return None

    configs: list[str] = []
    if isinstance(config_path, str):
        cfg_dir = (path.parent / config_path).resolve()
        if cfg_dir.is_dir():
            for p in sorted(cfg_dir.rglob("*.yaml")):
                configs.append(p.relative_to(cfg_dir).as_posix())
            for p in sorted(cfg_dir.rglob("*.yml")):
                rel = p.relative_to(cfg_dir).as_posix()
                if rel not in configs:
                    configs.append(rel)

    return {
        "kind": "hydra",
        "description": "Hydra",
        "config_path": config_path,
        "config_name": config_name,
        "args": [
            {
                "name": "--config-name",
                "dest": "config_name",
                "flags": ["-cn", "--config-name"],
                "type": "str",
                "default": config_name,
                "required": False,
                "help": "Hydra config name",
                "choices": [
                    Path(c).with_suffix("").as_posix() for c in configs
                ] or None,
                "action": "store",
                "nargs": None,
                "positional": False,
            }
        ],
        "configs": configs,
        "overrides": True,
    }


def _click(tree: ast.Module) -> list[dict[str, Any]]:
    args: list[dict[str, Any]] = []
    seen: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for dec in node.decorator_list:
            if not isinstance(dec, ast.Call):
                continue
            func = dec.func
            attr = ""
            if isinstance(func, ast.Attribute):
                attr = func.attr
                owner = func.value.id if isinstance(func.value, ast.Name) else ""
                if owner not in {"click", ""}:
                    continue
            elif isinstance(func, ast.Name):
                attr = func.id
            if attr not in {"option", "argument"}:
                continue
            flags = [_literal(a) for a in dec.args]
            flags = [f for f in flags if isinstance(f, str)]
            kwargs = {kw.arg: _literal(kw.value) for kw in dec.keywords if kw.arg}
            if not flags:
                continue
            primary = next((f for f in flags if f.startswith("--")), flags[0])
            dest = kwargs.get("name") or primary.lstrip("-").replace("-", "_")
            if dest in seen:
                continue
            seen.add(dest)
            is_flag = bool(kwargs.get("is_flag"))
            arg_type = "bool" if is_flag else _type_name(kwargs.get("type") or "str")
            default = kwargs.get("default")
            if is_flag and default is None:
                default = False
            help_text = kwargs.get("help")
            args.append(
                {
                    "name": primary,
                    "dest": dest,
                    "flags": flags,
                    "type": arg_type,
                    "default": default,
                    "required": bool(kwargs.get("required")) or attr == "argument",
                    "help": help_text if isinstance(help_text, str) else None,
                    "choices": kwargs.get("type")
                    if isinstance(kwargs.get("type"), list)
                    else None,
                    "action": "store_true" if is_flag else "store",
                    "nargs": None,
                    "positional": attr == "argument" and not primary.startswith("-"),
                }
            )
    return args


def _fire(tree: ast.Module) -> tuple[list[dict[str, Any]], str | None]:
    target = None
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        is_fire = False
        if isinstance(func, ast.Attribute) and func.attr == "Fire":
            if isinstance(func.value, ast.Name) and func.value.id == "fire":
                is_fire = True
        if not is_fire:
            continue
        if node.args and isinstance(node.args[0], ast.Name):
            target = node.args[0].id
        break
    if not target:
        return [], None

    fn = None
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == target:
            fn = node
            break
    if not fn:
        return [], target

    args: list[dict[str, Any]] = []
    defaults = list(fn.args.defaults)
    positional = fn.args.args
    pad = [None] * (len(positional) - len(defaults))
    default_map = dict(zip([a.arg for a in positional], pad + defaults))
    for arg in positional:
        if arg.arg in {"self", "cls"}:
            continue
        default_node = default_map.get(arg.arg)
        default = _literal(default_node) if default_node is not None else None
        ann = None
        if arg.annotation:
            ann = _literal(arg.annotation)
        arg_type = _type_name(ann) if ann else (
            "bool" if isinstance(default, bool)
            else "int" if isinstance(default, int) and not isinstance(default, bool)
            else "float" if isinstance(default, float)
            else "str"
        )
        args.append(
            {
                "name": f"--{arg.arg}",
                "dest": arg.arg,
                "flags": [f"--{arg.arg}"],
                "type": arg_type,
                "default": default,
                "required": default_node is None,
                "help": None,
                "choices": None,
                "action": "store_true" if arg_type == "bool" and default is False else "store",
                "nargs": None,
                "positional": False,
            }
        )
    return args, target


def build_argv(
    spec: dict[str, Any],
    values: dict[str, Any],
    extra: str = "",
    overrides: list[str] | None = None,
) -> list[str]:
    argv: list[str] = []
    kind = spec.get("kind")
    args = spec.get("args") or []

    if kind == "hydra":
        cn = values.get("config_name")
        default_cn = None
        for a in args:
            if a["dest"] == "config_name":
                default_cn = a.get("default")
        if cn and cn != default_cn:
            argv.extend(["-cn", str(cn)])
        for ov in overrides or []:
            ov = str(ov).strip()
            if ov:
                argv.append(ov)
        extra_parts = _split_extra(extra)
        argv.extend(extra_parts)
        return argv

    for arg in args:
        dest = arg["dest"]
        if dest not in values:
            continue
        val = values[dest]
        if val is None or val == "":
            continue
        action = arg.get("action") or "store"
        if action == "store_true":
            if _truthy(val):
                argv.append(arg["name"])
            continue
        if action == "store_false":
            if not _truthy(val):
                argv.append(arg["name"])
            continue
        if arg.get("positional"):
            if isinstance(val, list):
                argv.extend(str(x) for x in val)
            else:
                argv.append(str(val))
            continue
        flag = arg["name"] if arg["name"].startswith("-") else f"--{arg['dest']}"
        nargs = arg.get("nargs")
        if nargs in {"+", "*"} or isinstance(nargs, int) and nargs > 1 or isinstance(val, list):
            items = _nargs_items(val)
            if items:
                argv.append(flag)
                argv.extend(str(x) for x in items)
            continue
        argv.extend([flag, str(val)])

    argv.extend(_split_extra(extra))
    return argv


def _nargs_items(val: Any) -> list[Any]:
    if isinstance(val, list):
        if len(val) == 1 and isinstance(val[0], list):
            return val[0]
        return val
    return [p for p in _split_tokens(str(val)) if p != ""]


def _split_tokens(raw: str) -> list[str]:
    out: list[str] = []
    for part in raw.replace(",", " ").split():
        if part:
            out.append(part)
    return out


def _truthy(val: Any) -> bool:
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)):
        return bool(val)
    if isinstance(val, str):
        return val.strip().lower() in {"1", "true", "yes", "on", "y"}
    return bool(val)


def _split_extra(extra: str) -> list[str]:
    extra = (extra or "").strip()
    if not extra:
        return []
    import shlex
    import sys

    posix = sys.platform != "win32"
    try:
        return shlex.split(extra, posix=posix)
    except ValueError:
        return extra.split()


def _is_python_or_script(token: str) -> bool:
    name = Path(token.replace("\\", "/")).name.lower()
    if name.endswith(".py"):
        return True
    if "python" in name:
        return True
    return False


def _looks_negative_number(token: str) -> bool:
    try:
        float(token)
        return token.startswith("-")
    except ValueError:
        return False


def _coerce_cli(arg: dict[str, Any], raw: str) -> Any:
    t = arg.get("type")
    if t == "int":
        try:
            return int(raw, 10)
        except ValueError:
            return raw
    if t == "float":
        try:
            return float(raw)
        except ValueError:
            return raw
    if t == "bool":
        return _truthy(raw)
    return raw


def _is_nargs_list(arg: dict[str, Any]) -> bool:
    n = arg.get("nargs")
    if n in {"+", "*"}:
        return True
    if isinstance(n, int) and n > 1:
        return True
    return isinstance(arg.get("default"), list)


def parse_cli(spec: dict[str, Any], command: str) -> dict[str, Any]:
    """Fill form values from a pasted command line."""
    import shlex
    import sys

    posix = sys.platform != "win32"
    try:
        tokens = shlex.split((command or "").strip(), posix=posix)
    except ValueError:
        tokens = (command or "").split()

    while tokens and _is_python_or_script(tokens[0]):
        tokens.pop(0)

    args = spec.get("args") or []
    by_flag: dict[str, dict[str, Any]] = {}
    for arg in args:
        for flag in arg.get("flags") or [arg.get("name")]:
            if flag:
                by_flag[str(flag)] = arg

    values: dict[str, Any] = {}
    extra: list[str] = []
    overrides: list[str] = []
    i = 0
    kind = spec.get("kind")
    while i < len(tokens):
        tok = tokens[i]
        if tok == "--":
            extra.extend(tokens[i + 1 :])
            break
        if kind == "hydra" and "=" in tok and not tok.startswith("-"):
            overrides.append(tok)
            i += 1
            continue
        flag, eq = tok, None
        if tok.startswith("--") and "=" in tok:
            flag, eq = tok.split("=", 1)
        arg = by_flag.get(flag)
        if arg is None:
            extra.append(tok)
            i += 1
            continue
        dest = arg["dest"]
        action = arg.get("action") or "store"
        if action == "store_true":
            values[dest] = False if eq in {"0", "false", "False"} else True
            i += 1
            continue
        if action == "store_false":
            values[dest] = True if eq in {"0", "false", "False"} else False
            i += 1
            continue
        taken: list[Any] = []
        if eq is not None:
            taken.extend(_coerce_cli(arg, p) for p in _split_tokens(eq) or [eq])
            i += 1
        else:
            i += 1
            narg = arg.get("nargs")
            if _is_nargs_list(arg):
                limit = narg if isinstance(narg, int) else None
                while i < len(tokens):
                    nxt = tokens[i]
                    if nxt in by_flag or (nxt.startswith("-") and not _looks_negative_number(nxt)):
                        break
                    taken.append(_coerce_cli(arg, nxt))
                    i += 1
                    if limit is not None and len(taken) >= limit:
                        break
            elif i < len(tokens):
                nxt = tokens[i]
                if nxt not in by_flag and (not nxt.startswith("-") or _looks_negative_number(nxt)):
                    taken.append(_coerce_cli(arg, nxt))
                    i += 1
        if _is_nargs_list(arg):
            values[dest] = taken
        elif taken:
            values[dest] = taken[0]
        else:
            extra.append(flag)

    extra_s = " ".join(extra).strip()
    override_dims: dict[str, Any] = {}
    for ov in overrides:
        if "=" not in ov:
            continue
        key, val = ov.split("=", 1)
        override_dims[key] = val
    return {
        "values": values,
        "extra": extra_s,
        "overrides": overrides,
        "override_dims": override_dims,
    }
