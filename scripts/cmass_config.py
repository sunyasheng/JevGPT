"""Shared checks for the frozen CMASS configuration and retrieval fingerprint."""


def validate_health(health, config):
    retrieval = config["retrieval"]
    expected = {
        "status": "ready",
        "mode": "full",
        "index": retrieval["index"],
        "documents": retrieval["documents"],
        "bm25": config["bm25"],
    }
    if any(health.get(key) != value for key, value in expected.items()):
        raise ValueError(
            "CMASS service does not match the full-corpus BM25 configuration"
        )
    return health


def validate_budget(config):
    if config["submit_now_seconds"] != int(config["timeout_seconds"] * 0.7):
        raise ValueError("CMASS reminder must match the runtime's 0.7 timeout ratio")
