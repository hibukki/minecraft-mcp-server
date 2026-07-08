import { describe, expect, it } from "vitest";
import { MessageStore } from "./chatMessages.js";

describe("MessageStore", () => {
  it("returns recent messages in order", () => {
    const store = new MessageStore();
    store.addMessage("alice", "hi");
    store.addMessage("bob", "hey");
    const messages = store.getRecentMessages(10);
    expect(messages.map((m) => m.content)).toEqual(["hi", "hey"]);
  });

  it("limits returned messages to requested count", () => {
    const store = new MessageStore();
    for (let i = 0; i < 5; i++) store.addMessage("alice", `msg ${i}`);
    expect(store.getRecentMessages(2).map((m) => m.content)).toEqual(["msg 3", "msg 4"]);
  });

  it("drops oldest messages beyond the cap", () => {
    const store = new MessageStore();
    for (let i = 0; i < 150; i++) store.addMessage("alice", `msg ${i}`);
    const messages = store.getRecentMessages(200);
    expect(messages).toHaveLength(100);
    expect(messages[0].content).toBe("msg 50");
  });
});
