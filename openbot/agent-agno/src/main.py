"""Agno as a Bot.

The AG-UI support is an extra in Agno's own package rather than a separate bridge, so `agno[agui]`
is the whole dependency and `AGUIApp` is the whole integration. Nothing of the protocol is written
here, which is the rule.
"""

import os
import sys
from pathlib import Path

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import bot_settings

from agno.agent import Agent
from agno.db.in_memory import InMemoryDb
from agno.models.litellm import LiteLLM
from agno.os import AgentOS
from agno.os.interfaces.agui import AGUI


def _model_id() -> str:
    """`provider/model`, which is how litellm addresses one and how OpenBot stores the choice.

    The model half is whatever the endpoint publishes, slashes included. litellm takes the first
    path component as the provider and sends the rest as the model name, so a name that already
    contains a slash still needs the chosen provider in front: `qwen/qwen3-8b` on an
    OpenAI-compatible endpoint is `openai/qwen/qwen3-8b`, and `openai/gpt-5.6-terra` is
    `openai/openai/gpt-5.6-terra`. Treating a slash as "already a provider" dropped the prefix,
    and litellm then either routed to a provider nobody configured (`LLM Provider NOT provided`)
    or sent only the second half to the endpoint.
    """
    settings = bot_settings("agent-agno")
    provider = settings.provider
    model = settings.model
    return f"{provider}/{model}"


agent = Agent(
    # In memory, because a Bot's history lives in OpenBot's database and not in the harness. Two
    # places remembering the same conversation is how they come to disagree.
    db=InMemoryDb(),
    # `drop_params`, because Agno sends a temperature and a `top_p` on every request and LiteLLM
    # refuses both for a reasoning model, the default `gpt-5.5` among them: every run on an OpenAI
    # key failed before it reached OpenAI. A parameter a model does not take is dropped instead,
    # for this one client, as the LlamaIndex Bot does.
    model=LiteLLM(id=_model_id(), request_params={"drop_params": True}),
    # No role, goal or backstory invented on somebody's behalf. A Bot answers the question it is
    # asked, and anybody who wants a persona sets one in OpenBot where the rest of them live.
    instructions="Answer the question you are asked, briefly and correctly.",
)

app = AgentOS(agents=[agent], interfaces=[AGUI(agent=agent)]).get_app()


@app.get("/health")
async def health():
    return {"ok": True, "harness": "agno"}
