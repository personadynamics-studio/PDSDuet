"""ChatGPT subscription model bridge using the existing Codex OAuth integration."""

import json
import os
from pathlib import Path

from ag_ui_langgraph import add_langgraph_fastapi_endpoint
from fastapi import FastAPI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, MessagesState, StateGraph

from .tool_runtime import ToolAwareAgent, bind_tools, model_messages

with (Path(__file__).resolve().parents[2] / "shared" / "model-providers.json").open() as spec:
    DEFAULT_MODEL = json.load(spec)["bots"]["agent-langgraph-agui"]["model"]


def _model():
    store = (os.environ.get("CHATGPT_AUTH_FILE") or "").strip()
    if not store:
        raise RuntimeError("CHATGPT_AUTH_FILE is required for the ChatGPT model bridge.")
    from langchain_openai.chat_models.codex import _ChatOpenAICodex
    from .chatgpt_store import ChatGptTokenStore

    return _ChatOpenAICodex(
        model=(os.environ.get("BOT_MODEL") or "").strip() or DEFAULT_MODEL,
        token_provider=ChatGptTokenStore(path=Path(store)),
    )


async def answer(state: MessagesState):
    from openai import AuthenticationError, PermissionDeniedError
    from langchain_openai.chatgpt_oauth import _ChatGPTOAuthRefreshError
    from .tool_runtime import current_tools

    try:
        model = _model()
        messages = model_messages(state["messages"])
        return {"messages": [await bind_tools(model).ainvoke(messages)]}
    except (AuthenticationError, PermissionDeniedError, _ChatGPTOAuthRefreshError):
        # Typed provider boundary only. A callback or harness 401 is a different credential.
        current_tools().connection["authentication_failed"] = True
        raise


builder = StateGraph(MessagesState)
builder.add_node("answer", answer)
builder.add_edge(START, "answer")
builder.add_edge("answer", END)
# A checkpointer, because the AG-UI integration resumes a thread by id and LangGraph refuses to
# without one. In memory rather than in Postgres: OpenBot's database is where a conversation lives,
# and two stores remembering the same thread is how they come to disagree.
graph = builder.compile(checkpointer=MemorySaver())

app = FastAPI()


@app.get("/health")
async def health():
    return {"ok": True, "harness": "langgraph"}


add_langgraph_fastapi_endpoint(
    app=app,
    agent=ToolAwareAgent(name="openbot", graph=graph, config={"recursion_limit": 25}),
    path="/",
)
