import { AbstractAgent, type BaseEvent, type RunAgentInput } from "@ag-ui/client";
import { defer, finalize, type Observable } from "rxjs";
export { PLAN_RUN_COMPLETED } from "./native-agent";

type HeaderBearingAgent = AbstractAgent & { headers?: Record<string, string> };

/** Each HTTP segment owns a fresh transport and its real abort controller. */
export class CloningRemoteAgent extends AbstractAgent {
  headers?: Record<string, string>;
  private readonly remote: HeaderBearingAgent;
  constructor(remote: AbstractAgent, private readonly attachMiddleware: (target: AbstractAgent) => void) {
    super({ agentId: remote.agentId, description: remote.description, threadId: remote.threadId,
      initialMessages: remote.messages, initialState: remote.state, debug: remote.debug });
    this.remote = remote as HeaderBearingAgent;
    if (this.remote.headers) this.headers = { ...this.remote.headers };
    attachMiddleware(this);
  }
  run(input: RunAgentInput): Observable<BaseEvent> {
    return defer(() => {
      const transport = this.remote.clone() as HeaderBearingAgent;
      if (this.headers) transport.headers = { ...this.headers };
      return transport.run(input).pipe(finalize(() => transport.abortRun()));
    });
  }
  async getCapabilities() { return this.remote.getCapabilities?.() ?? {}; }
  clone(): CloningRemoteAgent {
    const clone = new CloningRemoteAgent(this.remote.clone(), this.attachMiddleware);
    if (this.headers) clone.headers = { ...this.headers };
    return clone;
  }
}

export class UnavailableAgent extends AbstractAgent {
  constructor(private readonly unavailable: { id: string; name: string; reason: string }) {
    super({ agentId: unavailable.id, description: unavailable.name });
  }
  clone(): UnavailableAgent { return new UnavailableAgent(this.unavailable); }
  run(): never { throw new Error(this.unavailable.reason); }
}
