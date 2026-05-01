"""
qdrant_shared.py — Single shared QdrantClient instance for the whole process.

Import get_qdrant() anywhere you need the client. Only one connection is ever
opened to the local storage directory, regardless of how many modules import this.
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from qdrant_client import QdrantClient

load_dotenv(Path(__file__).parent / ".env")

QDRANT_PATH = os.environ.get("QDRANT_PATH", "./qdrant_storage")

_client: QdrantClient | None = None


def get_qdrant() -> QdrantClient:
    global _client
    if _client is None:
        _client = QdrantClient(path=QDRANT_PATH)
    return _client
