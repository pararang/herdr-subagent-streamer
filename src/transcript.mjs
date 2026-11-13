// Transcripts: JSONL files of records, one per line, appended as the agent works. Every host's
// transcript (or opencode's projection of one) uses this envelope:
//   {type:"session", id}                                         omo and omp session header
//   {type:"message", timestamp, message:{role, content, ...}}    role: user | assistant | toolResult
// content is a string or an array of {type:"text", text} | {type:"thinking", thinking} |
// {type:"toolCall", id, name, arguments}; a toolResult carries toolCallId and isError.
import fs from "node:fs";

// Incremental reader: each poll returns the records completed since the last one. A partial last
// line, including a split UTF-8 sequence, waits for its newline; unparseable lines are skipped.
export function createTail(file) {
  let offset = 0, rest = Buffer.alloc(0);
  const poll = () => {
    let fd; try { fd = fs.openSync(file, "r"); } catch { return []; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size <= offset) return [];
      const buf = Buffer.alloc(size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      offset = size;
      rest = Buffer.concat([rest, buf]);
    } finally { fs.closeSync(fd); }
    const end = rest.lastIndexOf(0x0a);
    if (end < 0) return [];
    const records = [];
    for (const line of rest.subarray(0, end).toString("utf8").split("\n")) {
      try { records.push(JSON.parse(line)); } catch {}
    }
    rest = rest.subarray(end + 1);
    return records;
  };
  return { file, poll };
}

// An assistant message with no tool call hands the turn back: the agent is waiting, not working.
export const endsTurn = (message) =>
  message?.role === "assistant" && Array.isArray(message.content) && !message.content.some((c) => c.type === "toolCall");
