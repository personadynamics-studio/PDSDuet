# The TypeScript LangGraph AG-UI endpoint. Its browser runs in the separate computer container.
FROM oven/bun:1.4-alpine

WORKDIR /app
# The lockfile as well as the manifest: `--frozen-lockfile` with no lockfile present resolves afresh
# and exits 0, so the file has to be here for the flag to mean anything.
COPY agent-langgraph/package.json agent-langgraph/bun.lock ./agent-langgraph/
RUN cd agent-langgraph && bun install --frozen-lockfile

# The repo's own layout, kept exactly, so `../../shared/bot-prompt` resolves the same here as it
# does on a laptop. Flattening src to /app/src would change the depth and break only on deploy.
COPY shared ./shared
COPY agent-langgraph/src ./agent-langgraph/src

ENV PORT=4201
EXPOSE 4201
CMD ["bun", "agent-langgraph/src/index.ts"]
