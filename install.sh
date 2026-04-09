#!/usr/bin/env bash
# RTL Claude — install script for Antigravity / VS Code
# Re-run after pulling changes or rebuilding.

set -e

EXT_SOURCE="$(cd "$(dirname "$0")" && pwd)"
EXT_NAME="yhbrwbyn.rtl-claude-0.1.0"

# Detect target IDE: Antigravity first, then VS Code
if [ -d "$HOME/.antigravity/extensions" ]; then
  EXT_DIR="$HOME/.antigravity/extensions"
  IDE="Antigravity"
elif [ -d "$HOME/.vscode/extensions" ]; then
  EXT_DIR="$HOME/.vscode/extensions"
  IDE="VS Code"
else
  echo "❌ Could not find Antigravity or VS Code extensions directory."
  exit 1
fi

echo "📦 Installing RTL Claude into $IDE..."
echo "   Source: $EXT_SOURCE"
echo "   Target: $EXT_DIR/$EXT_NAME"

# Install dependencies if missing
if [ ! -d "$EXT_SOURCE/node_modules" ]; then
  echo "📥 Installing npm dependencies..."
  (cd "$EXT_SOURCE" && npm install)
fi

# Build TypeScript
echo "🔨 Compiling TypeScript..."
(cd "$EXT_SOURCE" && npm run build)

# Symlink into extensions dir
echo "🔗 Linking extension..."
rm -rf "$EXT_DIR/$EXT_NAME"
ln -s "$EXT_SOURCE" "$EXT_DIR/$EXT_NAME"

# Register in extensions.json (Antigravity-style registry)
EXTENSIONS_JSON="$EXT_DIR/extensions.json"
if [ -f "$EXTENSIONS_JSON" ]; then
  echo "📝 Updating extensions.json..."
  python3 - <<PY
import json, time, uuid
path = "$EXTENSIONS_JSON"
with open(path) as f:
    data = json.load(f)
data = [e for e in data if e.get("identifier", {}).get("id") != "yhbrwbyn.rtl-claude"]
data.append({
    "identifier": {"id": "yhbrwbyn.rtl-claude", "uuid": str(uuid.uuid4())},
    "version": "0.1.0",
    "location": {"\$mid": 1, "path": "$EXT_DIR/$EXT_NAME", "scheme": "file"},
    "relativeLocation": "$EXT_NAME",
    "metadata": {
        "installedTimestamp": int(time.time() * 1000),
        "source": "vsix",
        "targetPlatform": "undefined",
        "updated": False,
        "private": True,
        "isPreReleaseVersion": False,
        "hasPreReleaseVersion": False,
    },
})
with open(path, "w") as f:
    json.dump(data, f, indent=2)
PY
fi

echo ""
echo "✅ Done! Now reload $IDE:"
echo "   1. Cmd+Shift+P → 'Reload Window'"
echo "   2. Look for the new chat icon in the activity bar"
echo "   3. Or press Cmd+Shift+H to open the chat"
