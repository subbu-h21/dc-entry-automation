from openai import OpenAI, AsyncOpenAI
from config import OPENROUTER_API_KEY, OPENROUTER_BASE_URL

_sync_client: OpenAI | None = None
_async_client: AsyncOpenAI | None = None


def get_sync_client() -> OpenAI:
    global _sync_client
    if _sync_client is None:
        _sync_client = OpenAI(base_url=OPENROUTER_BASE_URL, api_key=OPENROUTER_API_KEY)
    return _sync_client


def get_async_client() -> AsyncOpenAI:
    global _async_client
    if _async_client is None:
        _async_client = AsyncOpenAI(base_url=OPENROUTER_BASE_URL, api_key=OPENROUTER_API_KEY)
    return _async_client
