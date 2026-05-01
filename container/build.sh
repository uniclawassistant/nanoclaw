#!/bin/bash
# Build the NanoClaw agent container image.
#
# By default, builds the image at $CONTAINER_IMAGE (the same env var the host
# runtime reads in src/config.ts), so per-bot deployments stay in sync — set
# CONTAINER_IMAGE=nanoclaw-agent-unic:latest in unic's launchd plist and
# CONTAINER_IMAGE=nanoclaw-agent-chef:latest in chef's, and each bot rebuilds
# its own image without overwriting the other.
#
# Override priority (highest first):
#   1. positional argument:    ./build.sh my-image:tag
#   2. CONTAINER_IMAGE env var
#   3. legacy default:         nanoclaw-agent:latest
#
# Apple Container 0.11.0 workaround: the builder-shim aborts the context
# transfer with "unable to write data to the archive, code 0" on large
# contexts — even before .dockerignore is applied (apple/container#1375,
# fixed in 0.12.0). agent-runner/{node_modules,dist} make the context
# ~120 MB, which triggers it every time. We move them aside for the
# duration of the build and restore them via trap, regardless of outcome.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

IMAGE="${1:-${CONTAINER_IMAGE:-nanoclaw-agent:latest}}"
CONTAINER_RUNTIME="${CONTAINER_RUNTIME:-container}"

ASIDE_DIR=""

restore_aside() {
  if [ -n "$ASIDE_DIR" ] && [ -d "$ASIDE_DIR" ]; then
    if [ -d "$ASIDE_DIR/node_modules" ] && [ ! -e "agent-runner/node_modules" ]; then
      mv "$ASIDE_DIR/node_modules" agent-runner/node_modules
    fi
    if [ -d "$ASIDE_DIR/dist" ] && [ ! -e "agent-runner/dist" ]; then
      mv "$ASIDE_DIR/dist" agent-runner/dist
    fi
    rmdir "$ASIDE_DIR" 2>/dev/null || true
  fi
}
trap restore_aside EXIT

if [ -d agent-runner/node_modules ] || [ -d agent-runner/dist ]; then
  ASIDE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/nanoclaw-build-aside.XXXXXX")"
  echo "Moving large dirs aside to ${ASIDE_DIR} (Apple Container 0.11.0 context-transfer workaround)"
  [ -d agent-runner/node_modules ] && mv agent-runner/node_modules "$ASIDE_DIR/node_modules"
  [ -d agent-runner/dist ] && mv agent-runner/dist "$ASIDE_DIR/dist"
fi

echo "Building NanoClaw agent container image..."
echo "Image: ${IMAGE}"

${CONTAINER_RUNTIME} build -t "${IMAGE}" .

echo ""
echo "Build complete!"
echo "Image: ${IMAGE}"
echo ""
echo "Test with:"
echo "  echo '{\"prompt\":\"What is 2+2?\",\"groupFolder\":\"test\",\"chatJid\":\"test@g.us\",\"isMain\":false}' | ${CONTAINER_RUNTIME} run -i ${IMAGE}"
