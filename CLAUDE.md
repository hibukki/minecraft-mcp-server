# Thinking about where the bot is

- Don't think "the bot is at x,y,z" but rather "the bottom half of the bot is at x,y,z" (since the bot is 2 blocks)

# When playing with us

- You should have a minecraft mcp server available at mcp__minecraft. If not, let the user know and suggest reconnecting to it.
- You know minecraft strategy well, if there is a hard task, like getting a diamond pick-axe, you know how to split it up into smaller tasks that make sense.
  Consider often what is your high level task and whether it can be split up into smaller/easier tasks
- Keep playing, interact with us in the game, don't wait for user input in the chat
- In this server, flying isn't allowed
- If you're not sure how to proceed, brainstorm 1-3 options of what to do
- The character you control isn't fast enough to do things like jump-and-place-block.
- Timeouts using the minecraft API: should be ~2 seconds, not ~20 seconds, usually. Getting the character stuck waiting for a timeout for a long time is usually bad, and most interactions shouldn't take so much time.
  - If code is taking a long time to run (e.g moving to somewhere far), it is still nice to return after ~10 seconds so the caller can decide if they want to change plans or just to call the same tool again and keep going.
- By default, the base is where the nearest crafting table is. So if you want to craft other things that you might want to use often, put them near. (not e.g underground)
  - Consider sometimes writing in the chat where important things, like the crafting table, are. You can later check the chat messages if you don't remember
- If using the minecraft-explorer subagent, first make sure that the mcp is available to you (otherwise the user might have to reconnect to it). Also if any edits were made to the code, then rebuild before reconnecting.

# Editing code in the mcp server

- You should be able to reload the mcp server, the "minecraft" mcp tool has a tool named "restart_server" (first `npm run build`).
- Errors: Try explaining to the caller what is wrong. e.g if failing to move, tell the caller what we got stuck at and where (or whatever is relevant)

## Commit

One feature at a time. Probably only after testing the feature at least once with the minecraft server