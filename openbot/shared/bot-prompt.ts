/** Browser capabilities are supplied by the shared executor, not by a chat surface. */
export const COMPUTER_GUIDANCE = [
  "You have a real browser and a persistent workspace. Use the computer tools for web and computer work. The person can watch the live screen.",
  "Use computer_navigate to open a URL, including a search engine when you need to find pages. Read actual page content with computer_read; use computer_snapshot for current element refs before computer_click, computer_type or computer_key. Do not invent refs or claim a page was read without reading it.",
  "Your browser profile retains its own sign-ins and state. Inspect the current page before asking for a login; do not assume the browser is signed in as nobody.",
  "When a page actually needs a person to sign in or complete a challenge, call computer_request_help or computer_request_sign_in. The turn waits while the person takes control. Continue in the same session after they hand it back; do not retry actions while they have control.",
  "For one private field, use computer_request_secret with its current ref. The private input goes straight to the page; do not ask for passwords or codes in chat.",
  "Files belong to your workspace. Use computer_list_files, computer_read_file and computer_write_file with paths relative to that workspace. A missing file is not a policy refusal.",
  "Use computer_screenshot when the visual state matters. Report the actual page or tool result, including failures; an attempted click is not proof that the requested operation completed.",
].join("\n\n");

/**
 * Where an answer came from, said out loud.
 *
 * Asked "a customer made 12 cash deposits just under the reporting threshold, what is our
 * obligation", the compliance Bot answered at length and with confidence: file a SAR, $5,000 or
 * more, within 30 calendar days of initial detection, retain for 5 years. The audit trail for that
 * turn holds one row, the routing decision. No tool call, no source, and no sentence anywhere saying
 * the answer came from the model rather than from anything this deployment can reach.
 *
 * Several of those numbers may well be right, and that is the problem. A confident, plausible,
 * unsourced answer is indistinguishable from a confident, plausible, wrong one, and nothing marked
 * the difference on a question about whether to file, against what threshold, inside what deadline.
 *
 * One package's `knowledge` Bot had a rule against exactly this, written into its YAML by whoever
 * happened to think of it. The Bot whose whole subject is regulatory obligation did not, because
 * `remote-ag-ui` gets its role description and nothing else. A rule that important sitting in one
 * agent's YAML is a rule that will be missing from the next agent somebody adds, so it lives here
 * and every Bot gets it.
 *
 * The last paragraph is not padding. An earlier attempt at this told Bots to go and find a source,
 * and they went hunting the open web and looped on a government 404 page, which is worse than the
 * problem: an unsourced answer marked as unsourced is honest, and a hunt for one is a Bot that
 * never answers. The instruction is to say where the answer came from, not to go looking.
 *
 * A search tool is the exception, and the line that says so is what lets one be used. Without it,
 * a Bot holding Exa still charted GDP figures from memory, because this paragraph told it not to
 * look. The browser is still not for hunting; a search tool's own guidance bounds how much it does.
 */
const PROVENANCE_GUIDANCE_LINES = [
  "Say where an answer came from. When you read it with one of your tools, cite what you read.",
  "When you are answering from your own knowledge instead, say so in a line, and never dress that",
  "up as something you looked up here.",
  "",
  "For customer-facing marketing copy rewritten from user-supplied documents, omit source notes",
  "and reading-process commentary unless requested; preserve facts and guaranteed/projected labels.",
  "",
  "This matters most for the answers people act on: a threshold, a deadline, a filing obligation, a",
  "figure, a rule you are presenting as this organisation's. Never state one of those as established",
  "here without having read it somewhere you can name. Saying 'I have not checked this against your",
  "own policy or the current regulation' costs you a sentence. Being confidently wrong about a",
  "number somebody acts on costs them a great deal more.",
  "",
  "This is not an instruction to go looking. Finding sources is what a search tool is for: if you",
  "hold one, use it as its own instructions say. Without one, if nothing you can reach covers the",
  "question, answer as well as you can, mark it plainly as unverified, and offer to check a source the",
  "person names. Do not go hunting the open web in your browser for something to cite, and do not",
  "keep retrying a page that is not giving you one: an unsourced answer that says it is unsourced is",
  "honest, and a search that never ends is a Bot that never answers.",
];

export const PROVENANCE_GUIDANCE = PROVENANCE_GUIDANCE_LINES.reduce<string[]>(
  (paragraphs, line) => {
    if (line === "") {
      paragraphs.push("");
      return paragraphs;
    }
    const last = paragraphs.length - 1;
    paragraphs[last] = paragraphs[last] ? `${paragraphs[last]} ${line}` : line;
    return paragraphs;
  },
  [""],
).join("\n\n");

/**
 * What a tool call is given when its answer never came.
 *
 * A tool call the surface owns ends the run without a result on purpose: the surface draws it, or
 * puts it to a person, and starts the next run carrying the answer. When nobody answers — a Bot asks
 * for the wheel to get past a sign-in and the person decides they do not need it after all — no
 * answer is ever carried, and the call stays in the history with nothing following it.
 *
 * Providers reject that outright on the NEXT turn: "an assistant message with 'tool_calls' must be
 * followed by tool messages responding to each 'tool_call_id'". So the conversation is not merely
 * stuck on that one request, it is finished, and the only escape is starting a new one.
 *
 * Written for the model rather than for a log, because the model is the only reader: it has to
 * understand the call is over and not worth waiting for, and be able to say something useful about
 * it. "Nothing happened" would leave it repeating the request, and a fake success would have it
 * report work it never did.
 *
 * Shared because both Bots in this repo have to say the same thing. The first fix for this landed in
 * `agent-langgraph` alone, and `agent-bot` — the Bot that ships in the box, and the one behind the
 * Browser Bot — went on failing in exactly the same way until somebody drove it.
 */
export const NO_ANSWER_CAME =
  "No result. The person did not answer this, and the run it belonged to has ended. " +
  "Do not wait for it and do not assume it succeeded. Carry on without it, and say plainly what " +
  "you could not do if it mattered.";
