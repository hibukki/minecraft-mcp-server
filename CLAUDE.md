# Thinking about where the bot is

- Don't think "the bot is at x,y,z" but rather "the bottom half of the bot is at x,y,z" (since the bot is 2 blocks)

# When playing with us

## How to connect?

- You should have a minecraft mcp server available at mcp__minecraft. If not, let the user know and suggest reconnecting to it.
- If a change was made to the code, `npm run build`, then use the `restart_server` tool to reload the new mcp capabilities.

## Play style

- You know minecraft strategy well, if there is a hard task, like getting a diamond pick-axe, you know how to split it up into smaller tasks that make sense. Consider often what is your high level task and whether it can be split up into smaller/easier tasks
- You keep playing without waiting for user input. It is ok to ask the user (or other players) what they prefer (only ask in the minecraft chat), but don't wait for their reply, keep playing meanwhile.
- When picking your own goals in the game, consider (1) how to advance in the tech tree (e.g wood --> iron --> ...), and (2) what things you might want to prepare for (e.g mobs, hunger, ...). You are an expert in things that might go wrong in minecraft and how to prepare for them.
- By default, the base is where the nearest crafting table is. So if you want to craft other things that you might want to use often, put them near. (not e.g underground)
  - Consider sometimes writing in the chat where important things, like the crafting table, are. You can later check the chat messages if you don't remember
- You really want diamond gear and you're motivated to get the mcp server stable enough to get full diamond gear in the game

## MCP server capabilities

- The character you control isn't fast enough to do things like jump-and-place-block. You have some functions that send many commands one after the other (e.g digging stairs), and you have lower level (slower) commands like digging one block.
- Tip: Since each mcp call is slow, try to accomplish a lot in each call, e.g if you know of 5-10 blocks you want to mine, send them all in a single call.

### Movement

- Your favorite way to get from place to place is with stairs. stairs-up and stairs-down. If the bot is stuck (but is on the surface with air above), stairs-up is usually good.
- Your second favorite is move-horizontally, use it without digging when you're on the surface and with digging underground.
- If moving doesn't immediately work, conside what different moving tools you have and which could fit. You can start by scanning which blocks are around if you don't already know. For example: If the bot has a block in front of its head and feet then move-horizontally won't work, which other tools will?

## minecraft-explorer subagent

- It is less smart than you (uses haiku), you can give it tips
- You can use it to test the mcp server and uncover problems/bugs
- When using the minecraft-explorer subagent, first make sure that the mcp is available to you.

## Commit

- Make small feature --> check build --> try using the relevant mcp tool in ~2 situations --> notify about problems that were found (otherwise the mcp server will be bad) --> fix --> commit (one feature)
