from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping, Sequence


def _json_safe(x: Any) -> Any:
    try:
        import numpy as np

        if isinstance(x, (np.integer,)):
            return int(x)
        if isinstance(x, (np.floating,)):
            return float(x)
        if isinstance(x, np.ndarray):
            return x.tolist()
    except Exception:
        pass

    if isinstance(x, Mapping):
        return {str(k): _json_safe(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_json_safe(v) for v in x]
    return x


def write_arborenum_builder_payload(
    model: Any,
    out_dir: str | Path,
    feature_names: Sequence[str] | None = None,
    continuous_groups: Mapping[str, Sequence[int]] | Sequence[Sequence[int]] | None = None,
    thresholds: Mapping[int, Any] | Sequence[Any] | None = None,
    feature_descriptions: Mapping[str, Any] | None = None,
    filename: str = "arborenum_payload.js",
) -> Path:
    graph = model.export_andor_graph(as_dict=True) if hasattr(model, "export_andor_graph") else model
    meta = {
        "featureNames": list(feature_names) if feature_names is not None else None,
        "continuousGroups": continuous_groups,
        "thresholds": thresholds,
        "featureDescriptions": feature_descriptions,
    }

    payload_obj = {
        "graph": _json_safe(graph),
        "meta": _json_safe(meta),
    }

    payload = "window.ARBORENUM_BUILDER_PAYLOAD = " + json.dumps(payload_obj) + ";\n"
    payload += "window.ARBORENUM_ANDOR_GRAPH = window.ARBORENUM_BUILDER_PAYLOAD.graph;\n"
    payload += "window.ARBORENUM_ANDOR_META = window.ARBORENUM_BUILDER_PAYLOAD.meta;\n"

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    path = out / filename
    path.write_text(payload, encoding="utf-8")
    return path
