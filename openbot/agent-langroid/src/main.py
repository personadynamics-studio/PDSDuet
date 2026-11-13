"""Langroid as a Bot, through `ag-ui-langroid`, which AG-UI maintains."""

import os
import sys
from pathlib import Path

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import bot_settings

from ag_ui_langroid import create_langroid_app
from langroid import ChatAgent, ChatAgentConfig
from langroid.language_models import OpenAIGPTConfig

from .frontend_tools import FrontendToolsAgent


def _model_id() -> str:
    """Langroid names an OpenAI model bare and everything else through litellm.

    `openai/gpt-4o-mini` is rejected by its OpenAI client as an invalid model id, so the prefix goes
    on only when the provider is somebody else.
    """
    settings = bot_settings("agent-langroid")
    provider = settings.provider
    model = settings.model
    if "/" in model or provider == "openai":
        return model
    return f"litellm/{provider}/{model}"


# An empty `OPENAI_API_KEY` is no key. Compose writes the keys a model choice does not use as empty
# rather than leaving them out, and Langroid reads `OPENAI_API_KEY` as its own setting: given an empty
# one it builds an OpenAI client with it, even for a model it hands to litellm, and the client refuses
# to be built. Unset, Langroid uses its placeholder and litellm reads the chosen provider's own key.
if not os.environ.get("OPENAI_API_KEY"):
    os.environ.pop("OPENAI_API_KEY", None)

# And an empty `OPENAI_BASE_URL` is no address. Compose writes it empty when the model screen chose a
# plain OpenAI key. Langroid builds its OpenAI client with no `base_url`, so the SDK reads this
# variable itself, and it falls back to `https://api.openai.com/v1` only when the variable is absent:
# given "", every request was built with no host and failed to connect. A real endpoint is left alone.
if not os.environ.get("OPENAI_BASE_URL", "").strip():
    os.environ.pop("OPENAI_BASE_URL", None)

agent = ChatAgent(
    ChatAgentConfig(
        llm=OpenAIGPTConfig(chat_model=_model_id(), parallel_tool_calls=False),
        add_to_registry=False,
        use_functions_api=True,
        use_tools=False,
        system_message="Answer the question you are asked, briefly and correctly.",
    )
)

app = create_langroid_app(FrontendToolsAgent(name="openbot", agent=agent))


@app.get("/health")
async def health():
    return {"ok": True, "harness": "langroid"}
