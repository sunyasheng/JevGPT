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


def validate_hybrid_health(health, config):
    """services/cmass_hybrid/SearchService.java: one document and one passage service."""
    retrieval = config["retrieval"]
    expected = {
        "document": (retrieval["documents"], config["bm25"]),
        "passage": (retrieval["passages"], config["passage_bm25"]),
    }
    for side, (count, bm25) in expected.items():
        found = health.get(side) or {}
        if (
            found.get("ready") is not True
            or found.get("mode") != side
            or found.get("documents") != count
            or found.get("bm25") != bm25
        ):
            raise ValueError(
                f"CMASS hybrid {side} service does not match the full-corpus BM25 configuration"
            )
    return health


def validate_pool_health(health, config):
    """services/cmass_pool.py: the full corpus, the frozen BM25 settings and the pool limits."""
    pool = config["pool"]
    expected = {
        "ready": True,
        "mode": "pool",
        "index": config["retrieval"]["index"],
        "documents": config["retrieval"]["documents"],
        "bm25": config["bm25"],
        "documents_per_search": pool["documents_per_search"],
        "grep_return_chars": pool["grep_return_chars"],
        "grep_seconds": pool["grep_seconds"],
    }
    if any(health.get(key) != value for key, value in expected.items()):
        raise ValueError("CMASS pool service does not match the pool_grep configuration")
    return health


def validate_budget(config):
    if config["submit_now_seconds"] != int(config["timeout_seconds"] * 0.7):
        raise ValueError("CMASS reminder must match the runtime's 0.7 timeout ratio")
