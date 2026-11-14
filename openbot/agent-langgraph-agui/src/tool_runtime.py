"""Bind this run's server-owned tools; the server executes each emitted batch."""

from contextlib import aclosing
from contextvars import ContextVar
from dataclasses import dataclass, field

from ag_ui.core import Context, EventType, RunAgentInput, RunErrorEvent, Tool
from langchain_core.messages import SystemMessage

from .parallel_tools import ParallelToolAgent


@dataclass
class RunTools:
    tools: tuple[Tool, ...] = ()
    context: tuple[Context, ...] = ()
    connection: dict = field(default_factory=dict, compare=False, repr=False)


_current: ContextVar[RunTools | None] = ContextVar("openbot_run_tools", default=None)


def current_tools() -> RunTools:
    context = _current.get()
    if context is None:
        raise RuntimeError("The model was called outside its current run.")
    return context


class UnofferedToolError(ValueError):
    pass


class ToolAwareAgent(ParallelToolAgent):
    async def run(self, input: RunAgentInput):
        context = RunTools(tools=tuple(input.tools or []), context=tuple(input.context or []))
        offered = {tool.name for tool in context.tools}
        pending = {}
        token = _current.set(context)
        try:
            # These tool results are already in input.messages. They are not a LangGraph
            # Command resuming a graph-owned interrupt.
            async with aclosing(super().run(input.model_copy(update={"resume": None}))) as stream:
                async for event in stream:
                    if event.type == EventType.TOOL_CALL_START:
                        if event.tool_call_name not in offered:
                            raise UnofferedToolError()
                        pending[event.tool_call_id] = event.tool_call_name
                    elif event.type == EventType.TOOL_CALL_RESULT:
                        pending.pop(event.tool_call_id, None)
                    elif event.type == EventType.RUN_FINISHED and pending:
                        event = event.model_copy(update={"outcome": {
                            "type": "interrupt",
                            "interrupts": [{
                                "id": call_id,
                                "toolCallId": call_id,
                                "reason": "tool_execution",
                                "message": "Waiting for the server tool executor.",
                            } for call_id in pending],
                        }})
                    if event.type == EventType.RUN_ERROR and context.connection.get("authentication_failed"):
                        event = event.model_copy(update={"code": "OPENBOT_MODEL_AUTH_REQUIRED"})
                    yield event
        except UnofferedToolError:
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message="The model requested a tool that was not offered for this run.",
            )
        except Exception:
            if not context.connection.get("authentication_failed"):
                raise
            yield RunErrorEvent(
                type=EventType.RUN_ERROR,
                message="Sign in to your model provider again.",
                code="OPENBOT_MODEL_AUTH_REQUIRED",
            )
        finally:
            _current.reset(token)


def model_messages(messages):
    return [
        *[SystemMessage(content=f"{entry.description}\n{entry.value}") for entry in current_tools().context],
        *messages,
    ]


def bind_tools(model):
    tools = current_tools().tools
    if not tools:
        return model
    return model.bind_tools([{
        "type": "function",
        "function": {
            "name": tool.name,
            "description": tool.description,
            "parameters": tool.parameters,
        },
    } for tool in tools])
