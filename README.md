# Minecraft MCP Server

> ⚠️ **CLAUDE DESKTOP DUAL LAUNCH WARNING**: Claude Desktop may sometimes launch MCP servers twice ([known issue](https://github.com/modelcontextprotocol/servers/issues/812)), which can lead to incorrect behavior of this MCP server. If you experience issues, restart Claude Desktop application to fix the problem. Alternatively, consider using other MCP clients.

https://github.com/user-attachments/assets/6f17f329-3991-4bc7-badd-7cde9aacb92f

A Minecraft bot powered by large language models and [Mineflayer API](https://github.com/PrismarineJS/mineflayer). This bot uses the [Model Context Protocol](https://github.com/modelcontextprotocol) (MCP) to enable Claude and other supported models to control a Minecraft character.

<a href="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@yuniko-software/minecraft-mcp-server/badge" alt="mcp-minecraft MCP server" />
</a>

## Prerequisites

- Git
- Node.js
- A running Minecraft game (the setup below was tested with Minecraft 1.21.8 Java Edition included in Microsoft Game Pass)
- An MCP-compatible client. Claude Desktop will be used as an example, but other MCP clients are also supported

## Getting started

This bot is designed to be used with Claude Desktop through the Model Context Protocol (MCP).

### Run Minecraft

Create a singleplayer world and open it to LAN (`ESC -> Open to LAN`). Bot will try to connect using port `25565` and hostname `localhost`. These parameters could be configured in `claude_desktop_config.json` on a next step. 

### MCP Configuration

Make sure that [Claude Desktop](https://claude.ai/download) is installed. Open `File -> Settings -> Developer -> Edit Config`. It should open installation directory. Find file with a name `claude_desktop_config.json` and insert the following code:

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "npx",
      "args": [
        "-y",
        "github:yuniko-software/minecraft-mcp-server",
        "--host",
        "localhost",
        "--port",
        "25565",
        "--username",
        "ClaudeBot"
      ]
    }
  }
}
```

Double-check that right `--port` and `--host` parameters were used. Make sure to completely reboot the Claude Desktop application (should be closed in OS tray). 

## Running

Make sure Minecraft game is running and the world is opened to LAN. Then start Claude Desktop application and the bot should join the game. 

It could take some time for Claude Desktop to boot the MCP server. The marker that the server has booted successfully:

![image](https://github.com/user-attachments/assets/39211d34-c3b3-46d6-bc80-353fd4fba690)

You can give bot any commands through any active Claude Desktop chat. You can also upload images of buildings and ask bot to build them 😁

Don't forget to mention that bot should do something in Minecraft in your prompt. Because saying this is a trigger to run MCP server. It will ask for your permissions.

Using Claude 4.0 Sonnet could give you some interesting results. The bot-agent would be really smart 🫡

Example usage: [shared Claude chat](https://claude.ai/share/535d5f69-f102-4cdb-9801-f74ea5709c0b)

## Available Commands

Once connected to a Minecraft server, Claude can use these commands:

### Movement
- `get-position` - Get the current position of the bot
- `move-to-position` - Move to specific coordinates
- `look-at` - Make the bot look at specific coordinates
- `jump` - Make the bot jump
- `move-in-direction` - Move in a specific direction for a duration

### Flight
- `fly-to` - Make the bot fly directly to specific coordinates

### Inventory
- `list-inventory` - List all items in the bot's inventory
- `find-item` - Find a specific item in inventory
- `equip-item` - Equip a specific item

### Block Interaction
- `place-block` - Place a block at specified coordinates
- `dig-block` - Dig a block at specified coordinates
- `get-block-info` - Get information about a block
- `find-block` - Find the nearest block of a specific type

### Entity Interaction
- `find-entity` - Find the nearest entity of a specific type

### Communication
- `send-chat` - Send a chat message in-game
- `read-chat` - Get recent chat messages from players

### Game State
- `detect-gamemode` - Detect the gamemode on game

## Development Setup

To clone and develop this project locally:

```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/hibukki/minecraft-mcp-server.git
cd minecraft-mcp-server

# If you already cloned without --recurse-submodules:
git submodule update --init --recursive

# Install dependencies in main repo
npm install

# Install dependencies in mineflayer submodule
cd mineflayer
npm install
cd ..

# Build the project
npm run build

# The bot is now ready to use!
```

### Mineflayer Modifications

This fork uses a modified version of [Mineflayer](https://github.com/PrismarineJS/mineflayer).
Our fork is located at [hibukki/mineflayer](https://github.com/hibukki/mineflayer) and includes:

- **Reduced timeout**: Default timeout reduced from 20s to 2s for faster failure detection
- **Crafting table distance check**: Clear error messages when crafting table is out of reach
- **Progress monitoring helpers**: New `gotoAndVerifyProgress` and `digWithTimeout` functions for better timeout handling

These modifications improve error handling and make the bot more responsive when operations fail.

## Contributing

This application was made in just two days, and the code is really simple and straightforward. All refactoring commits, functional and test contributions, issues and discussion are greatly appreciated!

Feel free to submit pull requests or open issues for improvements. Some areas that could use enhancement:

- Additional documentation
- More robust error handling
- Tests for different components
- New functionality and commands

To get started with contributing, please see [CONTRIBUTING.md](CONTRIBUTING.md).
