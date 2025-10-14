# Setup Instructions for Public GitHub Repos

## Current State
- Main repo: forked from `yuniko-software/minecraft-mcp-server`
- Mineflayer: local clone of `PrismarineJS/mineflayer` with 2 custom commits in `mineflayer/` subdirectory

## Option 1: Single Repo (Recommended - Simpler)

Keep everything in one repo. Users just clone and go.

### Steps:

1. **Create your fork on GitHub:**
   - Go to https://github.com/yuniko-software/minecraft-mcp-server
   - Click "Fork" → Create fork under your account (`yonatancale/minecraft-mcp-server`)

2. **Update git remote locally:**
   ```bash
   cd /Users/yonatancale/Development/minecraft-mcp-server
   git remote set-url origin https://github.com/yonatancale/minecraft-mcp-server.git
   git push -u origin main
   ```

3. **Commit mineflayer changes to main repo:**
   ```bash
   # The mineflayer/ directory is currently untracked
   git add mineflayer/
   git commit -m "mineflayer: +custom timeout and distance check patches"
   git push
   ```

4. **Add to README.md:**
   ```markdown
   ## Development Setup

   To clone and set up this project locally:

   ```bash
   # Clone the repository
   git clone https://github.com/yonatancale/minecraft-mcp-server.git
   cd minecraft-mcp-server

   # Install dependencies
   npm install

   # Build the project
   npm run build

   # The bot is ready to use!
   ```

   ### Mineflayer Modifications

   This project includes a modified version of [Mineflayer](https://github.com/PrismarineJS/mineflayer)
   with the following patches:
   - Reduced default timeout from 20s to 2s for faster failure detection
   - Added distance check for crafting table with clear error messages

   The modified Mineflayer is located in the `mineflayer/` directory.
   ```

**Pros:**
- ✅ Simple for users - one clone command
- ✅ No submodule complexity
- ✅ Everything works out of the box

**Cons:**
- ⚠️ Mineflayer changes not in a separate fork (harder to upstream later)
- ⚠️ Larger repo size

---

## Option 2: Two Separate Repos with Git Submodule

Fork both repos separately and link with submodule.

### Steps:

1. **Fork minecraft-mcp-server:**
   - Go to https://github.com/yuniko-software/minecraft-mcp-server
   - Click "Fork" → `yonatancale/minecraft-mcp-server`

2. **Fork mineflayer:**
   - Go to https://github.com/PrismarineJS/mineflayer
   - Click "Fork" → `yonatancale/mineflayer`

3. **Push your mineflayer changes:**
   ```bash
   cd /Users/yonatancale/Development/minecraft-mcp-server/mineflayer

   # Add your fork as remote
   git remote add my-fork https://github.com/yonatancale/mineflayer.git

   # Push your commits
   git push my-fork HEAD:main
   ```

4. **Convert mineflayer to submodule:**
   ```bash
   cd /Users/yonatancale/Development/minecraft-mcp-server

   # Remove mineflayer directory from tracking (but keep files)
   git rm -r --cached mineflayer/

   # Add .gitignore entry temporarily
   echo "mineflayer/" >> .gitignore
   git add .gitignore
   git commit -m "Prepare for mineflayer submodule"

   # Remove the directory
   rm -rf mineflayer/

   # Add as submodule
   git submodule add https://github.com/yonatancale/mineflayer.git mineflayer

   # Remove .gitignore entry
   # Edit .gitignore to remove the "mineflayer/" line

   # Commit
   git add .gitignore .gitmodules mineflayer
   git commit -m "mineflayer: convert to git submodule"
   ```

5. **Update README.md:**
   ```markdown
   ## Development Setup

   To clone and set up this project locally:

   ```bash
   # Clone with submodules
   git clone --recurse-submodules https://github.com/yonatancale/minecraft-mcp-server.git
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
   ```

   ### Mineflayer Modifications

   This project uses a modified version of [Mineflayer](https://github.com/PrismarineJS/mineflayer).
   Our fork is located at [yonatancale/mineflayer](https://github.com/yonatancale/mineflayer)
   and includes:
   - Reduced default timeout from 20s to 2s for faster failure detection
   - Added distance check for crafting table with clear error messages
   ```

**Pros:**
- ✅ Clean separation of concerns
- ✅ Easier to contribute mineflayer changes upstream
- ✅ Can track upstream changes separately

**Cons:**
- ⚠️ More complex setup for users
- ⚠️ Submodule management overhead
- ⚠️ Users might forget `--recurse-submodules`

---

## Recommendation

**Go with Option 1** unless you plan to:
- Frequently sync with upstream mineflayer
- Contribute your changes back to PrismarineJS/mineflayer
- Make many more mineflayer modifications

For a personal project fork with minor patches, keeping it simple is better.
