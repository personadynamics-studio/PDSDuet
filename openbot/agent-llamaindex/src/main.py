"""LlamaIndex as a Bot.

The AG-UI support is LlamaIndex's own package, `llama-index-protocols-ag-ui`, and it hands back a
FastAPI router. Mount it and stop.
"""

import os
import sys
from pathlib import Path

# The spec file every language in the box reads: one level above this Bot in the repository, and
# one level above /app/src in the image the Dockerfile builds.
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "shared"))
from model_providers import bot_settings

import litellm
from fastapi import FastAPI
from llama_index.llms.litellm import LiteLLM
from llama_index.protocols.ag_ui.router import get_ag_ui_workflow_router


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
    settings = bot_settings("agent-llamaindex")
    provider = settings.provider
    model = settings.model
    return f"{provider}/{model}"


def _llm() -> LiteLLM:
    model = _model_id()
    if not litellm.supports_function_calling(model):
        litellm.register_model(
            {
                model: {
                    "litellm_provider": model.split("/", 1)[0],
                    "mode": "chat",
                    "supports_function_calling": True,
                }
            }
        )
    return LiteLLM(model=model, additional_kwargs={"drop_params": True})


app = FastAPI()


@app.get("/health")
async def health():
    return {"ok": True, "harness": "llamaindex"}


app.include_router(get_ag_ui_workflow_router(llm=_llm()))
