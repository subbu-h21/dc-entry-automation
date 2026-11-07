from openai import OpenAI, AsyncOpenAI
from config import ANTHROPIC_BASE_URL, ANTHROPIC_KEY, OPENROUTER_API_KEY, OPENROUTER_BASE_URL

# Meant to be long enough for a big two-page DC. Waiting this long and then running the
# Gemini fallback can outlast a proxy's own limit, in which case staff click Extract
# again. No retries here: the fallback is the retry.
_ANTHROPIC_TIMEOUT_SECONDS = 90

_sync_client: OpenAI | None = None
_async_client: AsyncOpenAI | None = None
_anthropic_client: AsyncOpenAI | None = None


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


def get_anthropic_client() -> AsyncOpenAI:
    """Claude through Anthropic's OpenAI-compatible address, so the openai package
    already installed here works unchanged. Anthropic describes that address as mainly
    for testing, which is one reason a failure here always falls back to Gemini."""
    global _anthropic_client
    if _anthropic_client is None:
        _anthropic_client = AsyncOpenAI(
            base_url=ANTHROPIC_BASE_URL,
            api_key=ANTHROPIC_KEY,
            timeout=_ANTHROPIC_TIMEOUT_SECONDS,
            max_retries=0,
        )
    return _anthropic_client
