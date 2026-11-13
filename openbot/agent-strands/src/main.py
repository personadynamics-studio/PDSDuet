"""AWS Strands as a Bot, through `ag_ui_strands`, which AG-UI maintains."""

import os
import sys
from pathlib import Path

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import bot_settings

from ag_ui_strands import StrandsAgent, add_strands_fastapi_endpoint
from fastapi import FastAPI
from strands import Agent
from strands.models.litellm import LiteLLMModel


def _model_id() -> str:
    """`provider/model`, which is how litellm addresses one.

    The model half is whatever the endpoint publishes, slashes included. litellm takes the first
    path component as the provider and sends the rest as the model name, so a name that already
    contains a slash still needs the chosen provider in front: `qwen/qwen3-8b` on an
    OpenAI-compatible endpoint is `openai/qwen/qwen3-8b`, and `openai/gpt-5.6-terra` is
    `openai/openai/gpt-5.6-terra`. Treating a slash as "already a provider" dropped the prefix,
    and litellm then either routed to a provider nobody configured (`LLM Provider NOT provided`)
    or sent only the second half to the endpoint.
    """
    settings = bot_settings("agent-strands")
    provider = settings.provider
    model = settings.model
    return f"{provider}/{model}"


app = FastAPI()


@app.get("/health")
async def health():
    return {"ok": True, "harness": "strands"}


add_strands_fastapi_endpoint(
    app,
    StrandsAgent(name="openbot", agent=Agent(model=LiteLLMModel(model_id=_model_id()))),
    "/",
)
